import { crc32, inflateRaw } from "node:zlib";

import { XMLParser, XMLValidator } from "fast-xml-parser";
import sharp from "sharp";

import type { InputAttachmentMimeType } from "@/lib/contracts";
import {
  inputAttachmentFormatSpecifications,
  type InputAttachmentMimeTypeValue,
} from "@/lib/input-attachment-formats";
import { AppError } from "@/lib/errors";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii");
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const GIF_87A_SIGNATURE = Buffer.from("GIF87a", "ascii");
const GIF_89A_SIGNATURE = Buffer.from("GIF89a", "ascii");
const RIFF_SIGNATURE = Buffer.from("RIFF", "ascii");
const WEBP_SIGNATURE = Buffer.from("WEBP", "ascii");
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_MAX_COMMENT_BYTES = 65_535;

const MAX_OOXML_TOTAL_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_OOXML_COMPRESSION_RATIO = 100;
export const MAX_INPUT_IMAGE_PIXELS = 40_000_000;
export const MAX_INPUT_IMAGE_DIMENSION = 16_384;
export const MAX_INPUT_IMAGE_FRAMES = 200;
export const MAX_OOXML_CRITICAL_XML_BYTES = 16 * 1024 * 1024;
export const MAX_OOXML_XML_NODES = 200_000;
export const MAX_OOXML_XML_DEPTH = 256;

const CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_DOCUMENT_RELATIONSHIP_TYPES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
]);

type TextMimeType = Extract<
  InputAttachmentMimeType,
  "text/plain" | "text/csv" | "text/markdown" | "application/json"
>;

type ImageMimeType = Extract<
  InputAttachmentMimeType,
  "image/png" | "image/jpeg" | "image/webp" | "image/gif"
>;

type OoxmlMimeType = Extract<
  InputAttachmentMimeType,
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
>;

type ZipEntry = {
  compressedSize: number;
  compressionMethod: number;
  crc32: number;
  flags: number;
  localHeaderOffset: number;
  name: string;
  uncompressedSize: number;
};

type ZipDirectory = {
  centralDirectoryOffset: number;
  entries: ReadonlyMap<string, ZipEntry>;
};

type OoxmlSpecification = {
  label: "DOCX" | "XLSX" | "PPTX";
  mainContentType: string;
  mainNamespaces: readonly string[];
  rootElement: string;
};

type ValidatedZipEntry = {
  bytes: Buffer;
  recordEnd: number;
};

type XmlElement = {
  attributes: ReadonlyMap<string, string>;
  childNodes: readonly unknown[];
  localName: string;
  namespaceUri: string | null;
  namespaces: ReadonlyMap<string, string>;
};

const ooxmlSpecifications: Record<OoxmlMimeType, OoxmlSpecification> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    label: "DOCX",
    mainContentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    mainNamespaces: [
      "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
      "http://purl.oclc.org/ooxml/wordprocessingml/main",
    ],
    rootElement: "document",
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    label: "XLSX",
    mainContentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    mainNamespaces: [
      "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "http://purl.oclc.org/ooxml/spreadsheetml/main",
    ],
    rootElement: "workbook",
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    label: "PPTX",
    mainContentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    mainNamespaces: [
      "http://schemas.openxmlformats.org/presentationml/2006/main",
      "http://purl.oclc.org/ooxml/presentationml/main",
    ],
    rootElement: "presentation",
  },
};

const sharpFormatByMimeType: Record<ImageMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const xmlParser = new XMLParser({
  allowBooleanAttributes: false,
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  preserveOrder: true,
  processEntities: true,
  trimValues: false,
});

function invalidAttachment(message: string): AppError {
  return new AppError("INVALID_REQUEST", message, 415);
}

function startsWith(bytes: Buffer, signature: Buffer): boolean {
  return (
    bytes.length >= signature.length &&
    bytes.subarray(0, signature.length).equals(signature)
  );
}

function isKnownBinarySignature(bytes: Buffer): boolean {
  return (
    startsWith(bytes, PDF_SIGNATURE) ||
    startsWith(bytes, PNG_SIGNATURE) ||
    startsWith(bytes, JPEG_SIGNATURE) ||
    startsWith(bytes, GIF_87A_SIGNATURE) ||
    startsWith(bytes, GIF_89A_SIGNATURE) ||
    (bytes.length >= 12 &&
      startsWith(bytes, RIFF_SIGNATURE) &&
      bytes.subarray(8, 12).equals(WEBP_SIGNATURE)) ||
    (bytes.length >= 4 && bytes.readUInt32LE(0) === ZIP_LOCAL_FILE_SIGNATURE)
  );
}

