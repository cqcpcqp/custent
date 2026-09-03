import {
  isApiAbortError,
  userFacingRequestErrorMessage,
} from "@/components/api-client";
import type {
  ConversationShareListItem,
  ListConversationSharesResponse,
} from "@/lib/contracts";

export const sharedLinksPageSize = 30;

export type SharedLinksPageRequest = Readonly<{
  cursor: string | null;
  limit: number;
}>;

export type SharedLinksResultSurface =
  | "loading"
  | "failure"
  | "empty"
  | "results";

const sharedLinkDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function sharedLinksInitialPageRequest(): SharedLinksPageRequest {
  return { cursor: null, limit: sharedLinksPageSize };
}

export function sharedLinksNextPageRequest(
  cursor: string,
): SharedLinksPageRequest {
  if (cursor.length === 0) {
    throw new TypeError("共享链接分页 cursor 不能为空字符串");
  }
  return { cursor, limit: sharedLinksPageSize };
}

export function sharedLinksMergePage(
  current: readonly ConversationShareListItem[],
  incoming: readonly ConversationShareListItem[],
): ConversationShareListItem[] {
  const seenPublicIds = new Set(current.map((item) => item.publicId));
  const merged = [...current];
  for (const item of incoming) {
    if (seenPublicIds.has(item.publicId)) {
      throw new Error(`共享链接分页返回了重复链接 ${item.publicId}`);
    }
    seenPublicIds.add(item.publicId);
    merged.push(item);
  }
  return merged;
}

export function sharedLinksMergeContinuation(
  current: ListConversationSharesResponse,
  requestedCursor: string,
  incoming: ListConversationSharesResponse,
): ListConversationSharesResponse {
  if (current.nextCursor !== requestedCursor) {
    return current;
  }
  return {
    ...incoming,
    items: sharedLinksMergePage(current.items, incoming.items),
  };
}

export function sharedLinksWithoutRevokedItem(
  items: readonly ConversationShareListItem[],
  publicId: string,
): ConversationShareListItem[] {
  const remaining = items.filter((item) => item.publicId !== publicId);
  if (remaining.length !== items.length - 1) {
    throw new Error(`待移除的共享链接 ${publicId} 不在当前列表中`);
  }
  return remaining;
}

export function sharedLinksResultSurface(input: {
  isLoading: boolean;
  loadError: string | null;
  itemCount: number;
  hasNextPage: boolean;
}): SharedLinksResultSurface {
  if (input.isLoading || (input.itemCount === 0 && input.hasNextPage)) {
    return "loading";
  }
  if (input.loadError !== null) {
    return "failure";
  }
  return input.itemCount === 0 ? "empty" : "results";
}

export function formatSharedLinkDate(value: string): string {
  return sharedLinkDateFormatter.format(new Date(value));
}

export function sharedLinksErrorMessage(error: unknown): string {
  return userFacingRequestErrorMessage(
    error,
    "共享链接请求暂时失败，请重试。",
  );
}

export function sharedLinksIsAbortError(error: unknown): boolean {
  return isApiAbortError(error);
}
