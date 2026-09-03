import { describe, expect, it } from "vitest";

import {
  sharedLinksInitialPageRequest,
  sharedLinksMergeContinuation,
  sharedLinksMergePage,
  sharedLinksNextPageRequest,
  sharedLinksResultSurface,
  sharedLinksWithoutRevokedItem,
} from "@/components/shared-links-manager-state";
import type { ConversationShareListItem } from "@/lib/contracts";

const first: ConversationShareListItem = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  publicId: "22222222-2222-4222-8222-222222222222",
  publicPath: "/share/22222222-2222-4222-8222-222222222222",
  title: "German buyers",
  createdAt: "2026-08-29T08:00:00.000Z",
  updatedAt: "2026-08-30T08:00:00.000Z",
};

const second: ConversationShareListItem = {
  conversationId: "33333333-3333-4333-8333-333333333333",
  publicId: "44444444-4444-4444-8444-444444444444",
  publicPath: "/share/44444444-4444-4444-8444-444444444444",
  title: "French distributors",
  createdAt: "2026-08-28T08:00:00.000Z",
  updatedAt: "2026-08-29T08:00:00.000Z",
};

describe("shared links manager state", () => {
  it("uses one fixed page size for initial and continuation requests", () => {
    expect(sharedLinksInitialPageRequest()).toEqual({
      cursor: null,
      limit: 30,
    });
    expect(sharedLinksNextPageRequest("opaque_cursor")).toEqual({
      cursor: "opaque_cursor",
      limit: 30,
    });
    expect(() => sharedLinksNextPageRequest("")).toThrow(
      "共享链接分页 cursor 不能为空字符串",
    );
  });

  it("merges strict pages and rejects duplicate public identities", () => {
    expect(sharedLinksMergePage([first], [second])).toEqual([first, second]);
    expect(() => sharedLinksMergePage([first], [first])).toThrow(
      `共享链接分页返回了重复链接 ${first.publicId}`,
    );
  });

  it("removes exactly one confirmed revocation", () => {
    expect(sharedLinksWithoutRevokedItem([first, second], first.publicId))
      .toEqual([second]);
    expect(() => sharedLinksWithoutRevokedItem([first], second.publicId))
      .toThrow(`待移除的共享链接 ${second.publicId} 不在当前列表中`);
  });

  it("does not revive a revoked item when an older continuation request resolves", () => {
    const requestedCursor = "page_after_first";
    const pageWhenRequested = {
      items: [first],
      nextCursor: requestedCursor,
    };
    const currentAfterRevocation = {
      ...pageWhenRequested,
      items: sharedLinksWithoutRevokedItem(
        pageWhenRequested.items,
        first.publicId,
      ),
    };

    expect(
      sharedLinksMergeContinuation(currentAfterRevocation, requestedCursor, {
        items: [second],
        nextCursor: null,
      }),
    ).toEqual({ items: [second], nextCursor: null });
  });

  it("ignores a continuation response after the current cursor changes", () => {
    const current = { items: [first], nextCursor: "new_cursor" };

    expect(
      sharedLinksMergeContinuation(current, "stale_cursor", {
        items: [second],
        nextCursor: null,
      }),
    ).toBe(current);
  });

  it("does not expose a false empty state while a continuation exists", () => {
    expect(
      sharedLinksResultSurface({
        isLoading: false,
        loadError: null,
        itemCount: 0,
        hasNextPage: true,
      }),
    ).toBe("loading");
    expect(
      sharedLinksResultSurface({
        isLoading: false,
        loadError: null,
        itemCount: 0,
        hasNextPage: false,
      }),
    ).toBe("empty");
    expect(
      sharedLinksResultSurface({
        isLoading: false,
        loadError: "network failed",
        itemCount: 0,
        hasNextPage: false,
      }),
    ).toBe("failure");
  });
});
