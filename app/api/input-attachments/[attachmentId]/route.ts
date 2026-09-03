import { z } from "zod";

import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import type {
  DeleteInputAttachmentResponse,
  UploadInputAttachmentResponse,
} from "@/lib/contracts";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import {
  deleteStagedInputAttachment,
  getStagedInputAttachment,
  processInputAttachmentDeletion,
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
    const attachment = await getStagedInputAttachment(
      getCurrentUserId(),
      await parseAttachmentId(context),
    );
    if (attachment === null) {
      throw new AppError("NOT_FOUND", "附件不存在。", 404);
    }
    return Response.json(
      attachment satisfies UploadInputAttachmentResponse,
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ attachmentId: string }> },
): Promise<Response> {
  try {
    const attachmentId = await parseAttachmentId(context);
    const deleted = await deleteStagedInputAttachment(
      getCurrentUserId(),
      attachmentId,
    );
    const environment = getEnv();
    try {
      await processInputAttachmentDeletion({
        job: {
          attachmentId: deleted.deletion.attachmentId,
          storagePath: deleted.storagePath,
        },
        storageDirectory: environment.INPUT_ATTACHMENT_DIR,
        retryDelayMs: environment.INPUT_ATTACHMENT_DELETE_RETRY_MS,
      });
    } catch (cleanupError) {
      console.error(cleanupError);
    }
    return Response.json(
      { deletion: deleted.deletion } satisfies DeleteInputAttachmentResponse,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
