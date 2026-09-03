import { z } from "zod";

import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import {
  PatchConversationRequestSchema,
  type ConversationResponse,
  type DeleteConversationResponse,
  type PatchConversationResponse,
} from "@/lib/contracts";
import {
  getConversation,
  listMessages,
  patchConversation,
  softDeleteConversation,
  withReadOnlyRepeatableReadTransaction,
} from "@/lib/db";
import { AppError } from "@/lib/errors";
import { listConversationRuns } from "@/lib/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ConversationIdSchema = z.string().uuid();

export async function GET(
  _request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<Response> {
  try {
    const { conversationId: rawConversationId } = await context.params;
    const conversationId = ConversationIdSchema.parse(rawConversationId);
    const userId = getCurrentUserId();
    const detail = await withReadOnlyRepeatableReadTransaction(
      async (client): Promise<ConversationResponse> => {
        const conversation = await getConversation(
          userId,
          conversationId,
          client,
        );

        if (conversation === null) {
          throw new AppError("NOT_FOUND", "对话不存在。", 404);
        }

        const messages = await listMessages(userId, conversationId, client);
        const runs = await listConversationRuns(
          userId,
          conversationId,
          client,
        );
        return { conversation, messages, runs };
      },
    );
    return Response.json(detail);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<Response> {
  try {
    const { conversationId: rawConversationId } = await context.params;
    const conversationId = ConversationIdSchema.parse(rawConversationId);
    const patch = PatchConversationRequestSchema.parse(await request.json());
    const conversation = await patchConversation(
      getCurrentUserId(),
      conversationId,
      patch,
    );

    return Response.json(
      { conversation } satisfies PatchConversationResponse,
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<Response> {
  try {
    const { conversationId: rawConversationId } = await context.params;
    const conversationId = ConversationIdSchema.parse(rawConversationId);
    const deletion = await softDeleteConversation(
      getCurrentUserId(),
      conversationId,
    );

    return Response.json(
      { deletion } satisfies DeleteConversationResponse,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
