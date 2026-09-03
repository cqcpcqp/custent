import { z } from "zod";

import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import type { GetLibraryResearchResponse } from "@/lib/contracts";
import { withReadOnlyRepeatableReadTransaction } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { getLibraryResearchDetail } from "@/lib/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SnapshotIdSchema = z.string().uuid();

export async function GET(
  _request: Request,
  context: { params: Promise<{ snapshotId: string }> },
): Promise<Response> {
  try {
    const { snapshotId: rawSnapshotId } = await context.params;
    const snapshotId = SnapshotIdSchema.parse(rawSnapshotId);
    const userId = getCurrentUserId();
    const research = await withReadOnlyRepeatableReadTransaction((client) =>
      getLibraryResearchDetail(userId, snapshotId, client),
    );
    if (research === null) {
      throw new AppError("NOT_FOUND", "研究资料不存在。", 404);
    }
    return Response.json({
      research,
    } satisfies GetLibraryResearchResponse);
  } catch (error) {
    return errorResponse(error);
  }
}
