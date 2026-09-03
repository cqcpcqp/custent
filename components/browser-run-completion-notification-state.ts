import type { RunCompletionNotification } from "@/components/run-completion-notification-state";

export const browserRunCompletionNotificationPreferenceStorageKey =
  "custent:browser-run-completion-notifications";
export const browserRunCompletionNotificationLedgerStorageKey =
  "custent:browser-run-completion-notification-ledger:v1";
export const browserRunCompletionNotificationLedgerLockName =
  "custent:browser-run-completion-notification-ledger:v1";
export const browserRunCompletionNotificationLedgerProbeStorageKey =
  "custent:browser-run-completion-notification-ledger-probe:v1";
export const browserRunCompletionNotificationPreferenceChangedEventName =
  "custent:browser-run-completion-notification-preference-changed";

export const browserRunCompletionNotificationPreferences = [
  "disabled",
  "enabled",
] as const;

export type BrowserRunCompletionNotificationPreference =
  (typeof browserRunCompletionNotificationPreferences)[number];

export type BrowserRunCompletionNotificationLedger = readonly string[];

export type RunCompletionNotificationDecision = Readonly<{
  nextSerializedLedger: string | null;
  shouldNotify: boolean;
}>;

export type BrowserRunCompletionNotificationStorageReadResult =
  | Readonly<{ status: "available"; value: string | null }>
  | Readonly<{ status: "unavailable" }>;

export type RunCompletionSystemNotificationDelivery = Readonly<{
  rollback: () => void;
}>;

export type RunCompletionNotificationCoordinationOutcome =
  | "already_recorded"
  | "not_delivered"
  | "notified"
  | "recorded_without_notification"
  | "storage_unavailable";

export type RunCompletionNotificationCoordinator = Readonly<{
  deliverNotification: () => RunCompletionSystemNotificationDelivery | null;
  probeLedgerWrite: (serializedLedger: string) => boolean;
  readLedger: () => BrowserRunCompletionNotificationStorageReadResult;
  readPermission: () => NotificationPermission;
  readPreference: () => BrowserRunCompletionNotificationStorageReadResult;
  runExclusive: (
    operation: () =>
      | RunCompletionNotificationCoordinationOutcome
      | Promise<RunCompletionNotificationCoordinationOutcome>,
  ) => Promise<RunCompletionNotificationCoordinationOutcome>;
  writeLedger: (serializedLedger: string) => boolean;
}>;

const browserRunCompletionNotificationLedgerVersion = 1;

type StoredBrowserRunCompletionNotificationLedger = Readonly<{
  identities: readonly string[];
  version: typeof browserRunCompletionNotificationLedgerVersion;
}>;

export function readBrowserRunCompletionNotificationStorage(
  storage: () => Pick<Storage, "getItem">,
  key: string,
): BrowserRunCompletionNotificationStorageReadResult {
  try {
    return { status: "available", value: storage().getItem(key) };
  } catch {
    return { status: "unavailable" };
  }
}

export function writeBrowserRunCompletionNotificationStorage(
  storage: () => Pick<Storage, "setItem">,
  key: string,
  value: string,
): boolean {
  try {
    storage().setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function probeBrowserRunCompletionNotificationStorageWrite(
  storage: () => Pick<Storage, "removeItem" | "setItem">,
  key: string,
  value: string,
): boolean {
  try {
    const target = storage();
    target.setItem(key, value);
    target.removeItem(key);
    return true;
  } catch {
    try {
      storage().removeItem(key);
    } catch {
      // The caller will keep browser notifications unavailable. The probe key
      // is never read as notification state.
    }
    return false;
  }
}

export function parseBrowserRunCompletionNotificationPreference(
  value: string | null,
): BrowserRunCompletionNotificationPreference | null {
  if (value === "disabled" || value === "enabled") {
    return value;
  }
  return null;
}

export function serializeBrowserRunCompletionNotificationPreference(
  preference: BrowserRunCompletionNotificationPreference,
): BrowserRunCompletionNotificationPreference {
  return preference;
}

export function runCompletionNotificationIdentity(
  notification: Pick<
    RunCompletionNotification,
    "conversationId" | "runId"
  >,
): string {
  return JSON.stringify([notification.conversationId, notification.runId]);
}

export function parseBrowserRunCompletionNotificationLedger(
  value: string | null,
): BrowserRunCompletionNotificationLedger {
  if (value === null) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== browserRunCompletionNotificationLedgerVersion ||
      !("identities" in parsed) ||
      !Array.isArray(parsed.identities) ||
      parsed.identities.some(
        (identity) => typeof identity !== "string" || identity.length === 0,
      )
    ) {
      return [];
    }

    return Array.from(new Set(parsed.identities));
  } catch {
    return [];
  }
}

export function serializeBrowserRunCompletionNotificationLedger(
  ledger: BrowserRunCompletionNotificationLedger,
): string {
  const storedLedger: StoredBrowserRunCompletionNotificationLedger = {
    identities: Array.from(new Set(ledger)),
    version: browserRunCompletionNotificationLedgerVersion,
  };
  return JSON.stringify(storedLedger);
}

export function prepareRunCompletionSystemNotification(
  serializedLedger: string | null,
  notification: Pick<
    RunCompletionNotification,
    "conversationId" | "runId"
  >,
  notificationsAreEnabled: boolean,
): RunCompletionNotificationDecision {
  const ledger = parseBrowserRunCompletionNotificationLedger(
    serializedLedger,
  );
  const identity = runCompletionNotificationIdentity(notification);
  if (ledger.includes(identity)) {
    return {
      nextSerializedLedger: null,
      shouldNotify: false,
    };
  }

  const nextLedger = [...ledger, identity];
  return {
    nextSerializedLedger:
      serializeBrowserRunCompletionNotificationLedger(nextLedger),
    shouldNotify: notificationsAreEnabled,
  };
}

export async function coordinateRunCompletionSystemNotification(
  notification: Pick<
    RunCompletionNotification,
    "conversationId" | "runId"
  >,
  coordinator: RunCompletionNotificationCoordinator,
): Promise<RunCompletionNotificationCoordinationOutcome> {
  return coordinator.runExclusive(() => {
    const preferenceRead = coordinator.readPreference();
    const ledgerRead = coordinator.readLedger();
    if (
      preferenceRead.status === "unavailable" ||
      ledgerRead.status === "unavailable"
    ) {
      return "storage_unavailable";
    }

    const preference = parseBrowserRunCompletionNotificationPreference(
      preferenceRead.value,
    );
    const decision = prepareRunCompletionSystemNotification(
      ledgerRead.value,
      notification,
      preference === "enabled" &&
        coordinator.readPermission() === "granted",
    );
    if (decision.nextSerializedLedger === null) {
      return "already_recorded";
    }

    if (!decision.shouldNotify) {
      return coordinator.writeLedger(decision.nextSerializedLedger)
        ? "recorded_without_notification"
        : "storage_unavailable";
    }

    if (!coordinator.probeLedgerWrite(decision.nextSerializedLedger)) {
      return "storage_unavailable";
    }

    let delivery: RunCompletionSystemNotificationDelivery | null;
    try {
      delivery = coordinator.deliverNotification();
    } catch {
      return "not_delivered";
    }
    if (delivery === null) {
      return "not_delivered";
    }

    if (!coordinator.writeLedger(decision.nextSerializedLedger)) {
      try {
        delivery.rollback();
      } catch {
        // The storage failure remains authoritative. A rollback failure must
        // not convert this into a durable delivered identity.
      }
      return "storage_unavailable";
    }
    return "notified";
  });
}
