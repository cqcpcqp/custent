import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AttachmentDraftRecoveryNotice } from "@/components/attachment-draft-recovery-notice";

describe("attachment draft recovery notice", () => {
  it("announces restoration without exposing destructive controls", () => {
    const markup = renderToStaticMarkup(
      <AttachmentDraftRecoveryNotice
        message="正在确认已上传的附件草稿…"
        phase="restoring"
      />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("正在确认已上传的附件草稿…");
    expect(markup).not.toContain("重新恢复");
    expect(markup).not.toContain("放弃这些附件");
  });

  it("keeps retry and explicit discard available after a recoverable failure", () => {
    const markup = renderToStaticMarkup(
      <AttachmentDraftRecoveryNotice
        message="有 2 个附件暂时无法确认。"
        onDiscard={() => undefined}
        onRetry={() => undefined}
        phase="failed"
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain("有 2 个附件暂时无法确认。");
    expect(markup).toContain("重新恢复");
    expect(markup).toContain("放弃这些附件");
  });
});