function decodeStrictUtf8(bytes: Buffer, label: string): string {
  if (bytes.includes(0)) {
    throw invalidAttachment(`${label} 附件必须是纯 UTF-8 文本。`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidAttachment(`${label} 附件必须是有效 UTF-8 文本。`);
  }
}

function validateText(mimeType: TextMimeType, bytes: Buffer): void {
  const label = inputAttachmentFormatSpecifications[mimeType].label;
  if (isKnownBinarySignature(bytes)) {
    throw invalidAttachment(`${label} 附件内容与声明类型不符。`);
  }
  const text = decodeStrictUtf8(bytes, label);
  if (mimeType === "application/json") {
    try {
      JSON.parse(text);
    } catch {
      throw invalidAttachment("JSON 附件必须包含语法有效的 JSON。");
    }
  }
}

function validatePdf(bytes: Buffer): void {
  if (!startsWith(bytes, PDF_SIGNATURE)) {
    throw invalidAttachment("PDF 文件头不符合要求。");
  }
}

function skipGifSubBlocks(bytes: Buffer, initialOffset: number): number {
  let offset = initialOffset;
  while (offset < bytes.length) {
    const blockSize = bytes[offset];
    offset += 1;
    if (blockSize === 0) {
      return offset;
    }
    if (offset + blockSize > bytes.length) {
      break;
    }
    offset += blockSize;
  }
  throw invalidAttachment("GIF 文件结构不符合要求。");
}

function validateGifLzwCodeSizes(bytes: Buffer): void {
  if (
    bytes.length < 14 ||
    (!startsWith(bytes, GIF_87A_SIGNATURE) &&
      !startsWith(bytes, GIF_89A_SIGNATURE))
  ) {
    throw invalidAttachment("GIF 文件结构不符合要求。");
  }
  let offset = 13;
  if ((bytes[10] & 0x80) !== 0) {
    offset += 3 * 2 ** ((bytes[10] & 0x07) + 1);
  }
  while (offset < bytes.length) {
    const blockType = bytes[offset];
    offset += 1;
    if (blockType === 0x3b) {
      return;
    }
    if (blockType === 0x21) {
      if (offset >= bytes.length) {
        break;
      }
      offset += 1;
      offset = skipGifSubBlocks(bytes, offset);
      continue;
    }
    if (blockType !== 0x2c || offset + 9 > bytes.length) {
      break;
    }
    const packed = bytes[offset + 8];
    offset += 9;
    if ((packed & 0x80) !== 0) {
      offset += 3 * 2 ** ((packed & 0x07) + 1);
    }
    if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) {
      break;
    }
    offset += 1;
    offset = skipGifSubBlocks(bytes, offset);
  }
  throw invalidAttachment("GIF 文件结构不符合要求。");
}

export function validateInputImageResourceBudget(input: {
  height: number | undefined;
  pages: number | undefined;
  width: number | undefined;
}): void {
  const pages = input.pages ?? 1;
  if (
    input.width === undefined ||
    !Number.isSafeInteger(input.width) ||
    input.width <= 0 ||
    input.height === undefined ||
    !Number.isSafeInteger(input.height) ||
    input.height <= 0 ||
    !Number.isSafeInteger(pages) ||
    pages <= 0
  ) {
    throw invalidAttachment("图片尺寸信息不符合要求。");
  }
  if (
    input.width > MAX_INPUT_IMAGE_DIMENSION ||
    input.height > MAX_INPUT_IMAGE_DIMENSION
  ) {
    throw invalidAttachment("图片尺寸超过安全限制。");
  }
  if (pages > MAX_INPUT_IMAGE_FRAMES) {
    throw invalidAttachment("图片帧数超过安全限制。");
  }
  if (input.width * input.height * pages > MAX_INPUT_IMAGE_PIXELS) {
    throw invalidAttachment("图片总像素数超过安全限制。");
  }
}

