import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

async function workspaceSource(): Promise<string> {
  return readFile(
    path.join(process.cwd(), "components/research-workspace.tsx"),
    "utf8",
  );
}

function section(
  source: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1) {
    throw new Error(`缺少源码边界 ${startMarker} -> ${endMarker}`);
  }
  return source.slice(start, end);
}

describe("message branch workspace integration", () => {
  it("wires the action only into a completed persisted assistant answer", async () => {
    const source = await workspaceSource();
    const assistantRendering = section(
      source,
      "const renderedAttempt = (() =>",
      "const editState =",
    );
    const userRendering = section(
      source,
      "const editState =",
      "<TurnBranchControls",
    );

    expect(source.match(/branchToNewConversation=/gu)).toHaveLength(1);
    expect(assistantRendering).toContain('status === "completed"');
    expect(assistantRendering).toContain("branchToNewConversation={");
    expect(assistantRendering).toContain("attempt.assistantMessage.id");
    expect(userRendering).not.toContain("branchToNewConversation");
  });

  it("isolates pending UI by source conversation and message and reuses an ambiguous request ID", async () => {
    const callback = section(
      await workspaceSource(),
      "const handleBranchToNewConversation = useCallback",
      "const handleOpenLibrary = useCallback",
    );
    const requestIdLookup = callback.indexOf(
      "pendingMessageBranchRequestIdsRef.current.get(requestKey)",
    );
    const requestIdCreation = callback.indexOf("createClientId()", requestIdLookup);
    const requestIdStore = callback.indexOf(
      "pendingMessageBranchRequestIdsRef.current.set(requestKey, requestId)",
    );
    const requestStart = callback.indexOf(
      "await branchConversation(sourceConversationId",
    );

    expect(callback).toContain(
      "messageBranchRequestKey(\n        sourceConversationId,\n        target.messageId",
    );
    expect(requestIdLookup).toBeGreaterThan(0);
    expect(requestIdCreation).toBeGreaterThan(requestIdLookup);
    expect(requestIdStore).toBeGreaterThan(requestIdCreation);
    expect(requestIdStore).toBeLessThan(requestStart);
    expect(callback).toContain("new Set(current).add(requestKey)");
    expect(callback).toContain("next.delete(requestKey)");
    expect(callback).toContain("shouldRetainPendingChatRequest(error)");
  });

  it("loads and validates branch detail before exposing or navigating to it", async () => {
    const callback = section(
      await workspaceSource(),
      "const handleBranchToNewConversation = useCallback",
      "const handleOpenLibrary = useCallback",
    );
    const requestIndex = callback.indexOf("await branchConversation(");
    const loadIndex = callback.indexOf(
      "await loadConversationForStaleParent(",
    );
    const loadedCheckIndex = callback.indexOf(
      'loadResult.status !== "loaded"',
    );
    const detailIndex = callback.indexOf(
      "const branchedConversation = loadResult.detail.conversation",
    );
    const detailIdCheckIndex = callback.indexOf(
      "branchedConversation.id !== branchedConversationId",
    );
    const archivedCheckIndex = callback.indexOf(
      "branchedConversation.archivedAt !== null",
    );
    const requestIdDeleteIndex = callback.indexOf(
      "pendingMessageBranchRequestIdsRef.current.delete(requestKey)",
    );
    const summaryIndex = callback.indexOf(
      "commitConversationSummary(branchedConversation)",
    );
    const crossTabIndex = callback.indexOf("signalWorkspaceBootstrapChanged()");
    const currentRouteIndex = callback.indexOf("const currentRoute = routeRef.current");
    const activateIndex = callback.indexOf(
      "setActiveConversation(branchedConversationId)",
    );
    const navigateIndex = callback.indexOf(
      "navigateToConversation(branchedConversationId)",
    );

    expect(requestIndex).toBeGreaterThan(0);
    expect(loadIndex).toBeGreaterThan(requestIndex);
    expect(loadedCheckIndex).toBeGreaterThan(loadIndex);
    expect(detailIndex).toBeGreaterThan(loadedCheckIndex);
    expect(detailIdCheckIndex).toBeGreaterThan(detailIndex);
    expect(archivedCheckIndex).toBeGreaterThan(detailIdCheckIndex);
    expect(requestIdDeleteIndex).toBeGreaterThan(archivedCheckIndex);
    expect(summaryIndex).toBeGreaterThan(requestIdDeleteIndex);
    expect(crossTabIndex).toBeGreaterThan(summaryIndex);
    expect(currentRouteIndex).toBeGreaterThan(crossTabIndex);
    expect(activateIndex).toBeGreaterThan(currentRouteIndex);
    expect(navigateIndex).toBeGreaterThan(activateIndex);
    expect(callback).toContain("requestComposerFocus()");
    expect(callback).not.toContain("commitConversationSummary(response.conversation)");
    expect(callback).not.toContain("await loadConversation(branchedConversationId)");
    expect(callback).not.toContain(
      'navigateToConversation(branchedConversationId, "replace")',
    );
  });

  it("does not hijack a newer navigation intent and reports failures to the source", async () => {
    const callback = section(
      await workspaceSource(),
      "const handleBranchToNewConversation = useCallback",
      "const handleOpenLibrary = useCallback",
    );

    expect(callback).not.toContain("new AbortController");
    expect(callback).not.toContain("activeConversationIdRef.current !== sourceConversationId");
    expect(callback).toContain(
      "const navigationIntentRevision = navigationIntentRevisionRef.current",
    );
    expect(callback).toContain(
      "navigationIntentRevisionRef.current === navigationIntentRevision",
    );
    expect(callback).toContain(
      "activeConversationIdRef.current === sourceConversationId",
    );
    expect(callback).toContain('currentRoute.kind === "conversation"');
    expect(callback).toContain(
      "currentRoute.conversationId === sourceConversationId",
    );
    expect(callback).toContain('type: "set_error"');
    expect(callback).toContain("conversationId: sourceConversationId");
    expect(callback).toContain(
      "finishConversationMutation(sourceConversationId, mutationOwner)",
    );
  });

  it("advances every internal and browser-history navigation intent synchronously", async () => {
    const source = await workspaceSource();
    const navigation = section(
      source,
      "const advanceNavigationIntentRevision = useCallback",
      "const setRunReplayState = useCallback",
    );
    const advanceIndex = navigation.indexOf("advanceNavigationIntentRevision();");
    const routerIndex = navigation.indexOf("router[method](href, { scroll: false })");
    const libraryNavigation = section(
      source,
      "const handleOpenLibrary = useCallback",
      "const dismissRunCompletion = useCallback",
    );

    expect(advanceIndex).toBeGreaterThan(0);
    expect(routerIndex).toBeGreaterThan(advanceIndex);
    expect(navigation).toContain('window.addEventListener("popstate", handlePopState)');
    expect(navigation).toContain(
      'window.removeEventListener("popstate", handlePopState)',
    );
    expect(navigation).toContain("navigateWithinWorkspace(href, method)");
    expect(libraryNavigation).toContain(
      'navigateWithinWorkspace(libraryRoute("research"))',
    );
    expect(libraryNavigation).toContain(
      "navigateWithinWorkspace(libraryRoute(tab))",
    );
    expect(source.match(/router\.(?:push|replace)\(/gu)).toBeNull();
  });

  it("restores the connected trigger only after pending state has cleared", async () => {
    const source = await workspaceSource();
    const callback = section(
      source,
      "const handleBranchToNewConversation = useCallback",
      "const handleOpenLibrary = useCallback",
    );
    const restorationEffect = section(
      source,
      "useLayoutEffect(() => {\n    for (const [requestKey, trigger] of",
      "useEffect(() => {\n    setCitationSourcesView",
    );
    const rememberIndex = callback.indexOf(
      "pendingMessageBranchFocusRestoresRef.current.set(",
    );
    const pendingClearIndex = callback.indexOf(
      "setBranchingMessageKeys((current) => {",
      rememberIndex,
    );

    expect(rememberIndex).toBeGreaterThan(0);
    expect(pendingClearIndex).toBeGreaterThan(rememberIndex);
    expect(restorationEffect).toContain(
      "if (branchingMessageKeys.has(requestKey))",
    );
    expect(restorationEffect).toContain(
      "pendingMessageBranchFocusRestoresRef.current.delete(requestKey)",
    );
    expect(restorationEffect).toContain("if (trigger.isConnected)");
    expect(restorationEffect).toContain("trigger.focus()");
    expect(restorationEffect).toContain("}, [branchingMessageKeys])");
  });
});
