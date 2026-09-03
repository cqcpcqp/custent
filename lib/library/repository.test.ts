import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Queryable } from "@/lib/db/types";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  conversation: "22222222-2222-4222-8222-222222222222",
  run: "33333333-3333-4333-8333-333333333333",
  assistant: "44444444-4444-4444-8444-444444444444",
  firstSnapshot: "55555555-5555-4555-8555-555555555555",
  secondSnapshot: "55555555-5555-4555-8555-555555555554",
  artifact: "66666666-6666-4666-8666-666666666666",
  company: "77777777-7777-4777-8777-777777777777",
};

const mocks = vi.hoisted(() => ({
  getResearchSnapshot: vi.fn(),
}));

vi.mock("@/lib/research", () => ({
  getResearchSnapshot: mocks.getResearchSnapshot,
}));

import {
  getLibraryResearchDetail,
  listLibraryArtifactPage,
  listLibraryResearchPage,
} from "./repository";

const createdAt = new Date("2026-08-28T08:00:00.123Z");
const cursorCreatedAt = "2026-08-28T08:00:00.123456Z";

function researchRow(id: string) {
  return {
    id,
    title: `Research ${id}`,
    query_summary: "Public-source research.",
    company_count: 1,
    created_at: createdAt,
    cursor_created_at: cursorCreatedAt,
    conversation_id: ids.conversation,
    conversation_title: "Archived buyers",
    conversation_archived_at: createdAt,
    run_id: ids.run,
    assistant_message_id: ids.assistant,
  };
}

function artifactRow() {
  return {
    id: ids.artifact,
    name: "buyers.csv",
    mime_type: "text/csv" as const,
    size_bytes: 128,
    created_at: createdAt,
    cursor_created_at: cursorCreatedAt,
    conversation_id: ids.conversation,
    conversation_title: "Archived buyers",
    conversation_archived_at: createdAt,
    run_id: ids.run,
    assistant_message_id: ids.assistant,
    research_snapshot_id: ids.firstSnapshot,
  };
}

function databaseWithRows(...rowSets: unknown[][]) {
  const query = vi.fn();
  for (const rows of rowSets) {
    query.mockResolvedValueOnce({ rowCount: rows.length, rows });
  }
  return { database: { query } as unknown as Queryable, query };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Library repository", () => {
  it("paginates research with a kind-bound microsecond keyset cursor", async () => {
    const mock = databaseWithRows(
      [researchRow(ids.firstSnapshot), researchRow(ids.secondSnapshot)],
      [researchRow(ids.secondSnapshot)],
    );

    const firstPage = await listLibraryResearchPage(
      { userId: ids.user, cursor: null, limit: 1 },
      mock.database,
    );
    expect(firstPage.items.map((item) => item.id)).toEqual([ids.firstSnapshot]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await listLibraryResearchPage(
      { userId: ids.user, cursor: firstPage.nextCursor, limit: 1 },
      mock.database,
    );
    expect(secondPage.items.map((item) => item.id)).toEqual([ids.secondSnapshot]);
    expect(secondPage.nextCursor).toBeNull();
    expect(mock.query.mock.calls[1]?.[1]).toEqual([
      ids.user,
      cursorCreatedAt,
      ids.firstSnapshot,
      2,
    ]);

    const sql = String(mock.query.mock.calls[0]?.[0]);
    expect(sql).toContain("conversation.deleted_at IS NULL");
    expect(sql).toContain("run.status = 'completed'");
    expect(sql).toContain("assistant_message.id = run.assistant_message_id");
    expect(sql).toContain("assistant_message.run_id = run.id");
    expect(sql).not.toContain("conversation.archived_at IS NULL");
  });

  it("rejects a research cursor on the artifact endpoint before querying", async () => {
    const research = databaseWithRows([
      researchRow(ids.firstSnapshot),
      researchRow(ids.secondSnapshot),
    ]);
    const page = await listLibraryResearchPage(
      { userId: ids.user, cursor: null, limit: 1 },
      research.database,
    );
    const artifacts = databaseWithRows();

    await expect(
      listLibraryArtifactPage(
        { userId: ids.user, cursor: page.nextCursor, limit: 1 },
        artifacts.database,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400,
    });
    expect(artifacts.query).not.toHaveBeenCalled();
  });

  it("lists only finalized assistant-bound artifacts with owner download URLs", async () => {
    const mock = databaseWithRows([artifactRow()]);
    const page = await listLibraryArtifactPage(
      { userId: ids.user, cursor: null, limit: 24 },
      mock.database,
    );

    expect(page).toEqual({
      items: [
        expect.objectContaining({
          id: ids.artifact,
          downloadUrl: `/api/artifacts/${ids.artifact}/download`,
          researchSnapshotId: ids.firstSnapshot,
        }),
      ],
      nextCursor: null,
    });
    const sql = String(mock.query.mock.calls[0]?.[0]);
    expect(sql).toContain("assistant_message.id = artifact.message_id");
    expect(sql).toContain("assistant_message.id = run.assistant_message_id");
    expect(sql).toContain("artifact.user_id = $1");
    expect(sql).toContain("conversation.deleted_at IS NULL");
    expect(sql).toContain("artifact_snapshot.id = artifact.research_snapshot_id");
    expect(sql).toContain("artifact_snapshot.user_id = artifact.user_id");
    expect(sql).toContain(
      "artifact_snapshot.conversation_id = artifact.conversation_id",
    );
    expect(sql).toContain("artifact.research_snapshot_id IS NULL");
    expect(sql).toContain("artifact_snapshot.id IS NOT NULL");
    expect(sql).not.toContain("input_attachments");
  });

  it("materializes detail only after the Library eligibility query succeeds", async () => {
    const row = researchRow(ids.firstSnapshot);
    const mock = databaseWithRows([row]);
    mocks.getResearchSnapshot.mockResolvedValue({
      id: ids.firstSnapshot,
      title: row.title,
      querySummary: row.query_summary,
      limitations: "Only public evidence was used.",
      createdAt: createdAt.toISOString(),
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
    });

    const detail = await getLibraryResearchDetail(
      ids.user,
      ids.firstSnapshot,
      mock.database,
    );
    expect(detail).toMatchObject({
      id: ids.firstSnapshot,
      companyCount: 1,
      limitations: "Only public evidence was used.",
    });
    expect(mocks.getResearchSnapshot).toHaveBeenCalledWith(
      ids.user,
      ids.firstSnapshot,
      mock.database,
    );
  });

  it("does not materialize an inaccessible snapshot", async () => {
    const mock = databaseWithRows([]);
    await expect(
      getLibraryResearchDetail(ids.user, ids.firstSnapshot, mock.database),
    ).resolves.toBeNull();
    expect(mocks.getResearchSnapshot).not.toHaveBeenCalled();
  });
});
