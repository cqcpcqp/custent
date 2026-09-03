import { z } from "zod";

import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import {
  ConversationShareSummarySchema,
  GetConversationShareResponseSchema,
  PutConversationShareResponseSchema,
  RevokeConversationShareResponseSchema,
} from "@/lib/contracts";
import {
  getConversationShare,
  putConversationShare,
  revokeConversationShare,
} from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ConversationIdSchema = z.string().uuid();

type ShareRouteContext = {
  params: Promise<{ conversationId: string }>;
};

async function conversationIdFromContext(
  context: ShareRouteContext,
): Promise<string> {
  const { conversationId } = await context.params;
  return ConversationIdSchema.parse(conversationId);
}

export async function GET(
  _request: Request,
  context: ShareRouteContext,
): Promise<Response> {
  try {
    const conversationId = await conversationIdFromContext(context);
    const share = await getConversationShare(
      getCurrentUserId(),
      conversationId,
    );
    return Response.json(GetConversationShareResponseSchema.parse({ share }));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(
  _request: Request,
  context: ShareRouteContext,
): Promise<Response> {
  try {
    const conversationId = await conversationIdFromContext(context);
    const share = await putConversationShare(
      getCurrentUserId(),
      conversationId,
    );
    return Response.json(PutConversationShareResponseSchema.parse({ share }));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: ShareRouteContext,
): Promise<Response> {
  try {
    const conversationId = await conversationIdFromContext(context);
    const expectedPublicId =
      ConversationShareSummarySchema.shape.publicId.parse(
        new URL(request.url).searchParams.get("publicId"),
      );
    const revocation = await revokeConversationShare(
      getCurrentUserId(),
      conversationId,
      expectedPublicId,
    );
    return Response.json(
      RevokeConversationShareResponseSchema.parse({ revocation }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
