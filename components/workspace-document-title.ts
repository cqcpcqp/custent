import type { ConversationSummary } from "@/lib/contracts";
import type { WorkspaceSurfaceRoute } from "@/components/conversation-route";

const workspaceProductName = "外贸研究助手";

export type WorkspaceDocumentTitleInput = Readonly<{
  currentTitle: string;
  unreadCount: number;
  activeRunCount: number;
}>;

export type WorkspaceDocumentTitleContext = Readonly<{
  currentTitle: string;
  routeKey: string;
}>;

export function workspaceDocumentTitleContext(
  route: WorkspaceSurfaceRoute,
  activeConversationTitle: string | null,
): WorkspaceDocumentTitleContext {
  if (route.kind === "library") {
    return {
      currentTitle: "资料库",
      routeKey: `library\u0000${route.tab}\u0000${route.snapshotId ?? "index"}`,
    };
  }
  return {
    currentTitle: activeConversationTitle ?? workspaceProductName,
    routeKey: `conversation\u0000${route.conversationId ?? "new"}`,
  };
}

export function workspaceDocumentStatusCounts(
  conversations: readonly ConversationSummary[],
): Pick<WorkspaceDocumentTitleInput, "activeRunCount" | "unreadCount"> {
  let unreadCount = 0;
  let activeRunCount = 0;
  for (const conversation of conversations) {
    if (conversation.attention !== null) {
      unreadCount += 1;
    }
    if (conversation.activeRun !== null) {
      activeRunCount += 1;
    }
    activeRunCount += conversation.waitingRunCount;
  }
  return { unreadCount, activeRunCount };
}

function assertNonnegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label}必须是非负安全整数`);
  }
}

export function workspaceDocumentTitle({
  currentTitle,
  unreadCount,
  activeRunCount,
}: WorkspaceDocumentTitleInput): string {
  if (currentTitle.length === 0) {
    throw new Error("当前标签页标题不能为空");
  }
  assertNonnegativeSafeInteger(unreadCount, "未读数量");
  assertNonnegativeSafeInteger(activeRunCount, "活动运行数量");

  const pageTitle =
    currentTitle === workspaceProductName
      ? workspaceProductName
      : `${currentTitle} · ${workspaceProductName}`;
  const statusParts: string[] = [];
  if (unreadCount > 0) {
    statusParts.push(`${unreadCount} 条新结果`);
  }
  if (activeRunCount > 0) {
    statusParts.push(`${activeRunCount} 项进行中`);
  }

  return statusParts.length === 0
    ? pageTitle
    : `(${statusParts.join(" · ")}) ${pageTitle}`;
}
