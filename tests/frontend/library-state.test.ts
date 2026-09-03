import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchLibraryArtifactPage,
  fetchLibraryResearchDetail,
  fetchLibraryResearchPage,
  LibraryApiError,
  libraryDetailRequestCanCommit,
  libraryInitialPageRequest,
  libraryMergePage,
  libraryNextPageRequest,
  libraryPageForRender,
  libraryPageRequestCanCommit,
  libraryPageRequestUrl,
  libraryRequestKey,
  libraryResultSurface,
  libraryScrollIsNearEnd,
  libraryTabForKey,
} from "@/components/library-state";
import type {
  GetLibraryResearchResponse,
  LibraryArtifactItem,
  LibraryResearchItem,
  ListLibraryArtifactsResponse,
  ListLibraryResearchResponse,
} from "@/lib/contracts";

const conversation = {
  id: "10000000-0000-4000-8000-000000000001",
  title: "德国泵类买家",
  archivedAt: null,
} as const;

const researchItem: LibraryResearchItem = {
  id: "20000000-0000-4000-8000-000000000001",
  title: "德国工业泵目标买家",
  querySummary: "寻找德国的工业泵进口商与分销商。",
  companyCount: 1,
  createdAt: "2026-08-28T08:30:00.000Z",
  conversation,
  runId: "30000000-0000-4000-8000-000000000001",
  assistantMessageId: "40000000-0000-4000-8000-000000000001",
};

const artifactItem: LibraryArtifactItem = {
  id: "50000000-0000-4000-8000-000000000001",
  name: "germany-pump-buyers.csv",
  mimeType: "text/csv",
  sizeBytes: 4096,
  downloadUrl:
    "/api/artifacts/50000000-0000-4000-8000-000000000001/download",
  createdAt: "2026-08-28T08:35:00.000Z",
  conversation,
  runId: researchItem.runId,
  assistantMessageId: researchItem.assistantMessageId,
  researchSnapshotId: researchItem.id,
};

const researchPage: ListLibraryResearchResponse = {
  items: [researchItem],
  nextCursor: "research-cursor",
};

const artifactPage: ListLibraryArtifactsResponse = {
  items: [artifactItem],
  nextCursor: null,
};

