import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/errors";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  attachment: "22222222-2222-4222-8222-222222222222",
  message: "33333333-3333-4333-8333-333333333333",
};

const mocks = vi.hoisted(() => ({
  createInputAttachment: vi.fn(),
  deleteStagedInputAttachment: vi.fn(),
  deleteStoredInputAttachment: vi.fn(),
  getCurrentUserId: vi.fn(),
  getEnv: vi.fn(),
  getInputAttachmentContentRecord: vi.fn(),
  getStagedInputAttachment: vi.fn(),
  processInputAttachmentDeletion: vi.fn(),
  resolveStoredInputAttachmentPath: vi.fn(),
  storeInputAttachment: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

vi.mock("@/lib/env", () => ({
  getEnv: mocks.getEnv,
}));

vi.mock("@/lib/input-attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/input-attachments")>()),
  createInputAttachment: mocks.createInputAttachment,
  deleteStagedInputAttachment: mocks.deleteStagedInputAttachment,
  deleteStoredInputAttachment: mocks.deleteStoredInputAttachment,
  getInputAttachmentContentRecord: mocks.getInputAttachmentContentRecord,
  getStagedInputAttachment: mocks.getStagedInputAttachment,
  processInputAttachmentDeletion: mocks.processInputAttachmentDeletion,
  resolveStoredInputAttachmentPath: mocks.resolveStoredInputAttachmentPath,
  storeInputAttachment: mocks.storeInputAttachment,
}));

import {
  DELETE,
  GET as GET_METADATA,
} from "@/app/api/input-attachments/[attachmentId]/route";
import { GET as GET_CONTENT } from "@/app/api/input-attachments/[attachmentId]/content/route";
import { POST } from "@/app/api/input-attachments/route";

const createdAt = "2026-08-25T08:00:00.000Z";
const expiresAt = "2026-08-26T08:00:00.000Z";
const storedAttachment = {
  id: ids.attachment,
  kind: "file" as const,
  originalName: "buyers.txt",
  mimeType: "text/plain" as const,
  sizeBytes: 6,
  sha256: createHash("sha256").update("buyers").digest("hex"),
  storagePath: ids.attachment,
};
const attachmentSummary = {
  id: ids.attachment,
  kind: "file" as const,
  name: "buyers.txt",
  mimeType: "text/plain" as const,
  sizeBytes: 6,
  downloadUrl: `/api/input-attachments/${ids.attachment}/content`,
  createdAt,
};
const stagedAttachment = { attachment: attachmentSummary, expiresAt };

function uploadRequest(extraField = false): Request {
  const formData = new FormData();
  formData.append(
    "file",
    new File(["buyers"], "buyers.txt", { type: "text/plain" }),
  );
  if (extraField) {
    formData.append("description", "not allowed");
  }
  return new Request("http://localhost/api/input-attachments", {
    method: "POST",
    body: formData,
  });
}

function context() {
  return { params: Promise.resolve({ attachmentId: ids.attachment }) };
}

