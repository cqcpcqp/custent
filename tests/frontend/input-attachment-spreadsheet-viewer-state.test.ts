import { crc32, deflateRawSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InputAttachmentSpreadsheetPreviewCapabilityError,
  InputAttachmentSpreadsheetPreviewParseError,
  InputAttachmentSpreadsheetPreviewRequestError,
  MAX_XLSX_PREVIEW_RELATIONSHIPS,
  closeInputAttachmentSpreadsheetPreviewState,
  inputAttachmentSpreadsheetPreviewRequestCanCommit,
  loadInputAttachmentSpreadsheetPreview,
  nextSpreadsheetSheetIndex,
  parseInputAttachmentSpreadsheetPreview,
  spreadsheetSheetNavigationDirection,
  spreadsheetPreviewErrorReason,
} from "@/components/input-attachment-spreadsheet-viewer-state";

function zipFixture(
  entries: Readonly<Record<string, string | Uint8Array>>,
  options: { dataDescriptor?: boolean; stored?: boolean } = {},
): Uint8Array {
  const localRecords: Uint8Array[] = [];
  const centralRecords: Uint8Array[] = [];
  let localOffset = 0;

  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
    const body = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
    const compressed = options.stored ? body : deflateRawSync(body);
    const checksum = crc32(body);
    const flags = options.dataDescriptor ? 0x0008 : 0;
    const method = options.stored ? 0 : 8;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    if (!options.dataDescriptor) {
      localHeader.writeUInt32LE(checksum, 14);
      localHeader.writeUInt32LE(compressed.byteLength, 18);
      localHeader.writeUInt32LE(body.byteLength, 22);
    }
    localHeader.writeUInt16LE(nameBytes.byteLength, 26);
    const descriptor = options.dataDescriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (options.dataDescriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressed.byteLength, 8);
      descriptor.writeUInt32LE(body.byteLength, 12);
    }
    localRecords.push(localHeader, nameBytes, compressed, descriptor);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.byteLength, 20);
    centralHeader.writeUInt32LE(body.byteLength, 24);
    centralHeader.writeUInt16LE(nameBytes.byteLength, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(centralHeader, nameBytes);
    localOffset +=
      localHeader.byteLength +
      nameBytes.byteLength +
      compressed.byteLength +
      descriptor.byteLength;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

const packageRelationships =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

const workbook =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets>' +
  '<sheet name="买家名单" sheetId="1" r:id="rId1"/>' +
  '<sheet name="Summary" sheetId="2" r:id="rId2"/>' +
  '<sheet name="Hidden" sheetId="3" state="hidden" r:id="rId3"/>' +
  '</sheets>' +
  '</workbook>';

const workbookRelationships =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/hidden.xml"/>' +
  '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
  '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://attacker.example" TargetMode="External"/>' +
  '</Relationships>';

const sharedStrings =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">' +
  '<si><t>Company</t></si>' +
  '<si><r><t>Acme &amp; </t></r><r><t>Co.</t></r></si>' +
  '</sst>';

const firstWorksheet =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<sheetData>' +
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Active</t></is></c><c r="C1" t="str"><v>Score</v></c></row>' +
  '<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3" t="b"><v>1</v></c><c r="C3"><f>20+22</f><v>42</v></c></row>' +
  '</sheetData>' +
  '</worksheet>';

const secondWorksheet =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&lt;script&gt;inert&lt;/script&gt;</t></is></c></row></sheetData>' +
  '</worksheet>';

function xlsxFixture(
  options: { dataDescriptor?: boolean; stored?: boolean } = {},
  overrides: Readonly<Record<string, string | Uint8Array>> = {},
): Uint8Array {
  return zipFixture(
    {
      "_rels/.rels": packageRelationships,
      "xl/workbook.xml": workbook,
      "xl/_rels/workbook.xml.rels": workbookRelationships,
      "xl/sharedStrings.xml": sharedStrings,
      "xl/worksheets/sheet1.xml": firstWorksheet,
      "xl/worksheets/sheet2.xml": secondWorksheet,
      "xl/worksheets/hidden.xml": '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
      ...overrides,
    },
    options,
  );
}

function rootWorkbookFixture(): Uint8Array {
  const rootWorkbook =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="买家名单" sheetId="1" r:id="rId1"/></sheets>' +
    '</workbook>';
  return zipFixture(
    {
      "_rels/.rels": packageRelationships.replace("xl/workbook.xml", "workbook.xml"),
      "workbook.xml": rootWorkbook,
      "_rels/workbook.xml.rels":
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="sheet1.xml"/>' +
        '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
        '</Relationships>',
      "sheet1.xml": firstWorksheet,
      "sharedStrings.xml": sharedStrings,
    },
    { stored: true },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("historical XLSX preview parser", () => {
  it("parses visible sheets, shared/inline strings, booleans, numbers, and cached formula values", async () => {
    await expect(
      parseInputAttachmentSpreadsheetPreview(
        exactArrayBuffer(xlsxFixture()),
      ),
    ).resolves.toEqual({
      activeSheetIndex: 0,
      sheets: [
        {
          name: "买家名单",
          columnLabels: ["A", "B", "C"],
          rowNumbers: [1, 3],
          rows: [
            ["Company", "Active", "Score"],
            ["Acme & Co.", "TRUE", "42"],
          ],
        },
        {
          name: "Summary",
          columnLabels: ["A"],
          rowNumbers: [1],
          rows: [["<script>inert</script>"]],
        },
      ],
    });
  });

  it("supports stored ZIP entries, data descriptors, and a workbook at the package root", async () => {
    await expect(
      parseInputAttachmentSpreadsheetPreview(
        exactArrayBuffer(rootWorkbookFixture()),
      ),
    ).resolves.toMatchObject({
      activeSheetIndex: 0,
      sheets: [{ name: "买家名单" }],
    });

    const descriptorPreview = await parseInputAttachmentSpreadsheetPreview(
      exactArrayBuffer(xlsxFixture({ dataDescriptor: true })),
    );
    expect(descriptorPreview.sheets[0].rows).toEqual([
      ["Company", "Active", "Score"],
      ["Acme & Co.", "TRUE", "42"],
    ]);
  });

  it("rejects malformed archives and never follows external worksheet relationships", async () => {
    await expect(
      parseInputAttachmentSpreadsheetPreview(
        Uint8Array.from([0x50, 0x4b, 0x03, 0x04]).buffer,
      ),
    ).rejects.toBeInstanceOf(InputAttachmentSpreadsheetPreviewParseError);

    const maliciousRelationships = workbookRelationships.replace(
      'Target="worksheets/sheet1.xml"',
      'Target="https://attacker.example/sheet.xml" TargetMode="External"',
    );
    const malicious = zipFixture({
      "_rels/.rels": packageRelationships,
      "xl/workbook.xml": workbook,
      "xl/_rels/workbook.xml.rels": maliciousRelationships,
      "xl/sharedStrings.xml": sharedStrings,
      "xl/worksheets/sheet2.xml": secondWorksheet,
      "xl/worksheets/hidden.xml": secondWorksheet,
    });
    await expect(
      parseInputAttachmentSpreadsheetPreview(exactArrayBuffer(malicious)),
    ).rejects.toThrow("不是可预览的内部关系");

    const fakeWorksheetType = workbookRelationships.replace(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
      "urn:attacker/worksheet",
    );
    await expect(
      parseInputAttachmentSpreadsheetPreview(
        exactArrayBuffer(
          xlsxFixture(
            {},
            { "xl/_rels/workbook.xml.rels": fakeWorksheetType },
          ),
        ),
      ),
    ).rejects.toThrow("不是可预览的内部关系");
  });

  it("skips complete comments, CDATA, and processing instructions while scanning XML", async () => {
    const lexicalWorksheet =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<!-- fake markup must stay inert: </worksheet><row><c> -->' +
      '<sheetData><?preview fake <row></row> ?>' +
      '<row r="1"><c r="A1" t="inlineStr"><is><t><![CDATA[buyer <tag> </worksheet>]]></t></is></c></row>' +
      '</sheetData></worksheet>';

    const preview = await parseInputAttachmentSpreadsheetPreview(
      exactArrayBuffer(
        xlsxFixture({}, { "xl/worksheets/sheet1.xml": lexicalWorksheet }),
      ),
    );
    expect(preview.sheets[0].rows).toEqual([
      ["buyer <tag> </worksheet>"],
    ]);
  });

  it("rejects malformed XML and real declarations while allowing declaration text in comments", async () => {
    const malformedWorksheet = firstWorksheet.replace(
      "</sheetData>",
      "</worksheet>",
    );
    await expect(
      parseInputAttachmentSpreadsheetPreview(
        exactArrayBuffer(
          xlsxFixture({}, { "xl/worksheets/sheet1.xml": malformedWorksheet }),
        ),
      ),
    ).rejects.toThrow("XML 无法解析");

    const dtdWorksheet = firstWorksheet.replace(
      "<worksheet ",
      '<!DOCTYPE worksheet [<!ENTITY x "expanded">]><worksheet ',
    );
    await expect(
      parseInputAttachmentSpreadsheetPreview(
        exactArrayBuffer(
          xlsxFixture({}, { "xl/worksheets/sheet1.xml": dtdWorksheet }),
        ),
      ),
    ).rejects.toThrow("不允许包含 DTD 或实体声明");

    const harmlessCommentWorksheet = firstWorksheet.replace(
      "<sheetData>",
      "<!-- inert text: <!DOCTYPE worksheet> --><sheetData>",
    );
    const harmlessPreview = await parseInputAttachmentSpreadsheetPreview(
      exactArrayBuffer(
        xlsxFixture(
          {},
          { "xl/worksheets/sheet1.xml": harmlessCommentWorksheet },
        ),
      ),
    );
    expect(harmlessPreview.sheets[0].name).toBe("买家名单");
  });

  it("rejects duplicate worksheet targets and oversized relationship maps", async () => {
    const duplicateWorksheetTarget = workbookRelationships.replace(
      "worksheets/sheet2.xml",
      "worksheets/sheet1.xml",
    );
    await expect(
      parseInputAttachmentSpreadsheetPreview(
        exactArrayBuffer(
          xlsxFixture(
            {},
            {
              "xl/_rels/workbook.xml.rels": duplicateWorksheetTarget,
            },
          ),
        ),
      ),
    ).rejects.toThrow("工作表重复引用 xl/worksheets/sheet1.xml");

    const excessiveRelationships =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      Array.from(
        { length: MAX_XLSX_PREVIEW_RELATIONSHIPS + 1 },
        (_, index) =>
          `<Relationship Id="extra-${index}" Type="urn:custent:preview/unused" Target="unused-${index}.xml"/>`,
      ).join("") +
      "</Relationships>";
    await expect(
      parseInputAttachmentSpreadsheetPreview(
        exactArrayBuffer(
          xlsxFixture(
            { stored: true },
            { "xl/_rels/workbook.xml.rels": excessiveRelationships },
          ),
        ),
      ),
    ).rejects.toThrow("关系数量超过预览限制");
  });

  it("classifies a missing raw-deflate browser API as unavailable", async () => {
    vi.stubGlobal("DecompressionStream", undefined);

    const missingApiError = await parseInputAttachmentSpreadsheetPreview(
      exactArrayBuffer(xlsxFixture()),
    ).catch((caught: unknown) => caught);
    expect(missingApiError).toBeInstanceOf(
      InputAttachmentSpreadsheetPreviewCapabilityError,
    );
    expect(spreadsheetPreviewErrorReason(missingApiError)).toBe("unavailable");

    vi.stubGlobal(
      "DecompressionStream",
      class UnsupportedRawDeflateStream {
        constructor() {
          throw new TypeError("deflate-raw is not supported");
        }
      },
    );
    const unsupportedFormatError = await parseInputAttachmentSpreadsheetPreview(
      exactArrayBuffer(xlsxFixture()),
    ).catch((caught: unknown) => caught);
    expect(unsupportedFormatError).toBeInstanceOf(
      InputAttachmentSpreadsheetPreviewCapabilityError,
    );
    expect(spreadsheetPreviewErrorReason(unsupportedFormatError)).toBe(
      "unavailable",
    );
  });

  it("stops before or during parsing when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort("dialog closed");

    const error = await parseInputAttachmentSpreadsheetPreview(
      exactArrayBuffer(xlsxFixture({ stored: true })),
      controller.signal,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "InputAttachmentSpreadsheetPreviewAbortError",
    });
    expect(error).not.toBeInstanceOf(
      InputAttachmentSpreadsheetPreviewParseError,
    );

    const inFlightController = new AbortController();
    const inFlight = parseInputAttachmentSpreadsheetPreview(
      exactArrayBuffer(xlsxFixture()),
      inFlightController.signal,
    );
    inFlightController.abort("dialog closed while inflating");
    await expect(inFlight).rejects.toMatchObject({
      name: "InputAttachmentSpreadsheetPreviewAbortError",
    });
  });

  it("classifies only parser failures as fixed invalid-file states", () => {
    expect(
      spreadsheetPreviewErrorReason(
        new InputAttachmentSpreadsheetPreviewParseError("invalid"),
      ),
    ).toBe("invalid_xlsx");
    expect(
      spreadsheetPreviewErrorReason(
        new InputAttachmentSpreadsheetPreviewRequestError(503),
      ),
    ).toBe("unavailable");
  });
});

describe("historical XLSX preview loading and lifecycle", () => {
  it("fetches the exact owner-bound content URL without caching", async () => {
    const payload = xlsxFixture({ stored: true });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(exactArrayBuffer(payload), {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const url =
      "/api/input-attachments/60000000-0000-4000-8000-000000000030/content";

    const preview = await loadInputAttachmentSpreadsheetPreview(
      url,
      controller.signal,
    );
    expect(preview.sheets.map((sheet) => sheet.name)).toEqual([
      "买家名单",
      "Summary",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
  });

  it("rejects a non-success response without interpreting another response shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"error":{"code":"NOT_FOUND"}}', { status: 404 }),
      ),
    );
    await expect(
      loadInputAttachmentSpreadsheetPreview(
        "/api/input-attachments/60000000-0000-4000-8000-000000000031/content",
        new AbortController().signal,
      ),
    ).rejects.toEqual(new InputAttachmentSpreadsheetPreviewRequestError(404));
  });

  it("drops parsed workbook data on close and rejects late request completion", () => {
    expect(
      closeInputAttachmentSpreadsheetPreviewState({
        isOpen: true,
        preview: {
          status: "ready",
          content: {
            activeSheetIndex: 0,
            sheets: [
              {
                name: "Buyers",
                columnLabels: ["A"],
                rowNumbers: [1],
                rows: [["Acme"]],
              },
            ],
          },
        },
      }),
    ).toEqual({ isOpen: false, preview: { status: "loading" } });

    const request = {};
    expect(
      inputAttachmentSpreadsheetPreviewRequestCanCommit(
        request,
        request,
        false,
      ),
    ).toBe(true);
    expect(
      inputAttachmentSpreadsheetPreviewRequestCanCommit(null, request, false),
    ).toBe(false);
    expect(
      inputAttachmentSpreadsheetPreviewRequestCanCommit(request, request, true),
    ).toBe(false);
  });

  it("supports wrapping arrow navigation plus Home and End for sheet tabs", () => {
    expect(spreadsheetSheetNavigationDirection("ArrowRight")).toBe("next");
    expect(spreadsheetSheetNavigationDirection("ArrowDown")).toBe("next");
    expect(spreadsheetSheetNavigationDirection("ArrowLeft")).toBe("previous");
    expect(spreadsheetSheetNavigationDirection("ArrowUp")).toBe("previous");
    expect(spreadsheetSheetNavigationDirection("Home")).toBe("first");
    expect(spreadsheetSheetNavigationDirection("End")).toBe("last");
    expect(spreadsheetSheetNavigationDirection("Tab")).toBeNull();
    expect(nextSpreadsheetSheetIndex(0, "next", 3)).toBe(1);
    expect(nextSpreadsheetSheetIndex(2, "next", 3)).toBe(0);
    expect(nextSpreadsheetSheetIndex(0, "previous", 3)).toBe(2);
    expect(nextSpreadsheetSheetIndex(1, "first", 3)).toBe(0);
    expect(nextSpreadsheetSheetIndex(1, "last", 3)).toBe(2);
    expect(() => nextSpreadsheetSheetIndex(3, "next", 3)).toThrow(
      "XLSX 工作表索引无效",
    );
  });
});
