import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

async function workspaceSource(): Promise<string> {
  return readFile(
    path.join(process.cwd(), "components/research-workspace.tsx"),
    "utf8",
  );
}

function callbackSource(
  source: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`缺少回调源码边界 ${startMarker} -> ${endMarker}`);
  }
  return source.slice(start, end);
}

describe("run mutation integration invariants", () => {
  it("projects a retry response and subscribes before detail convergence", async () => {
    const source = callbackSource(
      await workspaceSource(),
      "const handleRetryRun = useCallback",
      "const handleRegenerateRun = useCallback",
    );
    const reloadIndex = source.indexOf(
      "const loadResult = await loadConversation(conversationId)",
    );

    expect(reloadIndex).toBeGreaterThan(0);
    expect(source.indexOf('type: "run_updated"')).toBeLessThan(reloadIndex);
    expect(
      source.indexOf("commitConversationSummary(response.conversation)"),
    ).toBeLessThan(reloadIndex);
    expect(
      source.indexOf(
        'ensureRunSubscription(conversationId, response.run.id, "active"',
      ),
    ).toBeLessThan(reloadIndex);
  });

  it("fences branch selection before issuing the existing PATCH", async () => {
    const source = callbackSource(
      await workspaceSource(),
      "const handleSelectRun = useCallback",
      "const closeConversationBrowser = useCallback",
    );
    const requestIndex = source.indexOf("await patchConversation");

    expect(requestIndex).toBeGreaterThan(0);
    expect(source.indexOf("conversationHasOutstandingRuns")).toBeLessThan(
      requestIndex,
    );
    expect(source.indexOf("conversationStateHasOutstandingRuns")).toBeLessThan(
      requestIndex,
    );
    expect(source.indexOf("activeRunSelectionMessage")).toBeLessThan(
      requestIndex,
    );
  });

  it("uses one operation fence for mutations, terminal refreshes, and bootstrap refreshes", async () => {
    const source = await workspaceSource();

    expect(source).toContain("creditOperationRevisionRef");
    expect(source).toContain("creditMutationOperationRevisionsRef");
    expect(source).toContain("beginTerminalCreditSnapshotOperation");
    expect(source).toContain("creditOperationRevisionAtRequestStart");
    expect(source.match(/shouldCommitCreditOperationResponse\(/gu)).toHaveLength(
      4,
    );
  });

  it("advances the conversation observation fence before newer Run observations commit", async () => {
    const source = await workspaceSource();
    const subscription = callbackSource(
      source,
      "const ensureRunSubscription = useCallback",
      "const loadConversation = useCallback",
    );
    const terminalRefresh = callbackSource(
      source,
      "const refreshAfterRun = useCallback",
      "const stopRunSubscriptionForRoleChange = useCallback",
    );
    const cancellation = callbackSource(
      source,
      "const handleCancelRun = useCallback",
      "const handleRetryRun = useCallback",
    );

    const observedEventIndex = subscription.indexOf("eventBuffer.observe(");
    const statusDecisionIndex = subscription.indexOf(
      "statusEventAdvancesConversationObservation({",
    );
    const statusRevisionIndex = subscription.indexOf(
      "advanceConversationObservationRevision(conversationId)",
    );
    const statusCommitIndex = subscription.indexOf(
      "setBootstrap((current) => {",
      statusRevisionIndex,
    );
    expect(observedEventIndex).toBeGreaterThan(0);
    expect(statusDecisionIndex).toBeGreaterThan(observedEventIndex);
    expect(statusRevisionIndex).toBeGreaterThan(statusDecisionIndex);
    expect(statusRevisionIndex).toBeLessThan(statusCommitIndex);

    const terminalBranchIndex = subscription.indexOf(
      'event.payload.type === "done" ||',
    );
    const terminalRevisionIndex = subscription.indexOf(
      "advanceConversationObservationRevision(conversationId)",
      statusRevisionIndex + 1,
    );
    const terminalCommitIndex = subscription.indexOf(
      "markCurrentRunSubscriptionTerminalEvent({",
    );
    expect(terminalRevisionIndex).toBeGreaterThan(terminalBranchIndex);
    expect(terminalRevisionIndex).toBeLessThan(terminalCommitIndex);

    const refreshFenceIndex = terminalRefresh.indexOf(
      "conversationObservationRevision(conversationId) !==",
    );
    const refreshRevisionIndex = terminalRefresh.indexOf(
      "advanceConversationObservationRevision(conversationId)",
    );
    const refreshCommitIndex = terminalRefresh.indexOf(
      'type: "load_succeeded"',
    );
    expect(refreshFenceIndex).toBeGreaterThan(0);
    expect(refreshRevisionIndex).toBeGreaterThan(refreshFenceIndex);
    expect(refreshRevisionIndex).toBeLessThan(refreshCommitIndex);

    expect(
      cancellation.indexOf(
        "advanceConversationObservationRevision(conversationId)",
      ),
    ).toBeLessThan(cancellation.indexOf('type: "run_updated"'));

    const cancelRequestIndex = cancellation.indexOf("await cancelRun(runId)");
    const cancelIdentityCheckIndex = cancellation.indexOf(
      "response.run.id !== runId",
    );
    const cancelResponseFenceIndex = cancellation.indexOf(
      "shouldCommitCancelRunResponse({",
    );
    const cancelRevisionCaptureIndex = cancellation.indexOf(
      "const observationRevisionAtRequestStart =",
    );
    const cancelRevisionCommitIndex = cancellation.indexOf(
      "advanceConversationObservationRevision(conversationId)",
    );
    expect(cancelRevisionCaptureIndex).toBeGreaterThan(0);
    expect(cancelRevisionCaptureIndex).toBeLessThan(cancelRequestIndex);
    expect(cancelIdentityCheckIndex).toBeGreaterThan(cancelRequestIndex);
    expect(cancelIdentityCheckIndex).toBeLessThan(cancelResponseFenceIndex);
    expect(cancelResponseFenceIndex).toBeLessThan(cancelRevisionCommitIndex);
  });

  it("releases a terminal SSE slot before detached read and refresh follow-up", async () => {
    const source = await workspaceSource();
    const subscription = callbackSource(
      source,
      "const ensureRunSubscription = useCallback",
      "const loadConversation = useCallback",
    );
    const followUp = callbackSource(
      source,
      "const scheduleRunTerminalFollowUp = useCallback",
      "const stopRunSubscriptionForRoleChange = useCallback",
    );
    const terminalBranchIndex = subscription.indexOf(
      'event.payload.type === "done" ||',
    );
    const terminalFlushIndex = subscription.indexOf(
      "eventBuffer.flush()",
      terminalBranchIndex,
    );
    const releaseIndex = subscription.indexOf(
      "releaseCurrentTerminalRunSubscription({",
      terminalBranchIndex,
    );
    const scheduleIndex = subscription.indexOf(
      "scheduleRunTerminalFollowUp({",
      terminalBranchIndex,
    );

    expect(terminalBranchIndex).toBeGreaterThan(0);
    expect(terminalFlushIndex).toBeGreaterThan(terminalBranchIndex);
    expect(releaseIndex).toBeGreaterThan(terminalFlushIndex);
    expect(scheduleIndex).toBeGreaterThan(releaseIndex);
    expect(subscription).not.toContain(
      "await markConversationRead(conversationId, runId, event.id)",
    );
    expect(followUp.indexOf("runTerminalFollowUpsRef.current.set")).toBeLessThan(
      followUp.indexOf("await markConversationRead("),
    );
    expect(followUp).toContain("controller.signal");
    expect(followUp).toContain("await refreshAfterRun(");

    expect(source).toContain(
      "for (const followUp of runTerminalFollowUps.values())",
    );
    expect(source).toContain("runTerminalFollowUps.clear()");
    expect(source).toContain(
      "for (const [runId, followUp] of runTerminalFollowUpsRef.current)",
    );
  });

  it("keeps pre-bootstrap invalidation dirty and schedules it after initialization", async () => {
    const source = await workspaceSource();
    const scheduler = callbackSource(
      source,
      "const scheduleBootstrapRevalidation = useCallback",
      "const finishCreditMutation = useCallback",
    );

    expect(scheduler).toContain("planBootstrapRevalidationRequest");
    expect(scheduler).toContain(
      "bootstrapIsReady: bootstrapRef.current !== null",
    );
    expect(source).toContain(
      "bootstrapRevalidationQueueStateRef.current.requested",
    );
    expect(source).toContain(
      "[bootstrapIsReady, scheduleBootstrapRevalidation]",
    );
  });
});
