import { createHash } from "node:crypto";

import OpenAI from "openai";
import type {
  Response as OpenAIResponse,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { describe, expect, it } from "vitest";

import { createSilentOpenAIClient } from "@/lib/agent/sharesub-client";

import {
  codeInterpreterContainerCreateRequest,
  codeInterpreterContainerLifecycleRequest,
  codeInterpreterVerificationRequest,
  createPdfProbeBuffer,
  fileInputVerificationRequest,
  imageGenerationVerificationRequest,
  imageInputVerificationRequest,
  inlineFileInputVerificationRequest,
  parseProviderToolCapability,
  pdfInputVerificationRequest,
  sanitizedErrorMessage,
  verifyCodeInterpreterEvents,
  verifyCodeInterpreterContainerLifecycle,
  verifyCodeInterpreterContainerLifecycleEvents,
  verifyFileInputEvents,
  verifyImageGenerationEvents,
  verifyImageInputEvents,
  verifyInlineFileInputEvents,
  verifyPdfInputEvents,
} from "./verify-provider-tools";

const codeItem: Extract<
  ResponseOutputItem,
  { type: "code_interpreter_call" }
> = {
  id: "code-call-1",
  type: "code_interpreter_call",
  status: "completed",
  code: 'print("PROVIDER_CODE_INTERPRETER_OK_2026_08_25")',
  container_id: "container-1",
  outputs: [
    {
      type: "logs",
      logs: "PROVIDER_CODE_INTERPRETER_OK_2026_08_25\n",
    },
  ],
};

const fileMessage: Extract<ResponseOutputItem, { type: "message" }> = {
  id: "message-file-1",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [
    {
      type: "output_text",
      text: "PROVIDER_FILE_INPUT_SENTINEL_2026_08_25",
      annotations: [],
    },
  ],
};

const imageMessage: Extract<ResponseOutputItem, { type: "message" }> = {
  id: "message-image-1",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "RED", annotations: [] }],
};

const pdfMessage: Extract<ResponseOutputItem, { type: "message" }> = {
  id: "message-pdf-1",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [
    {
      type: "output_text",
      text: "PROVIDER_PDF_INPUT_SENTINEL_2026_08_25",
      annotations: [],
    },
  ],
};

const imageItem: Extract<
  ResponseOutputItem,
  { type: "image_generation_call" }
> = {
  id: "image-call-1",
  type: "image_generation_call",
  status: "completed",
  result: "iVBORw0KGgo=",
};

function event(value: unknown): ResponseStreamEvent {
  return value as ResponseStreamEvent;
}

function completedResponse(
  sequenceNumber: number,
  output: ResponseOutputItem[],
): ResponseStreamEvent {
  return event({
    type: "response.completed",
    sequence_number: sequenceNumber,
    response: {
      id: "response-1",
      object: "response",
      created_at: 0,
      completed_at: 1,
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: null,
      model: "test-model",
      output,
      output_text: "",
      parallel_tool_calls: true,
      previous_response_id: null,
      prompt_cache_key: null,
      reasoning: null,
      safety_identifier: null,
      service_tier: "default",
      status: "completed",
      temperature: null,
      text: { format: { type: "text" }, verbosity: "medium" },
      tool_choice: "auto",
      tools: [],
      top_logprobs: 0,
      top_p: null,
      truncation: "disabled",
      metadata: {},
    } satisfies OpenAIResponse,
  });
}

function outputItemDone(
  sequenceNumber: number,
  outputIndex: number,
  item: ResponseOutputItem,
): ResponseStreamEvent {
  return event({
    type: "response.output_item.done",
    sequence_number: sequenceNumber,
    output_index: outputIndex,
    item,
  });
}

function validCodeEvents(): ResponseStreamEvent[] {
  return [
    event({
      type: "response.code_interpreter_call.in_progress",
      sequence_number: 0,
      output_index: 0,
      item_id: codeItem.id,
    }),
    event({
      type: "response.code_interpreter_call_code.done",
      sequence_number: 1,
      output_index: 0,
      item_id: codeItem.id,
      code: codeItem.code,
    }),
    event({
      type: "response.code_interpreter_call.interpreting",
      sequence_number: 2,
      output_index: 0,
      item_id: codeItem.id,
    }),
    event({
      type: "response.code_interpreter_call.completed",
      sequence_number: 3,
      output_index: 0,
      item_id: codeItem.id,
    }),
    outputItemDone(4, 0, codeItem),
    completedResponse(5, [codeItem]),
  ];
}

