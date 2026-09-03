import { beforeEach, describe, expect, it, vi } from "vitest";

import { BootstrapResponseSchema } from "@/lib/contracts";
import { TEST_EXECUTION_PROFILE_CATALOG } from "@/tests/fixtures/run-config";

const userId = "11111111-1111-4111-8111-111111111111";
const conversation = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "German pump buyers",
  updatedAt: "2026-08-28T01:00:00.000Z",
  pinnedAt: null,
  archivedAt: null,
  selectedRunId: null,
  activeRun: null,
  waitingRunCount: 0,
  attention: null,
};

const mocks = vi.hoisted(() => ({
  getCurrentUserId: vi.fn(),
  getUserAccount: vi.fn(),
  getEnv: vi.fn(),
  listConversationPage: vi.fn(),
  listTrackedConversations: vi.fn(),
  snapshotClient: { query: vi.fn() },
  withReadOnlyRepeatableReadTransaction: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

vi.mock("@/lib/db", () => ({
  getUserAccount: mocks.getUserAccount,
  listConversationPage: mocks.listConversationPage,
  listTrackedConversations: mocks.listTrackedConversations,
  withReadOnlyRepeatableReadTransaction:
    mocks.withReadOnlyRepeatableReadTransaction,
}));

vi.mock("@/lib/env", () => ({
  getEnv: mocks.getEnv,
}));

import { GET } from "@/app/api/bootstrap/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUserId.mockReturnValue(userId);
  mocks.getUserAccount.mockResolvedValue({
    user: { id: userId, name: "测试用户" },
    credits: { available: 10_000, reserved: 500 },
  });
  mocks.listConversationPage.mockResolvedValue({
    items: [],
    nextCursor: null,
  });
  mocks.listTrackedConversations.mockResolvedValue([]);
  mocks.withReadOnlyRepeatableReadTransaction.mockImplementation(
    async (operation: (client: unknown) => Promise<unknown>) =>
      operation(mocks.snapshotClient),
  );
  mocks.getEnv.mockReturnValue({
    INPUT_ATTACHMENT_MAX_BYTES: 8 * 1024 * 1024,
    INPUT_ATTACHMENT_MAX_PER_MESSAGE: 3,
    INPUT_ATTACHMENT_MAX_TOTAL_BYTES: 18 * 1024 * 1024,
  });
});

describe("GET /api/bootstrap", () => {
  it("returns the fixed contract from one account and conversation snapshot", async () => {
    mocks.listConversationPage.mockResolvedValueOnce({
      items: [{ ...conversation, searchMatch: null }],
      nextCursor: null,
    });
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      user: { id: userId, name: "测试用户" },
      credits: { available: 10_000, reserved: 500 },
      conversations: [conversation],
      nextCursor: null,
      trackedConversations: [],
      inputAttachmentLimits: {
        maxFileBytes: 8 * 1024 * 1024,
        maxFilesPerMessage: 3,
        maxTotalBytesPerMessage: 18 * 1024 * 1024,
      },
      executionProfiles: TEST_EXECUTION_PROFILE_CATALOG,
    });
    expect(BootstrapResponseSchema.parse(body)).toEqual(body);
    expect(
      mocks.withReadOnlyRepeatableReadTransaction,
    ).toHaveBeenCalledOnce();
    expect(mocks.getCurrentUserId).toHaveBeenCalledOnce();
    expect(mocks.getUserAccount).toHaveBeenCalledWith(
      userId,
      mocks.snapshotClient,
    );
    expect(mocks.listConversationPage).toHaveBeenCalledWith(
      {
        userId,
        view: "active",
        query: "",
        cursor: null,
        limit: 30,
      },
      mocks.snapshotClient,
    );
    expect(mocks.listTrackedConversations).toHaveBeenCalledWith(
      userId,
      mocks.snapshotClient,
    );
  });

  it("requires the exact bootstrap shape without missing or unknown fields", () => {
    const valid = {
      user: { id: userId, name: "测试用户" },
      credits: { available: 10_000, reserved: 500 },
      conversations: [],
      nextCursor: null,
      trackedConversations: [],
      inputAttachmentLimits: {
        maxFileBytes: 100,
        maxFilesPerMessage: 2,
        maxTotalBytesPerMessage: 150,
      },
      executionProfiles: TEST_EXECUTION_PROFILE_CATALOG,
    };

    expect(
      BootstrapResponseSchema.safeParse({
        ...valid,
        inputAttachmentLimits: {
          ...valid.inputAttachmentLimits,
          unsupported: true,
        },
      }).success,
    ).toBe(false);
    expect(
      BootstrapResponseSchema.safeParse({
        user: valid.user,
        credits: valid.credits,
        conversations: valid.conversations,
        nextCursor: valid.nextCursor,
        trackedConversations: valid.trackedConversations,
        executionProfiles: valid.executionProfiles,
      }).success,
    ).toBe(false);
    expect(
      BootstrapResponseSchema.safeParse({
        user: valid.user,
        credits: valid.credits,
        conversations: valid.conversations,
        trackedConversations: valid.trackedConversations,
        inputAttachmentLimits: valid.inputAttachmentLimits,
        executionProfiles: valid.executionProfiles,
      }).success,
    ).toBe(false);
    expect(
      BootstrapResponseSchema.safeParse({
        user: valid.user,
        credits: valid.credits,
        conversations: valid.conversations,
        nextCursor: valid.nextCursor,
        inputAttachmentLimits: valid.inputAttachmentLimits,
        executionProfiles: valid.executionProfiles,
      }).success,
    ).toBe(false);
    expect(
      BootstrapResponseSchema.safeParse({ ...valid, unsupported: true }).success,
    ).toBe(false);
  });
});
