import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import {
  ChatRequestSchema,
  type ChatStartResponse,
} from "@/lib/contracts";
import { getEnv } from "@/lib/env";
import { enqueueChatRun } from "@/lib/runs";
import { resolveRunExecutionConfig } from "@/lib/run-config";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const chatRequest = ChatRequestSchema.parse(await request.json());
    const environment = getEnv();
    const executionConfig = resolveRunExecutionConfig(
      chatRequest.executionProfileId,
      environment,
    );
    const response = await enqueueChatRun({
      userId: getCurrentUserId(),
      request: chatRequest,
      executionConfig,
      maxAttachmentCount: environment.INPUT_ATTACHMENT_MAX_PER_MESSAGE,
      maxAttachmentTotalBytes:
        environment.INPUT_ATTACHMENT_MAX_TOTAL_BYTES,
    });

    return Response.json(response satisfies ChatStartResponse, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