async function validateImage(
  mimeType: ImageMimeType,
  bytes: Buffer,
): Promise<void> {
  const label = inputAttachmentFormatSpecifications[mimeType].label;
  try {
    if (mimeType === "image/gif") {
      validateGifLzwCodeSizes(bytes);
    }
    const probe = sharp(bytes, {
      animated: false,
      failOn: "warning",
      limitInputChannels: 5,
      limitInputPixels: MAX_INPUT_IMAGE_PIXELS,
      unlimited: false,
    });
    const metadata = await probe.metadata();
    if (metadata.format !== sharpFormatByMimeType[mimeType]) {
      throw invalidAttachment(`${label} 附件内容与声明类型不符。`);
    }
    validateInputImageResourceBudget({
      height: metadata.height,
      pages: metadata.pages,
      width: metadata.width,
    });
    if (mimeType === "image/gif" && (metadata.pages ?? 1) !== 1) {
      throw invalidAttachment(`不支持动画 ${label}，请上传静态图片。`);
    }

    // metadata() does not decode compressed pixels; stats() does.
    await sharp(bytes, {
      animated: true,
      failOn: "warning",
      limitInputChannels: 5,
      limitInputPixels: MAX_INPUT_IMAGE_PIXELS,
      unlimited: false,
    }).stats();
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw invalidAttachment(`${label} 图片无法完整解码。`);
  }
}

function findZipEndOfCentralDirectory(bytes: Buffer): number {
  const minimumOffset = Math.max(
    0,
    bytes.length - 22 - ZIP_MAX_COMMENT_BYTES,
  );
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (
      bytes.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      return offset;
    }
  }
  return -1;
}

function decodeZipEntryName(bytes: Buffer, flags: number): string {
  if (bytes.length === 0 || bytes.includes(0)) {
    throw invalidAttachment("OOXML ZIP 条目名称不符合要求。");
  }
  let name: string;
  if ((flags & 0x0800) !== 0) {
    name = decodeStrictUtf8(bytes, "OOXML ZIP");
  } else {
    if (bytes.some((byte) => byte > 0x7f)) {
      throw invalidAttachment("OOXML ZIP 条目名称编码不符合要求。");
    }
    name = bytes.toString("ascii");
  }

  const pathWithoutTrailingSlash = name.endsWith("/")
    ? name.slice(0, -1)
    : name;
  const pathParts = pathWithoutTrailingSlash.split("/");
  if (
    pathWithoutTrailingSlash.length === 0 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    pathParts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw invalidAttachment("OOXML ZIP 条目路径不符合要求。");
  }
  return name;
}

function parseZipDirectory(bytes: Buffer): ZipDirectory {
  if (
    bytes.length < 22 ||
    bytes.readUInt32LE(0) !== ZIP_LOCAL_FILE_SIGNATURE
  ) {
    throw invalidAttachment("OOXML 文件不是有效的 ZIP 容器。");
  }
  const endOffset = findZipEndOfCentralDirectory(bytes);
  if (endOffset < 0) {
    throw invalidAttachment("OOXML ZIP 中央目录不存在。");
  }

  const diskNumber = bytes.readUInt16LE(endOffset + 4);
  const directoryDisk = bytes.readUInt16LE(endOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(endOffset + 8);
  const totalEntries = bytes.readUInt16LE(endOffset + 10);
  const centralDirectorySize = bytes.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = bytes.readUInt32LE(endOffset + 16);
  if (
    diskNumber !== 0 ||
    directoryDisk !== 0 ||
    entriesOnDisk === 0 ||
    entriesOnDisk !== totalEntries ||
    entriesOnDisk === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff ||
    centralDirectoryOffset + centralDirectorySize !== endOffset
  ) {
    throw invalidAttachment("OOXML ZIP 中央目录不符合要求。");
  }

  const entries = new Map<string, ZipEntry>();
  let totalUncompressedSize = 0;
  let offset = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      offset + 46 > endOffset ||
      bytes.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE
    ) {
      throw invalidAttachment("OOXML ZIP 中央目录条目不符合要求。");
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const compressionMethod = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const entryCommentLength = bytes.readUInt16LE(offset + 32);
    const startingDisk = bytes.readUInt16LE(offset + 34);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    const entryEnd =
      offset + 46 + nameLength + extraLength + entryCommentLength;
    const allowedFlags = 0x080e;
    if (
      entryEnd > endOffset ||
      startingDisk !== 0 ||
      (flags & ~allowedFlags) !== 0 ||
      (compressionMethod !== 0 && compressionMethod !== 8) ||
      (compressionMethod === 0 && (flags & 0x0006) !== 0) ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      localHeaderOffset >= centralDirectoryOffset ||
      (uncompressedSize > 0 &&
        (compressedSize === 0 ||
          uncompressedSize > compressedSize * MAX_OOXML_COMPRESSION_RATIO))
    ) {
      throw invalidAttachment("OOXML ZIP 条目元数据不符合要求。");
    }
    totalUncompressedSize += uncompressedSize;
    if (totalUncompressedSize > MAX_OOXML_TOTAL_UNCOMPRESSED_BYTES) {
      throw invalidAttachment("OOXML ZIP 总展开大小超过安全限制。");
    }

    const name = decodeZipEntryName(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
      flags,
    );
    if (entries.has(name)) {
      throw invalidAttachment("OOXML ZIP 不能包含重复条目。");
    }
    entries.set(name, {
      compressedSize,
      compressionMethod,
      crc32: checksum,
      flags,
      localHeaderOffset,
      name,
      uncompressedSize,
    });
    offset = entryEnd;
  }
  if (offset !== endOffset) {
    throw invalidAttachment("OOXML ZIP 中央目录长度不符合要求。");
  }
  return { centralDirectoryOffset, entries };
}

