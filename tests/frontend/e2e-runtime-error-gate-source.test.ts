import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

async function projectSource(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

describe("production E2E browser error gate", () => {
  it("fails every page on console errors and uncaught exceptions", async () => {
    const fixture = await projectSource("e2e/fixtures/test.ts");

    expect(fixture).toMatch(
      /browserRuntimeErrors: \[\s*async \(\{ context \}, use\) => \{[\s\S]*?const monitoredPages = new Map<[\s\S]*?if \(monitoredPages\.has\(page\)\) \{\s*return;\s*\}[\s\S]*?page\.on\("console", handleConsole\);\s*page\.on\("pageerror", handlePageError\);[\s\S]*?context\.on\("page", handlePage\);\s*for \(const page of context\.pages\(\)\) \{\s*handlePage\(page\);\s*\}\s*await use\(\);\s*context\.off\("page", handlePage\);\s*for \(const \[page, \{ handleConsole, handlePageError \}\] of monitoredPages\) \{\s*page\.off\("console", handleConsole\);\s*page\.off\("pageerror", handlePageError\);\s*\}\s*expect\([\s\S]*?runtimeErrors,[\s\S]*?"E2E pages must not emit console\.error or uncaught page errors",[\s\S]*?\)\.toEqual\(\[\]\);\s*\},\s*\{ auto: true \},\s*\]/u,
    );
    expect(fixture).toContain('message.type() === "error"');
    expect(fixture).toContain("message.page()?.url()");
    expect(fixture).toContain("error.stack?.trim()");
  });
});
