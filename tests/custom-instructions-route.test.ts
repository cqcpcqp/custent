import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountCustomInstructions } from "@/lib/contracts";
import { AppError } from "@/lib/errors";

const userId = "11111111-1111-4111-8111-111111111111";
const initialSetting: AccountCustomInstructions = {
  enabled: false,
  content: "",
  revision: 0,
  updatedAt: "2026-09-01T03:00:00.000Z",
};

const mocks = vi.hoisted(() => ({
  getAccountCustomInstructions: vi.fn(),
  getCurrentUserId: vi.fn(),
  updateAccountCustomInstructions: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

vi.mock("@/lib/custom-instructions", () => ({
  getAccountCustomInstructions: mocks.getAccountCustomInstructions,
  updateAccountCustomInstructions: mocks.updateAccountCustomInstructions,
}));

import {
  GET,
  PUT,
} from "@/app/api/account/custom-instructions/route";

function putRequest(body: unknown): Request {
  return new Request("http://localhost/api/account/custom-instructions", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUserId.mockReturnValue(userId);
  mocks.getAccountCustomInstructions.mockResolvedValue(initialSetting);
  mocks.updateAccountCustomInstructions.mockResolvedValue({
    enabled: true,
    content: "  Research only public sources.\n",
    revision: 1,
    updatedAt: "2026-09-01T03:01:00.000Z",
  } satisfies AccountCustomInstructions);
});

describe("/api/account/custom-instructions", () => {
  it("returns the fixed GET envelope for the current owner", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      customInstructions: initialSetting,
    });
    expect(mocks.getAccountCustomInstructions).toHaveBeenCalledWith(userId);
  });

  it("preserves PUT content and passes the expected revision", async () => {
    const body = {
      enabled: true,
      content: "  Research only public sources.\n",
      expectedRevision: 0,
    };
    const response = await PUT(putRequest(body));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      customInstructions: {
        enabled: true,
        content: body.content,
        revision: 1,
        updatedAt: "2026-09-01T03:01:00.000Z",
      },
    });
    expect(mocks.updateAccountCustomInstructions).toHaveBeenCalledWith({
      userId,
      ...body,
    });
  });

  it.each([
    { enabled: true, content: " \n\t ", expectedRevision: 0 },
    { enabled: true, content: "x".repeat(4_001), expectedRevision: 0 },
    { enabled: true, content: "valid", expectedRevision: -1 },
    {
      enabled: true,
      content: "valid",
      expectedRevision: 0,
      unexpected: true,
    },
  ])("rejects an invalid PUT body %#", async (body) => {
    const response = await PUT(putRequest(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "请求内容不符合接口约定。",
      },
    });
    expect(mocks.updateAccountCustomInstructions).not.toHaveBeenCalled();
  });

  it("returns the stable optimistic-concurrency conflict", async () => {
    mocks.updateAccountCustomInstructions.mockRejectedValueOnce(
      new AppError(
        "CUSTOM_INSTRUCTIONS_REVISION_CONFLICT",
        "自定义指令已在其他页面更新，请刷新后重试。",
        409,
      ),
    );
    const response = await PUT(
      putRequest({
        enabled: true,
        content: "Valid instructions",
        expectedRevision: 3,
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "CUSTOM_INSTRUCTIONS_REVISION_CONFLICT",
        message: "自定义指令已在其他页面更新，请刷新后重试。",
      },
    });
  });

  it("rejects malformed JSON without reaching the repository", async () => {
    const response = await PUT(
      new Request("http://localhost/api/account/custom-instructions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.updateAccountCustomInstructions).not.toHaveBeenCalled();
  });
});