function validCodeInterpreterContainerLifecycleEvents(
  containerId = "container-lifecycle-1",
  generatedFileId = "container-file-generated-1",
): ResponseStreamEvent[] {
  const lifecycleCodeItem: Extract<
    ResponseOutputItem,
    { type: "code_interpreter_call" }
  > = {
    ...codeItem,
    id: "code-call-lifecycle-1",
    container_id: containerId,
  };
  const text = "Download the generated digest file.";
  const lifecycleMessage: Extract<
    ResponseOutputItem,
    { type: "message" }
  > = {
    id: "message-lifecycle-1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text,
        annotations: [
          {
            type: "container_file_citation",
            container_id: containerId,
            file_id: generatedFileId,
            filename: "provider-code-interpreter-lifecycle-output.sha256",
            start_index: 0,
            end_index: text.length,
          },
        ],
      },
    ],
  };

  return [
    event({
      type: "response.code_interpreter_call.in_progress",
      sequence_number: 0,
      output_index: 0,
      item_id: lifecycleCodeItem.id,
    }),
    event({
      type: "response.code_interpreter_call_code.done",
      sequence_number: 1,
      output_index: 0,
      item_id: lifecycleCodeItem.id,
      code: lifecycleCodeItem.code,
    }),
    event({
      type: "response.code_interpreter_call.interpreting",
      sequence_number: 2,
      output_index: 0,
      item_id: lifecycleCodeItem.id,
    }),
    event({
      type: "response.code_interpreter_call.completed",
      sequence_number: 3,
      output_index: 0,
      item_id: lifecycleCodeItem.id,
    }),
    outputItemDone(4, 0, lifecycleCodeItem),
    outputItemDone(5, 1, lifecycleMessage),
    completedResponse(6, [lifecycleCodeItem, lifecycleMessage]),
  ];
}

function validMessageEvents(message: ResponseOutputItem): ResponseStreamEvent[] {
  return [outputItemDone(0, 0, message), completedResponse(1, [message])];
}

function validImageGenerationEvents(): ResponseStreamEvent[] {
  return [
    event({
      type: "response.image_generation_call.in_progress",
      sequence_number: 0,
      output_index: 0,
      item_id: imageItem.id,
    }),
    event({
      type: "response.image_generation_call.generating",
      sequence_number: 1,
      output_index: 0,
      item_id: imageItem.id,
    }),
    event({
      type: "response.image_generation_call.completed",
      sequence_number: 2,
      output_index: 0,
      item_id: imageItem.id,
    }),
    outputItemDone(3, 0, imageItem),
    completedResponse(4, [imageItem]),
  ];
}

