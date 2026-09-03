import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRun, ConversationSummary } from "@/lib/contracts";
import { AppError } from "@/lib/errors";
import { TEST_CAPTURED_RUN_EXECUTION_SUMMARY } from "@/tests/fixtures/run-config";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  conversation: "22222222-2222-4222-8222-222222222222",
  run: "33333333-3333-4333-8333-333333333333",
};

const mocks = vi.hoisted(() => ({
  archiveAllConversations: vi.fn(),
  createConversation: vi.fn(),
  getConversation: vi.fn(),
  getCurrentUserId: vi.fn(),
  listConversationPage: vi.fn(),
  listConversationRuns: vi.fn(),
  listMessages: vi.fn(),
  patchConversation: vi.fn(),
  snapshotClient: { query: vi.fn() },
  softDeleteAllConversations: vi.fn(),
  softDeleteConversation: vi.fn(),
  withReadOnlyRepeatableReadTransaction: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

vi.mock("@/lib/db", () => ({
  archiveAllConversations: mocks.archiveAllConversations,
  createConversation: mocks.createConversation,
  getConversation: mocks.getConversation,
  listConversationPage: mocks.listConversationPage,
  listMessages: mocks.listMessages,
  patchConversation: mocks.patchConversation,
  softDeleteAllConversations: mocks.softDeleteAllConversations,
  softDeleteConversation: mocks.softDeleteConversation,
  withReadOnlyRepeatableReadTransaction:
    mocks.withReadOnlyRepeatableReadTransaction,
}));

vi.mock("@/lib/runs", () => ({
  listConversationRuns: mocks.listConversationRuns,
}));

import {
  DELETE as DELETE_CONVERSATIONS,
  GET as LIST_CONVERSATIONS,
  PATCH as PATCH_CONVERSATIONS,
} from "@/app/api/conversations/route";
import {
  DELETE as DELETE_CONVERSATION,
  GET as GET_CONVERSATION,
  PATCH as PATCH_CONVERSATION,
} from "@/app/api/conversations/[conversationId]/route";

const timestamp = "2026-08-25T08:00:00.000Z";
const archiveAllMutation = {
  action: "archive_all" as const,
  conversationCount: 2,
  completedAt: timestamp,
};
const deleteAllMutation = {
  action: "delete_all" as const,
  conversationCount: 3,
  completedAt: timestamp,
};
const conversation: ConversationSummary = {
  id: ids.conversation,
  title: "德国工业泵买家",
  updatedAt: timestamp,
  pinnedAt: null,
  archivedAt: null,
  selectedRunId: null,
  activeRun: null,
  waitingRunCount: 0,
  attention: null,
};
const conversationListItem = { ...conversation, searchMatch: null };
const searchedConversationListItem = {
  ...conversation,
  searchMatch: {
    kind: "message" as const,
    messageId: "77777777-7777-4777-8777-777777777777",
    role: "user" as const,
    createdAt: timestamp,
    excerpt: {
      before: "German ",
      match: "pump",
      after: " buyer",
      beforeTruncated: false,
      afterTruncated: false,
    },
  },
};

const stoppingRun: AgentRun = {
  id: ids.run,
  requestId: "44444444-4444-4444-8444-444444444444",
  conversationId: ids.conversation,
  inputMessageId: "55555555-5555-4555-8555-555555555555",
  assistantMessageId: "66666666-6666-4666-8666-666666666666",
  status: "running",
  conversationTurn: "1",
  attemptIndex: 1,
  predecessorRunId: null,
  retryOfRunId: null,
  regenerateOfRunId: null,
  executionConfig: TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
  failure: null,
  createdAt: timestamp,
  startedAt: "2026-08-25T08:00:01.000Z",
  finishedAt: null,
  cancelRequestedAt: "2026-08-25T08:00:30.000Z",
};

function context(conversationId = ids.conversation) {
  return { params: Promise.resolve({ conversationId }) };
}

function patchRequest(body: unknown): Request {
  return new Request(
    `http://localhost/api/conversations/${ids.conversation}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function bulkPatchRequest(body: unknown): Request {
  return new Request("http://localhost/api/conversations", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUserId.mockReturnValue(ids.user);
  mocks.archiveAllConversations.mockResolvedValue(archiveAllMutation);
  mocks.listConversationPage.mockResolvedValue({
    items: [conversationListItem],
    nextCursor: null,
  });
  mocks.getConversation.mockResolvedValue(conversation);
  mocks.listMessages.mockResolvedValue([]);
  mocks.listConversationRuns.mockResolvedValue([]);
  mocks.patchConversation.mockResolvedValue(conversation);
  mocks.softDeleteAllConversations.mockResolvedValue(deleteAllMutation);
  mocks.softDeleteConversation.mockResolvedValue({
    conversationId: ids.conversation,
    deletedAt: timestamp,
  });
  mocks.withReadOnlyRepeatableReadTransaction.mockImplementation(
    async (operation: (client: unknown) => Promise<unknown>) =>
      operation(mocks.snapshotClient),
  );
});

describe("GET /api/conversations", () => {
  it("uses the fixed active-list defaults", async () => {
    const response = await LIST_CONVERSATIONS(
      new Request("http://localhost/api/conversations"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [conversationListItem],
      nextCursor: null,
    });
    expect(mocks.listConversationPage).toHaveBeenCalledWith({
      userId: ids.user,
      view: "active",
      query: "",
      cursor: null,
      limit: 30,
    });
  });

  it("trims search text and passes archived keyset pagination exactly", async () => {
    mocks.listConversationPage.mockResolvedValueOnce({
      items: [searchedConversationListItem],
      nextCursor: "next_opaque_cursor",
    });
    const response = await LIST_CONVERSATIONS(
      new Request(
        "http://localhost/api/conversations?view=archived&query=%20pump%20&cursor=opaque_cursor&limit=12",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [searchedConversationListItem],
      nextCursor: "next_opaque_cursor",
    });
    expect(mocks.listConversationPage).toHaveBeenCalledWith({
      userId: ids.user,
      view: "archived",
      query: "pump",
      cursor: "opaque_cursor",
      limit: 12,
    });
  });

  it.each([
    "view=deleted",
    "limit=0",
    "limit=51",
    "limit=1.5",
    `query=${"x".repeat(201)}`,
    "query=%00",
    "cursor=",
  ])("rejects invalid list query %s", async (query) => {
    const response = await LIST_CONVERSATIONS(
      new Request(`http://localhost/api/conversations?${query}`),
    );

    expect(response.status).toBe(400);
    expect(mocks.listConversationPage).not.toHaveBeenCalled();
  });
});

