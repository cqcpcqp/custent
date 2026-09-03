import {
  Children,
  createRef,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  LibraryArtifactList,
  LibraryEmptyState,
  LibraryHeader,
  LibraryLoadFailure,
  LibraryResearchDetailContent,
  LibraryResearchList,
  LibraryResultContent,
  LibraryView,
} from "@/components/library-view";
import {
  libraryPageForRender,
  libraryResultSurface,
} from "@/components/library-state";
import type {
  LibraryArtifactItem,
  LibraryResearchDetail,
  LibraryResearchItem,
} from "@/lib/contracts";

const conversation = {
  id: "10000000-0000-4000-8000-000000000001",
  title: "德国泵类买家",
  archivedAt: "2026-08-27T08:00:00.000Z",
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

const researchDetail: LibraryResearchDetail = {
  ...researchItem,
  limitations: "仅使用公开网页资料，联系人信息可能发生变化。",
  companies: [
    {
      id: "60000000-0000-4000-8000-000000000001",
      name: "Acme Pump GmbH",
      websiteUrl: "https://example.com",
      country: "德国",
      companyType: "distributor",
      relevanceSummary: "经营工业泵产品并服务德国工业客户。",
      contacts: [
        {
          name: "Anna Schmidt",
          titleOriginal: "Head of Procurement",
          roleCategory: "procurement",
          publicProfileUrl: "https://example.com/anna",
          confidence: "A",
          evidence: [
            {
              claim: "公司团队页列明其采购负责人职位。",
              sourceUrl: "https://example.com/team",
              sourceTitle: "Acme team",
              supports: "contact_role",
            },
          ],
        },
      ],
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
};

type InspectableElementProps = {
  children?: ReactNode;
  onClick?: unknown;
  [key: string]: unknown;
};

function findElement(
  root: ReactNode,
  predicate: (element: ReactElement<InspectableElementProps>) => boolean,
): ReactElement<InspectableElementProps> | null {
  for (const child of Children.toArray(root)) {
    if (!isValidElement<InspectableElementProps>(child)) {
      continue;
    }
    if (predicate(child)) {
      return child;
    }
    const nested = findElement(child.props.children, predicate);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

describe("library workspace surface", () => {
  it("renders an SSR-stable research tab with complete loading semantics", () => {
    const markup = renderToStaticMarkup(
      <LibraryView
        backgroundRunCenterTriggerRef={createRef<HTMLButtonElement>()}
        backgroundRunCount={2}
        isBackgroundRunCenterOpen={false}
        isSidebarOpen={false}
        mobileMenuTriggerRef={createRef<HTMLButtonElement>()}
        onNavigateSnapshot={() => undefined}
        onNavigateTab={() => undefined}
        onOpenBackgroundRunCenter={() => undefined}
        onOpenConversation={() => undefined}
        onOpenSidebar={() => undefined}
        refreshVersion={0}
        snapshotId={null}
        tab="research"
      />,
    );

    expect(markup).toContain('class="library-pane"');
    expect(markup).toContain('aria-controls="conversation-sidebar"');
    expect(markup).toContain('aria-controls="background-run-center-dialog"');
    expect(markup).toContain('aria-label="后台任务，2 项待处理"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="资料类型"');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain(
      'aria-controls="library-tab-panel" aria-selected="true" id="library-research-tab"',
    );
    expect(markup).toContain(
      'aria-controls="library-tab-panel" aria-selected="false" id="library-artifacts-tab"',
    );
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain('aria-busy="true" class="library-results"');
    expect(markup).toContain('class="library-loading" role="status"');
    expect(markup).toContain("正在加载研究快照");
    expect(markup).not.toContain("加载更多");
  });

  it("renders the route-controlled artifact tab without a local default", () => {
    const markup = renderToStaticMarkup(
      <LibraryView
        backgroundRunCenterTriggerRef={createRef<HTMLButtonElement>()}
        backgroundRunCount={0}
        isBackgroundRunCenterOpen={false}
        isSidebarOpen={false}
        mobileMenuTriggerRef={createRef<HTMLButtonElement>()}
        onNavigateSnapshot={() => undefined}
        onNavigateTab={() => undefined}
        onOpenBackgroundRunCenter={() => undefined}
        onOpenConversation={() => undefined}
        onOpenSidebar={() => undefined}
        refreshVersion={0}
        snapshotId={null}
        tab="artifacts"
      />,
    );

    expect(markup).toContain(
      'aria-controls="library-tab-panel" aria-selected="false" id="library-research-tab"',
    );
    expect(markup).toContain(
      'aria-controls="library-tab-panel" aria-selected="true" id="library-artifacts-tab"',
    );
    expect(markup).toContain(
      'aria-label="后台任务，当前没有待处理任务"',
    );
    expect(markup).not.toContain("disabled");
    expect(markup).toContain("正在加载生成文件");
  });

  it("renders a route-driven detail header with an explicit back action", () => {
    const onBack = vi.fn();
    const tree = LibraryHeader({
      backgroundRunCenterTriggerRef: createRef<HTMLButtonElement>(),
      backgroundRunCount: 1,
      isBackgroundRunCenterOpen: false,
      isSidebarOpen: true,
      mobileMenuTriggerRef: createRef<HTMLButtonElement>(),
      onBack,
      onOpenBackgroundRunCenter: () => undefined,
      onOpenSidebar: () => undefined,
      title: researchItem.title,
    });
    const backButton = findElement(
      tree,
      (element) => element.props["aria-label"] === "返回资料库",
    );
    if (backButton === null || typeof backButton.props.onClick !== "function") {
      throw new Error("研究详情页缺少返回资料库操作");
    }

    (backButton.props.onClick as () => void)();
    expect(onBack).toHaveBeenCalledTimes(1);

    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-label="返回资料库"');
    expect(markup).toContain(researchItem.title);
  });
});

describe("library result surfaces", () => {
  it("renders distinct and announced empty states", () => {
    const research = renderToStaticMarkup(
      <LibraryEmptyState tab="research" />,
    );
    const artifacts = renderToStaticMarkup(
      <LibraryEmptyState tab="artifacts" />,
    );

    expect(research).toContain('class="library-empty" role="status"');
    expect(research).toContain("还没有研究快照");
    expect(research).toContain("已完成的结构化研究");
    expect(artifacts).toContain('class="library-empty" role="status"');
    expect(artifacts).toContain("还没有生成文件");
    expect(artifacts).toContain("CSV 和 PDF");
  });

  it("announces a fixed load failure and exposes retry", () => {
    const onRetry = vi.fn();
    const tree = LibraryLoadFailure({
      message: "服务暂时不可用。",
      onRetry,
      tab: "artifacts",
    });
    const retry = findElement(
      tree,
      (element) => element.type === "button",
    );
    if (retry === null || typeof retry.props.onClick !== "function") {
      throw new Error("资料库加载失败状态缺少重试按钮");
    }
    (retry.props.onClick as () => void)();
    expect(onRetry).toHaveBeenCalledTimes(1);

    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain('class="library-failure" role="alert"');
    expect(markup).toContain("暂时无法加载生成文件");
    expect(markup).toContain("服务暂时不可用。");
  });

  it("fails closed when a failure surface has no error contract", () => {
    expect(() =>
      LibraryResultContent({
        artifactItems: [],
        initialLoadError: null,
        onNavigateSnapshot: () => undefined,
        onOpenConversation: () => undefined,
        onRetry: () => undefined,
        researchItems: [],
        surface: "failure",
        tab: "research",
      }),
    ).toThrow("资料库失败状态缺少错误信息");
  });
});

describe("library research cards", () => {
  it("keeps snapshot navigation and source-conversation navigation separate", () => {
    const onNavigateSnapshot = vi.fn();
    const markup = renderToStaticMarkup(
      <LibraryResearchList
        items={[researchItem]}
        onNavigateSnapshot={onNavigateSnapshot}
        onOpenConversation={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="研究快照列表"');
    expect(markup).toContain(
      `aria-label="查看研究快照：${researchItem.title}"`,
    );
    expect(markup).toContain(
      `data-library-snapshot-focus-key="research:${researchItem.id}"`,
    );
    expect(markup).toContain(
      `aria-label="打开来源对话：${conversation.title}"`,
    );
    expect(markup).toContain("已归档来源");
    expect(markup).toContain("1 家公司");
    expect(markup).toContain(`dateTime="${researchItem.createdAt}"`);
    expect(markup).not.toContain("href=");

    const tree = LibraryResearchList({
      items: [researchItem],
      onNavigateSnapshot,
      onOpenConversation: () => undefined,
    });
    const snapshotButton = findElement(
      tree,
      (element) =>
        element.props["aria-label"] ===
        `查看研究快照：${researchItem.title}`,
    );
    if (
      snapshotButton === null ||
      typeof snapshotButton.props.onClick !== "function"
    ) {
      throw new Error("研究快照卡缺少详情导航");
    }
    (snapshotButton.props.onClick as () => void)();
    expect(onNavigateSnapshot).toHaveBeenCalledWith(
      researchItem.id,
      `research:${researchItem.id}`,
    );
  });

  it("renders the strict read-only company, contact, and evidence detail", () => {
    const markup = renderToStaticMarkup(
      <LibraryResearchDetailContent
        onOpenConversation={() => undefined}
        research={researchDetail}
      />,
    );

    expect(markup).toContain('id="library-research-summary-title"');
    expect(markup).toContain(researchDetail.querySummary);
    expect(markup).toContain(researchDetail.limitations);
    expect(markup).toContain("Acme Pump GmbH");
    expect(markup).toContain("德国 · 分销商");
    expect(markup).toContain("Anna Schmidt");
    expect(markup).toContain("Head of Procurement");
    expect(markup).toContain("采购管理");
    expect(markup).toContain("置信度 A");
    expect(markup).toContain("业务匹配");
    expect(markup).toContain("联系人职能");
    expect(markup).toContain('href="https://example.com"');
    expect(markup).toContain('href="https://example.com/anna"');
    expect(markup).toContain('href="https://example.com/pumps"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer"');
  });

  it("states exactly when a company has no saved contacts", () => {
    const withoutContacts: LibraryResearchDetail = {
      ...researchDetail,
      companies: [
        {
          ...researchDetail.companies[0],
          contacts: [],
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <LibraryResearchDetailContent
        onOpenConversation={() => undefined}
        research={withoutContacts}
      />,
    );
    expect(markup).toContain("这家公司没有保存目标联系人。");
    expect(markup).toContain('role="status"');
  });
});

describe("library artifact cards", () => {
  it("reuses the in-app artifact viewer and keeps source navigation separate", () => {
    const onNavigateSnapshot = vi.fn();
    const markup = renderToStaticMarkup(
      <LibraryArtifactList
        items={[artifactItem]}
        onNavigateSnapshot={onNavigateSnapshot}
        onOpenConversation={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="生成文件列表"');
    expect(markup).toContain(
      `aria-label="预览文件：${artifactItem.name}"`,
    );
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain("研究快照导出");
    expect(markup).toContain(
      `aria-label="查看关联研究快照：${artifactItem.name}"`,
    );
    expect(markup).toContain(
      `data-library-snapshot-focus-key="artifact:${artifactItem.id}"`,
    );
    expect(markup).toContain(
      `aria-label="打开来源对话：${conversation.title}"`,
    );
    expect(markup).not.toContain("download=");
    expect(markup).not.toContain(`href="${artifactItem.downloadUrl}"`);

    const tree = LibraryArtifactList({
      items: [artifactItem],
      onNavigateSnapshot,
      onOpenConversation: () => undefined,
    });
    const linkedResearch = findElement(
      tree,
      (element) =>
        element.props["aria-label"] ===
        `查看关联研究快照：${artifactItem.name}`,
    );
    if (
      linkedResearch === null ||
      typeof linkedResearch.props.onClick !== "function"
    ) {
      throw new Error("关联研究文件缺少快照详情入口");
    }
    (linkedResearch.props.onClick as () => void)();
    expect(onNavigateSnapshot).toHaveBeenCalledWith(
      artifactItem.researchSnapshotId,
      `artifact:${artifactItem.id}`,
    );
  });

  it("does not invent a research entry for a conversation-generated file", () => {
    const standaloneArtifact: LibraryArtifactItem = {
      ...artifactItem,
      researchSnapshotId: null,
    };
    const markup = renderToStaticMarkup(
      <LibraryArtifactList
        items={[standaloneArtifact]}
        onNavigateSnapshot={() => undefined}
        onOpenConversation={() => undefined}
      />,
    );

    expect(markup).toContain("对话生成文件");
    expect(markup).toContain(
      `aria-label="预览文件：${standaloneArtifact.name}"`,
    );
    expect(markup).not.toContain("查看关联研究快照");
  });

  it("keeps the artifact card and preview trigger rendered during background refresh", () => {
    const previousPage = {
      requestKey: "artifacts\u00000\u00000",
      items: [artifactItem],
      nextCursor: null,
      error: null,
    };
    const visiblePage = libraryPageForRender(
      previousPage,
      "artifacts\u00001\u00000",
    );
    if (visiblePage === null) {
      throw new Error("后台刷新不应卸载已有生成文件页");
    }
    const surface = libraryResultSurface({
      isLoading: false,
      loadError: visiblePage.error,
      itemCount: visiblePage.items.length,
    });
    const markup = renderToStaticMarkup(
      <LibraryResultContent
        artifactItems={visiblePage.items}
        initialLoadError={visiblePage.error}
        onNavigateSnapshot={() => undefined}
        onOpenConversation={() => undefined}
        onRetry={() => undefined}
        researchItems={[]}
        surface={surface}
        tab="artifacts"
      />,
    );

    expect(visiblePage).toBe(previousPage);
    expect(markup).toContain(`aria-label="预览文件：${artifactItem.name}"`);
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).not.toContain('class="library-loading"');
  });
});
