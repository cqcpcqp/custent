import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  workspaceDocumentTitleContext,
  workspaceDocumentStatusCounts,
  workspaceDocumentTitle,
} from "@/components/workspace-document-title";
import type { ConversationSummary } from "@/lib/contracts";

describe("workspace document title", () => {
  it("keeps one Library title while changing the route key for list, detail, and history navigation", () => {
    const libraryList = workspaceDocumentTitleContext(
      { kind: "library", tab: "research", snapshotId: null },
      "不应使用的对话标题",
    );
    const artifactList = workspaceDocumentTitleContext(
      { kind: "library", tab: "artifacts", snapshotId: null },
      "不应使用的对话标题",
    );
    const libraryDetail = workspaceDocumentTitleContext(
      {
        kind: "library",
        tab: "research",
        snapshotId: "20000000-0000-4000-8000-000000000001",
      },
      "不应使用的对话标题",
    );
    const libraryListAfterBack = workspaceDocumentTitleContext(
      { kind: "library", tab: "research", snapshotId: null },
      null,
    );

    expect(libraryList.currentTitle).toBe("资料库");
    expect(libraryDetail.currentTitle).toBe("资料库");
    expect(artifactList.currentTitle).toBe("资料库");
    expect(artifactList.routeKey).not.toBe(libraryList.routeKey);
    expect(libraryDetail.routeKey).not.toBe(libraryList.routeKey);
    expect(libraryListAfterBack.routeKey).toBe(libraryList.routeKey);
    expect(
      workspaceDocumentTitle({
        currentTitle: libraryDetail.currentTitle,
        unreadCount: 2,
        activeRunCount: 1,
      }),
    ).toBe("(2 条新结果 · 1 项进行中) 资料库 · 外贸研究助手");
  });

  it("reruns the title owner for every workspace route identity change", async () => {
    const source = await readFile(
      path.join(process.cwd(), "components/research-workspace.tsx"),
      "utf8",
    );
    const effectStart = source.indexOf(
      "document.title = workspaceDocumentTitle({",
    );
    const effectEnd = source.indexOf(
      "\n\n  if (isBootstrapping",
      effectStart,
    );
    const titleEffect = source.slice(effectStart, effectEnd);

    expect(effectStart).toBeGreaterThan(0);
    expect(effectEnd).toBeGreaterThan(effectStart);
    expect(titleEffect).toContain("documentTitleContext.currentTitle");
    expect(titleEffect).toContain("documentTitleContext.routeKey");
  });

  it("brands the current conversation without duplicating the product name", () => {
    expect(
      workspaceDocumentTitle({
        currentTitle: "德国泵类买家",
        unreadCount: 0,
        activeRunCount: 0,
      }),
    ).toBe("德国泵类买家 · 外贸研究助手");
    expect(
      workspaceDocumentTitle({
        currentTitle: "外贸研究助手",
        unreadCount: 0,
        activeRunCount: 0,
      }),
    ).toBe("外贸研究助手");
  });

  it("shows unread results and active background runs together", () => {
    expect(
      workspaceDocumentTitle({
        currentTitle: "法国经销商",
        unreadCount: 2,
        activeRunCount: 1,
      }),
    ).toBe("(2 条新结果 · 1 项进行中) 法国经销商 · 外贸研究助手");
  });

  it("counts unread conversations, active runs, and every waiting run", () => {
    const conversation = (
      id: string,
      input: Pick<
        ConversationSummary,
        "activeRun" | "attention" | "waitingRunCount"
      >,
    ): ConversationSummary => ({
      id,
      title: id,
      updatedAt: "2026-08-27T08:00:00.000Z",
      pinnedAt: null,
      archivedAt: null,
      selectedRunId: null,
      ...input,
    });

    expect(
      workspaceDocumentStatusCounts([
        conversation("10000000-0000-4000-8000-000000000001", {
          activeRun: {
            id: "20000000-0000-4000-8000-000000000001",
            status: "running",
            startedAt: "2026-08-27T07:59:00.000Z",
          },
          attention: null,
          waitingRunCount: 2,
        }),
        conversation("10000000-0000-4000-8000-000000000002", {
          activeRun: null,
          attention: {
            runId: "20000000-0000-4000-8000-000000000002",
            terminalEventId: "42",
            status: "completed",
            finishedAt: "2026-08-27T08:00:00.000Z",
          },
          waitingRunCount: 1,
        }),
      ]),
    ).toEqual({ unreadCount: 1, activeRunCount: 4 });
  });

  it("omits each zero-valued status independently", () => {
    expect(
      workspaceDocumentTitle({
        currentTitle: "新研究",
        unreadCount: 3,
        activeRunCount: 0,
      }),
    ).toBe("(3 条新结果) 新研究 · 外贸研究助手");
    expect(
      workspaceDocumentTitle({
        currentTitle: "新研究",
        unreadCount: 0,
        activeRunCount: 4,
      }),
    ).toBe("(4 项进行中) 新研究 · 外贸研究助手");
  });

  it("rejects empty titles and invalid counts", () => {
    expect(() =>
      workspaceDocumentTitle({
        currentTitle: "",
        unreadCount: 0,
        activeRunCount: 0,
      }),
    ).toThrow("当前标签页标题不能为空");
    expect(() =>
      workspaceDocumentTitle({
        currentTitle: "新研究",
        unreadCount: -1,
        activeRunCount: 0,
      }),
    ).toThrow("未读数量必须是非负安全整数");
    expect(() =>
      workspaceDocumentTitle({
        currentTitle: "新研究",
        unreadCount: 0,
        activeRunCount: 0.5,
      }),
    ).toThrow("活动运行数量必须是非负安全整数");
  });
});
