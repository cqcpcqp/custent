import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConversationLoadFailure } from "@/components/conversation-load-failure";

describe("conversation load failure", () => {
  it("renders the failed detail request and an explicit retry action", () => {
    const markup = renderToStaticMarkup(
      <ConversationLoadFailure
        error="网络连接已中断"
        isRetrying={false}
        onRetry={() => undefined}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-busy="false"');
    expect(markup).toContain("暂时无法载入这个会话");
    expect(markup).toContain("网络连接已中断");
    expect(markup).toContain("重新载入");
    expect(markup).not.toContain("disabled");
  });

  it("locks the retry action while a replacement request is running", () => {
    const markup = renderToStaticMarkup(
      <ConversationLoadFailure
        error="网络连接已中断"
        isRetrying
        onRetry={() => undefined}
      />,
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("正在重新载入…");
    expect(markup).toContain("disabled");
  });
});
