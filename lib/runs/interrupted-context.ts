import type { AgentInputItem } from "@openai/agents";
import type { PoolClient } from "pg";

import { RunEventPayloadSchema, type AgentRunStatus } from "@/lib/contracts";
import { AppError } from "@/lib/errors";
import { getMessageBoundInputAttachmentRecord } from "@/lib/input-attachments";

import { materializeRetrySourcePreRunContext } from "./pre-run-context";
import { readRunSessionSnapshot, writeRunSessionSnapshot } from "./session-snapshots";
import { createCurrentUserInput } from "./worker-attachment-input";

type InterruptedRunRow = {
  status: AgentRunStatus;
  model_started_at: Date | null;
  predecessor_run_id: string | null;
  input_message_id: string | null;
  input_content: string | null;
  input_attachment_ids: string[];
};

function unavailable(): AppError {
  return new AppError(
    "RUN_CONTEXT_UNAVAILABLE",
    "Interrupted Run continuation context is unavailable",
    409,
  );
}

export async function materializeInterruptedRunContext(
  input: { userId: string; conversationId: string; runId: string },
  client: PoolClient,
): Promise<void> {
  const result = await client.query<InterruptedRunRow>(
    `
      SELECT
        run.status,
        run.model_started_at,
        run.predecessor_run_id,
        run.input_message_id,
        message.content AS input_content,
        ARRAY(
          SELECT binding.attachment_id
          FROM message_input_attachments binding
          WHERE binding.message_id = run.input_message_id
          ORDER BY binding.position
        ) AS input_attachment_ids
      FROM runs run
      LEFT JOIN messages message
        ON message.id = run.input_message_id
        AND message.conversation_id = run.conversation_id
        AND message.role = 'user'
      WHERE run.id = $1 AND run.user_id = $2 AND run.conversation_id = $3
    `,
    [input.runId, input.userId, input.conversationId],
  );
  if (result.rowCount !== 1) {
    throw unavailable();
  }
  const run = result.rows[0];
  if (run.status === "completed") {
    return;
  }
  if (run.status !== "cancelled" && run.status !== "reconciliation_required") {
    throw unavailable();
  }
  if (await readRunSessionSnapshot(input.runId, "post", client) !== null) {
    return;
  }
  if (run.input_message_id === null || run.input_content === null) {
    throw unavailable();
  }

  const pre = await readRunSessionSnapshot(input.runId, "pre", client);
  let history: AgentInputItem[];
  if (pre !== null) {
    history = pre.items;
  } else {
    if (run.status !== "cancelled" || run.model_started_at !== null) {
      throw unavailable();
    }
    if (run.predecessor_run_id !== null) {
      await materializeInterruptedRunContext(
        { ...input, runId: run.predecessor_run_id },
        client,
      );
    }
    const reconstructed = await materializeRetrySourcePreRunContext(
      {
        userId: input.userId,
        conversationId: input.conversationId,
        sourceRunId: input.runId,
        allowDeferredPredecessor: false,
      },
      client,
    );
    if (reconstructed.kind !== "available") {
      throw unavailable();
    }
    history = reconstructed.items;
  }

  const messageId = run.input_message_id;
  const attachments = await Promise.all(run.input_attachment_ids.map(async (attachmentId) => {
    const attachment = await getMessageBoundInputAttachmentRecord({
      userId: input.userId,
      conversationId: input.conversationId,
      messageId,
      attachmentId,
    }, client);
    if (attachment === null) {
      throw unavailable();
    }
    return attachment;
  }));
  const userInput = createCurrentUserInput({
    messageId,
    text: run.input_content,
    attachmentIds: run.input_attachment_ids,
    attachments,
  });
  const events = await client.query<{ payload: unknown }>(
    `SELECT payload FROM run_events
     WHERE run_id = $1 AND event_type IN ('delta', 'artifact') ORDER BY id`,
    [input.runId],
  );
  let partialText = "";
  const files: string[] = [];
  for (const row of events.rows) {
    const event = RunEventPayloadSchema.parse(row.payload);
    if (event.type === "delta") {
      partialText += event.text;
    } else if (event.type === "artifact") {
      files.push(JSON.stringify(event.artifact));
    }
  }
  const items: AgentInputItem[] = [...history, ...userInput];
  const retainedContent = [partialText, ...files].filter((part) => part.length > 0).join("\n\n");
  if (retainedContent.length > 0) {
    items.push({
      role: "assistant",
      status: "incomplete",
      content: [{ type: "output_text", text: retainedContent }],
    });
  }
  await writeRunSessionSnapshot(input.runId, "post", items, client);
}