function readZipDataDescriptorEnd(
  archive: Buffer,
  directory: ZipDirectory,
  entry: ZipEntry,
  dataEnd: number,
): number {
  const candidates = [
    { offset: dataEnd, end: dataEnd + 12 },
    { offset: dataEnd + 4, end: dataEnd + 16 },
  ];
  for (const candidate of candidates) {
    if (candidate.end > directory.centralDirectoryOffset) {
      continue;
    }
    if (
      candidate.offset !== dataEnd &&
      archive.readUInt32LE(dataEnd) !== ZIP_DATA_DESCRIPTOR_SIGNATURE
    ) {
      continue;
    }
    if (
      archive.readUInt32LE(candidate.offset) === entry.crc32 &&
      archive.readUInt32LE(candidate.offset + 4) === entry.compressedSize &&
      archive.readUInt32LE(candidate.offset + 8) === entry.uncompressedSize
    ) {
      return candidate.end;
    }
  }
  throw invalidAttachment(
    `OOXML 条目 ${entry.name} 的数据描述符不符合要求。`,
  );
}

async function inflateZipEntry(
  compressed: Buffer,
  entry: ZipEntry,
): Promise<Buffer> {
  if (entry.compressionMethod === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      throw invalidAttachment(`OOXML 条目 ${entry.name} 的存储大小不一致。`);
    }
    return compressed;
  }

  try {
    const result = await new Promise<{
      buffer: Buffer;
      engine: { bytesWritten: number };
    }>((resolve, reject) => {
      inflateRaw(
        compressed,
        {
          info: true,
          maxOutputLength: Math.max(1, entry.uncompressedSize),
        },
        (error, output) => {
          if (error !== null) {
            reject(error);
            return;
          }
          resolve(
            output as unknown as {
              buffer: Buffer;
              engine: { bytesWritten: number };
            },
          );
        },
      );
    });
    if (
      !Buffer.isBuffer(result.buffer) ||
      result.engine.bytesWritten !== compressed.length
    ) {
      throw new Error("Deflate stream did not consume the declared payload");
    }
    return result.buffer;
  } catch {
    throw invalidAttachment(`OOXML 条目 ${entry.name} 无法安全解压。`);
  }
}

