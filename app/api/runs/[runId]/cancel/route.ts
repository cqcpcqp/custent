import { z } from "zod";

import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import type { CancelRunResponse } from "@/lib/contracts";
import { cancelAgentRun } from "@/lib/runs";

export const runtime = "nodejs";

const RunIdSchema = z.string().uuid();

export async function POST(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    const { runId: rawRunId } = await context.params;
    const run = await cancelAgentRun(
      getCurrentUserId(),
      RunIdSchema.parse(rawRunId),
    );
    return Response.json({ run } satisfies CancelRunResponse);
  } catch (error) {
    return errorResponse(error);
  }
}
