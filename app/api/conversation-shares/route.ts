import { z } from "zod";

import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import { ListConversationSharesResponseSchema } from "@/lib/contracts";
import { listConversationSharePage } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ListConversationSharesQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1_024).nullable().default(null),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  })
  .strict();

export async function GET(request: Request): Promise<Response> {
  try {
    const searchParams = new URL(request.url).searchParams;
    const query = ListConversationSharesQuerySchema.parse({
      cursor: searchParams.get("cursor"),
      limit: searchParams.get("limit") ?? undefined,
    });
    const response = await listConversationSharePage({
      userId: getCurrentUserId(),
      ...query,
    });
    return Response.json(ListConversationSharesResponseSchema.parse(response));
  } catch (error) {
    return errorResponse(error);
  }
}
