import { XMLParser, XMLValidator } from "fast-xml-parser";

/**
 * XLSX is a ZIP package containing XML parts.  The server validates the
 * uploaded package before it is stored, but a historical attachment can still
 * be large enough to make a browser tab unhealthy.  These limits deliberately
 * bound the amount of work done by the read-only preview.  The original file
 * remains available through the download action when a limit is reached.
 */
export const MAX_XLSX_PREVIEW_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_XLSX_PREVIEW_TOTAL_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_XLSX_PREVIEW_XML_BYTES = 8 * 1024 * 1024;
export const MAX_XLSX_PREVIEW_ENTRIES = 10_000;
export const MAX_XLSX_PREVIEW_SHEETS = 50;
export const MAX_XLSX_PREVIEW_ROWS = 1_000;
export const MAX_XLSX_PREVIEW_COLUMNS = 50;
export const MAX_XLSX_PREVIEW_CELLS_PER_SHEET = 20_000;
export const MAX_XLSX_PREVIEW_RENDER_CELLS_PER_SHEET = 20_000;
export const MAX_XLSX_PREVIEW_WORKBOOK_CELLS = 100_000;
export const MAX_XLSX_PREVIEW_WORKBOOK_CHARACTERS = 2_000_000;
export const MAX_XLSX_PREVIEW_CELL_CHARACTERS = 4_000;
export const MAX_XLSX_PREVIEW_SHARED_STRINGS = 100_000;
export const MAX_XLSX_PREVIEW_SHARED_STRING_CHARACTERS = 2_000_000;
export const MAX_XLSX_PREVIEW_XML_NODES = 200_000;
export const MAX_XLSX_PREVIEW_XML_DEPTH = 256;
/** Relationship parts are metadata, not user-visible cells. Keep their maps bounded too. */
export const MAX_XLSX_PREVIEW_RELATIONSHIPS = 2_000;

const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_MAX_COMMENT_BYTES = 65_535;
const MAX_COMPRESSION_RATIO = 100;

const OFFICE_DOCUMENT_RELATIONSHIP_TYPES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
]);
const WORKSHEET_RELATIONSHIP_TYPES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet",
]);
const SHARED_STRINGS_RELATIONSHIP_TYPES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/sharedStrings",
]);

type XmlRecord = Record<string, unknown>;

type ZipEntry = {
  compressedSize: number;
  compressionMethod: number;
  crc32: number;
  flags: number;
  localHeaderOffset: number;
  name: string;
  uncompressedSize: number;
  recordEnd: number;
  dataOffset: number;
};

type ZipArchive = {
  bytes: Uint8Array;
  entries: ReadonlyMap<string, ZipEntry>;
};

type Relationship = {
  id: string;
  target: string;
  targetMode: string | undefined;
  type: string;
};

type ParsedWorksheet = {
  name: string;
  rows: string[][];
  rowNumbers: number[];
  columnLabels: string[];
};

type WorkbookPreviewBudget = {
  parsedCells: number;
  renderedCells: number;
  cellCharacters: number;
};

export type InputAttachmentSpreadsheetSheetPreview = ParsedWorksheet;

export type InputAttachmentSpreadsheetPreview = {
  sheets: InputAttachmentSpreadsheetSheetPreview[];
  activeSheetIndex: number;
};

export type InputAttachmentSpreadsheetPreviewRenderState =
  | { status: "loading" }
  | { status: "error"; reason: "invalid_xlsx" | "unavailable" }
  | {
      status: "ready";
      content: InputAttachmentSpreadsheetPreview;
    };

export type InputAttachmentSpreadsheetPreviewLifecycleState = {
  isOpen: boolean;
  preview: InputAttachmentSpreadsheetPreviewRenderState;
};

export class InputAttachmentSpreadsheetPreviewRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(
      `Input attachment spreadsheet preview request failed with status ${status}`,
    );
    this.name = "InputAttachmentSpreadsheetPreviewRequestError";
    this.status = status;
  }
}

export class InputAttachmentSpreadsheetPreviewParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "InputAttachmentSpreadsheetPreviewParseError";
  }
}

/** The browser cannot decode this ZIP package with the available platform APIs. */
export class InputAttachmentSpreadsheetPreviewCapabilityError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "InputAttachmentSpreadsheetPreviewCapabilityError";
  }
}

class InputAttachmentSpreadsheetPreviewAbortError extends Error {
  constructor(cause?: unknown) {
    super("XLSX 预览已取消。", cause === undefined ? undefined : { cause });
    this.name = "InputAttachmentSpreadsheetPreviewAbortError";
  }
}

export function spreadsheetPreviewErrorReason(
  error: unknown,
): Extract<
  InputAttachmentSpreadsheetPreviewRenderState,
  { status: "error" }
>["reason"] {
  return error instanceof InputAttachmentSpreadsheetPreviewParseError
    ? "invalid_xlsx"
    : "unavailable";
}

export function closeInputAttachmentSpreadsheetPreviewState(
  current: InputAttachmentSpreadsheetPreviewLifecycleState,
): InputAttachmentSpreadsheetPreviewLifecycleState {
  if (!current.isOpen && current.preview.status === "loading") {
    return current;
  }
  return {
    isOpen: false,
    preview: { status: "loading" },
  };
}

export function inputAttachmentSpreadsheetPreviewRequestCanCommit(
  activeRequestIdentity: object | null,
  requestIdentity: object,
  aborted: boolean,
): boolean {
  return !aborted && activeRequestIdentity === requestIdentity;
}