function expectCompletePdfStructure(buffer: Buffer): void {
  expect(buffer.length).toBeGreaterThan(500);
  expect(buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");

  const pdf = buffer.toString("latin1");
  expect(pdf).toMatch(/\nxref\n/u);
  expect(pdf).toMatch(/\ntrailer\n/u);
  const footer = /startxref\n(\d+)\n%%EOF\s*$/u.exec(pdf);
  expect(footer).not.toBeNull();
  if (footer === null) {
    throw new Error("Generated PDF omitted a complete startxref footer");
  }
  const xrefOffset = Number(footer[1]);
  expect(Number.isSafeInteger(xrefOffset)).toBe(true);
  expect(xrefOffset).toBeGreaterThan(0);
  expect(xrefOffset).toBeLessThan(buffer.length);
  expect(buffer.subarray(xrefOffset, xrefOffset + 4).toString("ascii")).toBe(
    "xref",
  );

  const sentinelHex = Buffer.from(
    "PROVIDER_PDF_INPUT_SENTINEL_2026_08_25",
    "utf8",
  ).toString("hex");
  const encodedText = [...pdf.matchAll(/<([0-9A-Fa-f]+)>/gu)]
    .map((match) => match[1])
    .join("")
    .toLowerCase();
  expect(encodedText).toContain(sentinelHex);
}

type LifecycleProviderMockOptions = {
  annotationFileId?: string;
  deleteStatus?: 200 | 204;
  generatedContent?: "valid" | "invalid";
};

function createLifecycleProviderMock(
  options: LifecycleProviderMockOptions = {},
): {
  client: OpenAI;
  requests: string[];
  responseRequestBody: () => unknown;
} {
  const containerId = "container-lifecycle-1";
  const inputFileId = "container-file-input-1";
  const generatedFileId = "container-file-generated-1";
  const requests: string[] = [];
  let inputBytes: Buffer | undefined;
  let inputFilename: string | undefined;
  let generatedBytes: Buffer | undefined;
  let responseBody: unknown;

  const inputMetadata = (): Record<string, unknown> => {
    if (inputBytes === undefined || inputFilename === undefined) {
      throw new Error("Mock input file has not been uploaded");
    }
    return {
      id: inputFileId,
      bytes: inputBytes.length,
      container_id: containerId,
      created_at: 2,
      object: "container.file",
      path: `/mnt/data/${inputFilename}`,
      source: "user",
    };
  };
  const generatedMetadata = (): Record<string, unknown> => {
    if (generatedBytes === undefined) {
      throw new Error("Mock generated file has not been created");
    }
    return {
      id: generatedFileId,
      bytes: generatedBytes.length,
      container_id: containerId,
      created_at: 3,
      object: "container.file",
      path:
        "/mnt/data/provider-code-interpreter-lifecycle-output.sha256",
      source: "assistant",
    };
  };
  const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), {
      headers: {
        "content-type": "application/json",
        "x-request-id": "request-test-only",
      },
      status: 200,
    });

  const fetchMock: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "data:,") {
      return new Response(null, { status: 200 });
    }
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    requests.push(route);

    if (route === "POST /v1/containers") {
      return json({
        id: containerId,
        created_at: 1,
        name: "custent-code-interpreter-container-lifecycle-probe",
        object: "container",
        status: "active",
      });
    }

    if (route === `POST /v1/containers/${containerId}/files`) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new Error("Lifecycle probe did not upload a multipart file");
      }
      inputBytes = Buffer.from(await file.arrayBuffer());
      inputFilename = file.name;
      return json(inputMetadata());
    }

    if (route === `GET /v1/containers/${containerId}/files`) {
      const data =
        generatedBytes === undefined
          ? [inputMetadata()]
          : [inputMetadata(), generatedMetadata()];
      return json({ object: "list", data, has_more: false });
    }

    if (
      route ===
      `GET /v1/containers/${containerId}/files/${inputFileId}`
    ) {
      return json(inputMetadata());
    }

    if (
      route ===
      `GET /v1/containers/${containerId}/files/${inputFileId}/content`
    ) {
      if (inputBytes === undefined) {
        throw new Error("Mock input bytes are unavailable");
      }
      return new Response(new Uint8Array(inputBytes), {
        headers: { "content-type": "application/octet-stream" },
        status: 200,
      });
    }

    if (route === "POST /v1/responses") {
      responseBody = await request.json();
      if (inputBytes === undefined) {
        throw new Error("Mock response ran before input upload");
      }
      const validGenerated = Buffer.from(
        `${createHash("sha256").update(inputBytes).digest("hex")}\n`,
        "ascii",
      );
      generatedBytes =
        options.generatedContent === "invalid"
          ? Buffer.from("invalid\n", "ascii")
          : validGenerated;
      const events = validCodeInterpreterContainerLifecycleEvents(
        containerId,
        options.annotationFileId ?? generatedFileId,
      );
      const sse = `${events
        .map((streamEvent) => `data: ${JSON.stringify(streamEvent)}\n\n`)
        .join("")}data: [DONE]\n\n`;
      return new Response(sse, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    }

    if (
      route ===
      `GET /v1/containers/${containerId}/files/${generatedFileId}`
    ) {
      return json(generatedMetadata());
    }

    if (
      route ===
      `GET /v1/containers/${containerId}/files/${generatedFileId}/content`
    ) {
      if (generatedBytes === undefined) {
        throw new Error("Mock generated bytes are unavailable");
      }
      return new Response(new Uint8Array(generatedBytes), {
        headers: { "content-type": "application/octet-stream" },
        status: 200,
      });
    }

    if (route === `DELETE /v1/containers/${containerId}`) {
      if (options.deleteStatus === 200) {
        return json({ deleted: true });
      }
      return new Response(null, { status: 204 });
    }

    throw new Error(`Unexpected mock provider route: ${route}`);
  };

  return {
    client: createSilentOpenAIClient({
      apiKey: "sk-test-only-not-a-secret",
      baseURL: "https://provider.test/v1",
      fetch: fetchMock,
    }),
    requests,
    responseRequestBody: () => responseBody,
  };
}

