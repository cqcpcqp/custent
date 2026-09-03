import { readFile } from "node:fs/promises";
import path from "node:path";

import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BackgroundRunCenterDialog,
  BackgroundRunHistoryView,
  BackgroundRunCenterTrigger,
} from "@/components/background-run-center";
import type { BackgroundRunCenterItem } from "@/components/background-run-center-state";
import type { BackgroundRunHistoryItem } from "@/lib/contracts";

const conversationUpdatedAt = "2026-08-28T08:00:00.000Z";

const items: readonly BackgroundRunCenterItem[] = [
  {
    id: "active:conversation-running:run-running",
    kind: "active",
    conversationId: "conversation-running",
    conversationTitle: "德国泵类买家",
    conversationUpdatedAt,
    runId: "run-running",
    status: "running",
    startedAt: "2026-08-28T07:59:00.000Z",
  },
  {
    id: "active:conversation-queued:run-queued",
    kind: "active",
    conversationId: "conversation-queued",
    conversationTitle: "法国工业经销商",
    conversationUpdatedAt,
    runId: "run-queued",
    status: "queued",
    startedAt: null,
  },
  {
    id: "waiting:conversation-waiting",
    kind: "waiting",
    conversationId: "conversation-waiting",
    conversationTitle: "美国采购经理",
    conversationUpdatedAt,
    status: "waiting",
    waitingRunCount: 3,
  },
  {
    id: "attention:conversation-completed:run-completed:event-completed",
    kind: "attention",
    conversationId: "conversation-completed",
    conversationTitle: "英国进口商",
    conversationUpdatedAt,
    runId: "run-completed",
    status: "completed",
    terminalEventId: "event-completed",
    finishedAt: "2026-08-28T08:00:00.000Z",
  },
  {
    id: "attention:conversation-failed:run-failed:event-failed",
    kind: "attention",
    conversationId: "conversation-failed",
    conversationTitle: "意大利代理商",
    conversationUpdatedAt,
    runId: "run-failed",
    status: "failed",
    terminalEventId: "event-failed",
    finishedAt: "2026-08-28T08:00:00.000Z",
  },
  {
    id: "attention:conversation-cancelled:run-cancelled:event-cancelled",
    kind: "attention",
    conversationId: "conversation-cancelled",
    conversationTitle: "加拿大批发商",
    conversationUpdatedAt,
    runId: "run-cancelled",
    status: "cancelled",
    terminalEventId: "event-cancelled",
    finishedAt: "2026-08-28T08:00:00.000Z",
  },
  {
    id: "attention:conversation-reconciliation:run-reconciliation:event-reconciliation",
    kind: "attention",
    conversationId: "conversation-reconciliation",
    conversationTitle: "澳大利亚采购团队",
    conversationUpdatedAt,
    runId: "run-reconciliation",
    status: "reconciliation_required",
    terminalEventId: "event-reconciliation",
    finishedAt: "2026-08-28T08:00:00.000Z",
  },
];

const historyItems: readonly BackgroundRunHistoryItem[] = [
  {
    runId: "30000000-0000-4000-8000-000000000001",
    conversationId: "40000000-0000-4000-8000-000000000001",
    conversationTitle: "西班牙泵类采购",
    status: "completed",
    finishedAt: "2026-08-28T07:58:00.000Z",
  },
  {
    runId: "30000000-0000-4000-8000-000000000002",
    conversationId: "40000000-0000-4000-8000-000000000002",
    conversationTitle: "荷兰经销商",
    status: "cancelled",
    finishedAt: "2026-08-28T07:50:00.000Z",
  },
];

function renderDialog(
  dialogItems: readonly BackgroundRunCenterItem[] = items,
): string {
  return renderToStaticMarkup(
    <BackgroundRunCenterDialog
      historyRevision={0}
      items={dialogItems}
      onClose={() => undefined}
      onSelect={() => undefined}
      onSelectHistory={() => undefined}
      returnFocusRef={createRef<HTMLButtonElement>()}
    />,
  );
}

