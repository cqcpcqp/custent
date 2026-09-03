import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import WorkspaceError from "@/app/error";
import GlobalWorkspaceError from "@/app/global-error";

const sensitiveMessage = "postgres://operator:secret@private-host/customer";

async function projectSource(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

describe("workspace route error boundaries", () => {
  it("renders generic, keyboard-operable recovery choices without leaking the error", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceError
        error={new Error(sensitiveMessage)}
        retry={() => undefined}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-labelledby="workspace-error-title"');
    expect(markup).toContain("工作区暂时无法显示");
    expect(markup).toContain('type="button"');
    expect(markup).toContain("重新尝试");
    expect(markup).toContain('href="/"');
    expect(markup).toContain("开始新研究");
    expect(markup).not.toContain(sensitiveMessage);
    expect(markup).not.toContain("private-host");
  });

  it("gives root-layout failures a script-free, system-themed document", () => {
    const markup = renderToStaticMarkup(
      <GlobalWorkspaceError
        error={new Error(sensitiveMessage)}
        retry={() => undefined}
      />,
    );

    expect(markup).toContain('<html data-theme="system"');
    expect(markup).toContain('lang="zh-CN"');
    expect(markup).toContain("<head>");
    expect(markup).toContain("<body");
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain(sensitiveMessage);
  });

  it("uses the Next 16.3 retry contract and logs only for diagnostics", async () => {
    const [routeBoundary, globalBoundary, fallback, fallbackStyles] =
      await Promise.all([
        projectSource("app/error.tsx"),
        projectSource("app/global-error.tsx"),
        projectSource("components/workspace-error-fallback.tsx"),
        projectSource("components/workspace-error-fallback.module.css"),
      ]);

    for (const source of [routeBoundary, globalBoundary]) {
      expect(source).toMatch(/^"use client";/);
      expect(source).toContain("retry: () => void");
      expect(source).toContain("console.error(error)");
      expect(source).toContain("onRetry={retry}");
      expect(source).not.toContain("error.message");
      expect(source).not.toContain("error.stack");
    }

    expect(globalBoundary).toContain("<html");
    expect(globalBoundary).toContain("<body");
    expect(globalBoundary).toContain("useLayoutEffect");
    expect(globalBoundary).toContain("themePreferenceStorageKey");
    expect(globalBoundary).not.toContain("<script");
    expect(globalBoundary).not.toContain("dangerouslySetInnerHTML");
    expect(fallback).toContain("onClick={onRetry}");
    expect(fallbackStyles).toContain(':global(html[data-theme="dark"])');
    expect(fallbackStyles).toContain(
      ':global(html[data-theme="system"])',
    );
    expect(fallbackStyles).toContain("@media (prefers-color-scheme: dark)");
    expect(fallbackStyles).toContain(".actions button:focus-visible");
    expect(fallbackStyles).toContain("@media (max-width: 560px)");
  });
});
