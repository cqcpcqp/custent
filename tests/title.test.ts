import { describe, expect, it } from "vitest";

import { deriveConversationTitle } from "@/lib/chat/title";

describe("deriveConversationTitle", () => {
  it("normalizes whitespace", () => {
    expect(deriveConversationTitle("  德国   工业阀门\n经销商  ")).toBe(
      "德国 工业阀门 经销商",
    );
  });

  it("truncates by Unicode code point", () => {
    const title = deriveConversationTitle("帮我寻找三十家德国工业阀门经销商并核验他们是否经营高压球阀产品");
    expect(Array.from(title).length).toBe(29);
    expect(title.endsWith("…")).toBe(true);
  });
});
