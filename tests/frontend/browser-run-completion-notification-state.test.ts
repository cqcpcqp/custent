import { describe, expect, it } from "vitest";

import {
  browserRunCompletionNotificationLedgerLockName,
  browserRunCompletionNotificationLedgerProbeStorageKey,
  browserRunCompletionNotificationLedgerStorageKey,
  browserRunCompletionNotificationPreferenceStorageKey,
  browserRunCompletionNotificationPreferences,
  coordinateRunCompletionSystemNotification,
  parseBrowserRunCompletionNotificationLedger,
  parseBrowserRunCompletionNotificationPreference,
  prepareRunCompletionSystemNotification,
  probeBrowserRunCompletionNotificationStorageWrite,
  readBrowserRunCompletionNotificationStorage,
  runCompletionNotificationIdentity,
  serializeBrowserRunCompletionNotificationLedger,
  serializeBrowserRunCompletionNotificationPreference,
  writeBrowserRunCompletionNotificationStorage,
  type BrowserRunCompletionNotificationStorageReadResult,
  type RunCompletionNotificationCoordinator,
} from "@/components/browser-run-completion-notification-state";
import type { RunCompletionNotification } from "@/components/run-completion-notification-state";

const completedNotification: RunCompletionNotification = {
  conversationId: "10000000-0000-4000-8000-000000000001",
  runId: "20000000-0000-4000-8000-000000000001",
  title: "德国泵类买家",
  outcome: "completed",
};

