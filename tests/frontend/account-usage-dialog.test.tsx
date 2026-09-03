import { readFile } from "node:fs/promises";
import path from "node:path";

import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AccountUsageDialog,
  AccountUsageReadyContent,
} from "@/components/account-usage-dialog";
import type { AccountUsageResponse } from "@/lib/contracts";

const readyPage: AccountUsageResponse = {
  balance: { available: 7_495, reserved: 1_500, frozen: 500 },
  items: [
    {
      runId: "10000000-0000-4000-8000-000000000001",
      conversationId: "20000000-0000-4000-8000-000000000001",
      conversationTitle: "德国工业泵买家",
      status: "completed",
      reservationCredits: 2_000,
      chargedCredits: 37,
      inputTokens: 1_200,
      outputTokens: 320,
      webSearches: 4,
      createdAt: "2026-08-28T08:00:00.000Z",
      finishedAt: "2026-08-28T08:02:00.000Z",
    },
    {
      runId: "10000000-0000-4000-8000-000000000002",
      conversationId: "20000000-0000-4000-8000-000000000002",
      conversationTitle: "法国阀门经销商",
      status: "running",
      reservationCredits: 2_000,
      chargedCredits: null,
      inputTokens: null,
      outputTokens: null,
      webSearches: null,
      createdAt: "2026-08-28T09:00:00.000Z",
      finishedAt: null,
    },
  ],
  nextCursor: "next-page",
};

describe("account usage dialog", () => {
  it("renders an accessible busy modal while the exact first page loads", () => {
    const markup = renderToStaticMarkup(
      <AccountUsageDialog
        onClose={() => undefined}
        returnFocusRef={createRef<HTMLButtonElement>()}
      />,
    );

    expect(markup).toContain('data-modal-layer=""');
    expect(markup).toContain(
      'aria-describedby="account-usage-description" aria-labelledby="account-usage-title" aria-modal="true"',
    );
    expect(markup).toContain('id="account-usage-dialog"');
    expect(markup).toContain('role="dialog" tabindex="-1"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("正在加载积分与用量");
    expect(markup).toContain('aria-label="关闭积分与用量"');
  });

  it("separates balances, reservation, charge, tokens, and web searches", () => {
    const markup = renderToStaticMarkup(
      <AccountUsageReadyContent
        isLoadingMore={false}
        loadMoreError={null}
        onLoadMore={() => undefined}
        page={readyPage}
      />,
    );

    expect(markup).toContain("可用积分");
    expect(markup).toContain("运行中预留积分");
    expect(markup).toContain("待对账冻结积分");
    expect(markup).toContain("7,495");
    expect(markup).toContain("1,500");
    expect(markup).toContain("500");
    expect(markup).toContain("德国工业泵买家");
    expect(markup).toContain("法国阀门经销商");
    expect(markup).toContain("本次预留积分");
    expect(markup).toContain("本次实扣积分");
    expect(markup).toContain("输入 tokens");
    expect(markup).toContain("输出 tokens");
    expect(markup).toContain("网页搜索次数");
    expect(markup).toContain('data-run-status="completed"');
    expect(markup).toContain('aria-label="运行状态：已完成"');
    expect(markup).toContain('data-run-status="running"');
    expect(markup).toContain('aria-label="运行状态：运行中"');
    expect(markup.match(/>—</gu)).toHaveLength(5);
    expect(markup).toContain('aria-label="加载更多用量记录"');
  });

  it("renders explicit empty and load-more retry states", () => {
    const emptyMarkup = renderToStaticMarkup(
      <AccountUsageReadyContent
        isLoadingMore={false}
        loadMoreError={null}
        onLoadMore={() => undefined}
        page={{ ...readyPage, items: [], nextCursor: null }}
      />,
    );
    const retryMarkup = renderToStaticMarkup(
      <AccountUsageReadyContent
        isLoadingMore={false}
        loadMoreError="网络连接已中断"
        onLoadMore={() => undefined}
        page={readyPage}
      />,
    );

    expect(emptyMarkup).toContain('class="account-usage-empty" role="status"');
    expect(emptyMarkup).toContain("还没有用量记录");
    expect(retryMarkup).toContain('role="alert"');
    expect(retryMarkup).toContain("加载更多失败：网络连接已中断");
    expect(retryMarkup).toContain('aria-label="重试加载更多用量记录"');
    expect(retryMarkup).toContain("重试加载更多");
  });

  it("uses the shared modal focus contract and responsive isolated styles", async () => {
    const [source, styles] = await Promise.all([
      readFile(
        path.join(process.cwd(), "components/account-usage-dialog.tsx"),
        "utf8",
      ),
      readFile(path.join(process.cwd(), "app/globals.css"), "utf8"),
    ]);
    const accountUsageStyles = styles.slice(
      styles.indexOf("/* Account usage dialog */"),
      styles.indexOf(".archived-conversation-notice"),
    );

    expect(source).toMatch(
      /useModalFocus\(\{[\s\S]*?backdropRef,[\s\S]*?canClose: true,[\s\S]*?containerRef: dialogRef,[\s\S]*?initialFocusRef: closeButtonRef,[\s\S]*?onClose,[\s\S]*?returnFocusRef,[\s\S]*?\}\);/u,
    );
    expect(accountUsageStyles).toContain(".account-usage-backdrop");
    expect(accountUsageStyles).toContain(
      'html[data-theme="dark"] .account-usage-dialog',
    );
    expect(accountUsageStyles).toContain("@media (max-width: 600px)");
    expect(accountUsageStyles).toMatch(
      /\.account-usage-dialog \{[\s\S]*?width: 100vw;[\s\S]*?min-height: 100dvh;/u,
    );
    expect(styles).toMatch(
      /\.sidebar--collapsed \.credit-card \{[\s\S]*?width: 38px;[\s\S]*?min-height: 38px;/u,
    );
  });
});
