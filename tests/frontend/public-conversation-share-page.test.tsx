import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicConversationShare } from "@/lib/contracts";

const mocks = vi.hoisted(() => ({
  getPublicConversationShare: vi.fn(),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/lib/db", () => ({
  getPublicConversationShare: mocks.getPublicConversationShare,
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
}));

import PublicConversationSharePage, {
  dynamic,
} from "@/app/share/[publicId]/page";

const publicId = "20000000-0000-4000-8000-000000000001";
const share: PublicConversationShare = {
  title: "共享买家研究",
  messages: [
    {
      id: "10000000-0000-4000-8000-000000000001",
      role: "user",
      content: "研究德国市场",
      citations: [],
      files: [],
      createdAt: "2026-08-28T08:00:00.000Z",
    },
  ],
  createdAt: "2026-08-28T08:00:00.000Z",
  updatedAt: "2026-08-28T08:00:00.000Z",
};

describe("public conversation share page", () => {
  beforeEach(() => {
    mocks.getPublicConversationShare.mockReset();
    mocks.notFound.mockClear();
  });

  it("always reads the current revocation state dynamically", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("rejects an invalid public ID before querying the repository", async () => {
    await expect(
      PublicConversationSharePage({
        params: Promise.resolve({ publicId: "not-a-uuid" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(mocks.getPublicConversationShare).not.toHaveBeenCalled();
    expect(mocks.notFound).toHaveBeenCalledOnce();
  });

  it("returns not found for a revoked or deleted share", async () => {
    mocks.getPublicConversationShare.mockResolvedValue(null);

    await expect(
      PublicConversationSharePage({
        params: Promise.resolve({ publicId }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(mocks.getPublicConversationShare).toHaveBeenCalledWith(publicId);
    expect(mocks.notFound).toHaveBeenCalledOnce();
  });

  it("renders the repository's strict public snapshot", async () => {
    mocks.getPublicConversationShare.mockResolvedValue(share);

    const page = await PublicConversationSharePage({
      params: Promise.resolve({ publicId }),
    });
    const markup = renderToStaticMarkup(page);

    expect(mocks.getPublicConversationShare).toHaveBeenCalledWith(publicId);
    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(markup).toContain("共享买家研究");
    expect(markup).toContain("研究德国市场");
  });
});