function createExclusiveRunner(): RunCompletionNotificationCoordinator["runExclusive"] {
  let tail: Promise<void> = Promise.resolve();
  return (operation) => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

function availableStorageValue(
  value: string | null,
): BrowserRunCompletionNotificationStorageReadResult {
  return { status: "available", value };
}

describe("browser Run-completion notification state", () => {
  it("uses stable browser-local keys and an explicit two-value opt-in contract", () => {
    expect(browserRunCompletionNotificationPreferenceStorageKey).toBe(
      "custent:browser-run-completion-notifications",
    );
    expect(browserRunCompletionNotificationLedgerStorageKey).toBe(
      "custent:browser-run-completion-notification-ledger:v1",
    );
    expect(browserRunCompletionNotificationLedgerLockName).toBe(
      browserRunCompletionNotificationLedgerStorageKey,
    );
    expect(browserRunCompletionNotificationLedgerProbeStorageKey).toBe(
      "custent:browser-run-completion-notification-ledger-probe:v1",
    );
    expect(browserRunCompletionNotificationPreferences).toEqual([
      "disabled",
      "enabled",
    ]);

    for (const preference of browserRunCompletionNotificationPreferences) {
      expect(parseBrowserRunCompletionNotificationPreference(preference)).toBe(
        preference,
      );
      expect(
        serializeBrowserRunCompletionNotificationPreference(preference),
      ).toBe(preference);
    }
  });

  it.each([null, "", "true", "false", "ENABLED", " enabled ", "on"])(
    "rejects a non-contract preference value: %s",
    (value) => {
      expect(parseBrowserRunCompletionNotificationPreference(value)).toBeNull();
    },
  );

  it("keys deduplication by the exact conversation and Run pair", () => {
    const sameRunInAnotherConversation = {
      ...completedNotification,
      conversationId: "10000000-0000-4000-8000-000000000002",
    };
    const anotherRunInSameConversation = {
      ...completedNotification,
      runId: "20000000-0000-4000-8000-000000000002",
    };

    expect(runCompletionNotificationIdentity(completedNotification)).not.toBe(
      runCompletionNotificationIdentity(sameRunInAnotherConversation),
    );
    expect(runCompletionNotificationIdentity(completedNotification)).not.toBe(
      runCompletionNotificationIdentity(anotherRunInSameConversation),
    );
    expect(
      JSON.parse(runCompletionNotificationIdentity(completedNotification)),
    ).toEqual([
      completedNotification.conversationId,
      completedNotification.runId,
    ]);
  });

  it("uses a strict, complete, duplicate-free local ledger", () => {
    expect(parseBrowserRunCompletionNotificationLedger(null)).toEqual([]);
    expect(parseBrowserRunCompletionNotificationLedger("not-json")).toEqual(
      [],
    );
    expect(
      parseBrowserRunCompletionNotificationLedger(
        JSON.stringify({ version: 2, identities: ["old"] }),
      ),
    ).toEqual([]);
    expect(
      parseBrowserRunCompletionNotificationLedger(
        JSON.stringify({ version: 1, identities: ["valid", 42] }),
      ),
    ).toEqual([]);

    const completeLedger = Array.from(
      { length: 300 },
      (_, index) => `identity-${index}`,
    );
    const parsed = parseBrowserRunCompletionNotificationLedger(
      serializeBrowserRunCompletionNotificationLedger([
        ...completeLedger,
        "identity-299",
      ]),
    );
    expect(parsed).toHaveLength(300);
    expect(parsed[0]).toBe("identity-0");
    expect(parsed.at(-1)).toBe("identity-299");
    expect(new Set(parsed).size).toBe(parsed.length);
  });

  it("does not redeliver any of 257 recorded completions", () => {
    const notifications = Array.from({ length: 257 }, (_, index) => ({
      ...completedNotification,
      runId: `run-${index + 1}`,
    }));
    let serializedLedger: string | null = null;

    for (const notification of notifications) {
      const decision = prepareRunCompletionSystemNotification(
        serializedLedger,
        notification,
        false,
      );
      expect(decision.shouldNotify).toBe(false);
      expect(decision.nextSerializedLedger).not.toBeNull();
      serializedLedger = decision.nextSerializedLedger;
    }
    expect(
      parseBrowserRunCompletionNotificationLedger(serializedLedger),
    ).toHaveLength(257);

    let redeliveryCount = 0;
    for (const notification of notifications) {
      const decision = prepareRunCompletionSystemNotification(
        serializedLedger,
        notification,
        true,
      );
      if (decision.shouldNotify) {
        redeliveryCount += 1;
      }
      if (decision.nextSerializedLedger !== null) {
        serializedLedger = decision.nextSerializedLedger;
      }
    }
    expect(redeliveryCount).toBe(0);
  });

  it("records completions while disabled without later notifying a backlog", () => {
    const disabledDecision = prepareRunCompletionSystemNotification(
      null,
      completedNotification,
      false,
    );
    expect(disabledDecision.shouldNotify).toBe(false);
    expect(disabledDecision.nextSerializedLedger).not.toBeNull();

    const laterEnabledDecision = prepareRunCompletionSystemNotification(
      disabledDecision.nextSerializedLedger,
      completedNotification,
      true,
    );
    expect(laterEnabledDecision).toEqual({
      nextSerializedLedger: null,
      shouldNotify: false,
    });
  });

  it("allows exactly one of two concurrent tabs to claim the same completion", async () => {
    let serializedLedger: string | null = null;
    let deliveryCount = 0;
    const runExclusive = createExclusiveRunner();
    const coordinator = (): RunCompletionNotificationCoordinator => ({
      deliverNotification: () => {
        deliveryCount += 1;
        return { rollback: () => undefined };
      },
      probeLedgerWrite: () => true,
      readLedger: () => availableStorageValue(serializedLedger),
      readPermission: () => "granted",
      readPreference: () => availableStorageValue("enabled"),
      runExclusive,
      writeLedger: (nextLedger) => {
        serializedLedger = nextLedger;
        return true;
      },
    });

    const decisions = await Promise.all([
      coordinateRunCompletionSystemNotification(
        completedNotification,
        coordinator(),
      ),
      coordinateRunCompletionSystemNotification(
        completedNotification,
        coordinator(),
      ),
    ]);

    expect(decisions).toEqual(["notified", "already_recorded"]);
    expect(deliveryCount).toBe(1);
    expect(
      parseBrowserRunCompletionNotificationLedger(serializedLedger),
    ).toEqual([runCompletionNotificationIdentity(completedNotification)]);
  });

  it("requires both the saved opt-in and granted browser permission", async () => {
    const cases = [
      { permission: "default", preference: "enabled" },
      { permission: "denied", preference: "enabled" },
      { permission: "granted", preference: "disabled" },
      { permission: "granted", preference: null },
    ] as const;

    for (const testCase of cases) {
      let serializedLedger: string | null = null;
      expect(
        await coordinateRunCompletionSystemNotification(
          completedNotification,
          {
            deliverNotification: () => {
              throw new Error("禁用时不应构造通知");
            },
            probeLedgerWrite: () => true,
            readLedger: () => availableStorageValue(serializedLedger),
            readPermission: () => testCase.permission,
            readPreference: () =>
              availableStorageValue(testCase.preference),
            runExclusive: async (operation) => operation(),
            writeLedger: (nextLedger) => {
              serializedLedger = nextLedger;
              return true;
            },
          },
        ),
      ).toBe("recorded_without_notification");
      expect(serializedLedger).not.toBeNull();
    }
  });

  it.each([
    ["unmounted", (): null => null],
    [
      "constructor failure",
      (): never => {
        throw new Error("Notification constructor failed");
      },
    ],
  ] as const)(
    "does not commit %s delivery and lets another tab claim it",
    async (_caseName, failedDelivery) => {
      let serializedLedger: string | null = null;
      const runExclusive = createExclusiveRunner();
      const coordinator = (
        deliverNotification: RunCompletionNotificationCoordinator["deliverNotification"],
      ): RunCompletionNotificationCoordinator => ({
        deliverNotification,
        probeLedgerWrite: () => true,
        readLedger: () => availableStorageValue(serializedLedger),
        readPermission: () => "granted",
        readPreference: () => availableStorageValue("enabled"),
        runExclusive,
        writeLedger: (nextLedger) => {
          serializedLedger = nextLedger;
          return true;
        },
      });

      await expect(
        coordinateRunCompletionSystemNotification(
          completedNotification,
          coordinator(failedDelivery),
        ),
      ).resolves.toBe("not_delivered");
      expect(serializedLedger).toBeNull();

      await expect(
        coordinateRunCompletionSystemNotification(
          completedNotification,
          coordinator(() => ({ rollback: () => undefined })),
        ),
      ).resolves.toBe("notified");
      expect(
        parseBrowserRunCompletionNotificationLedger(serializedLedger),
      ).toEqual([runCompletionNotificationIdentity(completedNotification)]);
    },
  );

  it("treats storage exceptions as unavailable without throwing or delivering", async () => {
    const storage = {
      getItem() {
        throw new DOMException("blocked", "SecurityError");
      },
      removeItem() {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem() {
        throw new DOMException("blocked", "SecurityError");
      },
    };

    expect(
      readBrowserRunCompletionNotificationStorage(() => storage, "key"),
    ).toEqual({ status: "unavailable" });
    expect(
      writeBrowserRunCompletionNotificationStorage(
        () => storage,
        "key",
        "value",
      ),
    ).toBe(false);
    expect(
      probeBrowserRunCompletionNotificationStorageWrite(
        () => storage,
        "probe",
        "value",
      ),
    ).toBe(false);
    const blockedStorageAccess = (): never => {
      throw new DOMException("blocked", "SecurityError");
    };
    expect(
      readBrowserRunCompletionNotificationStorage(
        blockedStorageAccess,
        "key",
      ),
    ).toEqual({ status: "unavailable" });
    expect(
      writeBrowserRunCompletionNotificationStorage(
        blockedStorageAccess,
        "key",
        "value",
      ),
    ).toBe(false);
    expect(
      probeBrowserRunCompletionNotificationStorageWrite(
        blockedStorageAccess,
        "probe",
        "value",
      ),
    ).toBe(false);

    let deliveryCount = 0;
    await expect(
      coordinateRunCompletionSystemNotification(completedNotification, {
        deliverNotification: () => {
          deliveryCount += 1;
          return { rollback: () => undefined };
        },
        probeLedgerWrite: () => false,
        readLedger: () => availableStorageValue(null),
        readPermission: () => "granted",
        readPreference: () => availableStorageValue("enabled"),
        runExclusive: async (operation) => operation(),
        writeLedger: () => false,
      }),
    ).resolves.toBe("storage_unavailable");
    expect(deliveryCount).toBe(0);
  });

  it("rolls back a constructed notification when the final ledger commit fails", async () => {
    let rollbackCount = 0;
    let deliveryCount = 0;

    await expect(
      coordinateRunCompletionSystemNotification(completedNotification, {
        deliverNotification: () => {
          deliveryCount += 1;
          return {
            rollback: () => {
              rollbackCount += 1;
            },
          };
        },
        probeLedgerWrite: () => true,
        readLedger: () => availableStorageValue(null),
        readPermission: () => "granted",
        readPreference: () => availableStorageValue("enabled"),
        runExclusive: async (operation) => operation(),
        writeLedger: () => false,
      }),
    ).resolves.toBe("storage_unavailable");
    expect(deliveryCount).toBe(1);
    expect(rollbackCount).toBe(1);
  });
});