describe("bulk /api/conversations mutations", () => {
  it("archives every eligible owned conversation from one strict PATCH", async () => {
    const response = await PATCH_CONVERSATIONS(
      bulkPatchRequest({ action: "archive_all" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mutation: archiveAllMutation,
    });
    expect(mocks.archiveAllConversations).toHaveBeenCalledOnce();
    expect(mocks.archiveAllConversations).toHaveBeenCalledWith(ids.user);
  });

  it.each([
    {},
    { action: "delete_all" },
    { action: "archive_all", extra: true },
  ])("rejects a non-contract bulk PATCH body %j", async (body) => {
    const response = await PATCH_CONVERSATIONS(bulkPatchRequest(body));

    expect(response.status).toBe(400);
    expect(mocks.archiveAllConversations).not.toHaveBeenCalled();
  });

  it("soft-deletes every eligible owned conversation without a DELETE body", async () => {
    const response = await DELETE_CONVERSATIONS();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mutation: deleteAllMutation,
    });
    expect(mocks.softDeleteAllConversations).toHaveBeenCalledOnce();
    expect(mocks.softDeleteAllConversations).toHaveBeenCalledWith(ids.user);
  });

  it("returns an exact idempotent empty mutation receipt", async () => {
    mocks.archiveAllConversations.mockResolvedValueOnce({
      ...archiveAllMutation,
      conversationCount: 0,
    });
    mocks.softDeleteAllConversations.mockResolvedValueOnce({
      ...deleteAllMutation,
      conversationCount: 0,
    });

    const archiveResponse = await PATCH_CONVERSATIONS(
      bulkPatchRequest({ action: "archive_all" }),
    );
    const deleteResponse = await DELETE_CONVERSATIONS();

    await expect(archiveResponse.json()).resolves.toEqual({
      mutation: { ...archiveAllMutation, conversationCount: 0 },
    });
    await expect(deleteResponse.json()).resolves.toEqual({
      mutation: { ...deleteAllMutation, conversationCount: 0 },
    });
  });

  it.each([
    ["archive_all", PATCH_CONVERSATIONS] as const,
    ["delete_all", DELETE_CONVERSATIONS] as const,
  ])("preserves the fixed ACTIVE_RUN conflict for %s", async (action, handler) => {
    const repository = action === "archive_all"
      ? mocks.archiveAllConversations
      : mocks.softDeleteAllConversations;
    repository.mockRejectedValueOnce(
      new AppError("ACTIVE_RUN", "Conversation has an active run", 409),
    );

    const response = action === "archive_all"
      ? await handler(bulkPatchRequest({ action: "archive_all" }))
      : await handler();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "ACTIVE_RUN",
        message: "Conversation has an active run",
      },
    });
  });
});