const researchDetail: GetLibraryResearchResponse = {
  research: {
    ...researchItem,
    limitations: "仅使用公开网页资料，联系人信息可能发生变化。",
    companies: [
      {
        id: "60000000-0000-4000-8000-000000000001",
        name: "Acme Pump GmbH",
        websiteUrl: "https://example.com",
        country: "德国",
        companyType: "distributor",
        relevanceSummary: "经营工业泵产品。",
        contacts: [],
        evidence: [
          {
            claim: "官网展示工业泵产品。",
            sourceUrl: "https://example.com/pumps",
            sourceTitle: "Industrial pumps",
            supports: "business_fit",
          },
        ],
      },
    ],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("library fixed API client", () => {
  it("builds only the exact list query and returns the fixed initial page", () => {
    expect(libraryInitialPageRequest()).toEqual({ cursor: null, limit: 24 });
    expect(
      libraryPageRequestUrl("research", libraryInitialPageRequest()),
    ).toBe("/api/library/research?limit=24");
    expect(
      libraryPageRequestUrl(
        "artifacts",
        libraryNextPageRequest("opaque/+ cursor="),
      ),
    ).toBe(
      "/api/library/artifacts?limit=24&cursor=opaque%2F%2B+cursor%3D",
    );
  });

  it("rejects invalid internal pagination instead of rewriting it", () => {
    expect(() =>
      libraryPageRequestUrl("research", { cursor: null, limit: 0 }),
    ).toThrow("资料库分页 limit 必须是 1 到 50 的安全整数");
    expect(() => libraryNextPageRequest("")).toThrow(
      "资料库分页 cursor 不能为空字符串",
    );
  });

  it("parses exact research and artifact pages without response fallback", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(researchPage))
      .mockResolvedValueOnce(Response.json(artifactPage));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLibraryResearchPage(libraryInitialPageRequest()),
    ).resolves.toEqual(researchPage);
    await expect(
      fetchLibraryArtifactPage(libraryInitialPageRequest()),
    ).resolves.toEqual(artifactPage);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/library/research?limit=24",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/library/artifacts?limit=24",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("rejects an extra backend field through the strict response schema", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          ...researchPage,
          inventedTotal: 1,
        }),
      ),
    );

    await expect(
      fetchLibraryResearchPage(libraryInitialPageRequest()),
    ).rejects.toThrow();
  });

  it("parses the exact detail and enforces companyCount", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(researchDetail))
      .mockResolvedValueOnce(
        Response.json({
          research: { ...researchDetail.research, companyCount: 2 },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLibraryResearchDetail(researchItem.id),
    ).resolves.toEqual(researchDetail);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/library/research/${researchItem.id}`,
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
    await expect(
      fetchLibraryResearchDetail(researchItem.id),
    ).rejects.toThrow("companyCount must match companies.length");
  });

  it("parses the fixed API error contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: {
              code: "NOT_FOUND",
              message: "研究快照不存在。",
            },
          },
          { status: 404 },
        ),
      ),
    );

    const error = await fetchLibraryResearchDetail(researchItem.id).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LibraryApiError);
    expect(error).toMatchObject({
      code: "NOT_FOUND",
      message: "服务请求失败",
      status: 404,
    });
  });
});

describe("library list state", () => {
  it("uses a stable tab and refresh request key", () => {
    expect(libraryRequestKey("research", 0)).toBe("research\u00000");
    expect(libraryRequestKey("artifacts", 12)).toBe("artifacts\u000012");
    expect(() => libraryRequestKey("research", -1)).toThrow(
      "资料库 refreshVersion 必须是非负安全整数",
    );
  });

  it("supports roving two-tab keyboard navigation", () => {
    expect(libraryTabForKey("research", "ArrowRight")).toBe("artifacts");
    expect(libraryTabForKey("artifacts", "ArrowLeft")).toBe("research");
    expect(libraryTabForKey("artifacts", "Home")).toBe("research");
    expect(libraryTabForKey("research", "End")).toBe("artifacts");
    expect(libraryTabForKey("research", "Enter")).toBeNull();
  });

  it("gives loading and failure precedence over empty", () => {
    expect(
      libraryResultSurface({ isLoading: true, loadError: "failed", itemCount: 0 }),
    ).toBe("loading");
    expect(
      libraryResultSurface({ isLoading: false, loadError: "failed", itemCount: 0 }),
    ).toBe("failure");
    expect(
      libraryResultSurface({ isLoading: false, loadError: null, itemCount: 0 }),
    ).toBe("empty");
    expect(
      libraryResultSurface({ isLoading: false, loadError: null, itemCount: 1 }),
    ).toBe("results");
  });

  it("keeps successful cards mounted during background refresh without reusing stale failures", () => {
    const successfulPage = {
      requestKey: "artifacts\u00000\u00000",
      items: [artifactItem],
      nextCursor: null,
      error: null,
    };
    const staleFailure = {
      requestKey: "artifacts\u00000\u00000",
      items: [] as LibraryArtifactItem[],
      nextCursor: null,
      error: "旧请求失败",
    };
    const refreshedRequestKey = "artifacts\u00001\u00000";

    const visiblePage = libraryPageForRender(
      successfulPage,
      refreshedRequestKey,
    );
    expect(visiblePage).toBe(successfulPage);
    expect(visiblePage?.items).toBe(successfulPage.items);
    expect(visiblePage?.items[0]).toBe(artifactItem);
    expect(libraryPageForRender(staleFailure, refreshedRequestKey)).toBeNull();
    expect(
      libraryPageForRender(staleFailure, staleFailure.requestKey),
    ).toBe(staleFailure);
  });

  it("appends immutable pages and rejects duplicate IDs", () => {
    const nextItem = {
      ...researchItem,
      id: "20000000-0000-4000-8000-000000000002",
    };
    expect(libraryMergePage([researchItem], [nextItem])).toEqual([
      researchItem,
      nextItem,
    ]);
    expect(() => libraryMergePage([researchItem], [researchItem])).toThrow(
      `资料库分页返回了重复条目 ${researchItem.id}`,
    );
    expect(() => libraryMergePage([], [researchItem, researchItem])).toThrow(
      `资料库分页返回了重复条目 ${researchItem.id}`,
    );
  });

  it("rejects aborted, superseded, and stale list completions", () => {
    const controller = new AbortController();
    expect(
      libraryPageRequestCanCommit({
        controller,
        currentController: controller,
        currentRequestKey: "research\u00000",
        requestKey: "research\u00000",
      }),
    ).toBe(true);
    expect(
      libraryPageRequestCanCommit({
        controller,
        currentController: new AbortController(),
        currentRequestKey: "research\u00000",
        requestKey: "research\u00000",
      }),
    ).toBe(false);
    expect(
      libraryPageRequestCanCommit({
        controller,
        currentController: controller,
        currentRequestKey: "artifacts\u00000",
        requestKey: "research\u00000",
      }),
    ).toBe(false);
    controller.abort();
    expect(
      libraryPageRequestCanCommit({
        controller,
        currentController: controller,
        currentRequestKey: "research\u00000",
        requestKey: "research\u00000",
      }),
    ).toBe(false);
  });

  it("rejects a stale detail completion after route changes", () => {
    const controller = new AbortController();
    expect(
      libraryDetailRequestCanCommit({
        controller,
        currentController: controller,
        currentSnapshotId: researchItem.id,
        snapshotId: researchItem.id,
      }),
    ).toBe(true);
    expect(
      libraryDetailRequestCanCommit({
        controller,
        currentController: controller,
        currentSnapshotId: null,
        snapshotId: researchItem.id,
      }),
    ).toBe(false);
  });

  it("starts incremental loading only near the viewport end", () => {
    expect(
      libraryScrollIsNearEnd({
        clientHeight: 400,
        scrollHeight: 1_000,
        scrollTop: 479,
      }),
    ).toBe(false);
    expect(
      libraryScrollIsNearEnd({
        clientHeight: 400,
        scrollHeight: 1_000,
        scrollTop: 480,
      }),
    ).toBe(true);
  });
});
