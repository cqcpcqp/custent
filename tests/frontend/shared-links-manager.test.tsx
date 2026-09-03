import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SharedLinksManagerReadyContent } from "@/components/shared-links-manager";
import type { ConversationShareListItem } from "@/lib/contracts";

const item: ConversationShareListItem = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  publicId: "22222222-2222-4222-8222-222222222222",
  publicPath: "/share/22222222-2222-4222-8222-222222222222",
  title: "German buyers",
  createdAt: "2026-08-29T08:00:00.000Z",
  updatedAt: "2026-08-30T08:00:00.000Z",
};

function renderReady(
  overrides: Partial<
    Parameters<typeof SharedLinksManagerReadyContent>[0]
  > = {},
): string {
  return renderToStaticMarkup(
    <SharedLinksManagerReadyContent
      confirmingPublicId={null}
      isLoadingMore={false}
      loadMoreError={null}
      mutationError={null}
      notice={null}
      onCancelRevoke={() => undefined}
      onConfirmRevoke={() => undefined}
      onLoadMore={() => undefined}
      onReload={() => undefined}
      onRequestRevoke={() => undefined}
      page={{ items: [item], nextCursor: null }}
      pendingPublicId={null}
      {...overrides}
    />,
  );
}

function openingTag(markup: string, marker: string): string {
  const markerIndex = markup.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Could not find markup marker: ${marker}`);
  }
  const start = markup.lastIndexOf("<", markerIndex);
  const end = markup.indexOf(">", markerIndex);
  if (start === -1 || end === -1) {
    throw new Error(`Could not find opening tag for marker: ${marker}`);
  }
  return markup.slice(start, end + 1);
}

describe("shared links manager", () => {
  it("renders exact metadata and a safe public-link opener", () => {
    const markup = renderReady();

    expect(markup).toContain('aria-labelledby="shared-links-manager-heading"');
    expect(markup).toContain("German buyers");
    expect(markup).toContain(
      `href="${item.publicPath}" rel="noreferrer" target="_blank"`,
    );
    expect(markup).toContain('aria-label="打开共享链接“German buyers”"');
    expect(markup).toContain('aria-label="撤销共享链接“German buyers”"');
  });

  it("requires inline confirmation and exposes the busy revocation state", () => {
    const markup = renderReady({
      confirmingPublicId: item.publicId,
      pendingPublicId: item.publicId,
    });

    expect(markup).toContain("撤销这个公开链接？");
    expect(markup).toContain("以后重新分享会生成新链接");
    expect(markup).toContain("正在撤销…");
    expect(markup).toContain('aria-busy="true"');
  });

  it("disables revocation while a continuation page is loading", () => {
    const markup = renderReady({
      confirmingPublicId: item.publicId,
      isLoadingMore: true,
      page: { items: [item], nextCursor: "next_page" },
    });

    expect(
      openingTag(markup, 'aria-label="撤销共享链接“German buyers”"'),
    ).toContain("disabled");
    expect(openingTag(markup, "确认撤销")).toContain("disabled");
  });

  it("renders mutation, continuation, and empty states without hiding errors", () => {
    const errorMarkup = renderReady({
      loadMoreError: "network failed",
      mutationError: {
        publicId: item.publicId,
        message: "分享链接不存在或已发生变化。",
      },
      page: { items: [item], nextCursor: "next_page" },
    });
    expect(errorMarkup).toContain("分享链接不存在或已发生变化。");
    expect(errorMarkup).toContain("加载更多失败：network failed");
    expect(errorMarkup).toContain('aria-label="重试加载更多共享链接"');

    const emptyMarkup = renderReady({
      page: { items: [], nextCursor: null },
    });
    expect(emptyMarkup).toContain("还没有共享链接");
  });
});
