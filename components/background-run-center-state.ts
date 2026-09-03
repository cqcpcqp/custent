import {
  ApiClientError,
  ApiNetworkError,
} from "@/components/api-client";
import type {
  AgentRun,
  BackgroundRunHistoryItem,
  BackgroundRunHistoryResponse,
  BackgroundRunHistoryStatusFilter,
  ConversationSummary,
} from "@/lib/contracts";

export const backgroundRunHistoryPageSize = 20;

export type BackgroundRunHistoryPageRequest = Readonly<{
  status: BackgroundRunHistoryStatusFilter;
  cursor: string | null;
  limit: number;
}>;

export type BackgroundRunHistoryResultSurface =
  | "loading"
  | "failure"
  | "empty"
  | "results";

export const backgroundRunHistoryStatusFilters = [
  { value: "all", label: "全部" },
  { value: "completed", label: "已完成" },
  { value: "failed", label: "失败" },
  { value: "cancelled", label: "已停止" },
  { value: "reconciliation_required", label: "待对账" },
] as const satisfies ReadonlyArray<{
  value: BackgroundRunHistoryStatusFilter;
  label: string;
}>;

const backgroundRunHistoryDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export type BackgroundRunCenterActiveStatus = Extract<
  AgentRun["status"],
  "queued" | "running"
>;

export type BackgroundRunCenterTerminalStatus = Extract<
  AgentRun["status"],
  "completed" | "failed" | "cancelled" | "reconciliation_required"
>;

type BackgroundRunCenterItemBase = Readonly<{
  conversationId: ConversationSummary["id"];
  conversationTitle: ConversationSummary["title"];
  conversationUpdatedAt: ConversationSummary["updatedAt"];
}>;

export type BackgroundRunCenterActiveItem =
  BackgroundRunCenterItemBase &
    Readonly<{
      id: `active:${string}:${string}`;
      kind: "active";
      runId: AgentRun["id"];
      status: BackgroundRunCenterActiveStatus;
      startedAt: AgentRun["startedAt"];
    }>;

export type BackgroundRunCenterWaitingItem =
  BackgroundRunCenterItemBase &
    Readonly<{
      id: `waiting:${string}`;
      kind: "waiting";
      status: "waiting";
      waitingRunCount: ConversationSummary["waitingRunCount"];
    }>;

export type BackgroundRunCenterAttentionItem =
  BackgroundRunCenterItemBase &
    Readonly<{
      id: `attention:${string}:${string}:${string}`;
      kind: "attention";
      runId: AgentRun["id"];
      status: BackgroundRunCenterTerminalStatus;
      terminalEventId: NonNullable<
        ConversationSummary["attention"]
      >["terminalEventId"];
      finishedAt: NonNullable<AgentRun["finishedAt"]>;
    }>;

export type BackgroundRunCenterItem =
  | BackgroundRunCenterActiveItem
  | BackgroundRunCenterWaitingItem
  | BackgroundRunCenterAttentionItem;

export type BackgroundRunCenterSelection = Readonly<{
  conversationId: ConversationSummary["id"];
  activityRunId: AgentRun["id"] | null;
}>;

export type BackgroundRunHistorySelection = Readonly<{
  conversationId: ConversationSummary["id"];
  activityRunId: AgentRun["id"];
}>;

export function backgroundRunHistoryInitialPageRequest(
  status: BackgroundRunHistoryStatusFilter,
): BackgroundRunHistoryPageRequest {
  return { status, cursor: null, limit: backgroundRunHistoryPageSize };
}

export function backgroundRunHistoryNextPageRequest(
  status: BackgroundRunHistoryStatusFilter,
  cursor: string,
): BackgroundRunHistoryPageRequest {
  if (cursor.length === 0) {
    throw new TypeError("后台任务历史分页 cursor 不能为空字符串");
  }
  return { status, cursor, limit: backgroundRunHistoryPageSize };
}

export function backgroundRunHistoryMergePage(
  current: readonly BackgroundRunHistoryItem[],
  incoming: readonly BackgroundRunHistoryItem[],
): BackgroundRunHistoryItem[] {
  const seenRunIds = new Set(current.map((item) => item.runId));
  const merged = [...current];
  for (const item of incoming) {
    if (seenRunIds.has(item.runId)) {
      throw new Error(`后台任务历史分页返回了重复 Run ${item.runId}`);
    }
    seenRunIds.add(item.runId);
    merged.push(item);
  }
  return merged;
}

export function backgroundRunHistoryWithoutCenterRuns(
  history: readonly BackgroundRunHistoryItem[],
  centerItems: readonly BackgroundRunCenterItem[],
): BackgroundRunHistoryItem[] {
  const centerRunIds = new Set(
    centerItems
      .filter((item) => item.kind !== "waiting")
      .map((item) => item.runId),
  );
  return history.filter((item) => !centerRunIds.has(item.runId));
}

export async function loadBackgroundRunHistoryUntilVisible(input: {
  currentItems: readonly BackgroundRunHistoryItem[];
  cursor: string | null;
  centerItems: readonly BackgroundRunCenterItem[];
  loadPage: (
    cursor: string | null,
  ) => Promise<BackgroundRunHistoryResponse>;
}): Promise<BackgroundRunHistoryResponse> {
  let items = [...input.currentItems];
  let cursor = input.cursor;

  while (true) {
    const page = await input.loadPage(cursor);
    items = backgroundRunHistoryMergePage(items, page.items);
    if (
      page.nextCursor === null ||
      backgroundRunHistoryWithoutCenterRuns(items, input.centerItems).length > 0
    ) {
      return { items, nextCursor: page.nextCursor };
    }
    cursor = page.nextCursor;
  }
}