describe("provider tool capability argument", () => {
  it.each([
    "code_interpreter",
    "code_interpreter_container_lifecycle",
    "file_input",
    "inline_file_input",
    "pdf_input",
    "image_input",
    "image_generation",
  ] as const)("accepts %s", (capability) => {
    expect(parseProviderToolCapability([capability])).toBe(capability);
  });

  it("rejects unknown or multiple capabilities before any provider call", () => {
    expect(() => parseProviderToolCapability(["computer_use"])).toThrow(
      "Unknown provider capability",
    );
    expect(() => parseProviderToolCapability([])).toThrow(
      "Expected exactly one capability",
    );
    expect(() =>
      parseProviderToolCapability(["file_input", "image_input"]),
    ).toThrow("Expected exactly one capability");
  });

  it("accepts one pnpm delimiter but rejects every other extra argument", () => {
    expect(
      parseProviderToolCapability(["--", "inline_file_input"]),
    ).toBe("inline_file_input");
    expect(parseProviderToolCapability(["--", "pdf_input"])).toBe(
      "pdf_input",
    );
    expect(() => parseProviderToolCapability(["--"])).toThrow(
      "Expected exactly one capability",
    );
    expect(() =>
      parseProviderToolCapability(["--", "file_input", "image_input"]),
    ).toThrow("Expected exactly one capability");
    expect(() =>
      parseProviderToolCapability(["file_input", "--"]),
    ).toThrow("Expected exactly one capability");
  });
});

