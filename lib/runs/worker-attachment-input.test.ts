import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { MessageInputAttachmentRecord } from "@/lib/input-attachments";
import {
  inputAttachmentFormatSpecifications,
  INPUT_ATTACHMENT_MIME_TYPES,
} from "@/lib/input-attachment-formats";

import {
  createCurrentUserInput,
  verifyLoadedInputAttachment,
} from "./worker-attachment-input";

const MESSAGE_ID = "10000000-0000-4000-8000-000000000001";
const FILE_ID = "20000000-0000-4000-8000-000000000001";
const IMAGE_ID = "30000000-0000-4000-8000-000000000001";

function attachment(
  overrides: Partial<MessageInputAttachmentRecord> &
    Pick<MessageInputAttachmentRecord, "id">,
): MessageInputAttachmentRecord {
  const bytes = Buffer.from("attachment", "utf8");
  return {
    userId: "40000000-0000-4000-8000-000000000001",
    messageId: MESSAGE_ID,
    position: 0,
    kind: "file",
    originalName: "buyers.txt",
    mimeType: "text/plain",
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    storagePath: overrides.id,
    createdAt: "2026-08-25T00:00:00.000Z",
    attachedAt: "2026-08-25T00:00:01.000Z",
    expiresAt: null,
    ...overrides,
    id: overrides.id,
  };
}

describe("worker attachment input", () => {
  it("represents text-only input with the same ordered AgentInputItem shape", () => {
    expect(
      createCurrentUserInput({
        messageId: MESSAGE_ID,
        text: "继续研究",
        attachmentIds: [],
        attachments: [],
      }),
    ).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "继续研究" }],
      },
    ]);
  });

  it("constructs one ordered user item and supports attachment-only input", () => {
    const file = attachment({ id: FILE_ID });
    const image = attachment({
      id: IMAGE_ID,
      position: 1,
      kind: "image",
      originalName: "factory.png",
      mimeType: "image/png",
    });

    expect(
      createCurrentUserInput({
        messageId: MESSAGE_ID,
        text: "",
        attachmentIds: [FILE_ID, IMAGE_ID],
        attachments: [file, image],
      }),
    ).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_file",
            file: `custent-attachment:${FILE_ID}`,
            filename: "buyers.txt",
          },
          {
            type: "input_image",
            image: `custent-attachment:${IMAGE_ID}`,
            detail: "auto",
          },
        ],
      },
    ]);
  });

  it("places text before attachments while preserving attachment positions", () => {
    expect(
      createCurrentUserInput({
        messageId: MESSAGE_ID,
        text: "分析这份买家名单",
        attachmentIds: [FILE_ID],
        attachments: [attachment({ id: FILE_ID })],
      })[0].content,
    ).toEqual([
      { type: "input_text", text: "分析这份买家名单" },
      {
        type: "input_file",
        file: `custent-attachment:${FILE_ID}`,
        filename: "buyers.txt",
      },
    ]);
  });

  it("constructs exact input_file or input_image content for every fixed MIME", () => {
    for (const mimeType of INPUT_ATTACHMENT_MIME_TYPES) {
      const specification = inputAttachmentFormatSpecifications[mimeType];
      const id = specification.kind === "file" ? FILE_ID : IMAGE_ID;
      const originalName = `fixture${specification.extensions[0]}`;
      const record = attachment({
        id,
        kind: specification.kind,
        mimeType,
        originalName,
      });

      expect(
        createCurrentUserInput({
          messageId: MESSAGE_ID,
          text: "",
          attachmentIds: [id],
          attachments: [record],
        }),
      ).toEqual([
        {
          role: "user",
          content: [
            specification.kind === "file"
              ? {
                  type: "input_file",
                  file: `custent-attachment:${id}`,
                  filename: originalName,
                }
              : {
                  type: "input_image",
                  image: `custent-attachment:${id}`,
                  detail: "auto",
                },
          ],
        },
      ]);
    }
  });

  it.each([
    {
      name: "count",
      attachmentIds: [FILE_ID, IMAGE_ID],
      attachments: [attachment({ id: FILE_ID })],
      expected: "count is inconsistent",
    },
    {
      name: "claim order",
      attachmentIds: [IMAGE_ID],
      attachments: [attachment({ id: FILE_ID })],
      expected: "order is inconsistent",
    },
    {
      name: "message binding",
      attachmentIds: [FILE_ID],
      attachments: [
        attachment({
          id: FILE_ID,
          messageId: "50000000-0000-4000-8000-000000000001",
        }),
      ],
      expected: "not bound to the claimed message position",
    },
    {
      name: "position binding",
      attachmentIds: [FILE_ID],
      attachments: [attachment({ id: FILE_ID, position: 1 })],
      expected: "not bound to the claimed message position",
    },
  ])("rejects inconsistent $name metadata", ({ attachmentIds, attachments, expected }) => {
    expect(() =>
      createCurrentUserInput({
        messageId: MESSAGE_ID,
        text: "",
        attachmentIds,
        attachments,
      }),
    ).toThrow(expected);
  });

  it("rejects a claimed run without text or attachments", () => {
    expect(() =>
      createCurrentUserInput({
        messageId: MESSAGE_ID,
        text: "",
        attachmentIds: [],
        attachments: [],
      }),
    ).toThrow("neither text nor attachments");
  });

  it("rejects fixed MIME and kind mismatches", () => {
    for (const record of [
      attachment({ id: FILE_ID, kind: "file", mimeType: "image/jpeg" }),
      attachment({ id: IMAGE_ID, kind: "image", mimeType: "text/csv" }),
    ]) {
      expect(() =>
        createCurrentUserInput({
          messageId: MESSAGE_ID,
          text: "",
          attachmentIds: [record.id],
          attachments: [record],
        }),
      ).toThrow("inconsistent");
    }
  });

  it("accepts only bytes whose size and SHA-256 exactly match the record", () => {
    const bytes = Buffer.from("attachment", "utf8");
    const record = attachment({ id: FILE_ID });

    expect(verifyLoadedInputAttachment(record, bytes)).toEqual({
      id: FILE_ID,
      kind: "file",
      name: "buyers.txt",
      mimeType: "text/plain",
      bytes,
    });
    expect(() =>
      verifyLoadedInputAttachment(
        { ...record, sizeBytes: record.sizeBytes + 1 },
        bytes,
      ),
    ).toThrow("byte length does not match");
    expect(() =>
      verifyLoadedInputAttachment({ ...record, sha256: "not-a-hash" }, bytes),
    ).toThrow("invalid stored SHA-256");
    expect(() =>
      verifyLoadedInputAttachment(
        {
          ...record,
          sha256: createHash("sha256").update("different").digest("hex"),
        },
        bytes,
      ),
    ).toThrow("SHA-256 does not match");
  });
});
