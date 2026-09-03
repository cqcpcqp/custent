import type {
  ActiveRunSummary,
  AgentRunStatus,
  ConversationSummary,
} from "@/lib/contracts";

export const conversationRecencyGroups = [
  { key: "today", label: "今天" },
  { key: "yesterday", label: "昨天" },
  { key: "previous_7_days", label: "过去 7 天" },
  { key: "previous_30_days", label: "过去 30 天" },
  { key: "older", label: "更早" },
] as const;

export type ConversationRecencyGroupKey =
  (typeof conversationRecencyGroups)[number]["key"];

export type ConversationRecencyGroup = {
  key: ConversationRecencyGroupKey;
  label: (typeof conversationRecencyGroups)[number]["label"];
  conversations: ConversationSummary[];
};

const millisecondsPerDay = 24 * 60 * 60 * 1_000;

function localCalendarDayOrdinal(value: Date): number {
  return Math.floor(
    Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) /
      millisecondsPerDay,
  );
}

export function conversationRecencyGroupKey(
  updatedAt: string,
  now: Date,
): ConversationRecencyGroupKey {
  const calendarDaysAgo =
    localCalendarDayOrdinal(now) -
    localCalendarDayOrdinal(new Date(updatedAt));

  if (calendarDaysAgo <= 0) {
    return "today";
  }
  if (calendarDaysAgo === 1) {
    return "yesterday";
  }
  if (calendarDaysAgo <= 7) {
    return "previous_7_days";
  }
  if (calendarDaysAgo <= 30) {
    return "previous_30_days";
  }
  return "older";
}

export function groupConversationSummariesByRecency(
  conversations: ConversationSummary[],
  now: Date,
): ConversationRecencyGroup[] {
  const conversationsByGroup: Record<
    ConversationRecencyGroupKey,
    ConversationSummary[]
  > = {
    today: [],
    yesterday: [],
    previous_7_days: [],
    previous_30_days: [],
    older: [],
  };

  for (const conversation of conversations) {
    conversationsByGroup[
      conversationRecencyGroupKey(conversation.updatedAt, now)
    ].push(conversation);
  }

  return conversationRecencyGroups.flatMap(({ key, label }) => {
    const groupedConversations = conversationsByGroup[key];
    return groupedConversations.length === 0
      ? []
      : [{ key, label, conversations: groupedConversations }];
  });
}

export function conversationOutstandingRunStatus(
  conversation: ConversationSummary,
): ActiveRunSummary["status"] | "waiting" | null {
  if (conversation.activeRun !== null) {
    return conversation.activeRun.status;
  }
  return conversation.waitingRunCount > 0 ? "waiting" : null;
}

export function conversationSidebarRunStatus(
  conversation: ConversationSummary,
): AgentRunStatus | null {
  return (
    conversationOutstandingRunStatus(conversation) ??
    conversation.attention?.status ??
    null
  );
}

export function conversationHasOutstandingRuns(
  conversation: ConversationSummary,
): boolean {
  return conversationOutstandingRunStatus(conversation) !== null;
}

export function compareConversationSummaries(
  left: ConversationSummary,
  right: ConversationSummary,
): number {
  if (left.pinnedAt !== right.pinnedAt) {
    if (left.pinnedAt === null) {
      return 1;
    }
    if (right.pinnedAt === null) {
      return -1;
    }
    return right.pinnedAt.localeCompare(left.pinnedAt);
  }

  const updatedOrder = right.updatedAt.localeCompare(left.updatedAt);
  return updatedOrder === 0 ? right.id.localeCompare(left.id) : updatedOrder;
}

export function sortConversationSummaries(
  conversations: ConversationSummary[],
): ConversationSummary[] {
  return [...conversations].sort(compareConversationSummaries);
}

export function upsertConversationSummary(
  conversations: ConversationSummary[],
  conversation: ConversationSummary,
): ConversationSummary[] {
  const withoutConversation = conversations.filter(
    (item) => item.id !== conversation.id,
  );
  return sortConversationSummaries([...withoutConversation, conversation]);
}

export function removeConversationSummary(
  conversations: ConversationSummary[],
  conversationId: string,
): ConversationSummary[] {
  return conversations.filter((conversation) => conversation.id !== conversationId);
}

export function removeConversationFromSummarySources(
  sources: {
    conversations: ConversationSummary[];
    trackedConversations: ConversationSummary[];
  },
  conversationId: string,
): {
  conversations: ConversationSummary[];
  trackedConversations: ConversationSummary[];
} {
  return {
    conversations: removeConversationSummary(
      sources.conversations,
      conversationId,
    ),
    trackedConversations: removeConversationSummary(
      sources.trackedConversations,
      conversationId,
    ),
  };
}

export function removeConversationAndSelectNext(
  conversations: ConversationSummary[],
  conversationId: string,
): { conversations: ConversationSummary[]; nextConversationId: string | null } {
  const removedIndex = conversations.findIndex(
    (conversation) => conversation.id === conversationId,
  );
  const remaining = removeConversationSummary(conversations, conversationId);
  if (removedIndex === -1) {
    return { conversations: remaining, nextConversationId: null };
  }

  return {
    conversations: remaining,
    nextConversationId:
      remaining[removedIndex]?.id ?? remaining[removedIndex - 1]?.id ?? null,
  };
}