describe("provider tool verification requests", () => {
  it("requests Code Interpreter outputs using the locked Responses field", () => {
    expect(codeInterpreterVerificationRequest("test-model")).toMatchObject({
      model: "test-model",
      stream: true,
      store: false,
      tool_choice: "required",
      tools: [{ type: "code_interpreter", container: { type: "auto" } }],
      include: ["code_interpreter_call.outputs"],
    });
  });

  it("binds the lifecycle probe to an explicitly created container", () => {
    expect(codeInterpreterContainerCreateRequest()).toEqual({
      name: "custent-code-interpreter-container-lifecycle-probe",
    });

    const request = codeInterpreterContainerLifecycleRequest(
      "test-model",
      "container-lifecycle-1",
      "/mnt/data/provider-code-interpreter-lifecycle-input.txt",
    );
    expect(request).toMatchObject({
      model: "test-model",
      stream: true,
      store: false,
      tool_choice: "required",
      include: ["code_interpreter_call.outputs"],
      tools: [
        {
          type: "code_interpreter",
          container: "container-lifecycle-1",
        },
      ],
    });
    expect(JSON.stringify(request.input)).toContain(
      "/mnt/data/provider-code-interpreter-lifecycle-input.txt",
    );
    expect(JSON.stringify(request.input)).toContain(
      "provider-code-interpreter-lifecycle-output.sha256",
    );

    expect(() =>
      codeInterpreterContainerLifecycleRequest("test-model", "", "/input"),
    ).toThrow("container ID must not be empty");
    expect(() =>
      codeInterpreterContainerLifecycleRequest(
        "test-model",
        "container-lifecycle-1",
        "",
      ),
    ).toThrow("input path must not be empty");
  });

  it("uses exact input_file and input_image content items", () => {
    expect(fileInputVerificationRequest("test-model", "file-1")).toMatchObject({
      input: [
        {
          role: "user",
          content: [
            { type: "input_file", file_id: "file-1" },
            {
              type: "input_text",
              text: "Read the attached text file and reply with only the single token it contains.",
            },
          ],
        },
      ],
      stream: true,
    });
    expect(imageInputVerificationRequest("test-model")).toMatchObject({
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url:
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAfElEQVR4nNXOQREAMAjAsK7+PTMRPLhGQd7QJnESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ES53Vg6wNShQF/fRSLfgAAAABJRU5ErkJggg==",
              detail: "low",
            },
            {
              type: "input_text",
              text: "Inspect the image and reply with exactly RED.",
            },
          ],
        },
      ],
      stream: true,
    });
  });

  it("uses the locked filename plus inline file_data data URL fields", () => {
    const request = inlineFileInputVerificationRequest("test-model");
    expect(request).toMatchObject({
      model: "test-model",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename: "provider-inline-capability.txt",
              file_data: expect.stringMatching(/^data:text\/plain;base64,/u),
            },
            {
              type: "input_text",
              text: "Read the attached text file and reply with only the single token it contains.",
            },
          ],
        },
      ],
      store: false,
      stream: true,
    });

    if (request.input === undefined || typeof request.input === "string") {
      throw new Error("Inline file verification request used string input");
    }
    const inputMessage = request.input[0];
    if (
      inputMessage.type !== "message" &&
      !("role" in inputMessage && inputMessage.role === "user")
    ) {
      throw new Error("Inline file verification request omitted user message");
    }
    if (!Array.isArray(inputMessage.content)) {
      throw new Error("Inline file verification request omitted content list");
    }
    const inputFile = inputMessage.content.find(
      (content) => content.type === "input_file",
    );
    if (inputFile?.file_data === undefined) {
      throw new Error("Inline file verification request omitted file_data");
    }
    const encoded = inputFile.file_data.split(",", 2)[1];
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(
      "PROVIDER_FILE_INPUT_SENTINEL_2026_08_25",
    );
  });

  it("creates a deterministic complete PDF and sends it as inline PDF data", async () => {
    const firstPdf = await createPdfProbeBuffer();
    const secondPdf = await createPdfProbeBuffer();
    expect(firstPdf.equals(secondPdf)).toBe(true);
    expectCompletePdfStructure(firstPdf);

    const request = await pdfInputVerificationRequest("test-model");
    expect(request).toMatchObject({
      model: "test-model",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename: "probe.pdf",
              file_data: expect.stringMatching(
                /^data:application\/pdf;base64,/u,
              ),
            },
            {
              type: "input_text",
              text: "Read the attached PDF and reply with exactly PROVIDER_PDF_INPUT_SENTINEL_2026_08_25.",
            },
          ],
        },
      ],
      max_output_tokens: 64,
      store: false,
      stream: true,
    });

    if (request.input === undefined || typeof request.input === "string") {
      throw new Error("PDF input verification request used string input");
    }
    const inputMessage = request.input[0];
    if (
      inputMessage.type !== "message" &&
      !("role" in inputMessage && inputMessage.role === "user")
    ) {
      throw new Error("PDF input verification request omitted user message");
    }
    if (!Array.isArray(inputMessage.content)) {
      throw new Error("PDF input verification request omitted content list");
    }
    const inputFile = inputMessage.content.find(
      (content) => content.type === "input_file",
    );
    if (inputFile?.file_data === undefined) {
      throw new Error("PDF input verification request omitted file_data");
    }
    const encoded = inputFile.file_data.split(",", 2)[1];
    const embeddedPdf = Buffer.from(encoded, "base64");
    expectCompletePdfStructure(embeddedPdf);
    expect(embeddedPdf.equals(firstPdf)).toBe(true);
  });

  it("requests a PNG image-generation call without partial images", () => {
    expect(imageGenerationVerificationRequest("test-model")).toMatchObject({
      stream: true,
      store: false,
      tool_choice: "required",
      tools: [
        {
          type: "image_generation",
          output_format: "png",
          partial_images: 0,
        },
      ],
    });
  });
});

