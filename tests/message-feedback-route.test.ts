import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/errors";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  message: "22222222-2222-4222-8222-222222222222",
};

const mocks = vi.hoisted(() => ({
  getCurrentUserId: vi.fn(),
  setMessageFeedback: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

vi.mock("@/lib/db", () => ({
  setMessageFeedback: mocks.setMessageFeedback,
}));

import { PATCH } from "@/app/api/messages/[messageId]/feedback/route";

function context(messageId = ids.message) {
  return { params: Promise.resolve({ messageId }) };
}

function request(body: unknown): Request {
  return new Request(
    `http://localhost/api/messages/${ids.message}/feedback`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUserId.mockReturnValue(ids.user);
  mocks.setMessageFeedback.mockImplementation(
    async (_userId: string, messageId: string, feedback: unknown) => ({
      messageId,
      feedback,
    }),
  );
});

describe("PATCH /api/messages/:messageId/feedback", () => {
  it.each(["up", "down", null] as const)(
    "stores and returns the exact %s feedback value",
    async (feedback) => {
      const response = await PATCH(request({ feedback }), context());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        messageId: ids.message,
        feedback,
      });
      expect(mocks.setMessageFeedback).toHaveBeenCalledWith(
        ids.user,
        ids.message,
        feedback,
      );
    },
  );

  it.each([
    {},
    { feedback: "sideways" },
    { feedback: true },
    { feedback: "up", reason: "useful" },
    null,
    [],
  ])("rejects the non-contract body %#", async (body) => {
    const response = await PATCH(request(body), context());

    expect(response.status).toBe(400);
    expect(mocks.setMessageFeedback).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and an invalid message ID", async () => {
    const malformedRequest = new Request(
      `http://localhost/api/messages/${ids.message}/feedback`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{",
      },
    );

    await expect(PATCH(malformedRequest, context())).resolves.toMatchObject({
      status: 400,
    });
    await expect(
      PATCH(request({ feedback: "up" }), context("not-a-uuid")),
    ).resolves.toMatchObject({ status: 400 });
    expect(mocks.setMessageFeedback).not.toHaveBeenCalled();
  });

  it("returns one hidden 404 for an unavailable or ineligible message", async () => {
    mocks.setMessageFeedback.mockRejectedValue(
      new AppError("NOT_FOUND", "Message was not found", 404),
    );

    const response = await PATCH(request({ feedback: "down" }), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "NOT_FOUND", message: "Message was not found" },
    });
  });
});
