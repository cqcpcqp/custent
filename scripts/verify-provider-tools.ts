import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import OpenAI, { toFile } from "openai";
import PDFDocument from "pdfkit";
import type {
  ContainerCreateParams,
  ContainerCreateResponse,
} from "openai/resources/containers/containers";
import type {
  FileCreateResponse as ContainerFileCreateResponse,
  FileListResponse as ContainerFileListResponse,
  FileRetrieveResponse as ContainerFileRetrieveResponse,
} from "openai/resources/containers/files/files";
import type { FileObject } from "openai/resources/files";
import type {
  Response as OpenAIResponse,
  ResponseCreateParamsStreaming,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

import {
  createShareSubOpenAIClient,
  createSilentOpenAIClient,
} from "@/lib/agent/sharesub-client";

export const PROVIDER_TOOL_CAPABILITIES = [
  "code_interpreter",
  "code_interpreter_container_lifecycle",
  "file_input",
  "inline_file_input",
  "pdf_input",
  "image_input",
  "image_generation",
] as const;

export type ProviderToolCapability =
  (typeof PROVIDER_TOOL_CAPABILITIES)[number];

type VerificationSummary =
  | {
      capability: "code_interpreter";
      status: "verified";
      calls: number;
      codeOutputs: number;
    }
  | {
      capability: "code_interpreter_container_lifecycle";
      status: "verified";
      calls: number;
      codeOutputs: number;
      inputFileBytes: number;
      generatedFiles: 1;
      generatedFileBytes: number;
      containerDeleted: true;
    }
  | {
      capability: "file_input";
      status: "verified";
      assistantMessages: number;
      providerFileDeleted: true;
    }
  | {
      capability: "inline_file_input";
      status: "verified";
      assistantMessages: number;
    }
  | {
      capability: "pdf_input";
      status: "verified";
      assistantMessages: number;
    }
  | {
      capability: "image_input";
      status: "verified";
      assistantMessages: number;
    }
  | {
      capability: "image_generation";
      status: "verified";
      calls: number;
    };

type ProviderConfiguration = {
  apiKey: string;
  provider: "openai" | "sharesub";
  baseURL: string;
  model: string;
};

type CodeCallState = {
  outputIndex: number;
  inProgressSequence?: number;
  interpretingSequence?: number;
  codeDoneSequence?: number;
  completedSequence?: number;
  code?: string;
};

type ImageCallState = {
  outputIndex: number;
  inProgressSequence?: number;
  generatingSequence?: number;
  completedSequence?: number;
};

type CodeInterpreterItem = Extract<
  ResponseOutputItem,
  { type: "code_interpreter_call" }
>;

type ImageGenerationItem = Extract<
  ResponseOutputItem,
  { type: "image_generation_call" }
>;

type GeneratedContainerFileReference = {
  annotationTypes: Set<"container_file_citation" | "file_path">;
};

type CodeInterpreterContainerLifecycleEvents = {
  calls: number;
  codeOutputs: number;
  generatedFileReferences: Map<string, GeneratedContainerFileReference>;
};

const FILE_SENTINEL = "PROVIDER_FILE_INPUT_SENTINEL_2026_08_25";
const PDF_SENTINEL = "PROVIDER_PDF_INPUT_SENTINEL_2026_08_25";
const CODE_SENTINEL = "PROVIDER_CODE_INTERPRETER_OK_2026_08_25";
const CODE_INTERPRETER_CONTAINER_NAME =
  "custent-code-interpreter-container-lifecycle-probe";
const CODE_INTERPRETER_INPUT_FILENAME =
  "provider-code-interpreter-lifecycle-input.txt";
const CODE_INTERPRETER_OUTPUT_FILENAME =
  "provider-code-interpreter-lifecycle-output.sha256";
const CODE_INTERPRETER_INPUT_SENTINEL =
  "PROVIDER_CODE_INTERPRETER_CONTAINER_INPUT_2026_08_29";
const INLINE_TEXT_FILE_DATA_URL = `data:text/plain;base64,${Buffer.from(
  FILE_SENTINEL,
  "utf8",
).toString("base64")}`;
const INLINE_RED_64_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAfElEQVR4nNXOQREAMAjAsK7+PTMRPLhGQd7QJnESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ES53Vg6wNShQF/fRSLfgAAAABJRU5ErkJggg==";
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

function isCodeInterpreterItem(
  item: ResponseOutputItem,
): item is CodeInterpreterItem {
  return item.type === "code_interpreter_call";
}

function isAssistantMessage(
  item: ResponseOutputItem,
): item is ResponseOutputMessage {
  return item.type === "message";
}

function isImageGenerationItem(
  item: ResponseOutputItem,
): item is ImageGenerationItem {
  return item.type === "image_generation_call";
}

export function parseProviderToolCapability(
  arguments_: readonly string[],
): ProviderToolCapability {
  const normalizedArguments =
    arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (normalizedArguments.length !== 1) {
    throw new Error(
      `Expected exactly one capability: ${PROVIDER_TOOL_CAPABILITIES.join(", ")}`,
    );
  }
  const capability = normalizedArguments[0];
  if (
    !PROVIDER_TOOL_CAPABILITIES.includes(
      capability as ProviderToolCapability,
    )
  ) {
    throw new Error(`Unknown provider capability: ${capability}`);
  }
  return capability as ProviderToolCapability;
}

export function codeInterpreterVerificationRequest(
  model: string,
): ResponseCreateParamsStreaming {
  return {
    model,
    input: `Use the python tool to print exactly ${CODE_SENTINEL}.`,
    tools: [
      {
        type: "code_interpreter",
        container: { type: "auto" },
      },
    ],
    tool_choice: "required",
    include: ["code_interpreter_call.outputs"],
    max_output_tokens: 256,
    store: false,
    stream: true,
  };
}

export function codeInterpreterContainerLifecycleRequest(
  model: string,
  containerId: string,
  inputPath: string,
): ResponseCreateParamsStreaming {
  if (containerId.length === 0) {
    throw new TypeError("Code Interpreter container ID must not be empty");
  }
  if (inputPath.length === 0) {
    throw new TypeError("Code Interpreter input path must not be empty");
  }

  return {
    model,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "Use the Python tool in the supplied container.",
              `Read the existing file at ${JSON.stringify(inputPath)} as bytes.`,
              "Compute the lowercase SHA-256 hexadecimal digest of those exact bytes.",
              `Write only that digest plus one trailing newline to a sibling file named ${JSON.stringify(CODE_INTERPRETER_OUTPUT_FILENAME)}.`,
              `Print exactly ${CODE_SENTINEL}.`,
              "In the final answer, attach or link the generated file so the Responses output contains its file annotation.",
              "Do not state the digest in the answer.",
            ].join(" "),
          },
        ],
      },
    ],
    tools: [
      {
        type: "code_interpreter",
        container: containerId,
      },
    ],
    tool_choice: "required",
    include: ["code_interpreter_call.outputs"],
    max_output_tokens: 512,
    store: false,
    stream: true,
  };
}

