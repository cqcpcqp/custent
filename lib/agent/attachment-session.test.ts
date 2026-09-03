import type { AgentInputItem } from "@openai/agents";
import { describe, expect, it, vi } from "vitest";

import {
  inputAttachmentFormatSpecifications,
  INPUT_ATTACHMENT_MIME_TYPES,
} from "@/lib/input-attachment-formats";

import {
  dehydrateAttachmentData,
  formatAttachmentReference,
  hydrateAttachmentReferences,
  hydrateAttachmentRunInput,
  parseAttachmentReference,
  type AttachmentLoader,
  type LoadedAttachment,
} from "./attachment-session";

const FILE_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_FILE_ID = "22222222-2222-4222-8222-222222222222";
const IMAGE_ID = "33333333-3333-4333-8333-333333333333";
const PDF_ID = "44444444-4444-4444-8444-444444444444";

function loadedAttachment(
  value: Omit<LoadedAttachment, "bytes"> & { bytes: string },
): LoadedAttachment {
  return { ...value, bytes: Buffer.from(value.bytes, "utf8") };
}

describe("attachment Session references", () => {
  it("formats and parses only exact canonical attachment references", () => {
    const reference = formatAttachmentReference(FILE_ID);
    expect(reference).toBe(`custent-attachment:${FILE_ID}`);
    expect(parseAttachmentReference(reference)).toBe(FILE_ID);

    expect(() => parseAttachmentReference(FILE_ID)).toThrow(
      "Invalid attachment reference",
    );
    expect(() =>
      parseAttachmentReference("custent-attachment:not-a-uuid"),
    ).toThrow("Invalid attachment reference");
    expect(() =>
      formatAttachmentReference("ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"),
    ).toThrow("Invalid attachment UUID");
  });

  it("hydrates file and image references without mutating input, then removes all data before persistence", async () => {
    const items: AgentInputItem[] = [
      {
        role: "user",
        providerData: { preserved: true },
        content: [
          { type: "input_text", text: "分析附件" },
          { type: "input_file", file: formatAttachmentReference(FILE_ID) },
          {
            type: "input_image",
            image: formatAttachmentReference(IMAGE_ID),
            detail: "high",
          },
        ],
      },
    ];
    const original = structuredClone(items);
    const loader = vi.fn<AttachmentLoader>((id) => {
      if (id === FILE_ID) {
        return loadedAttachment({
          id,
          kind: "file",
          name: "buyers.txt",
          mimeType: "text/plain",
          bytes: "buyer list",
        });
      }
      if (id === IMAGE_ID) {
        return loadedAttachment({
          id,
          kind: "image",
          name: "factory.png",
          mimeType: "image/png",
          bytes: "png bytes",
        });
      }
      return null;
    });

    const hydrated = await hydrateAttachmentReferences(items, loader);

    expect(items).toEqual(original);
    expect(hydrated.items).not.toBe(items);
    expect(hydrated.items[0]).not.toBe(items[0]);
    expect(hydrated.items).toEqual([
      {
        role: "user",
        providerData: { preserved: true },
        content: [
          { type: "input_text", text: "分析附件" },
          {
            type: "input_file",
            file: `data:text/plain;base64,${Buffer.from("buyer list").toString("base64")}`,
            filename: "buyers.txt",
          },
          {
            type: "input_image",
            image: `data:image/png;base64,${Buffer.from("png bytes").toString("base64")}`,
            detail: "high",
          },
        ],
      },
    ]);
    expect(hydrated.items[0]).not.toHaveProperty(
      "providerData.custentAttachment",
    );

    const dehydrated = dehydrateAttachmentData(
      hydrated.items,
      hydrated.plan,
    );
    expect(dehydrated).toEqual(original);
    expect(JSON.stringify(dehydrated)).not.toContain("data:");
  });

  it("hydrates PDF files with the exact application/pdf data URL", async () => {
    const items: AgentInputItem[] = [
      {
        role: "user",
        content: [
          {
            type: "input_file",
            file: formatAttachmentReference(PDF_ID),
            filename: "persisted-name.pdf",
          },
        ],
      },
    ];
    const pdfBytes = Buffer.from("%PDF-test", "utf8");
    const hydrated = await hydrateAttachmentReferences(items, () => ({
      id: PDF_ID,
      kind: "file",
      name: "catalog.pdf",
      mimeType: "application/pdf",
      bytes: pdfBytes,
    }));

    expect(hydrated.items).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_file",
            file: `data:application/pdf;base64,${pdfBytes.toString("base64")}`,
            filename: "catalog.pdf",
          },
        ],
      },
    ]);
    expect(dehydrateAttachmentData(hydrated.items, hydrated.plan)).toEqual(
      items,
    );
  });

  it("hydrates every fixed MIME into the exact file or image input shape", async () => {
    const bytes = Buffer.from("exact attachment bytes", "utf8");
    for (const mimeType of INPUT_ATTACHMENT_MIME_TYPES) {
      const specification = inputAttachmentFormatSpecifications[mimeType];
      const id = specification.kind === "file" ? FILE_ID : IMAGE_ID;
      const reference = formatAttachmentReference(id);
      const name = `fixture${specification.extensions[0]}`;
      const content =
        specification.kind === "file"
          ? { type: "input_file" as const, file: reference, filename: name }
          : {
              type: "input_image" as const,
              image: reference,
              detail: "low" as const,
            };
      const items = [
        { role: "user" as const, content: [content] },
      ] satisfies AgentInputItem[];

      const hydrated = await hydrateAttachmentReferences(items, () => ({
        id,
        kind: specification.kind,
        name,
        mimeType,
        bytes,
      }));

      const inlineData = `data:${mimeType};base64,${bytes.toString("base64")}`;
      expect(hydrated.items).toEqual([
        {
          role: "user",
          content: [
            specification.kind === "file"
              ? { type: "input_file", file: inlineData, filename: name }
              : { type: "input_image", image: inlineData, detail: "low" },
          ],
        },
      ]);
      expect(dehydrateAttachmentData(hydrated.items, hydrated.plan)).toEqual(
        items,
      );
    }
  });

  it("deterministically restores multiple references even when bytes and names repeat", async () => {
    const sharedBytes = Buffer.from("identical", "utf8");
    const references = [FILE_ID, SECOND_FILE_ID, FILE_ID];
    const items: AgentInputItem[] = [
      {
        role: "user",
        content: references.map((id) => ({
          type: "input_file" as const,
          file: formatAttachmentReference(id),
        })),
      },
    ];
    const loader = vi.fn<AttachmentLoader>((id) => ({
      id,
      kind: "file",
      name: "same.txt",
      mimeType: "text/plain",
      bytes: sharedBytes,
    }));

    const hydrated = await hydrateAttachmentReferences(items, loader);
    expect(loader.mock.calls.map(([id]) => id)).toEqual([
      FILE_ID,
      SECOND_FILE_ID,
    ]);
    expect(hydrated.plan.entries.map((entry) => entry.reference)).toEqual(
      references.map(formatAttachmentReference),
    );
    expect(dehydrateAttachmentData(hydrated.items, hydrated.plan)).toEqual(
      items,
    );
    expect(dehydrateAttachmentData(hydrated.items, hydrated.plan)).toEqual(
      items,
    );
  });

  it.each([
    {
      content: {
        type: "input_file" as const,
        file: formatAttachmentReference(IMAGE_ID),
      },
      attachment: loadedAttachment({
        id: IMAGE_ID,
        kind: "image",
        name: "factory.png",
        mimeType: "image/png",
        bytes: "png",
      }),
      expected: "does not match input_file",
    },
    {
      content: {
        type: "input_image" as const,
        image: formatAttachmentReference(FILE_ID),
      },
      attachment: loadedAttachment({
        id: FILE_ID,
        kind: "file",
        name: "buyers.txt",
        mimeType: "text/plain",
        bytes: "text",
      }),
      expected: "does not match input_image",
    },
  ])("rejects attachment kind mismatches", async ({ content, attachment, expected }) => {
    const items = [
      { role: "user" as const, content: [content] },
    ] satisfies AgentInputItem[];
    await expect(
      hydrateAttachmentReferences(items, () => attachment),
    ).rejects.toThrow(expected);
  });

  it("fails immediately for malformed references without invoking the loader", async () => {
    const loader = vi.fn<AttachmentLoader>(() => {
      throw new Error("must not be called");
    });
    const items: AgentInputItem[] = [
      {
        role: "user",
        content: [
          {
            type: "input_file",
            file: "custent-attachment:broken",
          },
        ],
      },
    ];

    await expect(hydrateAttachmentReferences(items, loader)).rejects.toThrow(
      "Invalid attachment reference",
    );
    expect(loader).not.toHaveBeenCalled();
  });

  it("fails when the loader cannot find a referenced attachment", async () => {
    const items: AgentInputItem[] = [
      {
        role: "user",
        content: [
          { type: "input_file", file: formatAttachmentReference(FILE_ID) },
        ],
      },
    ];

    await expect(
      hydrateAttachmentReferences(items, () => null),
    ).rejects.toThrow(`no attachment for ${FILE_ID}`);
  });

  it.each([
    {
      type: "file",
      item: {
        role: "user" as const,
        content: [
          {
            type: "input_file" as const,
            file: "data:application/octet-stream;base64,Zm9yZWlnbg==",
            filename: "future.bin",
          },
        ],
      },
    },
    {
      type: "image",
      item: {
        role: "user" as const,
        content: [
          {
            type: "input_image" as const,
            image: "data:image/png;base64,Zm9yZWlnbg==",
            detail: "low",
          },
        ],
      },
    },
  ])("refuses unknown inline $type data instead of persisting base64", ({ item }) => {
    expect(() =>
      dehydrateAttachmentData([item], { entries: [] }),
    ).toThrow("Refusing to persist unknown inline");
  });

  it("refuses to persist a Session that dropped a hydrated attachment", async () => {
    const items: AgentInputItem[] = [
      {
        role: "user",
        content: [
          { type: "input_file", file: formatAttachmentReference(FILE_ID) },
        ],
      },
    ];
    const hydrated = await hydrateAttachmentReferences(items, () =>
      loadedAttachment({
        id: FILE_ID,
        kind: "file",
        name: "buyers.txt",
        mimeType: "text/plain",
        bytes: "buyers",
      }),
    );

    expect(() => dehydrateAttachmentData([], hydrated.plan)).toThrow(
      "consumed 0 of 1 hydrated attachment references",
    );
  });

  it("deep-clones non-attachment items without changing their data", async () => {
    const items: AgentInputItem[] = [
      { role: "system", content: "Follow the instructions." },
      {
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
      {
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello back" }],
      },
      {
        type: "function_call",
        callId: "call-1",
        name: "list_research",
        arguments: "{}",
      },
    ];
    const loader = vi.fn<AttachmentLoader>(() => null);

    const hydrated = await hydrateAttachmentReferences(items, loader);
    expect(hydrated.items).toEqual(items);
    expect(hydrated.items).not.toBe(items);
    expect(hydrated.items[1]).not.toBe(items[1]);
    expect(hydrated.plan.entries).toEqual([]);
    expect(loader).not.toHaveBeenCalled();
    expect(dehydrateAttachmentData(hydrated.items, hydrated.plan)).toEqual(
      items,
    );
  });

  it("hydrates persisted history and the current user item once, then splits runner inputs", async () => {
    const persistedItems: AgentInputItem[] = [
      { role: "user", content: "earlier question" },
      {
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "earlier answer" }],
      },
    ];
    const currentUserItem = {
      role: "user" as const,
      content: [
        { type: "input_text" as const, text: "read this" },
        {
          type: "input_file" as const,
          file: formatAttachmentReference(FILE_ID),
        },
      ],
    };

    const hydrated = await hydrateAttachmentRunInput(
      persistedItems,
      currentUserItem,
      () =>
        loadedAttachment({
          id: FILE_ID,
          kind: "file",
          name: "buyers.txt",
          mimeType: "text/plain",
          bytes: "buyers",
        }),
    );

    expect(hydrated.initialItems).toEqual(persistedItems);
    expect(hydrated.currentInput).toHaveLength(1);
    expect(JSON.stringify(hydrated.currentInput)).toContain(
      "data:text/plain;base64,",
    );
    expect(
      dehydrateAttachmentData(
        [...hydrated.initialItems, ...hydrated.currentInput],
        hydrated.plan,
      ),
    ).toEqual([...persistedItems, currentUserItem]);
  });
});
