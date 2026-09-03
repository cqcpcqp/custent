import { z } from "zod";

import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import {
  BulkConversationMutationRequestSchema,
  type BulkConversationMutationResponse,
  ConversationListViewSchema,
  type CreateConversationResponse,
  type ListConversationsResponse,
} from "@/lib/contracts";
import {
  archiveAllConversations,
  createConversation,
  listConversationPage,
  softDeleteAllConversations,
} from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ListConversationsQuerySchema = z.object({
  view: ConversationListViewSchema.default("active"),
  query: z
    .string()
    .trim()
    .max(200)
    .refine((value) => !value.includes("\u0000"), "Search query is invalid")
    .default(""),
  cursor: z.string().min(1).max(1_024).nullable().default(null),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const searchParams = new URL(request.url).searchParams;
    const query = ListConversationsQuerySchema.parse({
      view: searchParams.get("view") ?? undefined,
      query: searchParams.get("query") ?? undefined,
      cursor: searchParams.get("cursor"),
      limit: searchParams.get("limit") ?? undefined,
    });
    const result = await listConversationPage({
      userId: getCurrentUserId(),
      ...query,
    });

    return Response.json(result satisfies ListConversationsResponse);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(): Promise<Response> {
  try {
    const conversation = await createConversation(
      getCurrentUserId(),
      "新对话",
    );

    return Response.json(
      { conversation } satisfies CreateConversationResponse,
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    BulkConversationMutationRequestSchema.parse(
      await request.json(),
    );
    const mutation = await archiveAllConversations(getCurrentUserId());
    return Response.json(
      { mutation } satisfies BulkConversationMutationResponse,
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(): Promise<Response> {
  try {
    const mutation = await softDeleteAllConversations(getCurrentUserId());
    return Response.json(
      { mutation } satisfies BulkConversationMutationResponse,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