describe("background run center dialog", () => {
  it("keeps background tasks separate from the current Run activity control", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const populated = renderToStaticMarkup(
      <BackgroundRunCenterTrigger
        count={12}
        isOpen={true}
        onOpen={() => undefined}
        triggerRef={triggerRef}
      />,
    );
    const empty = renderToStaticMarkup(
      <BackgroundRunCenterTrigger
        count={0}
        isOpen={false}
        onOpen={() => undefined}
        triggerRef={triggerRef}
      />,
    );

    expect(populated).toContain('aria-controls="background-run-center-dialog"');
    expect(populated).toContain('aria-expanded="true"');
    expect(populated).toContain('aria-haspopup="dialog"');
    expect(populated).toContain('aria-label="后台任务，12 项待处理"');
    expect(populated).toContain(">任务<");
    expect(populated).toContain('class="header-run-button__badge"');
    expect(populated).not.toContain("disabled");
    expect(empty).toContain('aria-label="后台任务，当前没有待处理任务"');
    expect(empty).not.toContain("disabled");
    expect(empty).not.toContain('class="header-run-button__badge"');
  });

  it("renders an accessible modal connected to the shared focus contract", () => {
    const markup = renderDialog();

    expect(markup).toContain('data-modal-layer=""');
    expect(markup).toContain(
      'aria-describedby="background-run-center-description" aria-labelledby="background-run-center-title" aria-modal="true"',
    );
    expect(markup).toContain('id="background-run-center-dialog"');
    expect(markup).toContain('role="dialog" tabindex="-1"');
    expect(markup).toContain('aria-label="关闭后台任务"');
    expect(markup).toContain('id="background-run-center-title">后台任务<');
    expect(markup).toContain("查看跨对话继续执行的 Agent 任务");
  });

  it("groups tasks in active, waiting, then attention order", () => {
    const markup = renderDialog();
    const activeHeading = markup.indexOf(">正在处理<");
    const waitingHeading = markup.indexOf(">等待继续<");
    const attentionHeading = markup.indexOf(">需要查看<");

    expect(activeHeading).toBeGreaterThanOrEqual(0);
    expect(waitingHeading).toBeGreaterThan(activeHeading);
    expect(attentionHeading).toBeGreaterThan(waitingHeading);
    expect(markup).toContain('aria-label="正在处理 2 项"');
    expect(markup).toContain('aria-label="等待继续 1 项"');
    expect(markup).toContain('aria-label="需要查看 4 项"');
  });

  it("renders every fixed run status with an explicit task action", () => {
    const markup = renderDialog();

    for (const className of [
      "waiting",
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
      "reconciliation_required",
    ]) {
      expect(markup).toContain(
        `background-run-center__task--${className}`,
      );
    }
    for (const label of [
      "等待中",
      "排队中",
      "运行中",
      "已完成",
      "失败",
      "已停止",
      "待对账",
    ]) {
      expect(markup).toContain(`>${label}<`);
    }
    expect(markup).toContain(
      'aria-label="查看活动“德国泵类买家”，运行中，Agent 正在后台执行"',
    );
    expect(markup).toContain(
      'aria-label="打开对话“美国采购经理”，等待中，3 个任务等待继续"',
    );
    expect(markup).toContain(
      'aria-label="查看活动“英国进口商”，已完成，结果已生成，等待查看"',
    );
    expect(markup.match(/class="background-run-center__task /gu)).toHaveLength(
      items.length,
    );
  });

  it("shows a pending empty state while keeping recent history available", () => {
    const markup = renderDialog([]);

    expect(markup).toContain(
      'class="background-run-center__empty background-run-center__empty--pending"',
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain("当前没有待处理任务");
    expect(markup).not.toContain("background-run-center__group--active");
    expect(markup).not.toContain("background-run-center__task ");
    expect(markup).toContain("background-run-center__group--history");
    expect(markup).toContain("正在加载最近完成任务");
  });

  it("renders fixed history filters plus loading and explicit retry surfaces", () => {
    const commonProps = {
      status: "all" as const,
      nextCursor: null,
      isLoadingMore: false,
      loadMoreError: null,
      onChangeStatus: () => undefined,
      onLoadMore: () => undefined,
      onRetryInitialLoad: () => undefined,
      onSelect: () => undefined,
    };
    const loading = renderToStaticMarkup(
      <BackgroundRunHistoryView
        {...commonProps}
        initialLoadError={null}
        items={null}
      />,
    );
    const failure = renderToStaticMarkup(
      <BackgroundRunHistoryView
        {...commonProps}
        initialLoadError="任务历史服务暂时不可用，请稍后重试。"
        items={null}
      />,
    );

    for (const label of ["全部", "已完成", "失败", "已停止", "待对账"]) {
      expect(loading).toContain(`>${label}<`);
    }
    expect(loading).toContain('aria-pressed="true"');
    expect(loading).toContain("正在加载最近完成任务");
    expect(failure).toContain('role="alert"');
    expect(failure).toContain("暂时无法加载最近完成任务");
    expect(failure).toContain("任务历史服务暂时不可用，请稍后重试。");
    expect(failure).toContain(">重新加载<");
  });

  it("keeps an empty filtered page in loading state while automatic paging continues", () => {
    const markup = renderToStaticMarkup(
      <BackgroundRunHistoryView
        initialLoadError={null}
        isLoadingMore={true}
        items={[]}
        loadMoreError={null}
        nextCursor="opaque-next-cursor"
        onChangeStatus={() => undefined}
        onLoadMore={() => undefined}
        onRetryInitialLoad={() => undefined}
        onSelect={() => undefined}
        status="all"
      />,
    );

    expect(markup).toContain("正在加载最近完成任务");
    expect(markup).not.toContain("没有符合筛选的历史任务");
    expect(markup).not.toContain('aria-label="最近完成 0 项"');
    expect(markup).not.toContain("加载更多最近完成任务");
  });

  it("renders history actions and pagination failures without hiding results", () => {
    const markup = renderToStaticMarkup(
      <BackgroundRunHistoryView
        initialLoadError={null}
        isLoadingMore={false}
        items={historyItems}
        loadMoreError="网络连接失败，请检查网络后重试。"
        nextCursor="opaque-next-cursor"
        onChangeStatus={() => undefined}
        onLoadMore={() => undefined}
        onRetryInitialLoad={() => undefined}
        onSelect={() => undefined}
        status="cancelled"
      />,
    );

    expect(markup).toContain('aria-label="最近完成 2 项"');
    expect(markup).toContain('aria-label="最近完成任务"');
    expect(markup).toContain("西班牙泵类采购");
    expect(markup).toContain("荷兰经销商");
    expect(markup).toContain(
      "加载更多失败：网络连接失败，请检查网络后重试。",
    );
    expect(markup).toContain('aria-label="重试加载更多最近完成任务"');
    expect(markup).toContain(">重试加载更多<");
    expect(markup).toMatch(/aria-pressed="true"[^>]*>已停止</u);
  });

  it("uses shared modal focus, restores the trigger, and closes from the backdrop", async () => {
    const source = await readFile(
      path.join(process.cwd(), "components/background-run-center.tsx"),
      "utf8",
    );

    expect(source).toMatch(
      /useModalFocus\(\{[\s\S]*?backdropRef,[\s\S]*?canClose: true,[\s\S]*?containerRef: dialogRef,[\s\S]*?initialFocusRef: closeButtonRef,[\s\S]*?onClose,[\s\S]*?returnFocusRef,[\s\S]*?\}\);/u,
    );
    expect(source).toMatch(
      /if \(event\.target === event\.currentTarget\) \{\s*event\.preventDefault\(\);\s*onClose\(\);\s*\}/u,
    );
    expect(source).toContain("onMouseDown={handleBackdropMouseDown}");
  });

  it("invalidates open history from the existing conversation browser revision", async () => {
    const [centerSource, workspaceSource] = await Promise.all([
      readFile(
        path.join(process.cwd(), "components/background-run-center.tsx"),
        "utf8",
      ),
      readFile(
        path.join(process.cwd(), "components/research-workspace.tsx"),
        "utf8",
      ),
    ]);

    expect(workspaceSource).toContain(
      "historyRevision={conversationBrowserVersion}",
    );
    expect(centerSource).toMatch(
      /const requestKey = `\$\{status\}[^`]*\$\{historyRevision\}[^`]*\$\{initialLoadRevision\}`;/u,
    );
    expect(centerSource).toContain("return () => controller.abort();");
  });
});
