import { describe, expect, it, vi } from "vitest";

import {
  conversationMessageIsSearchTarget,
  conversationSearchTargetFromSelection,
  revealConversationSearchTarget,
} from "@/components/conversation-search-target";
import type { ConversationBrowserSelection } from "@/components/conversation-browser-dialog";

const conversationId = "10000000-0000-4000-8000-000000000001";
const messageId = "20000000-0000-4000-8000-000000000001";

const conversation = {
  id: conversationId,
  title: "德国泵类买家",
  updatedAt: "2026-08-27T08:00:00.000Z",
  pinnedAt: null,
  archivedAt: null,
  selectedRunId: null,
  activeRun: null,
  waitingRunCount: 0,
  attention: null,
};

describe("conversation search target", () => {
  it("creates a target only for an exact message search match", () => {
    const messageSelection: ConversationBrowserSelection = {
      conversation,
      searchMatch: {
        kind: "message",
        messageId,
        role: "assistant",
        createdAt: "2026-08-27T07:59:00.000Z",
        excerpt: {
          before: "德国 ",
          match: "泵类",
          after: " 买家",
          beforeTruncated: false,
          afterTruncated: false,
        },
      },
    };

    expect(conversationSearchTargetFromSelection(messageSelection, 7)).toEqual({
      conversationId,
      messageId,
      requestId: 7,
    });
    expect(
      conversationSearchTargetFromSelection(
        {
          conversation,
          searchMatch: {
            kind: "title",
            excerpt: {
              before: "德国 ",
              match: "泵类",
              after: " 买家",
              beforeTruncated: false,
              afterTruncated: false,
            },
          },
        },
        8,
      ),
    ).toBeNull();
  });

  it("matches both conversation and message identity", () => {
    const target = { conversationId, messageId, requestId: 1 };

    expect(
      conversationMessageIsSearchTarget(target, conversationId, messageId),
    ).toBe(true);
    expect(
      conversationMessageIsSearchTarget(
        target,
        "10000000-0000-4000-8000-000000000002",
        messageId,
      ),
    ).toBe(false);
    expect(
      conversationMessageIsSearchTarget(
        target,
        conversationId,
        "20000000-0000-4000-8000-000000000002",
      ),
    ).toBe(false);
    expect(
      conversationMessageIsSearchTarget(null, conversationId, messageId),
    ).toBe(false);
  });

  it("scrolls the rendered message below the header and waits if it is not rendered", () => {
    const scrollIntoView = vi.fn();
    const querySelector = vi.fn(
      () => ({ scrollIntoView }) as unknown as HTMLElement,
    );
    const target = { conversationId, messageId, requestId: 1 };

    expect(
      revealConversationSearchTarget(
        { querySelector } as Pick<HTMLElement, "querySelector">,
        target,
        "smooth",
      ),
    ).toBe(true);
    expect(querySelector).toHaveBeenCalledWith(
      `[data-message-id="${messageId}"]`,
    );
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });

    expect(
      revealConversationSearchTarget(
        { querySelector: vi.fn(() => null) } as Pick<
          HTMLElement,
          "querySelector"
        >,
        target,
        "auto",
      ),
    ).toBe(false);
  });
});
