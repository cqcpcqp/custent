import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import {
  getInputAttachmentContentRecord,
  resolveStoredInputAttachmentPath,
} from "@/lib/input-attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AttachmentIdSchema = z.string().uuid();

async function parseAttachmentId(
  context: { params: Promise<{ attachmentId: string }> },
): Promise<string> {
  const { attachmentId } = await context.params;
  return AttachmentIdSchema.parse(attachmentId);
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ attachmentId: string }> },
): Promise<Response> {
  try {
    const attachmentId = await parseAttachmentId(context);
    const attachment = await getInputAttachmentContentRecord(
      getCurrentUserId(),
      attachmentId,
    );
    if (attachment === null) {
      throw new AppError("NOT_FOUND", "附件不存在。", 404);
    }

    const payload = await readFile(
      resolveStoredInputAttachmentPath(
        getEnv().INPUT_ATTACHMENT_DIR,
        attachment.storagePath,
      ),
    );
    if (
      payload.byteLength !== attachment.sizeBytes ||
      createHash("sha256").update(payload).digest("hex") !== attachment.sha256
    ) {
      throw new TypeError("Stored input attachment integrity check failed");
    }

    return new Response(payload, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `${
          attachment.kind === "image" ? "inline" : "attachment"
        }; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`,
        "Content-Length": String(attachment.sizeBytes),
        "Content-Type": attachment.mimeType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
