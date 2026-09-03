import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_INPUT_IMAGE_DIMENSION,
  MAX_INPUT_IMAGE_FRAMES,
  MAX_INPUT_IMAGE_PIXELS,
  MAX_OOXML_CRITICAL_XML_BYTES,
  MAX_OOXML_XML_DEPTH,
  MAX_OOXML_XML_NODES,
  validateInputImageResourceBudget,
  validateOoxmlCriticalXmlSize,
  validateOoxmlXmlComplexity,
} from "./file-validation";

import {
  deleteStoredInputAttachment,
  resolveStoredInputAttachmentPath,
  storeInputAttachment,
  writeInputAttachmentChunk,
} from "./storage";

function onePixelImage() {
  return sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 30, g: 120, b: 210, alpha: 1 },
    },
  });
}

const [onePixelPng, onePixelJpeg, onePixelWebp, onePixelGif] =
  await Promise.all([
    onePixelImage().png().toBuffer(),
    onePixelImage().jpeg().toBuffer(),
    onePixelImage().webp().toBuffer(),
    onePixelImage().gif().toBuffer(),
  ]);

const headerOnlyJpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01,
  0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff,
  0xd9,
]);

const headerOnlyWebp = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42,
  0x50, 0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

const invalidLzwGif = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
);
invalidLzwGif[29] = 0;

const animationPixels = Buffer.from([
  0xff, 0x00, 0x00, 0xff,
  0x00, 0x00, 0xff, 0xff,
]);
const [animatedGif, animatedWebp] = await Promise.all([
  sharp(animationPixels, {
    raw: { width: 1, height: 2, channels: 4, pageHeight: 1 },
  })
    .gif({ delay: [100, 100], keepDuplicateFrames: true })
    .toBuffer(),
  sharp(animationPixels, {
    raw: { width: 1, height: 2, channels: 4, pageHeight: 1 },
  })
    .webp({ delay: [100, 100], loop: 0 })
    .toBuffer(),
]);

