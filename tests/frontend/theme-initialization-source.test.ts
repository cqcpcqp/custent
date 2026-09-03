import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

async function projectSource(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

describe("pre-hydration theme initialization", () => {
  it("uses Next's pre-interactive root script without a manual head", async () => {
    const layout = await projectSource("app/layout.tsx");

    expect(layout).toContain('import Script from "next/script"');
    expect(layout).toContain("<Script");
    expect(layout).toContain(
      "dangerouslySetInnerHTML={{ __html: themeInitializationScript }}",
    );
    expect(layout).toContain('strategy="beforeInteractive"');
    expect(layout).toContain("suppressHydrationWarning");
    expect(layout).not.toContain("<head>");
    expect(layout).not.toContain("<script");
  });
});
