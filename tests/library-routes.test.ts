import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  LibraryArtifactItem,
  LibraryResearchDetail,
  LibraryResearchItem,
} from "@/lib/contracts";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  conversation: "22222222-2222-4222-8222-222222222222",
  run: "33333333-3333-4333-8333-333333333333",
  assistant: "44444444-4444-4444-8444-444444444444",
  snapshot: "55555555-5555-4555-8555-555555555555",
  company: "66666666-6666-4666-8666-666666666666",
  artifact: "77777777-7777-4777-8777-777777777777",
};

const mocks = vi.hoisted(() => ({
  getCurrentUserId: vi.fn(),
  getLibraryResearchDetail: vi.fn(),
  listLibraryArtifactPage: vi.fn(),
  listLibraryResearchPage: vi.fn(),
  snapshotClient: { query: vi.fn() },
  withReadOnlyRepeatableReadTransaction: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

vi.mock("@/lib/db", () => ({
  withReadOnlyRepeatableReadTransaction:
    mocks.withReadOnlyRepeatableReadTransaction,
}));

vi.mock("@/lib/library", () => ({
  getLibraryResearchDetail: mocks.getLibraryResearchDetail,
  listLibraryArtifactPage: mocks.listLibraryArtifactPage,
  listLibraryResearchPage: mocks.listLibraryResearchPage,
}));

import { GET as GET_LIBRARY_ARTIFACTS } from "@/app/api/library/artifacts/route";
import { GET as GET_LIBRARY_RESEARCH } from "@/app/api/library/research/route";
import { GET as GET_LIBRARY_RESEARCH_DETAIL } from "@/app/api/library/research/[snapshotId]/route";

const timestamp = "2026-08-28T08:00:00.000Z";
const conversation = {
  id: ids.conversation,
  title: "German pump buyers",
  archivedAt: timestamp,
};
const researchItem: LibraryResearchItem = {
  id: ids.snapshot,
  title: "Verified buyers",
  querySummary: "Public-source buyer research.",
  companyCount: 1,
  createdAt: timestamp,
  conversation,
  runId: ids.run,
  assistantMessageId: ids.assistant,
};
const artifactItem: LibraryArtifactItem = {
  id: ids.artifact,
  name: "buyers.pdf",
  mimeType: "application/pdf",
  sizeBytes: 256,
  downloadUrl: `/api/artifacts/${ids.artifact}/download`,
  createdAt: timestamp,
  conversation,
  runId: ids.run,
  assistantMessageId: ids.assistant,
  researchSnapshotId: ids.snapshot,
};
const researchDetail: LibraryResearchDetail = {
  ...researchItem,
  limitations: "Only public evidence was used.",
  companies: [
    {
      id: ids.company,
      name: "Buyer GmbH",
      websiteUrl: "https://buyer.example",
      country: "Germany",
      companyType: "distributor",
      relevanceSummary: "Relevant distributor.",
      contacts: [],
      evidence: [
        {
          claim: "The company distributes pumps.",
          sourceUrl: "https://buyer.example/evidence",
          sourceTitle: "Buyer evidence",
          supports: "business_fit",
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUserId.mockReturnValue(ids.user);
  mocks.listLibraryResearchPage.mockResolvedValue({
    items: [researchItem],
    nextCursor: null,
  });
  mocks.listLibraryArtifactPage.mockResolvedValue({
    items: [artifactItem],
    nextCursor: null,
  });
  mocks.getLibraryResearchDetail.mockResolvedValue(researchDetail);
  mocks.withReadOnlyRepeatableReadTransaction.mockImplementation(
    async (operation: (client: unknown) => Promise<unknown>) =>
      operation(mocks.snapshotClient),
  );
});

describe("Library routes", () => {
  it("uses independent research and artifact pagination defaults", async () => {
    const researchResponse = await GET_LIBRARY_RESEARCH(
      new Request("http://localhost/api/library/research"),
    );
    const artifactResponse = await GET_LIBRARY_ARTIFACTS(
      new Request("http://localhost/api/library/artifacts"),
    );

    expect(researchResponse.status).toBe(200);
    await expect(researchResponse.json()).resolves.toEqual({
      items: [researchItem],
      nextCursor: null,
    });
    expect(artifactResponse.status).toBe(200);
    await expect(artifactResponse.json()).resolves.toEqual({
      items: [artifactItem],
      nextCursor: null,
    });
    expect(mocks.listLibraryResearchPage).toHaveBeenCalledWith({
      userId: ids.user,
      cursor: null,
      limit: 24,
    });
    expect(mocks.listLibraryArtifactPage).toHaveBeenCalledWith({
      userId: ids.user,
      cursor: null,
      limit: 24,
    });
  });

  it("passes each opaque cursor and explicit limit without interpretation", async () => {
    await GET_LIBRARY_RESEARCH(
      new Request(
        "http://localhost/api/library/research?cursor=opaque_cursor&limit=12",
      ),
    );
    await GET_LIBRARY_ARTIFACTS(
      new Request(
        "http://localhost/api/library/artifacts?cursor=artifact_cursor&limit=7",
      ),
    );

    expect(mocks.listLibraryResearchPage).toHaveBeenCalledWith({
      userId: ids.user,
      cursor: "opaque_cursor",
      limit: 12,
    });
    expect(mocks.listLibraryArtifactPage).toHaveBeenCalledWith({
      userId: ids.user,
      cursor: "artifact_cursor",
      limit: 7,
    });
  });

  it.each(["cursor=", "limit=0", "limit=51", "limit=1.5"])(
    "rejects invalid list query %s before repository access",
    async (query) => {
      const researchResponse = await GET_LIBRARY_RESEARCH(
        new Request(`http://localhost/api/library/research?${query}`),
      );
      const artifactResponse = await GET_LIBRARY_ARTIFACTS(
        new Request(`http://localhost/api/library/artifacts?${query}`),
      );

      expect(researchResponse.status).toBe(400);
      expect(artifactResponse.status).toBe(400);
      expect(mocks.listLibraryResearchPage).not.toHaveBeenCalled();
      expect(mocks.listLibraryArtifactPage).not.toHaveBeenCalled();
    },
  );

  it("reads one eligible research detail through a repeatable-read client", async () => {
    const response = await GET_LIBRARY_RESEARCH_DETAIL(
      new Request(`http://localhost/api/library/research/${ids.snapshot}`),
      { params: Promise.resolve({ snapshotId: ids.snapshot }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ research: researchDetail });
    expect(
      mocks.withReadOnlyRepeatableReadTransaction,
    ).toHaveBeenCalledOnce();
    expect(mocks.getLibraryResearchDetail).toHaveBeenCalledWith(
      ids.user,
      ids.snapshot,
      mocks.snapshotClient,
    );
  });

  it("returns the same 404 for an inaccessible or absent research snapshot", async () => {
    mocks.getLibraryResearchDetail.mockResolvedValueOnce(null);
    const response = await GET_LIBRARY_RESEARCH_DETAIL(
      new Request(`http://localhost/api/library/research/${ids.snapshot}`),
      { params: Promise.resolve({ snapshotId: ids.snapshot }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "NOT_FOUND", message: "研究资料不存在。" },
    });
  });

  it("rejects an invalid detail UUID before opening a transaction", async () => {
    const response = await GET_LIBRARY_RESEARCH_DETAIL(
      new Request("http://localhost/api/library/research/not-a-uuid"),
      { params: Promise.resolve({ snapshotId: "not-a-uuid" }) },
    );

    expect(response.status).toBe(400);
    expect(
      mocks.withReadOnlyRepeatableReadTransaction,
    ).not.toHaveBeenCalled();
    expect(mocks.getLibraryResearchDetail).not.toHaveBeenCalled();
  });
});
