import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConversationSidebar } from "@/components/conversation-sidebar";
import type { ConversationSummary } from "@/lib/contracts";

const conversation: ConversationSummary = {
  id: "10000000-0000-4000-8000-000000000001",
  title: "德国泵类买家",
  updatedAt: "2026-08-25T08:00:00.000Z",
  pinnedAt: null,
  archivedAt: null,
  selectedRunId: "20000000-0000-4000-8000-000000000001",
  activeRun: null,
  waitingRunCount: 0,
  attention: {
    terminalEventId: "42",
    runId: "20000000-0000-4000-8000-000000000001",
    status: "completed",
    finishedAt: "2026-08-25T08:02:00.000Z",
  },
};

describe("conversation attention UI", () => {
  it("renders an accessible unread result marker in the sidebar", () => {
    const markup = renderToStaticMarkup(
      <ConversationSidebar
        activeConversationId={null}
        busyConversationIds={new Set()}
        conversations={[conversation]}
        conversationBrowserView={null}
        credits={{ available: 1000, reserved: 0 }}
        isCreating={false}
        isLibraryActive={false}
        isLoadingMore={false}
        isOpen
        loadMoreError={null}
        nextCursor={null}
        onArchiveAllConversations={async () => ({
          conversationCount: 0,
          error: null,
        })}
        onClose={() => undefined}
        onCreate={() => undefined}
        onDeleteAllConversations={async () => ({
          conversationCount: 0,
          error: null,
        })}
        onLoadMore={() => undefined}
        onOpenArchived={() => undefined}
        onOpenKeyboardShortcuts={() => undefined}
        onOpenLibrary={() => undefined}
        onOpenSearch={() => undefined}
        onRequestDelete={() => undefined}
        onRequestRename={() => undefined}
        onRequestShare={() => undefined}
        onSelect={() => undefined}
        onSetArchived={async () => undefined}
        onSetPinned={async () => undefined}
        runStatusByConversation={{ [conversation.id]: "completed" }}
        user={{
          id: "30000000-0000-4000-8000-000000000001",
          name: "测试用户",
        }}
      />,
    );

    expect(markup).toContain('aria-label="有新的运行结果"');
    expect(markup).toContain('aria-label="运行状态：已完成"');
  });

  it("does not render the marker when attention is null", () => {
    const markup = renderToStaticMarkup(
      <ConversationSidebar
        activeConversationId={null}
        busyConversationIds={new Set()}
        conversations={[{ ...conversation, attention: null }]}
        conversationBrowserView={null}
        credits={{ available: 1000, reserved: 0 }}
        isCreating={false}
        isLibraryActive={false}
        isLoadingMore={false}
        isOpen
        loadMoreError={null}
        nextCursor={null}
        onArchiveAllConversations={async () => ({
          conversationCount: 0,
          error: null,
        })}
        onClose={() => undefined}
        onCreate={() => undefined}
        onDeleteAllConversations={async () => ({
          conversationCount: 0,
          error: null,
        })}
        onLoadMore={() => undefined}
        onOpenArchived={() => undefined}
        onOpenKeyboardShortcuts={() => undefined}
        onOpenLibrary={() => undefined}
        onOpenSearch={() => undefined}
        onRequestDelete={() => undefined}
        onRequestRename={() => undefined}
        onRequestShare={() => undefined}
        onSelect={() => undefined}
        onSetArchived={async () => undefined}
        onSetPinned={async () => undefined}
        runStatusByConversation={{ [conversation.id]: null }}
        user={{
          id: "30000000-0000-4000-8000-000000000001",
          name: "测试用户",
        }}
      />,
    );

    expect(markup).not.toContain('aria-label="有新的运行结果"');
    expect(markup).not.toContain('aria-label="运行状态：');
    expect(markup).not.toContain("conversation-run-status");
  });
});
