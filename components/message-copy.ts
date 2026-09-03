export type MessageClipboard = {
  writeText: (content: string) => Promise<void>;
};

export type MessageCopyResult =
  | { status: "copied"; message: "已复制" }
  | { status: "error"; message: string };

export async function copyMessageContent(
  content: string,
  clipboard: MessageClipboard | null,
): Promise<MessageCopyResult> {
  if (clipboard === null) {
    return {
      status: "error",
      message: "当前环境无法访问剪贴板。",
    };
  }

  try {
    await clipboard.writeText(content);
    return { status: "copied", message: "已复制" };
  } catch {
    return {
      status: "error",
      message: "复制失败，请检查剪贴板权限后重试。",
    };
  }
}