export function codeInterpreterContainerCreateRequest(): ContainerCreateParams {
  return { name: CODE_INTERPRETER_CONTAINER_NAME };
}

export function fileInputVerificationRequest(
  model: string,
  fileId: string,
): ResponseCreateParamsStreaming {
  if (fileId.length === 0) {
    throw new TypeError("Provider file ID must not be empty");
  }
  return {
    model,
    input: [
      {
        role: "user",
        content: [
          { type: "input_file", file_id: fileId },
          {
            type: "input_text",
            text: "Read the attached text file and reply with only the single token it contains.",
          },
        ],
      },
    ],
    max_output_tokens: 64,
    store: false,
    stream: true,
  };
}

export function inlineFileInputVerificationRequest(
  model: string,
): ResponseCreateParamsStreaming {
  return {
    model,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_file",
            filename: "provider-inline-capability.txt",
            file_data: INLINE_TEXT_FILE_DATA_URL,
          },
          {
            type: "input_text",
            text: "Read the attached text file and reply with only the single token it contains.",
          },
        ],
      },
    ],
    max_output_tokens: 64,
    store: false,
    stream: true,
  };
}

export async function createPdfProbeBuffer(): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const fixedTimestamp = new Date("2026-08-25T00:00:00.000Z");
    const document = new PDFDocument({
      size: "A4",
      margins: { top: 48, right: 48, bottom: 48, left: 48 },
      compress: false,
      info: {
        Title: "Provider PDF input capability probe",
        Author: "Custent",
        Subject: "Responses inline PDF input verification",
        CreationDate: fixedTimestamp,
        ModDate: fixedTimestamp,
      },
    });

    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));

    document.font("Helvetica").fontSize(12).text(PDF_SENTINEL);
    document.end();
  });
}

export async function pdfInputVerificationRequest(
  model: string,
): Promise<ResponseCreateParamsStreaming> {
  const pdf = await createPdfProbeBuffer();
  const fileData = `data:application/pdf;base64,${pdf.toString("base64")}`;
  return {
    model,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_file",
            filename: "probe.pdf",
            file_data: fileData,
          },
          {
            type: "input_text",
            text: `Read the attached PDF and reply with exactly ${PDF_SENTINEL}.`,
          },
        ],
      },
    ],
    max_output_tokens: 64,
    store: false,
    stream: true,
  };
}

export function imageInputVerificationRequest(
  model: string,
): ResponseCreateParamsStreaming {
  return {
    model,
    input: [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: INLINE_RED_64_PNG, detail: "low" },
          {
            type: "input_text",
            text: "Inspect the image and reply with exactly RED.",
          },
        ],
      },
    ],
    max_output_tokens: 32,
    store: false,
    stream: true,
  };
}

export function imageGenerationVerificationRequest(
  model: string,
): ResponseCreateParamsStreaming {
  return {
    model,
    input:
      "Generate a simple solid blue square with no text and no other objects.",
    tools: [
      {
        type: "image_generation",
        output_format: "png",
        partial_images: 0,
        quality: "low",
        size: "1024x1024",
      },
    ],
    tool_choice: "required",
    max_output_tokens: 64,
    store: false,
    stream: true,
  };
}

function assertEventSequence(events: readonly ResponseStreamEvent[]): void {
  let previous = -1;
  for (const event of events) {
    if (
      !Number.isSafeInteger(event.sequence_number) ||
      event.sequence_number < 0 ||
      event.sequence_number <= previous
    ) {
      throw new Error(
        `Provider stream sequence_number is not strictly increasing at ${event.type}`,
      );
    }
    previous = event.sequence_number;
  }
}

function completedResponse(
  events: readonly ResponseStreamEvent[],
): OpenAIResponse {
  assertEventSequence(events);
  let completed: OpenAIResponse | undefined;

  for (const event of events) {
    if (event.type === "error") {
      throw new Error(`Provider stream error: ${event.message}`);
    }
    if (event.type === "response.failed") {
      const message = event.response.error?.message ?? "missing provider error";
      throw new Error(`Provider returned response.failed: ${message}`);
    }
    if (event.type === "response.incomplete") {
      throw new Error("Provider returned response.incomplete");
    }
    if (event.type === "response.completed") {
      if (completed !== undefined) {
        throw new Error("Provider emitted more than one response.completed event");
      }
      completed = event.response;
    }
  }

  if (completed === undefined) {
    throw new Error("Provider stream ended without response.completed");
  }
  if (events.at(-1)?.type !== "response.completed") {
    throw new Error("response.completed was not the terminal stream event");
  }
  if (completed.status !== "completed") {
    throw new Error(`Provider response status was ${completed.status}`);
  }
  return completed;
}

