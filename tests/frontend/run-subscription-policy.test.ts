import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  activeRunSubscriptionRole,
  backgroundRunBootstrapObservationRequired,
  connectionModeForRunSubscriptionRole,
  markCurrentRunSubscriptionTerminalEvent,
  releaseCurrentTerminalRunSubscription,
  runSubscriptionCommitsEvents,
  runSubscriptionPresentsConnectionState,
  runSubscriptionRole,
  runSubscriptionRoleTransition,
  runSubscriptionUsesEventStream,
} from "@/components/run-subscription-policy";

describe("run subscription policy", () => {
  it("only lets the current visible conversation follow an active Run", () => {
    expect(
      activeRunSubscriptionRole({
        conversationId: "conversation-a",
        activeConversationId: "conversation-a",
        visibilityState: "visible",
      }),
    ).toBe("foreground_follow");
    expect(
      activeRunSubscriptionRole({
        conversationId: "conversation-b",
        activeConversationId: "conversation-a",
        visibilityState: "visible",
      }),
    ).toBeNull();
    expect(
      activeRunSubscriptionRole({
        conversationId: "conversation-a",
        activeConversationId: "conversation-a",
        visibilityState: "hidden",
      }),
    ).toBeNull();
  });

  it("keeps an explicit replay finite regardless of conversation visibility", () => {
    expect(
      runSubscriptionRole({
        mode: "replay_once",
        conversationId: "conversation-b",
        activeConversationId: "conversation-a",
        visibilityState: "hidden",
      }),
    ).toBe("replay_once");
    expect(runSubscriptionUsesEventStream("replay_once")).toBe(true);
    expect(runSubscriptionUsesEventStream("foreground_follow")).toBe(true);
    expect(runSubscriptionUsesEventStream(null)).toBe(false);
  });

  it("uses one Bootstrap observation requirement for any number of background Runs", () => {
    const conversations = [
      { id: "conversation-a", activeRun: { id: "run-a" } },
      { id: "conversation-b", activeRun: { id: "run-b" } },
      { id: "conversation-c", activeRun: null },
    ];

    expect(
      backgroundRunBootstrapObservationRequired({
        conversations,
        activeConversationId: "conversation-a",
        visibilityState: "visible",
      }),
    ).toBe(true);
    expect(
      backgroundRunBootstrapObservationRequired({
        conversations: [conversations[0]],
        activeConversationId: "conversation-a",
        visibilityState: "visible",
      }),
    ).toBe(false);
    expect(
      backgroundRunBootstrapObservationRequired({
        conversations: [conversations[0]],
        activeConversationId: "conversation-a",
        visibilityState: "hidden",
      }),
    ).toBe(true);
    expect(
      backgroundRunBootstrapObservationRequired({
        conversations: [conversations[2]],
        activeConversationId: null,
        visibilityState: "visible",
      }),
    ).toBe(false);
  });

  it("maps the two Event Stream roles to their fixed connection behavior", () => {
    expect(runSubscriptionCommitsEvents("foreground_follow")).toBe(true);
    expect(runSubscriptionPresentsConnectionState("foreground_follow")).toBe(
      true,
    );
    expect(runSubscriptionCommitsEvents("replay_once")).toBe(true);
    expect(runSubscriptionPresentsConnectionState("replay_once")).toBe(true);
    expect(
      connectionModeForRunSubscriptionRole("foreground_follow"),
    ).toBe("follow");
    expect(connectionModeForRunSubscriptionRole("replay_once")).toBe(
      "replay_once",
    );
  });

  it("stops a follow when it becomes background but preserves terminal cleanup", () => {
    expect(
      runSubscriptionRoleTransition({
        currentRole: "foreground_follow",
        nextRole: null,
        terminalEventReceived: false,
      }),
    ).toBe("restart");
    expect(
      runSubscriptionRoleTransition({
        currentRole: "foreground_follow",
        nextRole: null,
        terminalEventReceived: true,
      }),
    ).toBe("preserve_terminal_follow_up");
    expect(
      runSubscriptionRoleTransition({
        currentRole: "replay_once",
        nextRole: "replay_once",
        terminalEventReceived: false,
      }),
    ).toBe("retain");
  });

  it("only lets the registry's current controller mark and release a terminal stream", () => {
    const currentController = new AbortController();
    const staleController = new AbortController();
    const subscriptions = new Map([
      [
        "run-a",
        {
          controller: currentController,
          terminalEventReceived: false,
        },
      ],
    ]);
    const current = subscriptions.get("run-a");

    expect(
      markCurrentRunSubscriptionTerminalEvent({
        current,
        controller: staleController,
      }),
    ).toBe(false);
    expect(
      markCurrentRunSubscriptionTerminalEvent({
        current,
        controller: currentController,
      }),
    ).toBe(true);
    expect(
      releaseCurrentTerminalRunSubscription({
        subscriptions,
        runId: "run-a",
        controller: staleController,
      }),
    ).toBe(false);
    expect(
      releaseCurrentTerminalRunSubscription({
        subscriptions,
        runId: "run-a",
        controller: currentController,
      }),
    ).toBe(true);
    expect(currentController.signal.aborted).toBe(true);
  });

  it("has no background Event Stream branch in the workspace", async () => {
    const source = await readFile(
      path.join(process.cwd(), "components/research-workspace.tsx"),
      "utf8",
    );

    expect(source).not.toContain("background_watch");
    expect(source).not.toContain("run_terminal_observed");
    expect(source).not.toContain("BackgroundRunObservationFailures");
    expect(source).toContain("runSubscriptionUsesEventStream(role)");
    expect(source).toContain(
      'scheduleBootstrapRevalidation("background_poll")',
    );
    expect(source).not.toContain("setInterval(");
  });

  it("keeps background polling lightweight and fences visible detail commits", async () => {
    const source = await readFile(
      path.join(process.cwd(), "components/research-workspace.tsx"),
      "utf8",
    );
    const revalidation = source.slice(
      source.indexOf("const revalidateBootstrap = useCallback"),
      source.indexOf("const workspaceNeedsBackgroundRunObservation"),
    );

    expect(revalidation).toContain('if (requestKind === "full") {\n      invalidateConversationPageLoad();');
    expect(revalidation).toContain(
      'while (requestKind === "full" && incomingNextCursor !== null)',
    );
    expect(revalidation).toContain("mergeConversationPageAtRevision({");
    expect(revalidation).toContain(
      "visibleConversationDetailRefreshIsCurrent({",
    );
    expect(source).toContain("commitGuard?: () => boolean");
    expect(source).toContain("bootstrapRevalidationRunningRequestRef");
  });
});
