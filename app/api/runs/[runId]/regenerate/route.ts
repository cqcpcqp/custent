import { z } from "zod";

import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import {
  RegenerateRunRequestSchema,
  type RegenerateRunResponse,
} from "@/lib/contracts";
import { regenerateAgentRun } from "@/lib/runs";

export const runtime = "nodejs";

const RunIdSchema = z.string().uuid();

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    const { runId: rawRunId } = await context.params;
    const regenerateRequest = RegenerateRunRequestSchema.parse(
      await request.json(),
    );
    const response = await regenerateAgentRun({
      userId: getCurrentUserId(),
      sourceRunId: RunIdSchema.parse(rawRunId),
      requestId: regenerateRequest.requestId,
    });
    return Response.json(response satisfies RegenerateRunResponse, {
      status: 202,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