export function backgroundRunHistoryResultSurface(input: {
  isLoading: boolean;
  loadError: string | null;
  itemCount: number;
}): BackgroundRunHistoryResultSurface {
  if (input.isLoading) {
    return "loading";
  }
  if (input.loadError !== null) {
    return "failure";
  }
  return input.itemCount === 0 ? "empty" : "results";
}

export function formatBackgroundRunHistoryDate(value: string): string {
  return backgroundRunHistoryDateFormatter.format(new Date(value));
}

export function backgroundRunHistoryErrorMessage(error: unknown): string {
  if (error instanceof ApiNetworkError) {
    return "网络连接失败，请检查网络后重试。";
  }
  if (error instanceof ApiClientError) {
    if (error.code === "INVALID_REQUEST" && error.status === 400) {
      return "最近完成任务的请求状态已失效，请重新加载。";
    }
    if (error.code === "INTERNAL_ERROR" && error.status === 500) {
      return "任务历史服务暂时不可用，请稍后重试。";
    }
  }
  return "暂时无法加载最近完成任务，请重试。";
}

export function backgroundRunHistoryIsAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

const kindPriority = {
  active: 0,
  waiting: 1,
  attention: 2,
} as const satisfies Record<BackgroundRunCenterItem["kind"], number>;

function sameActiveRun(
  left: ConversationSummary["activeRun"],
  right: ConversationSummary["activeRun"],
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.id === right.id &&
    left.status === right.status &&
    left.startedAt === right.startedAt
  );
}

function sameAttention(
  left: ConversationSummary["attention"],
  right: ConversationSummary["attention"],
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.terminalEventId === right.terminalEventId &&
    left.runId === right.runId &&
    left.status === right.status &&
    left.finishedAt === right.finishedAt
  );
}

function sameConversationSummary(
  left: ConversationSummary,
  right: ConversationSummary,
): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.updatedAt === right.updatedAt &&
    left.pinnedAt === right.pinnedAt &&
    left.archivedAt === right.archivedAt &&
    left.selectedRunId === right.selectedRunId &&
    left.waitingRunCount === right.waitingRunCount &&
    sameActiveRun(left.activeRun, right.activeRun) &&
    sameAttention(left.attention, right.attention)
  );
}

function uniqueConversationSummaries(
  conversations: readonly ConversationSummary[],
): ConversationSummary[] {
  const summariesById = new Map<string, ConversationSummary>();

  for (const conversation of conversations) {
    const existing = summariesById.get(conversation.id);
    if (existing === undefined) {
      summariesById.set(conversation.id, conversation);
      continue;
    }
    if (!sameConversationSummary(existing, conversation)) {
      throw new Error(`后台运行中心收到冲突的会话摘要 ${conversation.id}`);
    }
  }

  return [...summariesById.values()];
}

function itemBase(
  conversation: ConversationSummary,
): BackgroundRunCenterItemBase {
  return {
    conversationId: conversation.id,
    conversationTitle: conversation.title,
    conversationUpdatedAt: conversation.updatedAt,
  };
}

function compareBackgroundRunCenterItems(
  left: BackgroundRunCenterItem,
  right: BackgroundRunCenterItem,
): number {
  const priorityOrder = kindPriority[left.kind] - kindPriority[right.kind];
  if (priorityOrder !== 0) {
    return priorityOrder;
  }

  const updatedOrder = right.conversationUpdatedAt.localeCompare(
    left.conversationUpdatedAt,
  );
  if (updatedOrder !== 0) {
    return updatedOrder;
  }

  const conversationOrder = left.conversationId.localeCompare(
    right.conversationId,
  );
  return conversationOrder === 0
    ? left.id.localeCompare(right.id)
    : conversationOrder;
}

export function backgroundRunCenterItems(
  conversations: readonly ConversationSummary[],
): BackgroundRunCenterItem[] {
  const items: BackgroundRunCenterItem[] = [];

  for (const conversation of uniqueConversationSummaries(conversations)) {
    const base = itemBase(conversation);
    const activeRun = conversation.activeRun;
    if (activeRun !== null) {
      items.push({
        ...base,
        id: `active:${conversation.id}:${activeRun.id}`,
        kind: "active",
        runId: activeRun.id,
        status: activeRun.status,
        startedAt: activeRun.startedAt,
      });
    }

    if (conversation.waitingRunCount > 0) {
      items.push({
        ...base,
        id: `waiting:${conversation.id}`,
        kind: "waiting",
        status: "waiting",
        waitingRunCount: conversation.waitingRunCount,
      });
    }

    const attention = conversation.attention;
    if (attention !== null) {
      items.push({
        ...base,
        id: `attention:${conversation.id}:${attention.runId}:${attention.terminalEventId}`,
        kind: "attention",
        runId: attention.runId,
        status: attention.status,
        terminalEventId: attention.terminalEventId,
        finishedAt: attention.finishedAt,
      });
    }
  }

  return items.sort(compareBackgroundRunCenterItems);
}

export function backgroundRunCenterSelection(
  item: BackgroundRunCenterItem,
): BackgroundRunCenterSelection {
  return {
    conversationId: item.conversationId,
    activityRunId: item.kind === "waiting" ? null : item.runId,
  };
}

export function backgroundRunHistorySelection(
  item: BackgroundRunHistoryItem,
): BackgroundRunHistorySelection {
  return {
    conversationId: item.conversationId,
    activityRunId: item.runId,
  };
}