function fail(message: string, cause?: unknown): never {
  throw new InputAttachmentSpreadsheetPreviewParseError(message, cause);
}

function throwIfPreviewAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new InputAttachmentSpreadsheetPreviewAbortError(signal.reason);
  }
}

function isRecord(value: unknown): value is XmlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): XmlRecord {
  if (!isRecord(value)) {
    fail(`${label} XML 结构不符合预期。`);
  }
  return value;
}

function asRecordArray(value: unknown, label: string): XmlRecord[] {
  if (value === undefined) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => asRecord(item, label));
}

function attribute(record: XmlRecord, name: string): string | undefined {
  const value = record[`@_${name}`];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    fail(`XML 属性 ${name} 不是字符串。`);
  }
  return value;
}

function requiredAttribute(
  record: XmlRecord,
  name: string,
  label: string,
): string {
  const value = attribute(record, name);
  if (value === undefined || value.length === 0) {
    fail(`${label} 缺少 ${name} 属性。`);
  }
  return value;
}

function textFromValue(value: unknown, label: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => textFromValue(item, label)).join("");
  }
  if (isRecord(value)) {
    const directText = value["#text"];
    if (directText !== undefined && typeof directText !== "string") {
      fail(`${label} XML 文本不是字符串。`);
    }
    let text = directText === undefined ? "" : directText;
    for (const [key, child] of Object.entries(value)) {
      if (key === "#text" || key.startsWith("@_")) {
        continue;
      }
      text += textFromValue(child, label);
    }
    return text;
  }
  if (value === undefined || value === null) {
    return "";
  }
  fail(`${label} XML 文本结构不符合预期。`);
}

function textFromTag(value: unknown, tagName: string, label: string): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromTag(item, tagName, label))
      .join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  let text = "";
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("@_") || key === "#text") {
      continue;
    }
    if (key === tagName) {
      text += textFromValue(child, label);
    } else {
      text += textFromTag(child, tagName, label);
    }
  }
  return text;
}

function rootRecord(
  parsed: unknown,
  rootName: string,
  label: string,
): XmlRecord {
  const document = asRecord(parsed, label);
  const keys = Object.keys(document).filter(
    (key) => !key.startsWith("@_") && key !== "#text",
  );
  if (keys.length !== 1 || keys[0] !== rootName) {
    fail(`${label} XML 根元素不是 ${rootName}。`);
  }
  return asRecord(document[rootName], label);
}

function decodeXml(bytes: Uint8Array, label: string): string {
  if (bytes.byteLength > MAX_XLSX_PREVIEW_XML_BYTES) {
    fail(`${label} XML 超过预览大小限制。`);
  }

  let encoding: "utf-8" | "utf-16be" | "utf-16le" = "utf-8";
  let payload = bytes;
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    payload = bytes.subarray(3);
  } else if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    payload = bytes.subarray(2);
  } else if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    payload = bytes.subarray(2);
  } else if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x3c &&
    bytes[1] === 0x00 &&
    bytes[2] === 0x3f &&
    bytes[3] === 0x00
  ) {
    encoding = "utf-16le";
  } else if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x3c &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x3f
  ) {
    encoding = "utf-16be";
  } else if (bytes.includes(0)) {
    fail(`${label} XML 编码不符合要求。`);
  }

  let source: string;
  try {
    source = new TextDecoder(encoding, { fatal: true }).decode(payload);
  } catch (error) {
    fail(`${label} XML 编码不符合要求。`, error);
  }
  if (source.includes("\u0000")) {
    fail(`${label} XML 包含 NUL 字符。`);
  }
  return source;
}

function validateXmlComplexity(
  source: string,
  label: string,
  signal?: AbortSignal,
): void {
  let depth = 0;
  let nodes = 0;
  let offset = 0;
  while (offset < source.length) {
    if ((nodes & 0x3ff) === 0) {
      throwIfPreviewAborted(signal);
    }
    const open = source.indexOf("<", offset);
    if (open < 0) {
      break;
    }
    // Comments, CDATA, and processing instructions may legally contain
    // angle brackets. Skip their complete lexical span before counting
    // element depth; looking only for the first `>` would mistake markup in
    // a comment/string for real worksheet nodes.
    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      if (end < 0) {
        fail(`${label} XML 注释没有正确结束。`);
      }
      nodes += 1;
      if (nodes > MAX_XLSX_PREVIEW_XML_NODES) {
        fail(`${label} XML 节点数量超过预览限制。`);
      }
      offset = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open + 9);
      if (end < 0) {
        fail(`${label} XML CDATA 没有正确结束。`);
      }
      nodes += 1;
      if (nodes > MAX_XLSX_PREVIEW_XML_NODES) {
        fail(`${label} XML 节点数量超过预览限制。`);
      }
      offset = end + 3;
      continue;
    }
    if (source.startsWith("<?", open)) {
      const end = source.indexOf("?>", open + 2);
      if (end < 0) {
        fail(`${label} XML 处理指令没有正确结束。`);
      }
      nodes += 1;
      if (nodes > MAX_XLSX_PREVIEW_XML_NODES) {
        fail(`${label} XML 节点数量超过预览限制。`);
      }
      offset = end + 2;
      continue;
    }
    // DTDs, entity declarations, and any other declaration are not needed by
    // the preview and must never reach the entity-expanding XML parser.
    if (source.startsWith("<!", open)) {
      fail(`${label} XML 不允许包含 DTD 或实体声明。`);
    }

    const close = findTagEnd(source, open + 1);
    const token = source.slice(open + 1, close).trim();
    if (token.length === 0) {
      fail(`${label} XML 标签不能为空。`);
    }
    nodes += 1;
    if (nodes > MAX_XLSX_PREVIEW_XML_NODES) {
      fail(`${label} XML 节点数量超过预览限制。`);
    }
    if (token.startsWith("/")) {
      depth -= 1;
      if (depth < 0) {
        fail(`${label} XML 嵌套结构不符合要求。`);
      }
    } else if (!token.endsWith("/")) {
      depth += 1;
      if (depth > MAX_XLSX_PREVIEW_XML_DEPTH) {
        fail(`${label} XML 嵌套深度超过预览限制。`);
      }
    }
    offset = close + 1;
  }
  if (depth !== 0) {
    fail(`${label} XML 标签未正确闭合。`);
  }
}

