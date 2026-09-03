import { z } from "zod";

import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import {
  RetryRunRequestSchema,
  type RetryRunResponse,
} from "@/lib/contracts";
import { retryAgentRun } from "@/lib/runs";

export const runtime = "nodejs";

const RunIdSchema = z.string().uuid();

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    const { runId: rawRunId } = await context.params;
    const retryRequest = RetryRunRequestSchema.parse(await request.json());
    const response = await retryAgentRun({
      userId: getCurrentUserId(),
      sourceRunId: RunIdSchema.parse(rawRunId),
      requestId: retryRequest.requestId,
    });
    return Response.json(response satisfies RetryRunResponse, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