describe("GET /api/conversations/:id", () => {
  it("reads the fixed detail contract through one snapshot client", async () => {
    const response = await GET_CONVERSATION(
      new Request(`http://localhost/api/conversations/${ids.conversation}`),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      conversation,
      messages: [],
      runs: [],
    });
    expect(
      mocks.withReadOnlyRepeatableReadTransaction,
    ).toHaveBeenCalledOnce();
    expect(mocks.getConversation).toHaveBeenCalledWith(
      ids.user,
      ids.conversation,
      mocks.snapshotClient,
    );
    expect(mocks.listMessages).toHaveBeenCalledWith(
      ids.user,
      ids.conversation,
      mocks.snapshotClient,
    );
    expect(mocks.listConversationRuns).toHaveBeenCalledWith(
      ids.user,
      ids.conversation,
      mocks.snapshotClient,
    );
  });

  it("includes a running Run's persisted cancellation request in detail", async () => {
    mocks.listConversationRuns.mockResolvedValueOnce([stoppingRun]);

    const response = await GET_CONVERSATION(
      new Request(`http://localhost/api/conversations/${ids.conversation}`),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      conversation,
      messages: [],
      runs: [stoppingRun],
    });
  });

  it("does not issue concurrent queries through the snapshot client", async () => {
    const messagesRead = Promise.withResolvers<never[]>();
    mocks.listMessages.mockReturnValueOnce(messagesRead.promise);

    const responsePromise = GET_CONVERSATION(
      new Request(`http://localhost/api/conversations/${ids.conversation}`),
      context(),
    );

    await vi.waitFor(() => {
      expect(mocks.listMessages).toHaveBeenCalledOnce();
    });
    expect(mocks.listConversationRuns).not.toHaveBeenCalled();

    messagesRead.resolve([]);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(mocks.listConversationRuns).toHaveBeenCalledOnce();
  });

  it("returns 404 from inside the snapshot when the conversation is absent", async () => {
    mocks.getConversation.mockResolvedValue(null);

    const response = await GET_CONVERSATION(
      new Request(`http://localhost/api/conversations/${ids.conversation}`),
      context(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(mocks.listMessages).not.toHaveBeenCalled();
    expect(mocks.listConversationRuns).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/conversations/:id", () => {
  it.each([
    [
      { action: "rename", title: "  新标题  " },
      { action: "rename", title: "新标题" },
    ],
    [
      { action: "set_pinned", pinned: true },
      { action: "set_pinned", pinned: true },
    ],
    [
      { action: "set_archived", archived: false },
      { action: "set_archived", archived: false },
    ],
    [
      { action: "mark_read", throughEventId: "42" },
      { action: "mark_read", throughEventId: "42" },
    ],
    [
      { action: "select_run", runId: ids.run },
      { action: "select_run", runId: ids.run },
    ],
  ])("applies the exact %s action", async (body, parsed) => {
    const response = await PATCH_CONVERSATION(
      patchRequest(body),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ conversation });
    expect(mocks.patchConversation).toHaveBeenCalledWith(
      ids.user,
      ids.conversation,
      parsed,
    );
  });

  it.each([
    { action: "rename", title: "" },
    { action: "rename", title: "valid", extra: true },
    { action: "set_pinned", pinned: "yes" },
    { action: "set_archived" },
    { action: "mark_read", throughEventId: "0" },
    { action: "mark_read", throughEventId: "9223372036854775808" },
    { action: "mark_read", throughEventId: "42", extra: true },
    { action: "select_run", runId: "not-a-uuid" },
    { action: "unknown" },
  ])("rejects a non-contract body", async (body) => {
    const response = await PATCH_CONVERSATION(
      patchRequest(body),
      context(),
    );

    expect(response.status).toBe(400);
    expect(mocks.patchConversation).not.toHaveBeenCalled();
  });

  it.each([
    { action: "set_archived", archived: true },
    { action: "select_run", runId: ids.run },
  ])("returns the fixed active-run conflict for $action", async (body) => {
    mocks.patchConversation.mockRejectedValue(
      new AppError("ACTIVE_RUN", "Conversation has an active run", 409),
    );

    const response = await PATCH_CONVERSATION(
      patchRequest(body),
      context(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "ACTIVE_RUN",
        message: "Conversation has an active run",
      },
    });
  });
});

describe("DELETE /api/conversations/:id", () => {
  it("returns the exact soft-deletion receipt", async () => {
    const request = new Request(
      `http://localhost/api/conversations/${ids.conversation}`,
      { method: "DELETE" },
    );
    const response = await DELETE_CONVERSATION(request, context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deletion: {
        conversationId: ids.conversation,
        deletedAt: timestamp,
      },
    });
    expect(mocks.softDeleteConversation).toHaveBeenCalledWith(
      ids.user,
      ids.conversation,
    );
  });

  it("hides missing, cross-user, and already-deleted rows behind 404", async () => {
    mocks.softDeleteConversation.mockRejectedValue(
      new AppError("NOT_FOUND", "Conversation was not found", 404),
    );
    const request = new Request(
      `http://localhost/api/conversations/${ids.conversation}`,
      { method: "DELETE" },
    );

    const response = await DELETE_CONVERSATION(request, context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });
});