function findTagEnd(source: string, initialOffset: number): number {
  let quote: '"' | "'" | null = null;
  for (let offset = initialOffset; offset < source.length; offset += 1) {
    const character = source[offset];
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
  fail("XML 标签没有正确结束。");
}

const xmlParser = new XMLParser({
  allowBooleanAttributes: false,
  ignoreAttributes: false,
  ignoreDeclaration: true,
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: {
    enabled: true,
    maxEntitySize: 4_000,
    maxExpansionDepth: 8,
    maxTotalExpansions: 200,
    maxExpandedLength: MAX_XLSX_PREVIEW_SHARED_STRING_CHARACTERS,
  },
  removeNSPrefix: true,
  trimValues: false,
});

function parseXml(
  bytes: Uint8Array,
  rootName: string,
  label: string,
  signal?: AbortSignal,
): XmlRecord {
  throwIfPreviewAborted(signal);
  const source = decodeXml(bytes, label);
  validateXmlComplexity(source, label, signal);
  throwIfPreviewAborted(signal);
  try {
    if (XMLValidator.validate(source) !== true) {
      fail(`${label} XML 无法解析。`);
    }
    const parsed = xmlParser.parse(source) as unknown;
    throwIfPreviewAborted(signal);
    return rootRecord(parsed, rootName, label);
  } catch (error) {
    if (error instanceof InputAttachmentSpreadsheetPreviewParseError) {
      throw error;
    }
    fail(`${label} XML 无法解析。`, error);
  }
}

function readUint16(view: DataView, offset: number, label: string): number {
  if (offset < 0 || offset + 2 > view.byteLength) {
    fail(`${label} ZIP 读取越界。`);
  }
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number, label: string): number {
  if (offset < 0 || offset + 4 > view.byteLength) {
    fail(`${label} ZIP 读取越界。`);
  }
  return view.getUint32(offset, true);
}

function decodeZipName(bytes: Uint8Array, flags: number): string {
  try {
    // OOXML package part names are UTF-8 when bit 11 is set.  The standard
    // package names are ASCII otherwise; decoding those bytes as strict UTF-8
    // avoids introducing a locale-dependent CP437 implementation in the UI.
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (
      name.length === 0 ||
      name.includes("\u0000") ||
      name.includes("\\") ||
      name.startsWith("/") ||
      /(^|\/)\.\.($|\/)/u.test(name)
    ) {
      fail("XLSX ZIP 条目名称不符合要求。");
    }
    if ((flags & 0x0800) === 0 && /[^\x00-\x7f]/u.test(name)) {
      fail("XLSX ZIP 非 UTF-8 条目名称不受预览支持。");
    }
    return name;
  } catch (error) {
    if (error instanceof InputAttachmentSpreadsheetPreviewParseError) {
      throw error;
    }
    fail("XLSX ZIP 条目名称不是有效 UTF-8。", error);
  }
}

function findEndOfCentralDirectory(view: DataView): number {
  const firstOffset = Math.max(
    0,
    view.byteLength - 22 - ZIP_MAX_COMMENT_BYTES,
  );
  for (let offset = view.byteLength - 22; offset >= firstOffset; offset -= 1) {
    if (
      readUint32(view, offset, "XLSX") === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE
    ) {
      const commentLength = readUint16(view, offset + 20, "XLSX");
      if (offset + 22 + commentLength === view.byteLength) {
        return offset;
      }
    }
  }
  fail("XLSX ZIP 缺少中央目录结束标记。");
}

function inspectLocalEntry(
  bytes: Uint8Array,
  view: DataView,
  centralDirectoryOffset: number,
  entry: Omit<ZipEntry, "recordEnd" | "dataOffset">,
): Pick<ZipEntry, "recordEnd" | "dataOffset"> {
  const offset = entry.localHeaderOffset;
  if (
    offset < 0 ||
    offset + 30 > centralDirectoryOffset ||
    readUint32(view, offset, entry.name) !== ZIP_LOCAL_FILE_SIGNATURE
  ) {
    fail(`XLSX 条目 ${entry.name} 的本地文件头不符合要求。`);
  }
  const localFlags = readUint16(view, offset + 6, entry.name);
  const localMethod = readUint16(view, offset + 8, entry.name);
  const localCrc = readUint32(view, offset + 14, entry.name);
  const localCompressedSize = readUint32(view, offset + 18, entry.name);
  const localUncompressedSize = readUint32(view, offset + 22, entry.name);
  const localNameLength = readUint16(view, offset + 26, entry.name);
  const localExtraLength = readUint16(view, offset + 28, entry.name);
  const nameOffset = offset + 30;
  const dataOffset = nameOffset + localNameLength + localExtraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (
    localFlags !== entry.flags ||
    localMethod !== entry.compressionMethod ||
    dataOffset > centralDirectoryOffset ||
    dataEnd > centralDirectoryOffset
  ) {
    fail(`XLSX 条目 ${entry.name} 的本地元数据不符合要求。`);
  }
  const localName = decodeZipName(
    bytes.subarray(nameOffset, nameOffset + localNameLength),
    localFlags,
  );
  if (localName !== entry.name) {
    fail(`XLSX 条目 ${entry.name} 的名称不一致。`);
  }

  const hasDataDescriptor = (entry.flags & 0x0008) !== 0;
  let recordEnd = dataEnd;
  if (hasDataDescriptor) {
    if (
      (localCrc !== 0 && localCrc !== entry.crc32) ||
      (localCompressedSize !== 0 && localCompressedSize !== entry.compressedSize) ||
      (localUncompressedSize !== 0 &&
        localUncompressedSize !== entry.uncompressedSize)
    ) {
      fail(`XLSX 条目 ${entry.name} 的本地大小不符合要求。`);
    }
    const descriptorCandidates = [
      { offset: dataEnd, hasSignature: false, length: 12 },
      { offset: dataEnd + 4, hasSignature: true, length: 12 },
    ];
    let descriptorMatched = false;
    for (const candidate of descriptorCandidates) {
      if (candidate.offset + candidate.length > centralDirectoryOffset) {
        continue;
      }
      if (
        candidate.hasSignature &&
        readUint32(view, dataEnd, entry.name) !==
          ZIP_DATA_DESCRIPTOR_SIGNATURE
      ) {
        continue;
      }
      if (
        readUint32(view, candidate.offset, entry.name) === entry.crc32 &&
        readUint32(view, candidate.offset + 4, entry.name) ===
          entry.compressedSize &&
        readUint32(view, candidate.offset + 8, entry.name) ===
          entry.uncompressedSize
      ) {
        recordEnd = candidate.offset + candidate.length;
        descriptorMatched = true;
        break;
      }
    }
    if (!descriptorMatched) {
      fail(`XLSX 条目 ${entry.name} 的数据描述符不符合要求。`);
    }
  } else if (
    localCrc !== entry.crc32 ||
    localCompressedSize !== entry.compressedSize ||
    localUncompressedSize !== entry.uncompressedSize
  ) {
    fail(`XLSX 条目 ${entry.name} 的本地大小不符合要求。`);
  }
  return { dataOffset, recordEnd };
}

function parseZipArchive(input: ArrayBuffer, signal?: AbortSignal): ZipArchive {
  throwIfPreviewAborted(signal);
  const bytes = new Uint8Array(input);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_XLSX_PREVIEW_ARCHIVE_BYTES) {
    fail("XLSX 文件超过预览大小限制。" );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.byteLength < 4 ||
    readUint32(view, 0, "XLSX") !== ZIP_LOCAL_FILE_SIGNATURE
  ) {
    fail("XLSX 文件头不符合 ZIP 格式。" );
  }
  const endOffset = findEndOfCentralDirectory(view);
  const diskNumber = readUint16(view, endOffset + 4, "XLSX");
  const directoryDisk = readUint16(view, endOffset + 6, "XLSX");
  const entriesOnDisk = readUint16(view, endOffset + 8, "XLSX");
  const totalEntries = readUint16(view, endOffset + 10, "XLSX");
  const centralDirectorySize = readUint32(view, endOffset + 12, "XLSX");
  const centralDirectoryOffset = readUint32(view, endOffset + 16, "XLSX");
  if (
    diskNumber !== 0 ||
    directoryDisk !== 0 ||
    entriesOnDisk === 0 ||
    entriesOnDisk !== totalEntries ||
    entriesOnDisk === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff ||
    centralDirectoryOffset + centralDirectorySize !== endOffset ||
    totalEntries > MAX_XLSX_PREVIEW_ENTRIES
  ) {
    fail("XLSX ZIP 中央目录不符合预览要求。" );
  }

  const entries = new Map<string, ZipEntry>();
  let totalUncompressedSize = 0;
  let offset = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if ((index & 0x3f) === 0) {
      throwIfPreviewAborted(signal);
    }
    if (
      offset + 46 > endOffset ||
      readUint32(view, offset, "XLSX") !== ZIP_CENTRAL_DIRECTORY_SIGNATURE
    ) {
      fail("XLSX ZIP 中央目录条目不符合要求。" );
    }
    const flags = readUint16(view, offset + 8, "XLSX");
    const compressionMethod = readUint16(view, offset + 10, "XLSX");
    const crc = readUint32(view, offset + 16, "XLSX");
    const compressedSize = readUint32(view, offset + 20, "XLSX");
    const uncompressedSize = readUint32(view, offset + 24, "XLSX");
    const nameLength = readUint16(view, offset + 28, "XLSX");
    const extraLength = readUint16(view, offset + 30, "XLSX");
    const commentLength = readUint16(view, offset + 32, "XLSX");
    const startingDisk = readUint16(view, offset + 34, "XLSX");
    const localHeaderOffset = readUint32(view, offset + 42, "XLSX");
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (
      entryEnd > endOffset ||
      startingDisk !== 0 ||
      (flags & 0x0001) !== 0 ||
      (flags & ~0x080e) !== 0 ||
      (compressionMethod !== 0 && compressionMethod !== 8) ||
      (compressionMethod === 0 && (flags & 0x0006) !== 0) ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      localHeaderOffset >= centralDirectoryOffset ||
      (uncompressedSize > 0 &&
        (compressedSize === 0 ||
          uncompressedSize > compressedSize * MAX_COMPRESSION_RATIO))
    ) {
      fail("XLSX ZIP 条目元数据不符合预览要求。" );
    }
    totalUncompressedSize += uncompressedSize;
    if (totalUncompressedSize > MAX_XLSX_PREVIEW_TOTAL_UNCOMPRESSED_BYTES) {
      fail("XLSX ZIP 总展开大小超过预览限制。" );
    }
    const name = decodeZipName(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
      flags,
    );
    if (entries.has(name)) {
      fail("XLSX ZIP 不能包含重复条目。" );
    }
    const inspected = inspectLocalEntry(bytes, view, centralDirectoryOffset, {
      compressedSize,
      compressionMethod,
      crc32: crc,
      flags,
      localHeaderOffset,
      name,
      uncompressedSize,
    });
    entries.set(name, {
      compressedSize,
      compressionMethod,
      crc32: crc,
      dataOffset: inspected.dataOffset,
      flags,
      localHeaderOffset,
      name,
      recordEnd: inspected.recordEnd,
      uncompressedSize,
    });
    offset = entryEnd;
  }
  if (offset !== endOffset) {
    fail("XLSX ZIP 中央目录长度不符合要求。" );
  }

  const ranges = [...entries.values()]
    .map((entry) => ({ start: entry.localHeaderOffset, end: entry.recordEnd }))
    .sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1].end > ranges[index].start) {
      fail("XLSX ZIP 本地文件记录不能重叠。" );
    }
  }
  return { bytes, entries };
}

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ 0xedb88320;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function calculateCrc32(bytes: Uint8Array, signal?: AbortSignal): number {
  let checksum = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    if ((index & 0xffff) === 0) {
      throwIfPreviewAborted(signal);
    }
    checksum =
      crc32Table[(checksum ^ bytes[index]) & 0xff] ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

async function inflateEntry(
  archive: ZipArchive,
  entry: ZipEntry,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfPreviewAborted(signal);
  const compressed = archive.bytes.subarray(
    entry.dataOffset,
    entry.dataOffset + entry.compressedSize,
  );
  let result: Uint8Array;
  if (entry.compressionMethod === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      fail(`XLSX 条目 ${entry.name} 的存储大小不一致。`);
    }
    result = compressed.slice();
  } else {
    if (
      typeof DecompressionStream === "undefined" ||
      typeof Response === "undefined"
    ) {
      throw new InputAttachmentSpreadsheetPreviewCapabilityError(
        "当前浏览器不支持 XLSX 预览所需的解压 API。",
      );
    }
    try {
      const source = new Response(compressed.slice().buffer).body;
      if (source === null) {
        throw new InputAttachmentSpreadsheetPreviewCapabilityError(
          "XLSX 预览解压流不可用。",
        );
      }
      let stream: ReadableStream<Uint8Array>;
      try {
        stream = source.pipeThrough(new DecompressionStream("deflate-raw"));
      } catch (error) {
        // A browser may expose DecompressionStream while not implementing the
        // raw-deflate format used by ZIP. This is a capability issue, not an
        // invalid user file, and the UI should offer retry/download instead of
        // reporting a corrupt XLSX.
        throw new InputAttachmentSpreadsheetPreviewCapabilityError(
          "当前浏览器不支持 XLSX 预览解压格式。",
          error,
        );
      }
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      const handleAbort = () => {
        void reader.cancel(signal?.reason).catch(() => undefined);
      };
      signal?.addEventListener("abort", handleAbort, { once: true });
      try {
        while (true) {
          throwIfPreviewAborted(signal);
          const next = await reader.read();
          throwIfPreviewAborted(signal);
          if (next.done) {
            break;
          }
          const chunk = next.value;
          length += chunk.byteLength;
          if (
            length > entry.uncompressedSize ||
            length > MAX_XLSX_PREVIEW_TOTAL_UNCOMPRESSED_BYTES
          ) {
            await reader.cancel();
            fail(`XLSX 条目 ${entry.name} 展开大小超过预览限制。`);
          }
          chunks.push(chunk);
        }
      } finally {
        signal?.removeEventListener("abort", handleAbort);
      }
      result = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } catch (error) {
      if (signal?.aborted) {
        throw new InputAttachmentSpreadsheetPreviewAbortError(signal.reason);
      }
      if (
        error instanceof InputAttachmentSpreadsheetPreviewParseError ||
        error instanceof InputAttachmentSpreadsheetPreviewCapabilityError ||
        error instanceof InputAttachmentSpreadsheetPreviewAbortError
      ) {
        throw error;
      }
      fail(`XLSX 条目 ${entry.name} 无法安全解压。`, error);
    }
  }
  if (
    result.byteLength !== entry.uncompressedSize ||
    calculateCrc32(result, signal) !== entry.crc32
  ) {
    fail(`XLSX 条目 ${entry.name} 的完整性校验失败。`);
  }
  return result;
}