function setPhase(
  state: CodeCallState | ImageCallState,
  phase:
    | "inProgressSequence"
    | "interpretingSequence"
    | "codeDoneSequence"
    | "generatingSequence"
    | "completedSequence",
  sequence: number,
  eventType: string,
): void {
  if (phase in state && state[phase as keyof typeof state] !== undefined) {
    throw new Error(`Provider emitted duplicate ${eventType} for one call`);
  }
  Object.assign(state, { [phase]: sequence });
}

function stateForCall<T extends { outputIndex: number }>(
  calls: Map<string, T>,
  itemId: string,
  outputIndex: number,
  create: () => T,
): T {
  const existing = calls.get(itemId);
  if (existing === undefined) {
    const state = create();
    calls.set(itemId, state);
    return state;
  }
  if (existing.outputIndex !== outputIndex) {
    throw new Error(`Provider changed output_index for call ${itemId}`);
  }
  return existing;
}

function assertPhaseOrder(
  itemId: string,
  phases: readonly [string, number | undefined][],
): void {
  let previous = -1;
  for (const [name, sequence] of phases) {
    if (sequence === undefined) {
      throw new Error(`Provider omitted ${name} for call ${itemId}`);
    }
    if (sequence <= previous) {
      throw new Error(`Provider emitted out-of-order ${name} for call ${itemId}`);
    }
    previous = sequence;
  }
}

function assertCodeOutputs(
  outputs: NonNullable<CodeInterpreterItem["outputs"]>,
): number {
  let outputCount = 0;
  let sentinelObserved = false;
  for (const output of outputs) {
    switch (output.type) {
      case "logs":
        if (typeof output.logs !== "string") {
          throw new TypeError("Code Interpreter logs output omitted logs");
        }
        sentinelObserved ||= output.logs.includes(CODE_SENTINEL);
        outputCount += 1;
        break;
      case "image":
        if (typeof output.url !== "string" || output.url.length === 0) {
          throw new TypeError("Code Interpreter image output omitted url");
        }
        outputCount += 1;
        break;
      default:
        throw new TypeError("Code Interpreter output had an unknown type");
    }
  }
  if (!sentinelObserved) {
    throw new Error("Code Interpreter outputs did not contain the expected log token");
  }
  return outputCount;
}

export function verifyCodeInterpreterEvents(
  events: readonly ResponseStreamEvent[],
): Extract<VerificationSummary, { capability: "code_interpreter" }> {
  const response = completedResponse(events);
  const calls = new Map<string, CodeCallState>();
  const streamedItems = new Map<
    string,
    CodeInterpreterItem
  >();
  let codeOutputs = 0;

  for (const event of events) {
    switch (event.type) {
      case "response.code_interpreter_call.in_progress": {
        const state = stateForCall(
          calls,
          event.item_id,
          event.output_index,
          (): CodeCallState => ({ outputIndex: event.output_index }),
        );
        setPhase(state, "inProgressSequence", event.sequence_number, event.type);
        break;
      }
      case "response.code_interpreter_call.interpreting": {
        const state = stateForCall(
          calls,
          event.item_id,
          event.output_index,
          (): CodeCallState => ({ outputIndex: event.output_index }),
        );
        setPhase(state, "interpretingSequence", event.sequence_number, event.type);
        break;
      }
      case "response.code_interpreter_call_code.done": {
        const state = stateForCall(
          calls,
          event.item_id,
          event.output_index,
          (): CodeCallState => ({ outputIndex: event.output_index }),
        );
        if (event.code.trim().length === 0) {
          throw new Error("Code Interpreter code.done omitted non-empty code");
        }
        setPhase(state, "codeDoneSequence", event.sequence_number, event.type);
        state.code = event.code;
        break;
      }
      case "response.code_interpreter_call.completed": {
        const state = stateForCall(
          calls,
          event.item_id,
          event.output_index,
          (): CodeCallState => ({ outputIndex: event.output_index }),
        );
        setPhase(state, "completedSequence", event.sequence_number, event.type);
        break;
      }
      case "response.output_item.done":
        if (event.item.type === "code_interpreter_call") {
          if (streamedItems.has(event.item.id)) {
            throw new Error(`Duplicate Code Interpreter item ${event.item.id}`);
          }
          if (event.item.status !== "completed") {
            throw new Error(
              `Code Interpreter item ${event.item.id} status was ${event.item.status}`,
            );
          }
          if (event.item.code === null || event.item.code.trim().length === 0) {
            throw new Error(
              `Code Interpreter item ${event.item.id} omitted non-empty code`,
            );
          }
          if (event.item.outputs === null) {
            throw new Error(
              `Code Interpreter item ${event.item.id} omitted requested outputs`,
            );
          }
          const state = calls.get(event.item.id);
          if (state === undefined || state.outputIndex !== event.output_index) {
            throw new Error(
              `Code Interpreter item ${event.item.id} has no matching stream phases`,
            );
          }
          if (state.code !== event.item.code) {
            throw new Error(
              `Code Interpreter item ${event.item.id} code did not match code.done`,
            );
          }
          codeOutputs += assertCodeOutputs(event.item.outputs);
          streamedItems.set(event.item.id, event.item);
        }
        break;
    }
  }

  if (streamedItems.size === 0) {
    throw new Error("Provider emitted no completed Code Interpreter output item");
  }
  for (const [itemId, streamedItem] of streamedItems) {
    const state = calls.get(itemId);
    if (state === undefined) {
      throw new Error(`Code Interpreter item ${itemId} has no phase state`);
    }
    assertPhaseOrder(itemId, [
      ["code_interpreter_call.in_progress", state.inProgressSequence],
      ["code_interpreter_call_code.done", state.codeDoneSequence],
      ["code_interpreter_call.interpreting", state.interpretingSequence],
      ["code_interpreter_call.completed", state.completedSequence],
    ]);
    const finalItem = response.output.find(
      (item): item is CodeInterpreterItem =>
        isCodeInterpreterItem(item) && item.id === itemId,
    );
    if (
      finalItem === undefined ||
      finalItem.status !== "completed" ||
      finalItem.code === null ||
      finalItem.code.trim().length === 0 ||
      finalItem.outputs === null ||
      finalItem.code !== streamedItem.code ||
      JSON.stringify(finalItem.outputs) !== JSON.stringify(streamedItem.outputs)
    ) {
      throw new Error(
        `Completed response omitted valid Code Interpreter item ${itemId}`,
      );
    }
  }

  return {
    capability: "code_interpreter",
    status: "verified",
    calls: streamedItems.size,
    codeOutputs,
  };
}