async function readAndValidateZipEntry(
  archive: Buffer,
  directory: ZipDirectory,
  entry: ZipEntry,
): Promise<ValidatedZipEntry> {
  const offset = entry.localHeaderOffset;
  if (
    offset + 30 > directory.centralDirectoryOffset ||
    archive.readUInt32LE(offset) !== ZIP_LOCAL_FILE_SIGNATURE
  ) {
    throw invalidAttachment(
      `OOXML 条目 ${entry.name} 的本地文件头不符合要求。`,
    );
  }
  const localFlags = archive.readUInt16LE(offset + 6);
  const localMethod = archive.readUInt16LE(offset + 8);
  const localChecksum = archive.readUInt32LE(offset + 14);
  const localCompressedSize = archive.readUInt32LE(offset + 18);
  const localUncompressedSize = archive.readUInt32LE(offset + 22);
  const localNameLength = archive.readUInt16LE(offset + 26);
  const localExtraLength = archive.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (
    localFlags !== entry.flags ||
    localMethod !== entry.compressionMethod ||
    dataOffset > directory.centralDirectoryOffset ||
    dataEnd > directory.centralDirectoryOffset
  ) {
    throw invalidAttachment(
      `OOXML 条目 ${entry.name} 的本地元数据不符合要求。`,
    );
  }
  const localName = decodeZipEntryName(
    archive.subarray(offset + 30, offset + 30 + localNameLength),
    localFlags,
  );
  if (localName !== entry.name) {
    throw invalidAttachment(`OOXML 条目 ${entry.name} 的名称不一致。`);
  }

  const hasDataDescriptor = (entry.flags & 0x0008) !== 0;
  let recordEnd = dataEnd;
  if (hasDataDescriptor) {
    if (
      (localChecksum !== 0 && localChecksum !== entry.crc32) ||
      (localCompressedSize !== 0 &&
        localCompressedSize !== entry.compressedSize) ||
      (localUncompressedSize !== 0 &&
        localUncompressedSize !== entry.uncompressedSize)
    ) {
      throw invalidAttachment(
        `OOXML 条目 ${entry.name} 的本地大小不符合要求。`,
      );
    }
    recordEnd = readZipDataDescriptorEnd(
      archive,
      directory,
      entry,
      dataEnd,
    );
  } else if (
    localChecksum !== entry.crc32 ||
    localCompressedSize !== entry.compressedSize ||
    localUncompressedSize !== entry.uncompressedSize
  ) {
    throw invalidAttachment(
      `OOXML 条目 ${entry.name} 的本地大小不符合要求。`,
    );
  }

  const uncompressed = await inflateZipEntry(
    archive.subarray(dataOffset, dataEnd),
    entry,
  );
  if (
    uncompressed.length !== entry.uncompressedSize ||
    crc32(uncompressed) !== entry.crc32
  ) {
    throw invalidAttachment(
      `OOXML 条目 ${entry.name} 的完整性校验失败。`,
    );
  }
  return { bytes: uncompressed, recordEnd };
}

async function validateAllZipEntries(
  archive: Buffer,
  directory: ZipDirectory,
  retainedNames: ReadonlySet<string>,
  prevalidated: ReadonlyMap<string, ValidatedZipEntry> = new Map(),
): Promise<ReadonlyMap<string, Buffer>> {
  const retained = new Map<string, Buffer>();
  const ranges: { end: number; start: number }[] = [];
  for (const entry of directory.entries.values()) {
    const validated =
      prevalidated.get(entry.name) ??
      (await readAndValidateZipEntry(archive, directory, entry));
    ranges.push({
      end: validated.recordEnd,
      start: entry.localHeaderOffset,
    });
    if (retainedNames.has(entry.name)) {
      retained.set(entry.name, validated.bytes);
    }
  }
  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1].end > ranges[index].start) {
      throw invalidAttachment("OOXML ZIP 本地文件记录不能重叠。");
    }
  }
  return retained;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitQualifiedName(name: string): { localName: string; prefix: string } {
  const separator = name.indexOf(":");
  if (separator < 0) {
    return { localName: name, prefix: "" };
  }
  if (name.indexOf(":", separator + 1) >= 0) {
    throw new Error("XML qualified name contains multiple colons");
  }
  return {
    localName: name.slice(separator + 1),
    prefix: name.slice(0, separator),
  };
}

function orderedNodeElement(
  node: unknown,
  inheritedNamespaces: ReadonlyMap<string, string>,
): XmlElement | null {
  if (!isRecord(node)) {
    throw new Error("XML ordered node is not an object");
  }
  const elementNames = Object.keys(node).filter(
    (name) =>
      name !== ":@" &&
      !name.startsWith("#") &&
      !name.startsWith("?") &&
      !name.startsWith("!"),
  );
  if (elementNames.length === 0) {
    return null;
  }
  if (elementNames.length !== 1) {
    throw new Error("XML ordered node contains multiple elements");
  }

  const qualifiedName = elementNames[0];
  const childNodes = node[qualifiedName];
  if (!Array.isArray(childNodes)) {
    throw new Error("XML element children are not ordered");
  }
  const rawAttributes = node[":@"];
  if (rawAttributes !== undefined && !isRecord(rawAttributes)) {
    throw new Error("XML attributes are not an object");
  }

  const namespaces = new Map(inheritedNamespaces);
  const attributes = new Map<string, string>();
  if (rawAttributes !== undefined) {
    for (const [rawName, rawValue] of Object.entries(rawAttributes)) {
      if (!rawName.startsWith("@_") || typeof rawValue !== "string") {
        throw new Error("XML attribute representation is invalid");
      }
      const name = rawName.slice(2);
      if (name === "xmlns") {
        namespaces.set("", rawValue);
      } else if (name.startsWith("xmlns:")) {
        const prefix = name.slice("xmlns:".length);
        if (prefix.length === 0 || rawValue.length === 0) {
          throw new Error("XML namespace declaration is invalid");
        }
        namespaces.set(prefix, rawValue);
      } else {
        attributes.set(name, rawValue);
      }
    }
  }

  const { localName, prefix } = splitQualifiedName(qualifiedName);
  if (prefix.length > 0 && !namespaces.has(prefix)) {
    throw new Error("XML element uses an undeclared namespace prefix");
  }
  const namespace = namespaces.get(prefix);
  return {
    attributes,
    childNodes,
    localName,
    namespaceUri: namespace === undefined || namespace.length === 0 ? null : namespace,
    namespaces,
  };
}

