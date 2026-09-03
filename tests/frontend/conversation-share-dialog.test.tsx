import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ConversationShareDialog,
  ConversationShareReadyContent,
  conversationSharePublicUrl,
  conversationSharePublishDisabledReason,
  copyConversationShareUrl,
  type ConversationShareCopyState,
} from "@/components/conversation-share-dialog";
import type {
  ConversationShareSummary,
  ConversationSummary,
} from "@/lib/contracts";

const conversation: ConversationSummary = {
  id: "10000000-0000-4000-8000-000000000001",
  title: "德国工业泵买家研究",
  updatedAt: "2026-08-28T08:00:00.000Z",
  pinnedAt: null,
  archivedAt: null,
  selectedRunId: "30000000-0000-4000-8000-000000000001",
  activeRun: null,
  waitingRunCount: 0,
  attention: null,
};

const share: ConversationShareSummary = {
  conversationId: conversation.id,
  publicId: "20000000-0000-4000-8000-000000000001",
  publicPath: "/share/20000000-0000-4000-8000-000000000001",
  createdAt: "2026-08-28T08:00:00.000Z",
  updatedAt: "2026-08-28T09:00:00.000Z",
};

const idleCopyState: ConversationShareCopyState = { status: "idle" };

function readyMarkup(input: {
  copyState?: ConversationShareCopyState;
  isConfirmingRevoke?: boolean;
  publishDisabledReason?: string | null;
  share?: ConversationShareSummary | null;
} = {}): string {
  const currentShare = input.share === undefined ? null : input.share;
  return renderToStaticMarkup(
    <ConversationShareReadyContent
      copyState={input.copyState ?? idleCopyState}
      isConfirmingRevoke={input.isConfirmingRevoke ?? false}
      mutation={null}
      notice={null}
      onCancelRevoke={() => undefined}
      onCopy={() => undefined}
      onPublish={() => undefined}
      onRequestRevoke={() => undefined}
      onRevoke={() => undefined}
      operationError={null}
      publicUrl={
        currentShare === null
          ? null
          : `https://example.com${currentShare.publicPath}`
      }
      publishDisabledReason={input.publishDisabledReason ?? null}
      share={currentShare}
    />,
  );
}

describe("conversation share dialog", () => {
  it("renders an accessible modal while loading the current share state", () => {
    const markup = renderToStaticMarkup(
      <ConversationShareDialog
        conversation={conversation}
        onClose={() => undefined}
      />,
    );

    expect(markup).toContain('data-modal-layer=""');
    expect(markup).toContain('id="conversation-share-dialog"');
    expect(markup).toContain('aria-busy="false"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('role="dialog" tabindex="-1"');
    expect(markup).toContain("分享对话");
    expect(markup).toContain("德国工业泵买家研究");
    expect(markup).toContain('role="status"');
    expect(markup).toContain("正在载入分享状态");
  });

  it("offers snapshot creation for a completed non-empty conversation", () => {
    expect(conversationSharePublishDisabledReason(conversation)).toBeNull();

    const markup = readyMarkup();
    expect(markup).toContain("创建只读分享链接");
    expect(markup).toContain("创建分享链接");
    expect(markup).not.toContain("disabled");
  });

  it("blocks empty conversations before the API rejects them", () => {
    const reason = conversationSharePublishDisabledReason({
      ...conversation,
      selectedRunId: null,
    });

    expect(reason).toBe("空对话不能分享。请先完成至少一轮研究。");
    const markup = readyMarkup({ publishDisabledReason: reason });
    expect(markup).toContain('role="status"');
    expect(markup).toContain(reason);
    expect(markup).toContain('disabled=""');
  });

  it("blocks snapshot publication while a run is active", () => {
    const reason = conversationSharePublishDisabledReason({
      ...conversation,
      activeRun: {
        id: "40000000-0000-4000-8000-000000000001",
        status: "running",
        startedAt: "2026-08-28T09:30:00.000Z",
      },
    });

    expect(reason).toBe(
      "研究正在运行或等待中，完成或停止后才能创建或更新分享快照。",
    );
    const markup = readyMarkup({
      publishDisabledReason: reason,
      share,
    });
    expect(markup).toContain(reason);
    expect(markup).toContain("更新快照");
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("撤销链接");
  });

  it("shows the fixed public link, update action, and explicit revoke step", () => {
    const markup = readyMarkup({ share });

    expect(markup).toContain(
      `value="https://example.com${share.publicPath}"`,
    );
    expect(markup).toContain('aria-label="复制分享链接"');
    expect(markup).toContain(`href="${share.publicPath}"`);
    expect(markup).toContain("更新快照");
    expect(markup).toContain("撤销链接");

    const confirmationMarkup = readyMarkup({
      isConfirmingRevoke: true,
      share,
    });
    expect(confirmationMarkup).toContain('role="alert"');
    expect(confirmationMarkup).toContain("撤销这个公开链接？");
    expect(confirmationMarkup).toContain("确认撤销");
  });

  it("builds and copies an absolute link without changing the API path", async () => {
    const writeText = vi.fn(async () => undefined);

    expect(
      conversationSharePublicUrl(share.publicPath, "https://app.example.com"),
    ).toBe(`https://app.example.com${share.publicPath}`);
    await expect(
      copyConversationShareUrl(
        share.publicPath,
        "https://app.example.com",
        { writeText },
      ),
    ).resolves.toEqual({ status: "copied", message: "分享链接已复制" });
    expect(writeText).toHaveBeenCalledWith(
      `https://app.example.com${share.publicPath}`,
    );
  });

  it("reports unavailable clipboard capability for manual copying", async () => {
    await expect(
      copyConversationShareUrl(
        share.publicPath,
        "https://app.example.com",
        null,
      ),
    ).resolves.toEqual({
      status: "error",
      message: "当前浏览器不支持复制，请手动选择链接。",
    });
  });
});