function addGeneratedContainerFileReference(
  references: Map<string, GeneratedContainerFileReference>,
  fileId: string,
  annotationType: "container_file_citation" | "file_path",
): void {
  if (fileId.length === 0) {
    throw new Error("Code Interpreter file annotation omitted a file ID");
  }
  const existing = references.get(fileId);
  if (existing === undefined) {
    references.set(fileId, {
      annotationTypes: new Set([annotationType]),
    });
    return;
  }
  existing.annotationTypes.add(annotationType);
}

export function verifyCodeInterpreterContainerLifecycleEvents(
  events: readonly ResponseStreamEvent[],
  containerId: string,
): CodeInterpreterContainerLifecycleEvents {
  if (containerId.length === 0) {
    throw new TypeError("Code Interpreter container ID must not be empty");
  }

  const codeVerification = verifyCodeInterpreterEvents(events);
  const response = completedResponse(events);
  const generatedFileReferences = new Map<
    string,
    GeneratedContainerFileReference
  >();
  const streamedMessages = new Map<string, ResponseOutputMessage>();
  let matchingContainerCalls = 0;

  for (const event of events) {
    if (event.type !== "response.output_item.done") {
      continue;
    }
    if (event.item.type !== "message") {
      continue;
    }
    if (streamedMessages.has(event.item.id)) {
      throw new Error(
        `Provider emitted duplicate assistant message ${event.item.id}`,
      );
    }
    streamedMessages.set(event.item.id, event.item);
  }

  for (const item of response.output) {
    if (item.type === "code_interpreter_call") {
      if (item.container_id !== containerId) {
        throw new Error(
          `Code Interpreter call ${item.id} used an unexpected container`,
        );
      }
      matchingContainerCalls += 1;
      continue;
    }
    if (item.type !== "message") {
      continue;
    }
    if (item.role !== "assistant" || item.status !== "completed") {
      throw new Error(
        `Code Interpreter assistant message ${item.id} was not completed`,
      );
    }
    const streamedMessage = streamedMessages.get(item.id);
    if (
      streamedMessage === undefined ||
      JSON.stringify(streamedMessage) !== JSON.stringify(item)
    ) {
      throw new Error(
        `Completed response message ${item.id} did not match response.output_item.done`,
      );
    }

    for (const content of item.content) {
      if (content.type !== "output_text") {
        continue;
      }
      for (const annotation of content.annotations) {
        switch (annotation.type) {
          case "container_file_citation":
            if (annotation.container_id !== containerId) {
              throw new Error(
                "Code Interpreter generated-file citation used an unexpected container",
              );
            }
            if (annotation.filename !== CODE_INTERPRETER_OUTPUT_FILENAME) {
              throw new Error(
                "Code Interpreter generated-file citation used an unexpected filename",
              );
            }
            if (
              !Number.isSafeInteger(annotation.start_index) ||
              annotation.start_index < 0 ||
              !Number.isSafeInteger(annotation.end_index) ||
              annotation.end_index < annotation.start_index
            ) {
              throw new Error(
                "Code Interpreter generated-file citation used invalid text indexes",
              );
            }
            addGeneratedContainerFileReference(
              generatedFileReferences,
              annotation.file_id,
              annotation.type,
            );
            break;
          case "file_path":
            if (
              !Number.isSafeInteger(annotation.index) ||
              annotation.index < 0
            ) {
              throw new Error(
                "Code Interpreter generated file_path used an invalid index",
              );
            }
            addGeneratedContainerFileReference(
              generatedFileReferences,
              annotation.file_id,
              annotation.type,
            );
            break;
          case "file_citation":
          case "url_citation":
            break;
        }
      }
    }
  }

  if (matchingContainerCalls !== codeVerification.calls) {
    throw new Error(
      "Completed response did not bind every Code Interpreter call to the explicit container",
    );
  }
  if (generatedFileReferences.size === 0) {
    throw new Error(
      "Completed response omitted a generated container-file annotation",
    );
  }

  return {
    calls: codeVerification.calls,
    codeOutputs: codeVerification.codeOutputs,
    generatedFileReferences,
  };
}

function completedAssistantMessages(
  events: readonly ResponseStreamEvent[],
): { messages: ResponseOutputMessage[]; text: string } {
  const response = completedResponse(events);
  const messages: ResponseOutputMessage[] = [];

  for (const event of events) {
    if (event.type !== "response.output_item.done" || event.item.type !== "message") {
      continue;
    }
    if (event.item.role !== "assistant" || event.item.status !== "completed") {
      throw new Error(`Assistant message ${event.item.id} was not completed`);
    }
    if (messages.some((message) => message.id === event.item.id)) {
      throw new Error(`Provider emitted duplicate assistant message ${event.item.id}`);
    }
    messages.push(event.item);
  }

  if (messages.length === 0) {
    throw new Error("Provider emitted no completed assistant message");
  }

  for (const message of messages) {
    const finalMessage = response.output.find(
      (item): item is ResponseOutputMessage =>
        isAssistantMessage(item) && item.id === message.id,
    );
    if (
      finalMessage === undefined ||
      finalMessage.role !== "assistant" ||
      finalMessage.status !== "completed"
    ) {
      throw new Error(`Completed response omitted assistant message ${message.id}`);
    }
  }

  const textParts: string[] = [];
  for (const message of messages) {
    for (const content of message.content) {
      switch (content.type) {
        case "output_text":
          if (
            typeof content.text !== "string" ||
            !Array.isArray(content.annotations)
          ) {
            throw new TypeError(
              "Assistant output_text omitted fixed text or annotations fields",
            );
          }
          textParts.push(content.text);
          break;
        case "refusal":
          throw new Error("Provider refused the capability verification prompt");
        default:
          throw new TypeError("Assistant message contained an unknown content type");
      }
    }
  }
  const text = textParts.join("").trim();
  if (text.length === 0) {
    throw new Error("Completed assistant message omitted non-empty output_text");
  }
  return { messages, text };
}