describe("Code Interpreter provider contract", () => {
  it("accepts the complete ordered lifecycle and strict output item", () => {
    expect(verifyCodeInterpreterEvents(validCodeEvents())).toEqual({
      capability: "code_interpreter",
      status: "verified",
      calls: 1,
      codeOutputs: 1,
    });
  });

  it("rejects omitted phases, requested outputs, and reordered sequences", () => {
    expect(() =>
      verifyCodeInterpreterEvents(
        validCodeEvents().filter(
          (item) => item.type !== "response.code_interpreter_call.interpreting",
        ),
      ),
    ).toThrow("omitted code_interpreter_call.interpreting");

    const withoutOutputs = { ...codeItem, outputs: null };
    const outputEvents = validCodeEvents();
    outputEvents[4] = outputItemDone(4, 0, withoutOutputs);
    outputEvents[5] = completedResponse(5, [withoutOutputs]);
    expect(() => verifyCodeInterpreterEvents(outputEvents)).toThrow(
      "omitted requested outputs",
    );

    const duplicateSequence = validCodeEvents();
    duplicateSequence[1] = event({
      ...duplicateSequence[1],
      sequence_number: 0,
    });
    expect(() => verifyCodeInterpreterEvents(duplicateSequence)).toThrow(
      "sequence_number is not strictly increasing",
    );
  });

  it("requires explicit-container calls and a real generated-file annotation", () => {
    const verified = verifyCodeInterpreterContainerLifecycleEvents(
      validCodeInterpreterContainerLifecycleEvents(),
      "container-lifecycle-1",
    );
    expect({
      calls: verified.calls,
      codeOutputs: verified.codeOutputs,
      generatedFileIds: [...verified.generatedFileReferences.keys()],
    }).toEqual({
      calls: 1,
      codeOutputs: 1,
      generatedFileIds: ["container-file-generated-1"],
    });

    expect(() =>
      verifyCodeInterpreterContainerLifecycleEvents(
        validCodeInterpreterContainerLifecycleEvents(),
        "container-other",
      ),
    ).toThrow("used an unexpected container");

    const withoutAnnotation = validCodeInterpreterContainerLifecycleEvents();
    for (const streamEvent of withoutAnnotation) {
      if (streamEvent.type !== "response.output_item.done") {
        continue;
      }
      if (streamEvent.item.type !== "message") {
        continue;
      }
      const content = streamEvent.item.content[0];
      if (content.type === "output_text") {
        content.annotations = [];
      }
    }
    const terminal = withoutAnnotation.at(-1);
    if (terminal?.type !== "response.completed") {
      throw new Error("Lifecycle fixture omitted response.completed");
    }
    const terminalMessage = terminal.response.output.find(
      (item) => item.type === "message",
    );
    if (terminalMessage?.type !== "message") {
      throw new Error("Lifecycle fixture omitted terminal message");
    }
    const terminalContent = terminalMessage.content[0];
    if (terminalContent.type === "output_text") {
      terminalContent.annotations = [];
    }
    expect(() =>
      verifyCodeInterpreterContainerLifecycleEvents(
        withoutAnnotation,
        "container-lifecycle-1",
      ),
    ).toThrow("omitted a generated container-file annotation");
  });
});

describe("Code Interpreter explicit-container lifecycle probe", () => {
  it("verifies create, upload, list, metadata, content, execution, generated file, and delete", async () => {
    const provider = createLifecycleProviderMock();

    await expect(
      verifyCodeInterpreterContainerLifecycle(provider.client, "test-model"),
    ).resolves.toEqual({
      capability: "code_interpreter_container_lifecycle",
      status: "verified",
      calls: 1,
      codeOutputs: 1,
      inputFileBytes: Buffer.byteLength(
        "PROVIDER_CODE_INTERPRETER_CONTAINER_INPUT_2026_08_29",
        "utf8",
      ),
      generatedFiles: 1,
      generatedFileBytes: 65,
      containerDeleted: true,
    });

    expect(provider.requests).toEqual([
      "POST /v1/containers",
      "POST /v1/containers/container-lifecycle-1/files",
      "GET /v1/containers/container-lifecycle-1/files",
      "GET /v1/containers/container-lifecycle-1/files/container-file-input-1",
      "GET /v1/containers/container-lifecycle-1/files/container-file-input-1/content",
      "POST /v1/responses",
      "GET /v1/containers/container-lifecycle-1/files",
      "GET /v1/containers/container-lifecycle-1/files/container-file-generated-1",
      "GET /v1/containers/container-lifecycle-1/files/container-file-generated-1/content",
      "DELETE /v1/containers/container-lifecycle-1",
    ]);
    expect(provider.responseRequestBody()).toMatchObject({
      model: "test-model",
      include: ["code_interpreter_call.outputs"],
      stream: true,
      store: false,
      tools: [
        {
          type: "code_interpreter",
          container: "container-lifecycle-1",
        },
      ],
    });
  });

  it("does not guess a generated file by filename when annotation and list IDs do not join", async () => {
    const provider = createLifecycleProviderMock({
      annotationFileId: "container-file-not-listed",
    });

    await expect(
      verifyCodeInterpreterContainerLifecycle(provider.client, "test-model"),
    ).rejects.toThrow(
      "file annotations and the post-execution container file list did not uniquely identify",
    );
    expect(provider.requests.at(-1)).toBe(
      "DELETE /v1/containers/container-lifecycle-1",
    );
    expect(provider.requests).not.toContain(
      "GET /v1/containers/container-lifecycle-1/files/container-file-generated-1/content",
    );
  });

  it("validates downloaded generated bytes and still deletes the container on failure", async () => {
    const provider = createLifecycleProviderMock({
      generatedContent: "invalid",
    });

    await expect(
      verifyCodeInterpreterContainerLifecycle(provider.client, "test-model"),
    ).rejects.toThrow("did not match the input-derived digest");
    expect(provider.requests.at(-1)).toBe(
      "DELETE /v1/containers/container-lifecycle-1",
    );
  });

  it("rejects a JSON-shaped delete response instead of inventing a deletion body contract", async () => {
    const provider = createLifecycleProviderMock({ deleteStatus: 200 });

    await expect(
      verifyCodeInterpreterContainerLifecycle(provider.client, "test-model"),
    ).rejects.toThrow("container cleanup stage failed");
    expect(provider.requests.at(-1)).toBe(
      "DELETE /v1/containers/container-lifecycle-1",
    );
  });

  it("redacts API keys from probe errors", () => {
    const key = "sk-sharesub-test_key-do-not-print";
    const message = sanitizedErrorMessage(
      new Error(`Provider rejected Authorization: Bearer ${key}`),
    );
    expect(message).toContain("[REDACTED_API_KEY]");
    expect(message).not.toContain(key);
  });
});