function decodeOoxmlXml(bytes: Buffer, label: string): string {
  let encoding: "utf-8" | "utf-16be" | "utf-16le" = "utf-8";
  let payload = bytes;
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    payload = bytes.subarray(3);
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    payload = bytes.subarray(2);
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    payload = bytes.subarray(2);
  } else if (
    bytes.length >= 4 &&
    bytes[0] === 0x3c &&
    bytes[1] === 0x00 &&
    bytes[2] === 0x3f &&
    bytes[3] === 0x00
  ) {
    encoding = "utf-16le";
  } else if (
    bytes.length >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x3c &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x3f
  ) {
    encoding = "utf-16be";
  } else if (bytes.includes(0)) {
    throw invalidAttachment(
      `${label} OOXML XML 必须使用可识别的 UTF-16 或有效 UTF-8。`,
    );
  }

  try {
    const xml = new TextDecoder(encoding, { fatal: true }).decode(payload);
    if (xml.includes("\0")) {
      throw new Error("OOXML XML contains a NUL character");
    }
    return xml;
  } catch {
    throw invalidAttachment(`${label} OOXML XML 编码不符合要求。`);
  }
}

function findXmlTagEnd(xml: string, initialOffset: number): number {
  let quote: '"' | "'" | null = null;
  for (let offset = initialOffset; offset < xml.length; offset += 1) {
    const character = xml[offset];
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return offset;
    }
  }
  throw new Error("OOXML XML tag is not terminated");
}

export function validateOoxmlXmlComplexity(xml: string): void {
  let depth = 0;
  let nodeCount = 0;
  let offset = 0;

  const countNode = () => {
    nodeCount += 1;
    if (nodeCount > MAX_OOXML_XML_NODES) {
      throw invalidAttachment("OOXML XML 节点数超过安全限制。");
    }
  };

  while (offset < xml.length) {
    const markupOffset = xml.indexOf("<", offset);
    if (markupOffset < 0) {
      break;
    }
    if (xml.startsWith("<!--", markupOffset)) {
      countNode();
      const end = xml.indexOf("-->", markupOffset + 4);
      if (end < 0) {
        throw new Error("OOXML XML comment is not terminated");
      }
      offset = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", markupOffset)) {
      countNode();
      const end = xml.indexOf("]]>", markupOffset + 9);
      if (end < 0) {
        throw new Error("OOXML XML CDATA is not terminated");
      }
      offset = end + 3;
      continue;
    }
    if (xml.startsWith("<?", markupOffset)) {
      countNode();
      const end = xml.indexOf("?>", markupOffset + 2);
      if (end < 0) {
        throw new Error("OOXML XML processing instruction is not terminated");
      }
      offset = end + 2;
      continue;
    }
    if (xml.startsWith("<!", markupOffset)) {
      throw new Error("OOXML XML cannot contain declarations");
    }
    if (xml.startsWith("</", markupOffset)) {
      const end = findXmlTagEnd(xml, markupOffset + 2);
      depth -= 1;
      if (depth < 0) {
        throw new Error("OOXML XML element depth is invalid");
      }
      offset = end + 1;
      continue;
    }

    countNode();
    const end = findXmlTagEnd(xml, markupOffset + 1);
    let markerOffset = end - 1;
    while (markerOffset > markupOffset && /\s/u.test(xml[markerOffset])) {
      markerOffset -= 1;
    }
    if (xml[markerOffset] !== "/") {
      depth += 1;
      if (depth > MAX_OOXML_XML_DEPTH) {
        throw invalidAttachment("OOXML XML 嵌套深度超过安全限制。");
      }
    }
    offset = end + 1;
  }
  if (depth !== 0) {
    throw new Error("OOXML XML element depth is invalid");
  }
}

