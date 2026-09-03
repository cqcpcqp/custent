import { z } from "zod";

import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import { encodeRunEventSse } from "@/lib/contracts";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import {
  getAgentRun,
  isTerminalRunStatus,
  readRunEventBatch,
} from "@/lib/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RunIdSchema = z.string().uuid();
const maximumEventId = 9_223_372_036_854_775_807n;
const keepAliveIntervalMs = 15_000;
const keepAlive = new TextEncoder().encode(": keep-alive\n\n");

function parseLastEventId(request: Request): string {
  const value = request.headers.get("last-event-id") ?? "0";
  if (!/^\d+$/u.test(value) || BigInt(value) > maximumEventId) {
    throw new AppError(
      "INVALID_REQUEST",
      "Last-Event-ID 不符合事件游标约定。",
      400,
    );
  }
  return value;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });

    function finish() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    const { runId: rawRunId } = await context.params;
    const runId = RunIdSchema.parse(rawRunId);
    const userId = getCurrentUserId();
    const lastEventId = parseLastEventId(request);
    if ((await getAgentRun(userId, runId)) === null) {
      throw new AppError("NOT_FOUND", "Run was not found", 404);
    }

    const relay = new AbortController();
    const signal = AbortSignal.any([request.signal, relay.signal]);
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          let cursor = lastEventId;
          let lastKeepAliveAt = Date.now();
          try {
            while (!signal.aborted) {
              const batch = await readRunEventBatch({
                userId,
                runId,
                afterEventId: cursor,
              });
              if (batch === null) {
                throw new AppError("NOT_FOUND", "Run was not found", 404);
              }

              for (const event of batch.events) {
                if (signal.aborted) {
                  return;
                }
                controller.enqueue(encodeRunEventSse(event));
                cursor = event.id;
              }

              if (
                batch.events.length === 0 &&
                isTerminalRunStatus(batch.run.status)
              ) {
                closed = true;
                controller.close();
                return;
              }
              if (batch.events.length > 0) {
                continue;
              }

              const now = Date.now();
              if (now - lastKeepAliveAt >= keepAliveIntervalMs) {
                controller.enqueue(keepAlive);
                lastKeepAliveAt = now;
              }
              await delay(getEnv().RUN_EVENT_POLL_MS, signal);
            }
          } catch (error) {
            if (!signal.aborted) {
              closed = true;
              controller.error(error);
            }
          } finally {
            if (!closed && !signal.aborted) {
              closed = true;
              controller.close();
            }
          }
        })();
      },
      cancel() {
        closed = true;
        relay.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
