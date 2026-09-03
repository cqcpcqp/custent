import { describe, expect, it, vi } from "vitest";

import { copyMessageContent } from "@/components/message-copy";

describe("copyMessageContent", () => {
  it("把原始 message.content 原样写入 Clipboard API", async () => {
    const writeText = vi.fn(async () => undefined);
    const content = "## 买家名单\n\n- **Example GmbH**\n";

    await expect(copyMessageContent(content, { writeText })).resolves.toEqual({
      status: "copied",
      message: "已复制",
    });
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(content);
  });

  it("Clipboard API 不可用时返回明确错误且不使用兼容 fallback", async () => {
    await expect(copyMessageContent("回答", null)).resolves.toEqual({
      status: "error",
      message: "当前环境无法访问剪贴板。",
    });
  });

  it("剪贴板拒绝写入时返回可展示的失败信息", async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });

    await expect(copyMessageContent("回答", { writeText })).resolves.toEqual({
      status: "error",
      message: "复制失败，请检查剪贴板权限后重试。",
    });
  });
});