export function verifyFileInputEvents(
  events: readonly ResponseStreamEvent[],
): Omit<
  Extract<VerificationSummary, { capability: "file_input" }>,
  "providerFileDeleted"
> {
  const result = completedAssistantMessages(events);
  if (result.text !== FILE_SENTINEL) {
    throw new Error("File input response did not match the uploaded file token");
  }
  return {
    capability: "file_input",
    status: "verified",
    assistantMessages: result.messages.length,
  };
}

export function verifyInlineFileInputEvents(
  events: readonly ResponseStreamEvent[],
): Extract<VerificationSummary, { capability: "inline_file_input" }> {
  const result = completedAssistantMessages(events);
  if (result.text !== FILE_SENTINEL) {
    throw new Error(
      "Inline file input response did not match the embedded file token",
    );
  }
  return {
    capability: "inline_file_input",
    status: "verified",
    assistantMessages: result.messages.length,
  };
}

export function verifyPdfInputEvents(
  events: readonly ResponseStreamEvent[],
): Extract<VerificationSummary, { capability: "pdf_input" }> {
  const result = completedAssistantMessages(events);
  if (result.text !== PDF_SENTINEL) {
    throw new Error("PDF input response did not match the embedded PDF token");
  }
  return {
    capability: "pdf_input",
    status: "verified",
    assistantMessages: result.messages.length,
  };
}

export function verifyImageInputEvents(
  events: readonly ResponseStreamEvent[],
): Extract<VerificationSummary, { capability: "image_input" }> {
  const result = completedAssistantMessages(events);
  if (result.text !== "RED") {
    throw new Error("Image input response did not report the expected color");
  }
  return {
    capability: "image_input",
    status: "verified",
    assistantMessages: result.messages.length,
  };
}

function assertPngBase64(result: string, itemId: string): void {
  if (
    result.length === 0 ||
    result.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(result)
  ) {
    throw new Error(`Image generation item ${itemId} returned invalid base64`);
  }
  const bytes = Buffer.from(result, "base64");
  if (
    bytes.length < PNG_SIGNATURE.length ||
    PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)
  ) {
    throw new Error(`Image generation item ${itemId} did not return PNG bytes`);
  }
}

export function verifyImageGenerationEvents(
  events: readonly ResponseStreamEvent[],
): Extract<VerificationSummary, { capability: "image_generation" }> {
  const response = completedResponse(events);
  const calls = new Map<string, ImageCallState>();
  const streamedItems = new Map<string, string>();

  for (const event of events) {
    switch (event.type) {
      case "response.image_generation_call.in_progress": {
        const state = stateForCall(
          calls,
          event.item_id,
          event.output_index,
          (): ImageCallState => ({ outputIndex: event.output_index }),
        );
        setPhase(state, "inProgressSequence", event.sequence_number, event.type);
        break;
      }
      case "response.image_generation_call.generating": {
        const state = stateForCall(
          calls,
          event.item_id,
          event.output_index,
          (): ImageCallState => ({ outputIndex: event.output_index }),
        );
        setPhase(state, "generatingSequence", event.sequence_number, event.type);
        break;
      }
      case "response.image_generation_call.completed": {
        const state = stateForCall(
          calls,
          event.item_id,
          event.output_index,
          (): ImageCallState => ({ outputIndex: event.output_index }),
        );
        setPhase(state, "completedSequence", event.sequence_number, event.type);
        break;
      }
      case "response.output_item.done":
        if (event.item.type === "image_generation_call") {
          if (streamedItems.has(event.item.id)) {
            throw new Error(`Duplicate image generation item ${event.item.id}`);
          }
          if (event.item.status !== "completed") {
            throw new Error(
              `Image generation item ${event.item.id} status was ${event.item.status}`,
            );
          }
          if (event.item.result === null) {
            throw new Error(
              `Image generation item ${event.item.id} omitted non-empty result`,
            );
          }
          const state = calls.get(event.item.id);
          if (state === undefined || state.outputIndex !== event.output_index) {
            throw new Error(
              `Image generation item ${event.item.id} has no matching stream phases`,
            );
          }
          assertPngBase64(event.item.result, event.item.id);
          streamedItems.set(event.item.id, event.item.result);
        }
        break;
    }
  }

  if (streamedItems.size === 0) {
    throw new Error("Provider emitted no completed image generation output item");
  }
  for (const [itemId, result] of streamedItems) {
    const state = calls.get(itemId);
    if (state === undefined) {
      throw new Error(`Image generation item ${itemId} has no phase state`);
    }
    assertPhaseOrder(itemId, [
      ["image_generation_call.in_progress", state.inProgressSequence],
      ["image_generation_call.generating", state.generatingSequence],
      ["image_generation_call.completed", state.completedSequence],
    ]);
    const finalItem = response.output.find(
      (item): item is ImageGenerationItem =>
        isImageGenerationItem(item) && item.id === itemId,
    );
    if (
      finalItem === undefined ||
      finalItem.status !== "completed" ||
      finalItem.result === null ||
      finalItem.result !== result
    ) {
      throw new Error(
        `Completed response omitted valid image generation item ${itemId}`,
      );
    }
  }

  return {
    capability: "image_generation",
    status: "verified",
    calls: streamedItems.size,
  };
}