function zipFixture(
  entries: Readonly<Record<string, string | Buffer>>,
  options: { comment?: Buffer } = {},
): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;

  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "ascii");
    const body = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const compressed = deflateRawSync(body);
    const checksum = crc32(body);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(body.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localRecords.push(localHeader, nameBytes, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(body.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(centralHeader, nameBytes);
    localOffset += localHeader.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const comment = options.comment ?? Buffer.alloc(0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...localRecords, centralDirectory, end, comment]);
}

type OoxmlFixtureKind = "docx" | "xlsx" | "pptx";

const ooxmlFixtures = {
  docx: {
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    mainPart: "word/document.xml",
    namespace:
      "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    root: "w:document",
  },
  xlsx: {
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    mainPart: "xl/workbook.xml",
    namespace:
      "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    root: "workbook",
  },
  pptx: {
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    mainPart: "ppt/presentation.xml",
    namespace:
      "http://schemas.openxmlformats.org/presentationml/2006/main",
    root: "p:presentation",
  },
} as const;

function ooxmlFixture(
  kind: OoxmlFixtureKind,
  options: {
    comment?: Buffer;
    extraEntries?: Record<string, Buffer>;
    mainPart?: string;
    relationshipTarget?: string;
    xmlEncoding?: "utf16be" | "utf16le" | "utf8";
  } = {},
): Buffer {
  const fixture = ooxmlFixtures[kind];
  const mainPart = options.mainPart ?? fixture.mainPart;
  const encodeXml = (xml: string): string | Buffer => {
    if (
      options.xmlEncoding !== "utf16le" &&
      options.xmlEncoding !== "utf16be"
    ) {
      return `<?xml version="1.0" encoding="UTF-8"?>${xml}`;
    }
    const encoded = Buffer.from(
      `<?xml version="1.0" encoding="UTF-16"?>${xml}`,
      "utf16le",
    );
    if (options.xmlEncoding === "utf16be") {
      encoded.swap16();
    }
    return Buffer.concat([
      options.xmlEncoding === "utf16le"
        ? Buffer.from([0xff, 0xfe])
        : Buffer.from([0xfe, 0xff]),
      encoded,
    ]);
  };
  return zipFixture({
    "[Content_Types].xml": encodeXml(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      `<Override PartName="/${mainPart}" ContentType="${fixture.contentType}"/>` +
      "</Types>",
    ),
    "_rels/.rels": encodeXml(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
      `Target="${options.relationshipTarget ?? mainPart}"/>` +
      "</Relationships>",
    ),
    [mainPart]: encodeXml(
      `<${fixture.root} ` +
        `xmlns${fixture.root.includes(":") ? `:${fixture.root.split(":")[0]}` : ""}="${fixture.namespace}"/>`,
    ),
    ...options.extraEntries,
  }, options);
}

const validFixtures = [
  {
    name: "buyers.txt",
    type: "text/plain",
    body: Buffer.from("buyer one\nbuyer two\n", "utf8"),
    kind: "file",
  },
  {
    name: "catalog.pdf",
    type: "application/pdf",
    body: Buffer.from("%PDF-1.4\n%%EOF\n", "ascii"),
    kind: "file",
  },
  {
    name: "buyers.csv",
    type: "text/csv",
    body: Buffer.from("company,country\nAcme,DE\n", "utf8"),
    kind: "file",
  },
  {
    name: "brief.md",
    type: "text/markdown",
    body: Buffer.from("# Product brief\n\nSteel pump", "utf8"),
    kind: "file",
  },
  {
    name: "filters.json",
    type: "application/json",
    body: Buffer.from('{"country":"DE"}', "utf8"),
    kind: "file",
  },
  {
    name: "brief.docx",
    type:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    body: ooxmlFixture("docx"),
    kind: "file",
  },
  {
    name: "buyers.xlsx",
    type:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body: ooxmlFixture("xlsx"),
    kind: "file",
  },
  {
    name: "catalog.pptx",
    type:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    body: ooxmlFixture("pptx"),
    kind: "file",
  },
  {
    name: "product.png",
    type: "image/png",
    body: onePixelPng,
    kind: "image",
  },
  {
    name: "product.jpg",
    type: "image/jpeg",
    body: onePixelJpeg,
    kind: "image",
  },
  {
    name: "product.jpeg",
    type: "image/jpeg",
    body: onePixelJpeg,
    kind: "image",
  },
  {
    name: "product.webp",
    type: "image/webp",
    body: onePixelWebp,
    kind: "image",
  },
  {
    name: "product.gif",
    type: "image/gif",
    body: onePixelGif,
    kind: "image",
  },
] as const;

describe("input attachment storage", () => {
  let storageDirectory: string;

  beforeEach(async () => {
    storageDirectory = await mkdtemp(
      path.join(os.tmpdir(), "custent-input-attachments-"),
    );
  });

  afterEach(async () => {
    await rm(storageDirectory, { recursive: true, force: true });
  });

  it.each(validFixtures)("atomically stores a valid $type attachment", async (fixture) => {
    const stored = await storeInputAttachment({
      file: new File([Uint8Array.from(fixture.body)], fixture.name, {
        type: fixture.type,
      }),
      storageDirectory,
      maxBytes: 10 * 1024 * 1024,
    });

    expect(stored).toMatchObject({
      kind: fixture.kind,
      originalName: fixture.name,
      mimeType: fixture.type,
      sizeBytes: fixture.body.byteLength,
      sha256: createHash("sha256").update(fixture.body).digest("hex"),
      storagePath: stored.id,
    });
    const finalPath = resolveStoredInputAttachmentPath(
      storageDirectory,
      stored.storagePath,
    );
    await expect(readFile(finalPath)).resolves.toEqual(fixture.body);
    expect((await stat(finalPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(storageDirectory)).toEqual([stored.id]);

    await deleteStoredInputAttachment(storageDirectory, stored.storagePath);
    await expect(readdir(storageDirectory)).resolves.toEqual([]);
  });

  it.each([
    new File([Buffer.from("not pdf", "utf8")], "fake.pdf", {
      type: "application/pdf",
    }),
    new File([Buffer.from([0xff, 0xfe, 0x00])], "invalid.txt", {
      type: "text/plain",
    }),
    new File([onePixelPng], "product.jpg", { type: "image/png" }),
    new File([onePixelPng], "../product.png", { type: "image/png" }),
    new File([onePixelPng], "product.png", { type: "image/jpeg" }),
    new File([onePixelJpeg], "product.jpg", { type: "image/jpg" }),
  ])("rejects invalid extension, content, name, or MIME without publishing", async (file) => {
    await expect(
      storeInputAttachment({
        file,
        storageDirectory,
        maxBytes: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(readdir(storageDirectory)).resolves.toEqual([]);
  });

  it.each([
    {
      body: onePixelJpeg,
      declaredType: "image/jpeg",
      expectedType: "image/jpeg",
      name: "PRODUCT.JPG",
    },
    {
      body: onePixelWebp,
      declaredType: "",
      expectedType: "image/webp",
      name: "PRODUCT.WEBP",
    },
    {
      body: ooxmlFixture("docx"),
      declaredType: "application/octet-stream",
      expectedType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "BRIEF.DOCX",
    },
  ])(
    "normalizes a generic MIME and uppercase extension for $name",
    async ({ body, declaredType, expectedType, name }) => {
      const stored = await storeInputAttachment({
        file: new File([Uint8Array.from(body)], name, {
          type: declaredType,
        }),
        storageDirectory,
        maxBytes: 10 * 1024 * 1024,
      });

      expect(stored.mimeType).toBe(expectedType);
      await deleteStoredInputAttachment(storageDirectory, stored.storagePath);
    },
  );

  it.each([
    ["invalid.txt", "text/plain"],
    ["invalid.csv", "text/csv"],
    ["invalid.md", "text/markdown"],
    ["invalid.json", "application/json"],
  ] as const)("rejects invalid UTF-8 for %s", async (name, type) => {
    await expect(
      storeInputAttachment({
        file: new File([Buffer.from([0xff, 0xfe])], name, { type }),
        storageDirectory,
        maxBytes: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 415 });
    await expect(readdir(storageDirectory)).resolves.toEqual([]);
  });

  it("rejects NUL text and invalid JSON syntax", async () => {
    for (const file of [
      new File([Buffer.from("buyer\0name", "utf8")], "buyers.csv", {
        type: "text/csv",
      }),
      new File(["{\"country\":}"], "filters.json", {
        type: "application/json",
      }),
      new File(["{} trailing"], "trailing.json", {
        type: "application/json",
      }),
    ]) {
      await expect(
        storeInputAttachment({
          file,
          storageDirectory,
          maxBytes: 10 * 1024 * 1024,
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 415 });
    }
    await expect(readdir(storageDirectory)).resolves.toEqual([]);
  });

  it.each(["42", "[1,2]", '"buyer"'])(
    "accepts any syntactically valid JSON value: %s",
    async (json) => {
      const stored = await storeInputAttachment({
        file: new File([json], "value.json", { type: "application/json" }),
        storageDirectory,
        maxBytes: 10 * 1024 * 1024,
      });
      await deleteStoredInputAttachment(storageDirectory, stored.storagePath);
    },
  );

  it("fully decodes images and rejects animated GIF", async () => {
    const files = [
      new File([onePixelPng.subarray(0, 20)], "broken.png", {
        type: "image/png",
      }),
      new File([headerOnlyJpeg], "header-only.jpg", {
        type: "image/jpeg",
      }),
      new File([headerOnlyWebp], "header-only.webp", {
        type: "image/webp",
      }),
      new File([invalidLzwGif], "invalid-lzw.gif", {
        type: "image/gif",
      }),
      new File([animatedGif], "animated.gif", { type: "image/gif" }),
    ];
    for (const file of files) {
      await expect(
        storeInputAttachment({
          file,
          storageDirectory,
          maxBytes: 10 * 1024 * 1024,
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 415 });
    }
    await expect(readdir(storageDirectory)).resolves.toEqual([]);
  });

  it("accepts animated WebP", async () => {
    const stored = await storeInputAttachment({
      file: new File([animatedWebp], "animated.webp", { type: "image/webp" }),
      storageDirectory,
      maxBytes: 10 * 1024 * 1024,
    });

    expect(stored).toMatchObject({
      kind: "image",
      mimeType: "image/webp",
      originalName: "animated.webp",
      sizeBytes: animatedWebp.byteLength,
    });
    await deleteStoredInputAttachment(storageDirectory, stored.storagePath);
  });

  it("enforces explicit image dimension, pixel, and frame boundaries", async () => {
    expect(() =>
      validateInputImageResourceBudget({
        height: 1,
        pages: 1,
        width: MAX_INPUT_IMAGE_DIMENSION,
      }),
    ).not.toThrow();
    expect(() =>
      validateInputImageResourceBudget({
        height: 1,
        pages: 1,
        width: MAX_INPUT_IMAGE_DIMENSION + 1,
      }),
    ).toThrow("图片尺寸超过安全限制");
    expect(() =>
      validateInputImageResourceBudget({
        height: 4_000,
        pages: 1,
        width: MAX_INPUT_IMAGE_PIXELS / 4_000,
      }),
    ).not.toThrow();
    expect(() =>
      validateInputImageResourceBudget({
        height: 4_001,
        pages: 1,
        width: MAX_INPUT_IMAGE_PIXELS / 4_000,
      }),
    ).toThrow("图片总像素数超过安全限制");
    expect(() =>
      validateInputImageResourceBudget({
        height: 1,
        pages: MAX_INPUT_IMAGE_FRAMES,
        width: 1,
      }),
    ).not.toThrow();
    expect(() =>
      validateInputImageResourceBudget({
        height: 1,
        pages: MAX_INPUT_IMAGE_FRAMES + 1,
        width: 1,
      }),
    ).toThrow("图片帧数超过安全限制");

    const [atDimensionLimit, overDimensionLimit] = await Promise.all([
      sharp({
        create: {
          width: 1,
          height: MAX_INPUT_IMAGE_DIMENSION,
          channels: 3,
          background: "white",
        },
      })
        .png()
        .toBuffer(),
      sharp({
        create: {
          width: 1,
          height: MAX_INPUT_IMAGE_DIMENSION + 1,
          channels: 3,
          background: "white",
        },
      })
        .png()
        .toBuffer(),
    ]);
    const stored = await storeInputAttachment({
      file: new File([atDimensionLimit], "at-limit.png", {
        type: "image/png",
      }),
      storageDirectory,
      maxBytes: 10 * 1024 * 1024,
    });
    await deleteStoredInputAttachment(storageDirectory, stored.storagePath);
    await expect(
      storeInputAttachment({
        file: new File([overDimensionLimit], "over-limit.png", {
          type: "image/png",
        }),
        storageDirectory,
        maxBytes: 10 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 415 });
    await expect(readdir(storageDirectory)).resolves.toEqual([]);
  });

  it("requires MIME-specific OOXML central-directory markers", async () => {
    const genericZip = zipFixture({ "word/document.xml": "marker only" });
    const incompleteDocx = zipFixture({
      "[Content_Types].xml": "<Types/>",
      "_rels/.rels": "<Relationships/>",
      "word/document.xml": "<w:document/>",
    });
    const validDocx = ooxmlFixture("docx");
    const files = [
      new File([Buffer.from("PK\u0003\u0004word/document.xml")], "fake.docx", {
        type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      new File([Uint8Array.from(genericZip)], "generic.docx", {
        type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      new File([Uint8Array.from(incompleteDocx)], "incomplete.docx", {
        type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      new File([Uint8Array.from(validDocx)], "disguised.xlsx", {
        type:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      new File(
        [Uint8Array.from(validDocx.subarray(0, -1))],
        "truncated.docx",
        {
          type:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      ),
    ];
    for (const file of files) {
      await expect(
        storeInputAttachment({
          file,
          storageDirectory,
          maxBytes: 10 * 1024 * 1024,
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 415 });
    }
    await expect(readdir(storageDirectory)).resolves.toEqual([]);
  });

  it.each([
    {
      body: ooxmlFixture("docx", {
        mainPart: "custom/main-document.xml",
        relationshipTarget: "./custom/main-document.xml",
      }),
      name: "custom-main-part.docx",
    },
    {
      body: ooxmlFixture("docx", { xmlEncoding: "utf16le" }),
      name: "utf16le.docx",
    },
    {
      body: ooxmlFixture("docx", { xmlEncoding: "utf16be" }),
      name: "utf16be.docx",
    },
  ])("accepts a valid OOXML package variant: $name", async ({ body, name }) => {
    const stored = await storeInputAttachment({
      file: new File([Uint8Array.from(body)], name, {
        type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      storageDirectory,
      maxBytes: 10 * 1024 * 1024,
    });

    await deleteStoredInputAttachment(storageDirectory, stored.storagePath);
  });

  it("enforces critical OOXML XML byte, node, and depth boundaries", () => {
    expect(() =>
      validateOoxmlCriticalXmlSize(
        MAX_OOXML_CRITICAL_XML_BYTES,
        "word/document.xml",
      ),
    ).not.toThrow();
    expect(() =>
      validateOoxmlCriticalXmlSize(
        MAX_OOXML_CRITICAL_XML_BYTES + 1,
        "word/document.xml",
      ),
    ).toThrow("超过安全限制");

    const atDepthLimit =
      "<a>".repeat(MAX_OOXML_XML_DEPTH) +
      "</a>".repeat(MAX_OOXML_XML_DEPTH);
    expect(() => validateOoxmlXmlComplexity(atDepthLimit)).not.toThrow();
    expect(() =>
      validateOoxmlXmlComplexity(`<a>${atDepthLimit}</a>`),
    ).toThrow("嵌套深度超过安全限制");

    const atNodeLimit =
      "<root>" + "<n/>".repeat(MAX_OOXML_XML_NODES - 1) + "</root>";
    expect(() => validateOoxmlXmlComplexity(atNodeLimit)).not.toThrow();
    expect(() =>
      validateOoxmlXmlComplexity(
        "<root>" + "<n/>".repeat(MAX_OOXML_XML_NODES) + "</root>",
      ),
    ).toThrow("节点数超过安全限制");
  });

  it("rejects comment-only markers and DTD entities in OOXML", async () => {
    const commentOnlyDocx = zipFixture({
      "[Content_Types].xml":
        '<!-- <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        "</Types> -->",
      "_rels/.rels":
        '<!-- <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        "</Relationships> -->",
      "word/document.xml":
        '<!-- <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/> -->',
    });

    const entityDocx = ooxmlFixture("docx", {
      extraEntries: {
        "word/document.xml": Buffer.from(
          '<!DOCTYPE w:document [<!ENTITY injected "buyer">]>' +
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">&injected;</w:document>',
          "utf8",
        ),
      },
    });

    for (const [name, body] of [
      ["comment-only.docx", commentOnlyDocx],
      ["entity.docx", entityDocx],
    ] as const) {
      await expect(
        storeInputAttachment({
          file: new File([Uint8Array.from(body)], name, {
            type:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          }),
          storageDirectory,
          maxBytes: 10 * 1024 * 1024,
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 415 });
    }
    await expect(readdir(storageDirectory)).resolves.toEqual([]);
  });

  it("rejects an unchecked-entry ZIP bomb and corrupt non-marker entry", async () => {
    const bomb = ooxmlFixture("docx", {
      extraEntries: {
        "word/media/bomb.bin": Buffer.alloc(4 * 1024 * 1024),
      },
    });
    const payload = Buffer.from("non-marker integrity payload", "utf8");
    const corrupt = ooxmlFixture("docx", {
      extraEntries: { "word/media/data.bin": payload },
    });
    const compressedPayload = deflateRawSync(payload);
    const payloadOffset = corrupt.indexOf(compressedPayload);
    expect(payloadOffset).toBeGreaterThan(0);
    corrupt[payloadOffset + Math.floor(compressedPayload.length / 2)] ^= 0xff;

    for (const [name, body] of [
      ["bomb.docx", bomb],
      ["corrupt-entry.docx", corrupt],
    ] as const) {
      await expect(
        storeInputAttachment({
          file: new File([Uint8Array.from(body)], name, {
            type:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          }),
          storageDirectory,
          maxBytes: 10 * 1024 * 1024,
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 415 });
    }
    await expect(readdir(storageDirectory)).resolves.toEqual([]);
  });

  it("accepts an EOCD signature inside a valid ZIP comment", async () => {
    const body = ooxmlFixture("docx", {
      comment: Buffer.concat([
        Buffer.from("comment-prefix", "ascii"),
        Buffer.from([0x50, 0x4b, 0x05, 0x06]),
        Buffer.alloc(30),
      ]),
    });
    const stored = await storeInputAttachment({
      file: new File([Uint8Array.from(body)], "commented.docx", {
        type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      storageDirectory,
      maxBytes: 10 * 1024 * 1024,
    });

    await deleteStoredInputAttachment(storageDirectory, stored.storagePath);
  });

  it("enforces the streamed byte limit and rejects empty files", async () => {
    await expect(
      storeInputAttachment({
        file: new File(["too large"], "buyers.txt", { type: "text/plain" }),
        storageDirectory,
        maxBytes: 2,
      }),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      storeInputAttachment({
        file: new File([], "buyers.txt", { type: "text/plain" }),
        storageDirectory,
        maxBytes: 2,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(readdir(storageDirectory)).resolves.toEqual([]);
  });

  it("does not open a staging file before validation-buffer allocation succeeds", async () => {
    const allocationFailure = vi
      .spyOn(Buffer, "allocUnsafe")
      .mockImplementationOnce(() => {
        throw new Error("simulated allocation failure");
      });
    try {
      await expect(
        storeInputAttachment({
          file: new File(["buyers"], "buyers.txt", { type: "text/plain" }),
          storageDirectory,
          maxBytes: 10 * 1024 * 1024,
        }),
      ).rejects.toThrow("simulated allocation failure");
    } finally {
      allocationFailure.mockRestore();
    }
    await expect(readdir(storageDirectory)).resolves.toEqual([]);
  });

  it("never resolves a database-controlled path outside the storage root", () => {
    expect(() =>
      resolveStoredInputAttachmentPath(storageDirectory, "../../secret"),
    ).toThrow("must be a UUID");
  });

  it("retries partial writes until the entire chunk is persisted", async () => {
    const persisted: Buffer[] = [];
    const fileHandle = {
      async write(chunk: Uint8Array) {
        const bytesWritten = Math.min(2, chunk.byteLength);
        persisted.push(Buffer.from(chunk.subarray(0, bytesWritten)));
        return { bytesWritten, buffer: chunk };
      },
    };

    await writeInputAttachmentChunk(
      fileHandle as never,
      Buffer.from("abcdef", "utf8"),
    );

    expect(Buffer.concat(persisted).toString("utf8")).toBe("abcdef");
  });

  it("rejects a zero-length partial write instead of looping forever", async () => {
    const fileHandle = {
      async write(chunk: Uint8Array) {
        return { bytesWritten: 0, buffer: chunk };
      },
    };

    await expect(
      writeInputAttachmentChunk(
        fileHandle as never,
        Buffer.from("abc", "utf8"),
      ),
    ).rejects.toThrow("invalid write length");
  });
});