describe("file, PDF, and image input provider contracts", () => {
  it("requires the exact token read from the uploaded file", () => {
    expect(verifyFileInputEvents(validMessageEvents(fileMessage))).toEqual({
      capability: "file_input",
      status: "verified",
      assistantMessages: 1,
    });

    const wrong = {
      ...fileMessage,
      id: "message-file-wrong",
      content: [{ type: "output_text" as const, text: "guessed", annotations: [] }],
    };
    expect(() => verifyFileInputEvents(validMessageEvents(wrong))).toThrow(
      "did not match the uploaded file token",
    );
  });

  it("requires the exact token read from the inline file_data", () => {
    expect(
      verifyInlineFileInputEvents(validMessageEvents(fileMessage)),
    ).toEqual({
      capability: "inline_file_input",
      status: "verified",
      assistantMessages: 1,
    });

    const wrong = {
      ...fileMessage,
      id: "message-inline-file-wrong",
      content: [{ type: "output_text" as const, text: "guessed", annotations: [] }],
    };
    expect(() =>
      verifyInlineFileInputEvents(validMessageEvents(wrong)),
    ).toThrow("did not match the embedded file token");
  });

  it("requires the exact token read from the inline PDF", () => {
    expect(verifyPdfInputEvents(validMessageEvents(pdfMessage))).toEqual({
      capability: "pdf_input",
      status: "verified",
      assistantMessages: 1,
    });

    const wrong = {
      ...pdfMessage,
      id: "message-pdf-wrong",
      content: [{ type: "output_text" as const, text: "guessed", annotations: [] }],
    };
    expect(() => verifyPdfInputEvents(validMessageEvents(wrong))).toThrow(
      "did not match the embedded PDF token",
    );
  });

  it("requires a completed assistant message that identifies the image color", () => {
    expect(verifyImageInputEvents(validMessageEvents(imageMessage))).toEqual({
      capability: "image_input",
      status: "verified",
      assistantMessages: 1,
    });

    const incomplete = { ...imageMessage, status: "incomplete" as const };
    expect(() => verifyImageInputEvents(validMessageEvents(incomplete))).toThrow(
      "was not completed",
    );

    const wrongColor = {
      ...imageMessage,
      id: "message-image-wrong-color",
      content: [{ type: "output_text" as const, text: "red", annotations: [] }],
    };
    expect(() =>
      verifyImageInputEvents(validMessageEvents(wrongColor)),
    ).toThrow("did not report the expected color");
  });
});

describe("image generation provider contract", () => {
  it("accepts the complete lifecycle and non-empty PNG result", () => {
    expect(verifyImageGenerationEvents(validImageGenerationEvents())).toEqual({
      capability: "image_generation",
      status: "verified",
      calls: 1,
    });
  });

  it("rejects a missing result or omitted completed phase", () => {
    const noResult = { ...imageItem, result: null };
    const noResultEvents = validImageGenerationEvents();
    noResultEvents[3] = outputItemDone(3, 0, noResult);
    noResultEvents[4] = completedResponse(4, [noResult]);
    expect(() => verifyImageGenerationEvents(noResultEvents)).toThrow(
      "omitted non-empty result",
    );

    expect(() =>
      verifyImageGenerationEvents(
        validImageGenerationEvents().filter(
          (item) => item.type !== "response.image_generation_call.completed",
        ),
      ),
    ).toThrow("omitted image_generation_call.completed");
  });
});
