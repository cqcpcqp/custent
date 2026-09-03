import { z } from "zod";

import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import {
  PatchMessageFeedbackRequestSchema,
  type PatchMessageFeedbackResponse,
} from "@/lib/contracts";
import { setMessageFeedback } from "@/lib/db";

export const runtime = "nodejs";

const MessageIdSchema = z.string().uuid();

export async function PATCH(
  request: Request,
  context: { params: Promise<{ messageId: string }> },
): Promise<Response> {
  try {
    const { messageId: rawMessageId } = await context.params;
    const messageId = MessageIdSchema.parse(rawMessageId);
    const patch = PatchMessageFeedbackRequestSchema.parse(
      await request.json(),
    );
    const response = await setMessageFeedback(
      getCurrentUserId(),
      messageId,
      patch.feedback,
    );

    return Response.json(response satisfies PatchMessageFeedbackResponse);
  } catch (error) {
    return errorResponse(error);
  }
}
