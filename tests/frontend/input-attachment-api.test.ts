import { afterEach, describe, expect, it, vi } from "vitest";

import { getStagedInputAttachment } from "@/components/api-client";

const metadata = {
  attachment: {
    id: "20000000-0000-4000-8000-000000000001",
    kind: "file" as const,
    name: "buyers.txt",
    mimeType: "text/plain" as const,
    sizeBytes: 12,
    downloadUrl:
      "/api/input-attachments/20000000-0000-4000-8000-000000000001/content",
    createdAt: "2026-08-29T08:00:00.000Z",
  },
  expiresAt: "2026-08-30T08:00:00.000Z",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("staged input attachment API client", () => {
  it("loads the existing attachment resource without caching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(metadata));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getStagedInputAttachment(metadata.attachment.id),
    ).resolves.toEqual(metadata);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/input-attachments/${metadata.attachment.id}`,
      { method: "GET", cache: "no-store", signal: undefined },
    );
  });

  it("rejects fields outside the fixed metadata contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ ...metadata, staged: true }),
      ),
    );

    await expect(
      getStagedInputAttachment(metadata.attachment.id),
    ).rejects.toThrow();
  });

  it("preserves code/status without exposing the backend message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "NOT_FOUND",
              message: "附件不存在。",
            },
          },
          404,
        ),
      ),
    );

    await expect(
      getStagedInputAttachment(metadata.attachment.id),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "服务请求失败",
      status: 404,
    });
  });
});