function resolveZipPath(baseDirectory: string, target: string): string {
  if (
    target.length === 0 ||
    target.includes("\\") ||
    /[\u0000-\u001f\u007f?#]/u.test(target) ||
    /^[a-z][a-z0-9+.-]*:/iu.test(target)
  ) {
    fail("XLSX 关系目标不符合要求。" );
  }
  const rawParts = (target.startsWith("/")
    ? target.slice(1)
    : baseDirectory.length === 0
      ? target
      : `${baseDirectory}/${target}`
  ).split("/");
  const parts: string[] = [];
  for (const part of rawParts) {
    if (part === ".") {
      continue;
    }
    if (part === "") {
      fail("XLSX 关系目标路径包含空分段。" );
    }
    if (part === "..") {
      if (parts.length === 0) {
        fail("XLSX 关系目标不能越过包根目录。" );
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    fail("XLSX 关系目标不能为空。" );
  }
  return parts.join("/");
}

function relationshipPartPath(documentPart: string): string {
  const slash = documentPart.lastIndexOf("/");
  const directory = slash < 0 ? "" : documentPart.slice(0, slash);
  const name = slash < 0 ? documentPart : documentPart.slice(slash + 1);
  return `${directory.length === 0 ? "" : `${directory}/`}_rels/${name}.rels`;
}

async function readZipEntryAsync(
  archive: ZipArchive,
  name: string,
  cache: Map<string, Uint8Array>,
  retain = true,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfPreviewAborted(signal);
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const entry = archive.entries.get(name);
  if (entry === undefined) {
    fail(`XLSX 文件缺少 ${name}。`);
  }
  const bytes = await inflateEntry(archive, entry, signal);
  throwIfPreviewAborted(signal);
  if (retain) {
    cache.set(name, bytes);
  }
  return bytes;
}

async function parseRelationshipsAsync(
  archive: ZipArchive,
  partName: string,
  cache: Map<string, Uint8Array>,
  signal?: AbortSignal,
): Promise<Map<string, Relationship>> {
  const bytes = await readZipEntryAsync(archive, partName, cache, true, signal);
  const root = parseXml(
    bytes,
    "Relationships",
    `XLSX 关系文件 ${partName}`,
    signal,
  );
  const records = asRecordArray(root.Relationship, "XLSX Relationship");
  if (records.length > MAX_XLSX_PREVIEW_RELATIONSHIPS) {
    fail(`XLSX 关系文件 ${partName} 包含的关系数量超过预览限制。`);
  }
  const relationships = new Map<string, Relationship>();
  for (const record of records) {
    throwIfPreviewAborted(signal);
    const id = requiredAttribute(record, "Id", "XLSX Relationship");
    const target = requiredAttribute(record, "Target", "XLSX Relationship");
    const type = requiredAttribute(record, "Type", "XLSX Relationship");
    if (relationships.has(id)) {
      fail(`XLSX 关系文件 ${partName} 包含重复关系 ID。`);
    }
    relationships.set(id, {
      id,
      target,
      targetMode: attribute(record, "TargetMode"),
      type,
    });
  }
  return relationships;
}

function parseInteger(value: string, label: string): number {
  if (!/^\d+$/u.test(value)) {
    fail(`${label} 不是有效整数。`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    fail(`${label} 超出安全整数范围。`);
  }
  return parsed;
}

function parseCellReference(value: string): { column: number; row: number } {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/iu.exec(value);
  if (match === null) {
    fail(`XLSX 单元格引用 ${value} 不符合要求。`);
  }
  const letters = match[1].toUpperCase();
  let column = 0;
  for (const character of letters) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  const row = parseInteger(match[2], "XLSX 行号");
  if (
    column <= 0 ||
    column > MAX_XLSX_PREVIEW_COLUMNS ||
    row <= 0 ||
    row > MAX_XLSX_PREVIEW_ROWS
  ) {
    fail("XLSX 单元格超出预览行列限制。" );
  }
  return { column, row };
}

function parseCellValue(
  record: XmlRecord,
  sharedStrings: readonly string[] | null,
): string {
  const type = attribute(record, "t") ?? "n";
  const valueNode = record.v;
  const rawValue = valueNode === undefined ? "" : textFromValue(valueNode, "XLSX 单元格");
  let value: string;
  switch (type) {
    case "s": {
      const index = parseInteger(rawValue, "XLSX 共享字符串索引");
      if (sharedStrings === null || index >= sharedStrings.length) {
        fail("XLSX 单元格引用了不存在的共享字符串。" );
      }
      value = sharedStrings[index];
      break;
    }
    case "inlineStr":
      value = textFromTag(record.is, "t", "XLSX 内联字符串");
      break;
    case "b":
      if (rawValue === "1") {
        value = "TRUE";
      } else if (rawValue === "0") {
        value = "FALSE";
      } else {
        fail("XLSX 布尔单元格值不符合要求。" );
      }
      break;
    case "e":
    case "d":
    case "str":
    case "n":
    case "":
      value = rawValue;
      break;
    default:
      fail(`XLSX 单元格类型 ${type} 不受预览支持。` );
  }
  if (value.length > MAX_XLSX_PREVIEW_CELL_CHARACTERS) {
    fail("XLSX 单元格文本超过预览字符限制。" );
  }
  return value;
}

function columnLabel(column: number): string {
  let value = column;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function parseWorksheet(
  bytes: Uint8Array,
  name: string,
  sharedStrings: readonly string[] | null,
  budget: WorkbookPreviewBudget,
  signal?: AbortSignal,
): ParsedWorksheet {
  const root = parseXml(
    bytes,
    "worksheet",
    `XLSX 工作表 ${name}`,
    signal,
  );
  const sheetData = root.sheetData;
  if (sheetData === undefined) {
    return { name, rows: [], rowNumbers: [], columnLabels: [] };
  }
  const sheetDataRecord = asRecord(sheetData, `XLSX 工作表 ${name}`);
  const rowRecords = asRecordArray(
    sheetDataRecord.row,
    `XLSX 工作表 ${name} 行`,
  );
  if (rowRecords.length > MAX_XLSX_PREVIEW_ROWS) {
    fail(`XLSX 工作表 ${name} 行数超过预览限制。`);
  }

  const rows = new Map<number, Map<number, string>>();
  let inferredRow = 0;
  let cellCount = 0;
  let maxColumn = 0;
  for (const rowRecord of rowRecords) {
    throwIfPreviewAborted(signal);
    const cellRecords = asRecordArray(
      rowRecord.c,
      `XLSX 工作表 ${name} 单元格`,
    );
    const rowAttribute = attribute(rowRecord, "r");
    let rowNumber: number;
    if (rowAttribute !== undefined) {
      rowNumber = parseInteger(rowAttribute, "XLSX 行号");
    } else {
      const firstReference =
        cellRecords.length === 0 ? undefined : attribute(cellRecords[0], "r");
      rowNumber =
        firstReference === undefined
          ? inferredRow + 1
          : parseCellReference(firstReference).row;
    }
    if (rowNumber <= 0 || rowNumber > MAX_XLSX_PREVIEW_ROWS) {
      fail(`XLSX 工作表 ${name} 行号超出预览限制。`);
    }
    if (rows.has(rowNumber)) {
      fail(`XLSX 工作表 ${name} 包含重复行。`);
    }
    const row = new Map<number, string>();
    let inferredColumn = 0;
    for (const cellRecord of cellRecords) {
      throwIfPreviewAborted(signal);
      cellCount += 1;
      budget.parsedCells += 1;
      if (
        cellCount > MAX_XLSX_PREVIEW_CELLS_PER_SHEET ||
        budget.parsedCells > MAX_XLSX_PREVIEW_WORKBOOK_CELLS
      ) {
        fail(`XLSX 工作表 ${name} 单元格数量超过预览限制。`);
      }
      const reference = attribute(cellRecord, "r");
      let column: number;
      if (reference === undefined) {
        column = inferredColumn + 1;
      } else {
        const parsedReference = parseCellReference(reference);
        if (parsedReference.row !== rowNumber) {
          fail(`XLSX 工作表 ${name} 单元格行号与行节点不一致。`);
        }
        column = parsedReference.column;
      }
      if (
        column <= 0 ||
        column > MAX_XLSX_PREVIEW_COLUMNS ||
        row.has(column)
      ) {
        fail(`XLSX 工作表 ${name} 单元格列号不符合预览要求。`);
      }
      inferredColumn = column;
      const value = parseCellValue(cellRecord, sharedStrings);
      budget.cellCharacters += value.length;
      if (
        budget.cellCharacters > MAX_XLSX_PREVIEW_WORKBOOK_CHARACTERS
      ) {
        fail("XLSX 工作簿单元格字符总量超过预览限制。");
      }
      row.set(column, value);
      maxColumn = Math.max(maxColumn, column);
    }
    rows.set(rowNumber, row);
    inferredRow = rowNumber;
  }

  const rowNumbers = [...rows.keys()].sort((left, right) => left - right);
  const columnLabels = Array.from({ length: maxColumn }, (_, index) =>
    columnLabel(index + 1),
  );
  const renderedCells = rowNumbers.length * maxColumn;
  budget.renderedCells += renderedCells;
  if (
    renderedCells > MAX_XLSX_PREVIEW_RENDER_CELLS_PER_SHEET ||
    budget.renderedCells > MAX_XLSX_PREVIEW_WORKBOOK_CELLS
  ) {
    fail(`XLSX 工作表 ${name} 展示单元格数量超过预览限制。`);
  }
  const normalizedRows = rowNumbers.map((rowNumber) => {
    const row = rows.get(rowNumber);
    if (row === undefined) {
      fail("内部错误：XLSX 行索引丢失。" );
    }
    return Array.from({ length: maxColumn }, (_, index) => row.get(index + 1) ?? "");
  });
  return {
    name,
    rows: normalizedRows,
    rowNumbers,
    columnLabels,
  };
}

function parseSharedStrings(
  bytes: Uint8Array,
  signal?: AbortSignal,
): string[] {
  const root = parseXml(bytes, "sst", "XLSX 共享字符串", signal);
  const records = asRecordArray(root.si, "XLSX 共享字符串项");
  if (records.length > MAX_XLSX_PREVIEW_SHARED_STRINGS) {
    fail("XLSX 共享字符串数量超过预览限制。" );
  }
  let totalCharacters = 0;
  return records.map((record) => {
    throwIfPreviewAborted(signal);
    const value = textFromTag(record, "t", "XLSX 共享字符串");
    if (value.length > MAX_XLSX_PREVIEW_CELL_CHARACTERS) {
      fail("XLSX 共享字符串单项超过预览字符限制。" );
    }
    totalCharacters += value.length;
    if (totalCharacters > MAX_XLSX_PREVIEW_SHARED_STRING_CHARACTERS) {
      fail("XLSX 共享字符串总长度超过预览限制。" );
    }
    return value;
  });
}

function relationshipTarget(
  relationships: ReadonlyMap<string, Relationship>,
  id: string,
  expectedTypes: ReadonlySet<string>,
  baseDirectory: string,
): string {
  const relationship = relationships.get(id);
  if (
    relationship === undefined ||
    relationship.targetMode !== undefined && relationship.targetMode !== "Internal" ||
    !expectedTypes.has(relationship.type)
  ) {
    fail(`XLSX 关系 ${id} 不是可预览的内部关系。` );
  }
  return resolveZipPath(baseDirectory, relationship.target);
}

export async function parseInputAttachmentSpreadsheetPreview(
  input: ArrayBuffer,
  signal?: AbortSignal,
): Promise<InputAttachmentSpreadsheetPreview> {
  throwIfPreviewAborted(signal);
  const archive = parseZipArchive(input, signal);
  const cache = new Map<string, Uint8Array>();

  const packageRelationships = await parseRelationshipsAsync(
    archive,
    "_rels/.rels",
    cache,
    signal,
  );
  const officeRelationships = [...packageRelationships.values()].filter(
    (relationship) => OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(relationship.type),
  );
  if (officeRelationships.length !== 1) {
    fail("XLSX 文件必须包含唯一的内部工作簿关系。" );
  }
  const workbookPart = relationshipTarget(
    packageRelationships,
    officeRelationships[0].id,
    OFFICE_DOCUMENT_RELATIONSHIP_TYPES,
    "",
  );
  const workbookBytes = await readZipEntryAsync(
    archive,
    workbookPart,
    cache,
    true,
    signal,
  );
  const workbook = parseXml(workbookBytes, "workbook", "XLSX 工作簿", signal);
  const workbookSlash = workbookPart.lastIndexOf("/");
  const workbookDirectory =
    workbookSlash < 0 ? "" : workbookPart.slice(0, workbookSlash);
  const workbookRelationshipsPart = relationshipPartPath(workbookPart);
  const workbookRelationships = await parseRelationshipsAsync(
    archive,
    workbookRelationshipsPart,
    cache,
    signal,
  );

  const sheetContainer = asRecord(workbook.sheets, "XLSX 工作表列表");
  const sheetRecords = asRecordArray(sheetContainer.sheet, "XLSX 工作表");
  if (sheetRecords.length === 0) {
    fail("XLSX 文件没有工作表。" );
  }
  const visibleSheets = sheetRecords.filter((record) => {
    const state = attribute(record, "state");
    return state === undefined || state === "visible";
  });
  if (visibleSheets.length === 0 || visibleSheets.length > MAX_XLSX_PREVIEW_SHEETS) {
    fail("XLSX 可见工作表数量不符合预览限制。" );
  }

  let sharedStrings: string[] | null = null;
  const sharedStringsRelationships = [...workbookRelationships.values()].filter(
    (relationship) => SHARED_STRINGS_RELATIONSHIP_TYPES.has(relationship.type),
  );
  if (sharedStringsRelationships.length > 1) {
    fail("XLSX 文件包含重复的共享字符串关系。" );
  }
  if (sharedStringsRelationships.length === 1) {
    const sharedStringsPart = relationshipTarget(
      workbookRelationships,
      sharedStringsRelationships[0].id,
      SHARED_STRINGS_RELATIONSHIP_TYPES,
      workbookDirectory,
    );
    sharedStrings = parseSharedStrings(
      await readZipEntryAsync(
        archive,
        sharedStringsPart,
        cache,
        true,
        signal,
      ),
      signal,
    );
  }

  const budget: WorkbookPreviewBudget = {
    parsedCells: 0,
    renderedCells: 0,
    cellCharacters: 0,
  };
  const sheets: ParsedWorksheet[] = [];
  const worksheetParts = new Set<string>();
  for (const record of visibleSheets) {
    throwIfPreviewAborted(signal);
    const name = requiredAttribute(record, "name", "XLSX 工作表");
    if (name.length > 255) {
      fail("XLSX 工作表名称超过预览限制。" );
    }
    const relationshipId = requiredAttribute(record, "id", "XLSX 工作表");
    const worksheetPart = relationshipTarget(
      workbookRelationships,
      relationshipId,
      WORKSHEET_RELATIONSHIP_TYPES,
      workbookDirectory,
    );
    if (worksheetParts.has(worksheetPart)) {
      // Parsing the same large part once per sheet would multiply CPU and
      // allocation cost while contributing little useful preview data.
      fail(`XLSX 工作表重复引用 ${worksheetPart}。`);
    }
    worksheetParts.add(worksheetPart);
    // Worksheets are parsed one at a time and deliberately not retained in
    // the ZIP-entry cache.  This keeps fifty visible sheets from producing
    // fifty simultaneous inflate buffers in the browser.
    const worksheetBytes = await readZipEntryAsync(
      archive,
      worksheetPart,
      cache,
      false,
      signal,
    );
    sheets.push(
      parseWorksheet(worksheetBytes, name, sharedStrings, budget, signal),
    );
  }

  return { sheets, activeSheetIndex: 0 };
}

export async function loadInputAttachmentSpreadsheetPreview(
  downloadUrl: string,
  signal: AbortSignal,
): Promise<InputAttachmentSpreadsheetPreview> {
  const response = await fetch(downloadUrl, {
    method: "GET",
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new InputAttachmentSpreadsheetPreviewRequestError(response.status);
  }
  throwIfPreviewAborted(signal);
  return parseInputAttachmentSpreadsheetPreview(
    await response.arrayBuffer(),
    signal,
  );
}

export function nextSpreadsheetSheetIndex(
  currentIndex: number,
  direction: "next" | "previous" | "first" | "last",
  sheetCount: number,
): number {
  if (
    !Number.isSafeInteger(currentIndex) ||
    !Number.isSafeInteger(sheetCount) ||
    sheetCount <= 0 ||
    currentIndex < 0 ||
    currentIndex >= sheetCount
  ) {
    throw new RangeError("XLSX 工作表索引无效");
  }
  if (direction === "first") {
    return 0;
  }
  if (direction === "last") {
    return sheetCount - 1;
  }
  const delta = direction === "next" ? 1 : -1;
  return (currentIndex + delta + sheetCount) % sheetCount;
}

export function spreadsheetSheetNavigationDirection(
  key: string,
): "next" | "previous" | "first" | "last" | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return "next";
    case "ArrowLeft":
    case "ArrowUp":
      return "previous";
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return null;
  }
}
