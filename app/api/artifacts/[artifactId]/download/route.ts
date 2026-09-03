import { readFile } from "node:fs/promises";

import { z } from "zod";

import { errorResponse } from "@/lib/api/errors";
import { getArtifact } from "@/lib/artifacts";
import { getCurrentUserId } from "@/lib/auth";
import { AppError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ArtifactIdSchema = z.string().uuid();

export async function GET(
  _request: Request,
  context: { params: Promise<{ artifactId: string }> },
): Promise<Response> {
  try {
    const { artifactId: rawArtifactId } = await context.params;
    const artifactId = ArtifactIdSchema.parse(rawArtifactId);
    const artifact = await getArtifact(getCurrentUserId(), artifactId);

    if (artifact === null) {
      throw new AppError("NOT_FOUND", "文件不存在。", 404);
    }

    const payload = await readFile(artifact.storagePath);
    return new Response(payload, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
        "Content-Length": String(artifact.sizeBytes),
        "Content-Type": artifact.mimeType,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
