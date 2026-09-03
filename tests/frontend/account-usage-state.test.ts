import { afterEach, describe, expect, it, vi } from "vitest";

import {
  accountUsageInitialPageRequest,
  accountUsageMergePage,
  accountUsageNextPageRequest,
  accountUsageResultSurface,
  accountUsageStatusLabels,
  formatAccountUsageDate,
  formatAccountUsageNumber,
} from "@/components/account-usage-state";
import { getAccountUsage } from "@/components/api-client";
import type {
  AccountUsageItem,
  AccountUsageResponse,
  AgentRunStatus,
} from "@/lib/contracts";

const firstItem: AccountUsageItem = {
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
};

const response: AccountUsageResponse = {
  balance: { available: 7_495, reserved: 1_500, frozen: 500 },
  items: [firstItem],
  nextCursor: "opaque/+ cursor=",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("account usage fixed API client", () => {
  it("uses limit 30 and preserves the opaque cursor exactly", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(response))
      .mockResolvedValueOnce(
        Response.json({ ...response, items: [], nextCursor: null }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getAccountUsage(accountUsageInitialPageRequest()),
    ).resolves.toEqual(response);
    await expect(
      getAccountUsage(accountUsageNextPageRequest("opaque/+ cursor=")),
    ).resolves.toMatchObject({ nextCursor: null });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/account/usage?limit=30",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/account/usage?limit=30&cursor=opaque%2F%2B+cursor%3D",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("strictly parses the fixed response instead of accepting extra fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ ...response, inventedTotal: 1 }),
      ),
    );

    await expect(
      getAccountUsage(accountUsageInitialPageRequest()),
    ).rejects.toThrow();
  });
});

describe("account usage pagination and presentation state", () => {
  it("appends every incoming Run once and rejects overlap", () => {
    const secondItem: AccountUsageItem = {
      ...firstItem,
      runId: "10000000-0000-4000-8000-000000000002",
      status: "running",
      chargedCredits: null,
      inputTokens: null,
      outputTokens: null,
      webSearches: null,
      finishedAt: null,
    };

    expect(accountUsageMergePage([firstItem], [secondItem])).toEqual([
      firstItem,
      secondItem,
    ]);
    expect(() => accountUsageMergePage([firstItem], [firstItem])).toThrow(
      `积分用量分页返回了重复 Run ${firstItem.runId}`,
    );
    expect(() => accountUsageMergePage([], [firstItem, firstItem])).toThrow(
      `积分用量分页返回了重复 Run ${firstItem.runId}`,
    );
  });

  it("covers the complete fixed Run status enum with Chinese labels", () => {
    const statuses: AgentRunStatus[] = [
      "waiting",
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
      "reconciliation_required",
    ];

    expect(Object.keys(accountUsageStatusLabels)).toEqual(statuses);
    expect(accountUsageStatusLabels).toEqual({
      waiting: "等待执行",
      queued: "排队中",
      running: "运行中",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
      reconciliation_required: "待对账",
    });
  });

  it("shows null measurements as an em dash without inferring values", () => {
    expect(formatAccountUsageNumber(null)).toBe("—");
    expect(formatAccountUsageDate(null)).toBe("—");
    expect(formatAccountUsageNumber(0)).toBe("0");
  });

  it("selects loading, failure, empty, and results surfaces exactly", () => {
    expect(
      accountUsageResultSurface({
        isLoading: true,
        loadError: "failed",
        itemCount: 1,
      }),
    ).toBe("loading");
    expect(
      accountUsageResultSurface({
        isLoading: false,
        loadError: "failed",
        itemCount: 1,
      }),
    ).toBe("failure");
    expect(
      accountUsageResultSurface({
        isLoading: false,
        loadError: null,
        itemCount: 0,
      }),
    ).toBe("empty");
    expect(
      accountUsageResultSurface({
        isLoading: false,
        loadError: null,
        itemCount: 1,
      }),
    ).toBe("results");
  });

  it("rejects an empty internal cursor rather than rewriting it", () => {
    expect(() => accountUsageNextPageRequest("")).toThrow(
      "积分用量分页 cursor 不能为空字符串",
    );
  });
});
