import { z } from "zod";

import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import {
  BranchConversationRequestSchema,
  type BranchConversationResponse,
} from "@/lib/contracts";
import { branchConversationFromMessage } from "@/lib/db";

export const runtime = "nodejs";

const ConversationIdSchema = z.string().uuid();

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<Response> {
  try {
    const { conversationId: rawConversationId } = await context.params;
    const sourceConversationId = ConversationIdSchema.parse(rawConversationId);
    const branchRequest = BranchConversationRequestSchema.parse(
      await request.json(),
    );
    const response = await branchConversationFromMessage({
      userId: getCurrentUserId(),
      sourceConversationId,
      request: branchRequest,
    });

    return Response.json(response satisfies BranchConversationResponse, {
      status: 201,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