async function collectEvents(
  stream: AsyncIterable<ResponseStreamEvent>,
): Promise<ResponseStreamEvent[]> {
  const events: ResponseStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function readProviderConfiguration(): ProviderConfiguration {
  const environmentFile = path.resolve(process.cwd(), ".env");
  if (existsSync(environmentFile)) {
    loadEnvFile(environmentFile);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const provider = process.env.OPENAI_PROVIDER;
  const baseURL = process.env.OPENAI_BASE_URL;
  const model = process.env.OPENAI_MODEL;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("OPENAI_API_KEY is required");
  }
  if (provider !== "openai" && provider !== "sharesub") {
    throw new Error("OPENAI_PROVIDER must be openai or sharesub");
  }
  if (baseURL === undefined || baseURL.length === 0) {
    throw new Error("OPENAI_BASE_URL is required");
  }
  if (model === undefined || model.length === 0) {
    throw new Error("OPENAI_MODEL is required");
  }
  return { apiKey, provider, baseURL, model };
}

function createProviderClient(configuration: ProviderConfiguration): OpenAI {
  return configuration.provider === "sharesub"
    ? createShareSubOpenAIClient(configuration)
    : createSilentOpenAIClient({
        apiKey: configuration.apiKey,
        baseURL: configuration.baseURL,
      });
}

function providerStageError(stage: string, cause: unknown): Error {
  const status =
    typeof cause === "object" &&
    cause !== null &&
    "status" in cause &&
    typeof cause.status === "number"
      ? ` (HTTP ${cause.status})`
      : "";
  return new Error(`${stage} failed${status}`, { cause });
}

function assertContainerCreateResponse(
  container: ContainerCreateResponse,
): string {
  if (
    typeof container.id !== "string" ||
    container.id.length === 0 ||
    container.name !== CODE_INTERPRETER_CONTAINER_NAME ||
    typeof container.object !== "string" ||
    container.object.length === 0 ||
    typeof container.status !== "string" ||
    container.status.length === 0 ||
    !Number.isSafeInteger(container.created_at) ||
    container.created_at < 0
  ) {
    throw new Error(
      "Provider Containers API returned an invalid created container object",
    );
  }
  return container.id;
}

type ContainerFileMetadata =
  | ContainerFileCreateResponse
  | ContainerFileListResponse
  | ContainerFileRetrieveResponse;

function assertContainerFileMetadata(
  file: ContainerFileMetadata,
  containerId: string,
): void {
  if (
    typeof file.id !== "string" ||
    file.id.length === 0 ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 0 ||
    file.container_id !== containerId ||
    !Number.isSafeInteger(file.created_at) ||
    file.created_at < 0 ||
    file.object !== "container.file" ||
    typeof file.path !== "string" ||
    file.path.length === 0 ||
    typeof file.source !== "string" ||
    file.source.length === 0
  ) {
    throw new Error(
      "Provider Containers Files API returned invalid file metadata",
    );
  }
}

function assertMatchingContainerFileMetadata(
  expected: ContainerFileMetadata,
  actual: ContainerFileMetadata,
): void {
  if (
    actual.id !== expected.id ||
    actual.bytes !== expected.bytes ||
    actual.container_id !== expected.container_id ||
    actual.created_at !== expected.created_at ||
    actual.object !== expected.object ||
    actual.path !== expected.path ||
    actual.source !== expected.source
  ) {
    throw new Error(
      `Container file metadata did not match for file ${expected.id}`,
    );
  }
}

function assertUniqueContainerFileIds(
  files: readonly ContainerFileListResponse[],
  containerId: string,
): void {
  const ids = new Set<string>();
  for (const file of files) {
    assertContainerFileMetadata(file, containerId);
    if (ids.has(file.id)) {
      throw new Error(`Container file list repeated file ${file.id}`);
    }
    ids.add(file.id);
  }
}

function listedContainerFile(
  files: readonly ContainerFileListResponse[],
  expected: ContainerFileMetadata,
): ContainerFileListResponse {
  const matching = files.filter((file) => file.id === expected.id);
  if (matching.length !== 1) {
    throw new Error(
      `Container file list did not contain exactly one ${expected.id}`,
    );
  }
  assertMatchingContainerFileMetadata(expected, matching[0]);
  return matching[0];
}

async function listAllContainerFiles(
  client: OpenAI,
  containerId: string,
): Promise<ContainerFileListResponse[]> {
  const page = await client.containers.files.list(containerId, { order: "asc" });
  const files: ContainerFileListResponse[] = [];
  for await (const file of page) {
    files.push(file);
  }
  assertUniqueContainerFileIds(files, containerId);
  return files;
}

async function retrieveContainerFileBytes(
  client: OpenAI,
  containerId: string,
  fileId: string,
): Promise<Buffer> {
  const response = await client.containers.files.content.retrieve(fileId, {
    container_id: containerId,
  });
  if (!response.ok) {
    throw new Error(
      `Container file content returned unsuccessful HTTP ${response.status}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

function locateAnnotatedGeneratedContainerFile(
  beforeResponse: readonly ContainerFileListResponse[],
  afterResponse: readonly ContainerFileListResponse[],
  references: ReadonlyMap<string, GeneratedContainerFileReference>,
): ContainerFileListResponse {
  const priorIds = new Set(beforeResponse.map((file) => file.id));
  const newlyListedFiles = afterResponse.filter(
    (file) => !priorIds.has(file.id),
  );
  const annotatedNewFiles = newlyListedFiles.filter((file) =>
    references.has(file.id),
  );

  if (annotatedNewFiles.length !== 1) {
    throw new Error(
      "Responses file annotations and the post-execution container file list did not uniquely identify one newly generated file",
    );
  }

  const generated = annotatedNewFiles[0];
  if (path.posix.basename(generated.path) !== CODE_INTERPRETER_OUTPUT_FILENAME) {
    throw new Error(
      "The uniquely linked generated container file had an unexpected path",
    );
  }
  return generated;
}

function expectedCodeInterpreterGeneratedBytes(input: Buffer): Buffer {
  const digest = createHash("sha256").update(input).digest("hex");
  return Buffer.from(`${digest}\n`, "ascii");
}

function assertContainerDeleteResponse(
  deletion: { data: unknown; response: Response },
): void {
  // openai@7.5.0 types this endpoint as void; its 204 parser exposes null at
  // runtime. withResponse() is the contracted way to inspect the raw status.
  if (
    deletion.response.status !== 204 ||
    deletion.response.ok !== true ||
    deletion.data !== null
  ) {
    throw new Error(
      "Provider Containers API delete did not return the SDK-contracted 204 empty result",
    );
  }
}

export async function verifyCodeInterpreterContainerLifecycle(
  client: OpenAI,
  model: string,
): Promise<
  Extract<
    VerificationSummary,
    { capability: "code_interpreter_container_lifecycle" }
  >
> {
  const inputBytes = Buffer.from(CODE_INTERPRETER_INPUT_SENTINEL, "utf8");
  const expectedGeneratedBytes =
    expectedCodeInterpreterGeneratedBytes(inputBytes);
  let containerId: string | undefined;
  let verificationError: unknown;
  let cleanupError: unknown;
  let verified:
    | Omit<
        Extract<
          VerificationSummary,
          { capability: "code_interpreter_container_lifecycle" }
        >,
        "containerDeleted"
      >
    | undefined;

  try {
    let container: ContainerCreateResponse;
    try {
      container = await client.containers.create(
        codeInterpreterContainerCreateRequest(),
      );
    } catch (error) {
      throw providerStageError(
        "Code Interpreter container create stage",
        error,
      );
    }
    if (typeof container.id === "string" && container.id.length > 0) {
      containerId = container.id;
    }
    containerId = assertContainerCreateResponse(container);

    let uploaded: ContainerFileCreateResponse;
    try {
      uploaded = await client.containers.files.create(containerId, {
        file: await toFile(inputBytes, CODE_INTERPRETER_INPUT_FILENAME, {
          type: "text/plain",
        }),
      });
    } catch (error) {
      throw providerStageError(
        "Code Interpreter container input upload stage",
        error,
      );
    }
    assertContainerFileMetadata(uploaded, containerId);
    if (
      uploaded.bytes !== inputBytes.length ||
      path.posix.basename(uploaded.path) !== CODE_INTERPRETER_INPUT_FILENAME
    ) {
      throw new Error(
        "Uploaded Code Interpreter container file metadata did not match the input",
      );
    }

    let filesBeforeResponse: ContainerFileListResponse[];
    try {
      filesBeforeResponse = await listAllContainerFiles(client, containerId);
    } catch (error) {
      throw providerStageError(
        "Code Interpreter container input list stage",
        error,
      );
    }
    listedContainerFile(filesBeforeResponse, uploaded);

    let retrievedInput: ContainerFileRetrieveResponse;
    try {
      retrievedInput = await client.containers.files.retrieve(uploaded.id, {
        container_id: containerId,
      });
    } catch (error) {
      throw providerStageError(
        "Code Interpreter container input metadata stage",
        error,
      );
    }
    assertContainerFileMetadata(retrievedInput, containerId);
    assertMatchingContainerFileMetadata(uploaded, retrievedInput);

    let downloadedInput: Buffer;
    try {
      downloadedInput = await retrieveContainerFileBytes(
        client,
        containerId,
        uploaded.id,
      );
    } catch (error) {
      throw providerStageError(
        "Code Interpreter container input content stage",
        error,
      );
    }
    if (!downloadedInput.equals(inputBytes)) {
      throw new Error(
        "Downloaded Code Interpreter container input content did not match the upload",
      );
    }

    let lifecycleEvents: CodeInterpreterContainerLifecycleEvents;
    try {
      const stream = await client.responses.create(
        codeInterpreterContainerLifecycleRequest(
          model,
          containerId,
          uploaded.path,
        ),
      );
      lifecycleEvents = verifyCodeInterpreterContainerLifecycleEvents(
        await collectEvents(stream),
        containerId,
      );
    } catch (error) {
      throw providerStageError(
        "Code Interpreter explicit-container Responses stage",
        error,
      );
    }

    let filesAfterResponse: ContainerFileListResponse[];
    try {
      filesAfterResponse = await listAllContainerFiles(client, containerId);
    } catch (error) {
      throw providerStageError(
        "Code Interpreter generated file list stage",
        error,
      );
    }
    listedContainerFile(filesAfterResponse, uploaded);
    const listedGenerated = locateAnnotatedGeneratedContainerFile(
      filesBeforeResponse,
      filesAfterResponse,
      lifecycleEvents.generatedFileReferences,
    );
    assertContainerFileMetadata(listedGenerated, containerId);

    let retrievedGenerated: ContainerFileRetrieveResponse;
    try {
      retrievedGenerated = await client.containers.files.retrieve(
        listedGenerated.id,
        { container_id: containerId },
      );
    } catch (error) {
      throw providerStageError(
        "Code Interpreter generated file metadata stage",
        error,
      );
    }
    assertContainerFileMetadata(retrievedGenerated, containerId);
    assertMatchingContainerFileMetadata(listedGenerated, retrievedGenerated);

    let downloadedGenerated: Buffer;
    try {
      downloadedGenerated = await retrieveContainerFileBytes(
        client,
        containerId,
        listedGenerated.id,
      );
    } catch (error) {
      throw providerStageError(
        "Code Interpreter generated file content stage",
        error,
      );
    }
    if (
      retrievedGenerated.bytes !== expectedGeneratedBytes.length ||
      downloadedGenerated.length !== retrievedGenerated.bytes ||
      !downloadedGenerated.equals(expectedGeneratedBytes)
    ) {
      throw new Error(
        "Downloaded Code Interpreter generated file content did not match the input-derived digest",
      );
    }

    verified = {
      capability: "code_interpreter_container_lifecycle",
      status: "verified",
      calls: lifecycleEvents.calls,
      codeOutputs: lifecycleEvents.codeOutputs,
      inputFileBytes: inputBytes.length,
      generatedFiles: 1,
      generatedFileBytes: downloadedGenerated.length,
    };
  } catch (error) {
    verificationError = error;
  } finally {
    if (containerId !== undefined) {
      try {
        const deletion = await client.containers
          .delete(containerId)
          .withResponse();
        assertContainerDeleteResponse(deletion);
      } catch (error) {
        cleanupError = providerStageError(
          "Code Interpreter container cleanup stage",
          error,
        );
      }
    }
  }

  if (verificationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [verificationError, cleanupError],
      "Code Interpreter container lifecycle verification failed and container cleanup also failed",
    );
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  if (verificationError !== undefined) {
    throw verificationError;
  }
  if (verified === undefined || containerId === undefined) {
    throw new Error(
      "Code Interpreter container lifecycle verification finished without a result",
    );
  }

  return { ...verified, containerDeleted: true };
}

async function verifyFileInput(
  client: OpenAI,
  model: string,
): Promise<Extract<VerificationSummary, { capability: "file_input" }>> {
  let fileId: string | undefined;
  let verificationError: unknown;
  let verified:
    | Omit<
        Extract<VerificationSummary, { capability: "file_input" }>,
        "providerFileDeleted"
      >
    | undefined;

  try {
    let file: FileObject;
    try {
      file = await client.files.create({
        file: await toFile(
          Buffer.from(FILE_SENTINEL, "utf8"),
          "provider-tool-capability.txt",
          { type: "text/plain" },
        ),
        purpose: "user_data",
      });
    } catch (error) {
      throw providerStageError("File input upload stage", error);
    }
    if (typeof file.id === "string" && file.id.length > 0) {
      fileId = file.id;
    }
    if (
      fileId === undefined ||
      file.object !== "file" ||
      file.purpose !== "user_data" ||
      file.filename !== "provider-tool-capability.txt" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0
    ) {
      throw new Error("Provider Files API returned an invalid uploaded file object");
    }
    try {
      const stream = await client.responses.create(
        fileInputVerificationRequest(model, fileId),
      );
      verified = verifyFileInputEvents(await collectEvents(stream));
    } catch (error) {
      throw providerStageError("File input Responses stage", error);
    }
  } catch (error) {
    verificationError = error;
  }

  let cleanupError: unknown;
  if (fileId !== undefined) {
    try {
      const deleted = await client.files.delete(fileId);
      if (
        deleted.id !== fileId ||
        deleted.object !== "file" ||
        deleted.deleted !== true
      ) {
        throw new Error("Provider Files API returned an invalid deletion result");
      }
    } catch (error) {
      cleanupError = providerStageError("Provider file cleanup stage", error);
    }
  }

  if (verificationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [verificationError, cleanupError],
      "File input verification failed and provider file cleanup also failed",
    );
  }
  if (cleanupError !== undefined) {
    throw new Error("Provider file cleanup failed", { cause: cleanupError });
  }
  if (verificationError !== undefined) {
    throw verificationError;
  }
  if (verified === undefined || fileId === undefined) {
    throw new Error("File input verification finished without a result");
  }

  return { ...verified, providerFileDeleted: true };
}

export async function runProviderToolVerification(
  capability: ProviderToolCapability,
  configuration = readProviderConfiguration(),
): Promise<VerificationSummary> {
  const client = createProviderClient(configuration);

  switch (capability) {
    case "code_interpreter": {
      const stream = await client.responses.create(
        codeInterpreterVerificationRequest(configuration.model),
      );
      return verifyCodeInterpreterEvents(await collectEvents(stream));
    }
    case "code_interpreter_container_lifecycle":
      return verifyCodeInterpreterContainerLifecycle(
        client,
        configuration.model,
      );
    case "file_input":
      return verifyFileInput(client, configuration.model);
    case "inline_file_input": {
      try {
        const stream = await client.responses.create(
          inlineFileInputVerificationRequest(configuration.model),
        );
        return verifyInlineFileInputEvents(await collectEvents(stream));
      } catch (error) {
        throw providerStageError("Inline file input Responses stage", error);
      }
    }
    case "pdf_input": {
      try {
        const stream = await client.responses.create(
          await pdfInputVerificationRequest(configuration.model),
        );
        return verifyPdfInputEvents(await collectEvents(stream));
      } catch (error) {
        throw providerStageError("PDF input Responses stage", error);
      }
    }
    case "image_input": {
      const stream = await client.responses.create(
        imageInputVerificationRequest(configuration.model),
      );
      return verifyImageInputEvents(await collectEvents(stream));
    }
    case "image_generation": {
      const stream = await client.responses.create(
        imageGenerationVerificationRequest(configuration.model),
      );
      return verifyImageGenerationEvents(await collectEvents(stream));
    }
  }
}

export function sanitizedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown verification error";
  return message.replace(/sk-[A-Za-z0-9_-]+/gu, "[REDACTED_API_KEY]");
}

async function main(): Promise<void> {
  try {
    const capability = parseProviderToolCapability(process.argv.slice(2));
    const summary = await runProviderToolVerification(capability);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(`Provider tool verification failed: ${sanitizedErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

const executedPath = process.argv[1];
if (
  executedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(executedPath)).href
) {
  await main();
}
