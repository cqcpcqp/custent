import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import type { UploadInputAttachmentResponse } from "@/lib/contracts";
import { getEnv } from "@/lib/env";
import {
  createInputAttachment,
  deleteStoredInputAttachment,
  parseSingleInputAttachment,
  storeInputAttachment,
} from "@/lib/input-attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let storedAttachment:
    | Awaited<ReturnType<typeof storeInputAttachment>>
    | undefined;
  try {
    const environment = getEnv();
    const file = await parseSingleInputAttachment(
      request,
      environment.INPUT_ATTACHMENT_MAX_BYTES,
    );
    storedAttachment = await storeInputAttachment({
      file,
      storageDirectory: environment.INPUT_ATTACHMENT_DIR,
      maxBytes: environment.INPUT_ATTACHMENT_MAX_BYTES,
    });

    let stagedAttachment: Awaited<ReturnType<typeof createInputAttachment>>;
    try {
      const expiresAt = new Date(
        Date.now() +
          environment.INPUT_ATTACHMENT_STAGED_TTL_HOURS * 60 * 60 * 1_000,
      );
      stagedAttachment = await createInputAttachment({
        userId: getCurrentUserId(),
        stored: storedAttachment,
        expiresAt,
      });
    } catch (databaseError) {
      try {
        await deleteStoredInputAttachment(
          environment.INPUT_ATTACHMENT_DIR,
          storedAttachment.storagePath,
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [databaseError, cleanupError],
          "Input attachment database insert failed and storage cleanup was incomplete",
        );
      }
      throw databaseError;
    }

    return Response.json(
      stagedAttachment satisfies UploadInputAttachmentResponse,
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
