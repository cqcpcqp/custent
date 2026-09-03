import { z } from "zod";

import { getAccountUsagePage } from "@/lib/account";
import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import type { AccountUsageResponse } from "@/lib/contracts";
import { withReadOnlyRepeatableReadTransaction } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AccountUsageQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1_024).nullable().default(null),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  })
  .strict();

export async function GET(request: Request): Promise<Response> {
  try {
    const searchParams = new URL(request.url).searchParams;
    const query = AccountUsageQuerySchema.parse({
      cursor: searchParams.get("cursor"),
      limit: searchParams.get("limit") ?? undefined,
    });
    const userId = getCurrentUserId();
    const result = await withReadOnlyRepeatableReadTransaction((client) =>
      getAccountUsagePage(
        {
          userId,
          cursor: query.cursor,
          limit: query.limit,
        },
        client,
      ),
    );

    return Response.json(result satisfies AccountUsageResponse);
  } catch (error) {
    return errorResponse(error);
  }
}