function parseXmlRoot(xml: string): XmlElement {
  validateOoxmlXmlComplexity(xml);
  if (XMLValidator.validate(xml) !== true) {
    throw new Error("OOXML XML is not well formed");
  }
  const document = xmlParser.parse(xml) as unknown;
  if (!Array.isArray(document)) {
    throw new Error("OOXML XML parser did not return an ordered document");
  }
  const initialNamespaces = new Map([
    ["xml", "http://www.w3.org/XML/1998/namespace"],
  ]);
  const roots = document.flatMap((node) => {
    const element = orderedNodeElement(node, initialNamespaces);
    return element === null ? [] : [element];
  });
  if (roots.length !== 1) {
    throw new Error("OOXML XML must contain exactly one document element");
  }
  return roots[0];
}

function directXmlChildren(element: XmlElement): XmlElement[] {
  return element.childNodes.flatMap((node) => {
    const child = orderedNodeElement(node, element.namespaces);
    return child === null ? [] : [child];
  });
}

function requiredZipEntry(
  entries: ReadonlyMap<string, Buffer>,
  name: string,
): Buffer {
  const entry = entries.get(name);
  if (entry === undefined) {
    throw invalidAttachment(`OOXML 文件缺少 ${name}。`);
  }
  return entry;
}

function requiredZipDirectoryEntry(
  directory: ZipDirectory,
  name: string,
): ZipEntry {
  const entry = directory.entries.get(name);
  if (entry === undefined) {
    throw invalidAttachment(`OOXML 文件缺少 ${name}。`);
  }
  return entry;
}

export function validateOoxmlCriticalXmlSize(
  uncompressedSize: number,
  entryName: string,
): void {
  if (
    !Number.isSafeInteger(uncompressedSize) ||
    uncompressedSize < 0 ||
    uncompressedSize > MAX_OOXML_CRITICAL_XML_BYTES
  ) {
    throw invalidAttachment(`OOXML XML 条目 ${entryName} 超过安全限制。`);
  }
}

function validateCriticalXmlEntrySize(entry: ZipEntry): void {
  validateOoxmlCriticalXmlSize(entry.uncompressedSize, entry.name);
}