describe("input attachment routes", () => {
  let temporaryDirectory: string;
  let contentPath: string;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "custent-attachment-route-"),
    );
    contentPath = path.join(temporaryDirectory, "content");
  });

  afterAll(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUserId.mockReturnValue(ids.user);
    mocks.getEnv.mockReturnValue({
      INPUT_ATTACHMENT_DIR: temporaryDirectory,
      INPUT_ATTACHMENT_MAX_BYTES: 10 * 1024 * 1024,
      INPUT_ATTACHMENT_STAGED_TTL_HOURS: 24,
      INPUT_ATTACHMENT_DELETE_RETRY_MS: 30_000,
    });
    mocks.storeInputAttachment.mockResolvedValue(storedAttachment);
    mocks.createInputAttachment.mockResolvedValue(stagedAttachment);
    mocks.getStagedInputAttachment.mockResolvedValue(stagedAttachment);
    mocks.deleteStoredInputAttachment.mockResolvedValue(undefined);
    mocks.processInputAttachmentDeletion.mockResolvedValue(true);
    mocks.resolveStoredInputAttachmentPath.mockReturnValue(contentPath);
  });

  it("accepts exactly one file part and returns the fixed 201 response", async () => {
    const response = await POST(uploadRequest());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(stagedAttachment);
    expect(mocks.storeInputAttachment).toHaveBeenCalledWith({
      file: expect.any(File),
      storageDirectory: temporaryDirectory,
      maxBytes: 10 * 1024 * 1024,
    });
    expect(mocks.createInputAttachment).toHaveBeenCalledWith({
      userId: ids.user,
      stored: storedAttachment,
      expiresAt: expect.any(Date),
    });
  });

  it("rejects extra multipart fields and non-multipart requests", async () => {
    const extraFieldResponse = await POST(uploadRequest(true));
    expect(extraFieldResponse.status).toBe(400);
    const jsonResponse = await POST(
      new Request("http://localhost/api/input-attachments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(jsonResponse.status).toBe(400);
    expect(mocks.storeInputAttachment).not.toHaveBeenCalled();
  });

  it("removes the published file when the database insert fails", async () => {
    mocks.createInputAttachment.mockRejectedValue(
      new AppError("NOT_FOUND", "用户不存在。", 404),
    );

    const response = await POST(uploadRequest());

    expect(response.status).toBe(404);
    expect(mocks.deleteStoredInputAttachment).toHaveBeenCalledWith(
      temporaryDirectory,
      storedAttachment.storagePath,
    );
  });

  it("serves only an authorized byte-exact attachment", async () => {
    await writeFile(contentPath, "buyers");
    mocks.getInputAttachmentContentRecord.mockResolvedValue({
      ...storedAttachment,
      userId: ids.user,
      messageId: ids.message,
    });

    const response = await GET_CONTENT(
      new Request(`http://localhost${attachmentSummary.downloadUrl}`),
      context(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''buyers.txt",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.text()).resolves.toBe("buyers");
    expect(mocks.getInputAttachmentContentRecord).toHaveBeenCalledWith(
      ids.user,
      ids.attachment,
    );
  });

  it("serves validated image attachments inline for message previews", async () => {
    const imageBytes = Buffer.from("validated image bytes", "utf8");
    await writeFile(contentPath, imageBytes);
    mocks.getInputAttachmentContentRecord.mockResolvedValue({
      ...storedAttachment,
      userId: ids.user,
      kind: "image",
      originalName: "product image.png",
      mimeType: "image/png",
      sizeBytes: imageBytes.byteLength,
      sha256: createHash("sha256").update(imageBytes).digest("hex"),
    });

    const response = await GET_CONTENT(
      new Request(`http://localhost${attachmentSummary.downloadUrl}`),
      context(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe(
      "inline; filename*=UTF-8''product%20image.png",
    );
    await expect(response.arrayBuffer()).resolves.toEqual(
      imageBytes.buffer.slice(
        imageBytes.byteOffset,
        imageBytes.byteOffset + imageBytes.byteLength,
      ),
    );
  });

  it("returns 404 when the repository rejects attachment visibility", async () => {
    mocks.getInputAttachmentContentRecord.mockResolvedValue(null);

    const response = await GET_CONTENT(
      new Request(`http://localhost${attachmentSummary.downloadUrl}`),
      context(),
    );

    expect(response.status).toBe(404);
    expect(mocks.resolveStoredInputAttachmentPath).not.toHaveBeenCalled();
  });

  it("returns the exact live staged metadata for its owner", async () => {
    const response = await GET_METADATA(
      new Request(`http://localhost/api/input-attachments/${ids.attachment}`),
      context(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual(stagedAttachment);
    expect(mocks.getStagedInputAttachment).toHaveBeenCalledWith(
      ids.user,
      ids.attachment,
    );
  });

  it("returns 404 when staged metadata is not visible", async () => {
    mocks.getStagedInputAttachment.mockResolvedValue(null);

    const response = await GET_METADATA(
      new Request(`http://localhost/api/input-attachments/${ids.attachment}`),
      context(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "NOT_FOUND", message: "附件不存在。" },
    });
  });

  it("deletes the database row before removing staged storage", async () => {
    mocks.deleteStagedInputAttachment.mockResolvedValue({
      deletion: { attachmentId: ids.attachment, deletedAt: createdAt },
      storagePath: ids.attachment,
      completedAt: null,
    });

    const response = await DELETE(
      new Request(`http://localhost/api/input-attachments/${ids.attachment}`, {
        method: "DELETE",
      }),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deletion: { attachmentId: ids.attachment, deletedAt: createdAt },
    });
    expect(mocks.deleteStagedInputAttachment).toHaveBeenCalledWith(
      ids.user,
      ids.attachment,
    );
    expect(mocks.processInputAttachmentDeletion).toHaveBeenCalledWith({
      job: {
        attachmentId: ids.attachment,
        storagePath: ids.attachment,
      },
      storageDirectory: temporaryDirectory,
      retryDelayMs: 30_000,
    });
    expect(
      mocks.deleteStagedInputAttachment.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.processInputAttachmentDeletion.mock.invocationCallOrder[0],
    );
  });

  it("returns the fixed 409 error for a bound attachment", async () => {
    mocks.deleteStagedInputAttachment.mockRejectedValue(
      new AppError(
        "INVALID_REQUEST",
        "已发送的附件不能单独删除。",
        409,
      ),
    );

    const response = await DELETE(
      new Request(`http://localhost/api/input-attachments/${ids.attachment}`, {
        method: "DELETE",
      }),
      context(),
    );

    expect(response.status).toBe(409);
    expect(mocks.processInputAttachmentDeletion).not.toHaveBeenCalled();
  });

  it("keeps a logical deletion successful when physical cleanup is queued", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.deleteStagedInputAttachment.mockResolvedValue({
      deletion: { attachmentId: ids.attachment, deletedAt: createdAt },
      storagePath: ids.attachment,
      completedAt: null,
    });
    mocks.processInputAttachmentDeletion.mockRejectedValue(
      new Error("filesystem unavailable"),
    );

    const response = await DELETE(
      new Request(`http://localhost/api/input-attachments/${ids.attachment}`, {
        method: "DELETE",
      }),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deletion: { attachmentId: ids.attachment, deletedAt: createdAt },
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
