import { z } from "zod";

import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import type { ListLibraryArtifactsResponse } from "@/lib/contracts";
import { listLibraryArtifactPage } from "@/lib/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LibraryPageQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1_024).nullable().default(null),
    limit: z.coerce.number().int().min(1).max(50).default(24),
  })
  .strict();

export async function GET(request: Request): Promise<Response> {
  try {
    const searchParams = new URL(request.url).searchParams;
    const query = LibraryPageQuerySchema.parse({
      cursor: searchParams.get("cursor"),
      limit: searchParams.get("limit") ?? undefined,
    });
    const result = await listLibraryArtifactPage({
      userId: getCurrentUserId(),
      cursor: query.cursor,
      limit: query.limit,
    });
    return Response.json(result satisfies ListLibraryArtifactsResponse);
  } catch (error) {
    return errorResponse(error);
  }
}