function resolvePackageRelationshipTarget(target: string): string {
  if (
    target.length === 0 ||
    target.includes("\\") ||
    /[\u0000-\u001f\u007f?#]/u.test(target) ||
    /^[a-z][a-z0-9+.-]*:/iu.test(target)
  ) {
    throw invalidAttachment("OOXML 主文档关系目标不符合要求。");
  }

  const rawPath = target.startsWith("/") ? target.slice(1) : target;
  const normalizedParts: string[] = [];
  for (const part of rawPath.split("/")) {
    if (part === ".") {
      continue;
    }
    if (part === "..") {
      if (normalizedParts.length === 0) {
        throw invalidAttachment("OOXML 主文档关系目标不能越过包根目录。");
      }
      normalizedParts.pop();
      continue;
    }
    if (part.length === 0) {
      throw invalidAttachment("OOXML 主文档关系目标路径不符合要求。");
    }
    normalizedParts.push(part);
  }
  if (normalizedParts.length === 0) {
    throw invalidAttachment("OOXML 主文档关系目标不能为空。");
  }
  return normalizedParts.join("/");
}

function officeDocumentMainPart(relationships: XmlElement): string {
  if (
    relationships.localName !== "Relationships" ||
    relationships.namespaceUri !== RELATIONSHIPS_NAMESPACE
  ) {
    throw invalidAttachment("OOXML 文件缺少有效的包级关系标记。");
  }

  const candidates = directXmlChildren(relationships).flatMap((element) => {
    const type = element.attributes.get("Type");
    const target = element.attributes.get("Target");
    const targetMode = element.attributes.get("TargetMode");
    if (
      element.localName !== "Relationship" ||
      element.namespaceUri !== RELATIONSHIPS_NAMESPACE ||
      type === undefined ||
      !OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(type) ||
      target === undefined ||
      targetMode === "External"
    ) {
      return [];
    }
    if (targetMode !== undefined && targetMode !== "Internal") {
      throw invalidAttachment("OOXML 主文档关系模式不符合要求。");
    }
    return [resolvePackageRelationshipTarget(target)];
  });
  if (candidates.length !== 1) {
    throw invalidAttachment("OOXML 文件必须包含唯一的内部主文档关系。");
  }
  return candidates[0];
}

function hasExpectedMainContentType(
  contentTypes: XmlElement,
  mainPartName: string,
  expectedContentType: string,
): boolean {
  if (
    contentTypes.localName !== "Types" ||
    contentTypes.namespaceUri !== CONTENT_TYPES_NAMESPACE
  ) {
    return false;
  }

  const children = directXmlChildren(contentTypes);
  const matchingOverride = children.some((element) => {
    const partName = element.attributes.get("PartName");
    return (
      element.localName === "Override" &&
      element.namespaceUri === CONTENT_TYPES_NAMESPACE &&
      partName !== undefined &&
      resolvePackageRelationshipTarget(partName) === mainPartName &&
      element.attributes.get("ContentType") === expectedContentType
    );
  });
  if (matchingOverride) {
    return true;
  }

  const dotOffset = mainPartName.lastIndexOf(".");
  if (dotOffset < 0 || dotOffset === mainPartName.length - 1) {
    return false;
  }
  const extension = mainPartName.slice(dotOffset + 1).toLowerCase();
  return children.some(
    (element) =>
      element.localName === "Default" &&
      element.namespaceUri === CONTENT_TYPES_NAMESPACE &&
      element.attributes.get("Extension")?.toLowerCase() === extension &&
      element.attributes.get("ContentType") === expectedContentType,
  );
}

async function validateOoxml(
  mimeType: OoxmlMimeType,
  bytes: Buffer,
): Promise<void> {
  const specification = ooxmlSpecifications[mimeType];
  try {
    const directory = parseZipDirectory(bytes);
    const relationshipsEntry = requiredZipDirectoryEntry(
      directory,
      "_rels/.rels",
    );
    validateCriticalXmlEntrySize(relationshipsEntry);
    const validatedRelationships = await readAndValidateZipEntry(
      bytes,
      directory,
      relationshipsEntry,
    );
    const relationships = parseXmlRoot(
      decodeOoxmlXml(validatedRelationships.bytes, specification.label),
    );
    const mainPartName = officeDocumentMainPart(relationships);
    const contentTypesEntry = requiredZipDirectoryEntry(
      directory,
      "[Content_Types].xml",
    );
    const mainPartEntry = requiredZipDirectoryEntry(directory, mainPartName);
    validateCriticalXmlEntrySize(contentTypesEntry);
    validateCriticalXmlEntrySize(mainPartEntry);

    const requiredNames = new Set([
      "[Content_Types].xml",
      "_rels/.rels",
      mainPartName,
    ]);
    const retained = await validateAllZipEntries(
      bytes,
      directory,
      requiredNames,
      new Map([[relationshipsEntry.name, validatedRelationships]]),
    );
    const contentTypes = parseXmlRoot(
      decodeOoxmlXml(
        requiredZipEntry(retained, "[Content_Types].xml"),
        specification.label,
      ),
    );
    const mainPart = parseXmlRoot(
      decodeOoxmlXml(
        requiredZipEntry(retained, mainPartName),
        specification.label,
      ),
    );

    const hasContentType = hasExpectedMainContentType(
      contentTypes,
      mainPartName,
      specification.mainContentType,
    );
    const hasMainRoot =
      mainPart.localName === specification.rootElement &&
      mainPart.namespaceUri !== null &&
      specification.mainNamespaces.includes(mainPart.namespaceUri);
    if (!hasContentType || !hasMainRoot) {
      throw invalidAttachment(
        `${specification.label} 文件缺少必要的 OOXML 标记。`,
      );
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw invalidAttachment(`${specification.label} 文件结构不符合要求。`);
  }
}

export async function validateInputAttachmentBytes(
  mimeType: InputAttachmentMimeTypeValue,
  bytes: Buffer,
): Promise<void> {
  switch (mimeType) {
    case "text/plain":
    case "text/csv":
    case "text/markdown":
    case "application/json":
      validateText(mimeType, bytes);
      return;
    case "application/pdf":
      validatePdf(bytes);
      return;
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      await validateOoxml(mimeType, bytes);
      return;
    case "image/png":
    case "image/jpeg":
    case "image/webp":
    case "image/gif":
      await validateImage(mimeType, bytes);
  }
}