export function nextConversationIdAfterRemoteRemoval(input: {
  previousConversations: ConversationSummary[];
  currentConversations: ConversationSummary[];
  removedConversationId: string;
}): string | null {
  const adjacentConversationId = removeConversationAndSelectNext(
    input.previousConversations,
    input.removedConversationId,
  ).nextConversationId;
  if (
    adjacentConversationId !== null &&
    input.currentConversations.some(
      (conversation) => conversation.id === adjacentConversationId,
    )
  ) {
    return adjacentConversationId;
  }
  return input.currentConversations[0]?.id ?? null;
}

export function mergeConversationPage(
  current: ConversationSummary[],
  incoming: ConversationSummary[],
): ConversationSummary[] {
  const incomingById = new Map(incoming.map((conversation) => [conversation.id, conversation]));
  const merged = current.map(
    (conversation) => incomingById.get(conversation.id) ?? conversation,
  );
  const currentIds = new Set(current.map((conversation) => conversation.id));
  for (const conversation of incoming) {
    if (!currentIds.has(conversation.id)) {
      merged.push(conversation);
    }
  }
  return merged;
}

function assertNonnegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer`);
  }
}

export function advanceConversationLoadedDepth(
  currentDepth: number,
  receivedItemCount: number,
): number {
  assertNonnegativeSafeInteger(currentDepth, "currentDepth");
  assertNonnegativeSafeInteger(receivedItemCount, "receivedItemCount");
  const nextDepth = currentDepth + receivedItemCount;
  if (!Number.isSafeInteger(nextDepth)) {
    throw new TypeError("conversation loaded depth exceeds safe integer range");
  }
  return nextDepth;
}

export function conversationPageLimitToRestoreDepth(input: {
  targetDepth: number;
  loadedCount: number;
  pageSize: number;
}): number | null {
  assertNonnegativeSafeInteger(input.targetDepth, "targetDepth");
  assertNonnegativeSafeInteger(input.loadedCount, "loadedCount");
  if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1) {
    throw new TypeError("pageSize must be a positive safe integer");
  }
  const remaining = input.targetDepth - input.loadedCount;
  return remaining <= 0 ? null : Math.min(remaining, input.pageSize);
}

export function mergeConversationPageAtRevision(input: {
  current: ConversationSummary[];
  incoming: ConversationSummary[];
  atRequestStart: ConversationSummary[];
  revisionsAtRequestStart: ReadonlyMap<string, number>;
  currentRevisions: ReadonlyMap<string, number>;
}): ConversationSummary[] {
  const currentById = new Map(
    input.current.map((conversation) => [conversation.id, conversation]),
  );
  const atRequestStartById = new Map(
    input.atRequestStart.map((conversation) => [conversation.id, conversation]),
  );
  const mergedById = new Map(currentById);

  for (const conversation of input.incoming) {
    const current = currentById.get(conversation.id);
    const changedSinceRequest =
      (input.currentRevisions.get(conversation.id) ?? 0) !==
        (input.revisionsAtRequestStart.get(conversation.id) ?? 0) ||
      current !== atRequestStartById.get(conversation.id);
    if (changedSinceRequest) {
      continue;
    }
    mergedById.set(conversation.id, conversation);
  }

  return sortConversationSummaries([...mergedById.values()]);
}

export function mergeConversationSummarySources(
  primary: ConversationSummary[],
  secondary: ConversationSummary[],
): ConversationSummary[] {
  const mergedById = new Map(
    secondary.map((conversation) => [conversation.id, conversation]),
  );
  for (const conversation of primary) {
    mergedById.set(conversation.id, conversation);
  }
  return sortConversationSummaries([...mergedById.values()]);
}

export function mergeBootstrapConversationSummaries(input: {
  current: ConversationSummary[];
  incoming: ConversationSummary[];
  atRequestStart: ConversationSummary[];
  revisionsAtRequestStart: ReadonlyMap<string, number>;
  currentRevisions: ReadonlyMap<string, number>;
  preserveIncomingConversationIds: ReadonlySet<string>;
}): ConversationSummary[] {
  const currentById = new Map(
    input.current.map((conversation) => [conversation.id, conversation]),
  );
  const requestById = new Map(
    input.atRequestStart.map((conversation) => [conversation.id, conversation]),
  );
  const incomingIds = new Set(
    input.incoming.map((conversation) => conversation.id),
  );
  const changedSinceRequest = (conversationId: string) =>
    input.preserveIncomingConversationIds.has(conversationId) ||
    (input.currentRevisions.get(conversationId) ?? 0) !==
      (input.revisionsAtRequestStart.get(conversationId) ?? 0) ||
    currentById.get(conversationId) !== requestById.get(conversationId);

  const merged = input.incoming.flatMap((conversation) => {
    if (!changedSinceRequest(conversation.id)) {
      return [conversation];
    }
    const current = currentById.get(conversation.id);
    return current === undefined ? [] : [current];
  });
  for (const conversation of input.current) {
    if (
      !incomingIds.has(conversation.id) &&
      changedSinceRequest(conversation.id)
    ) {
      merged.push(conversation);
    }
  }
  return sortConversationSummaries(merged);
}

export function nextSearchResultIndex(
  currentIndex: number,
  resultCount: number,
  direction: "up" | "down",
): number {
  if (resultCount === 0) {
    return -1;
  }
  if (direction === "down") {
    return currentIndex < 0 ? 0 : Math.min(currentIndex + 1, resultCount - 1);
  }
  return currentIndex < 0
    ? resultCount - 1
    : Math.max(currentIndex - 1, 0);
}
