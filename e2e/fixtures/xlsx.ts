import { crc32, deflateRawSync } from "node:zlib";

/**
 * The browser regression suite must exercise the real attachment upload and
 * download routes without contacting a model provider.  Keep this fixture
 * deliberately small, deterministic, and self-contained instead of relying
 * on a spreadsheet package or a checked-in binary blob.
 */
export const E2E_XLSX_ATTACHMENT_NAME = "verified-buyers.xlsx";
export const E2E_XLSX_ATTACHMENT_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const E2E_XLSX_FIRST_SHEET_NAME = "Buyer List";
export const E2E_XLSX_SECOND_SHEET_NAME = "Follow Up";

type ZipEntries = Readonly<Record<string, string | Uint8Array>>;

function zipFixture(entries: ZipEntries): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;

  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
    const body =
      typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
    const compressed = deflateRawSync(body);
    const checksum = crc32(body);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.byteLength, 18);
    localHeader.writeUInt32LE(body.byteLength, 22);
    localHeader.writeUInt16LE(nameBytes.byteLength, 26);
    localRecords.push(localHeader, nameBytes, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.byteLength, 20);
    centralHeader.writeUInt32LE(body.byteLength, 24);
    centralHeader.writeUInt16LE(nameBytes.byteLength, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(centralHeader, nameBytes);

    localOffset +=
      localHeader.byteLength + nameBytes.byteLength + compressed.byteLength;
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

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
  '</Types>';

const PACKAGE_RELATIONSHIPS_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

const WORKBOOK_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets>' +
  `<sheet name="${E2E_XLSX_FIRST_SHEET_NAME}" sheetId="1" r:id="rId1"/>` +
  `<sheet name="${E2E_XLSX_SECOND_SHEET_NAME}" sheetId="2" r:id="rId2"/>` +
  '</sheets>' +
  '</workbook>';

const WORKBOOK_RELATIONSHIPS_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
  '</Relationships>';

const SHARED_STRINGS_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">' +
  '<si><t>Company</t></si>' +
  '<si><t>Country</t></si>' +
  '<si><t>Acme GmbH</t></si>' +
  '<si><t>Germany</t></si>' +
  '</sst>';

const FIRST_WORKSHEET_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<sheetData>' +
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Priority</t></is></c></row>' +
  '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>42</v></c></row>' +
  '</sheetData>' +
  '</worksheet>';

const SECOND_WORKSHEET_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<sheetData>' +
  '<row r="1"><c r="A1" t="inlineStr"><is><t>Status</t></is></c><c r="B1" t="inlineStr"><is><t>Contacted</t></is></c></row>' +
  '<row r="2"><c r="A2" t="inlineStr"><is><t>Follow up</t></is></c><c r="B2" t="b"><v>1</v></c></row>' +
  '</sheetData>' +
  '</worksheet>';

/** A valid two-visible-sheet OOXML package for the browser attachment path. */
export function createE2eXlsxFixture(): Buffer {
  return zipFixture({
    "[Content_Types].xml": CONTENT_TYPES_XML,
    "_rels/.rels": PACKAGE_RELATIONSHIPS_XML,
    "xl/workbook.xml": WORKBOOK_XML,
    "xl/_rels/workbook.xml.rels": WORKBOOK_RELATIONSHIPS_XML,
    "xl/sharedStrings.xml": SHARED_STRINGS_XML,
    "xl/worksheets/sheet1.xml": FIRST_WORKSHEET_XML,
    "xl/worksheets/sheet2.xml": SECOND_WORKSHEET_XML,
  });
}
