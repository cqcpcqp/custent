import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import {
  type AccountCustomInstructionsResponse,
  PutAccountCustomInstructionsRequestSchema,
} from "@/lib/contracts";
import {
  getAccountCustomInstructions,
  updateAccountCustomInstructions,
} from "@/lib/custom-instructions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const customInstructions = await getAccountCustomInstructions(
      getCurrentUserId(),
    );

    return Response.json({
      customInstructions,
    } satisfies AccountCustomInstructionsResponse);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const body = PutAccountCustomInstructionsRequestSchema.parse(
      await request.json(),
    );
    const customInstructions = await updateAccountCustomInstructions({
      userId: getCurrentUserId(),
      ...body,
    });

    return Response.json({
      customInstructions,
    } satisfies AccountCustomInstructionsResponse);
  } catch (error) {
    return errorResponse(error);
  }
}
