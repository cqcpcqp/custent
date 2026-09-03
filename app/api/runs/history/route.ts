import { z } from "zod";

import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import {
  BackgroundRunHistoryStatusFilterSchema,
  type BackgroundRunHistoryResponse,
} from "@/lib/contracts";
import { listBackgroundRunHistoryPage } from "@/lib/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BackgroundRunHistoryQuerySchema = z
  .object({
    status: BackgroundRunHistoryStatusFilterSchema.default("all"),
    cursor: z.string().min(1).max(1_024).nullable().default(null),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export async function GET(request: Request): Promise<Response> {
  try {
    const searchParams = new URL(request.url).searchParams;
    const query = BackgroundRunHistoryQuerySchema.parse({
      status: searchParams.get("status") ?? undefined,
      cursor: searchParams.get("cursor"),
      limit: searchParams.get("limit") ?? undefined,
    });
    const result = await listBackgroundRunHistoryPage({
      userId: getCurrentUserId(),
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return Response.json(result satisfies BackgroundRunHistoryResponse);
  } catch (error) {
    return errorResponse(error);
  }
}
