import { describe, expect, it } from "vitest";

import {
  GenericCsvArtifactRequestSchema,
  GenericPdfArtifactRequestSchema,
  MAX_GENERIC_CSV_ARTIFACT_BYTES,
  MAX_GENERIC_CSV_CELL_LENGTH,
  MAX_GENERIC_CSV_COLUMNS,
  MAX_GENERIC_CSV_ROWS,
  MAX_GENERIC_PDF_SECTION_BODY_LENGTH,
  MAX_GENERIC_PDF_ARTIFACT_BYTES,
  MAX_GENERIC_PDF_SECTIONS,
  renderGenericCsv,
  renderGenericPdf,
  requestedArtifactName,
} from "@/lib/artifacts";

describe("generic artifact rendering", () => {
  it("renders exact UTF-8 CSV and protects every cell from spreadsheet injection", () => {
    const payload = renderGenericCsv({
      columns: ["name", "formula"],
      rows: [
        ["Alice", "=1+1"],
        ["Bob", "+SUM(A1:A2)"],
        ["Carol", "-2"],
        ["Dave", "@cmd"],
        ["Eve", "\tformula"],
        ["Grace", "\n=HYPERLINK(\"https://example.com\")"],
        ["Heidi", "  =1+1"],
        ["Frank", "plain \"quote\""],
      ],
    });

    expect(payload.toString("utf8")).toBe(
      '\uFEFF"name","formula"\r\n' +
        '"Alice","\'=1+1"\r\n' +
        '"Bob","\'+SUM(A1:A2)"\r\n' +
        '"Carol","\'-2"\r\n' +
        '"Dave","\'@cmd"\r\n' +
        '"Eve","\'\tformula"\r\n' +
        '"Grace","\'\n=HYPERLINK(""https://example.com"")"\r\n' +
        '"Heidi","\'  =1+1"\r\n' +
        '"Frank","plain ""quote"""\r\n',
    );
    expect(payload.byteLength).toBeLessThanOrEqual(
      MAX_GENERIC_CSV_ARTIFACT_BYTES,
    );
  });

  it("rejects malformed tables, unsafe names, and each declared CSV limit", () => {
    const valid = {
      fileName: "客户名单.csv",
      columns: ["company", "country"],
      rows: [["Acme", "Germany"]],
    };
    expect(GenericCsvArtifactRequestSchema.parse(valid)).toEqual(valid);
    expect(() =>
      GenericCsvArtifactRequestSchema.parse({
        ...valid,
        rows: [["Acme"]],
      }),
    ).toThrow("exactly one cell per column");
    expect(() =>
      GenericCsvArtifactRequestSchema.parse({
        ...valid,
        columns: ["company", "company"],
      }),
    ).toThrow("unique");
    expect(() =>
      GenericCsvArtifactRequestSchema.parse({
        ...valid,
        fileName: "../buyers.csv",
      }),
    ).toThrow("Unsafe artifact fileName");
    expect(() =>
      GenericCsvArtifactRequestSchema.parse({
        ...valid,
        columns: Array.from(
          { length: MAX_GENERIC_CSV_COLUMNS + 1 },
          (_, index) => `column-${index}`,
        ),
      }),
    ).toThrow();
    expect(() =>
      GenericCsvArtifactRequestSchema.parse({
        ...valid,
        rows: Array.from({ length: MAX_GENERIC_CSV_ROWS + 1 }, () => [
          "Acme",
          "Germany",
        ]),
      }),
    ).toThrow();
    expect(() =>
      GenericCsvArtifactRequestSchema.parse({
        ...valid,
        rows: [["x".repeat(MAX_GENERIC_CSV_CELL_LENGTH + 1), "Germany"]],
      }),
    ).toThrow();
    expect(() =>
      renderGenericCsv({ columns: ["a", "b"], rows: [["one"]] }),
    ).toThrow("exactly one cell per column");
  });

  it("enforces aggregate CSV and PDF input byte limits", () => {
    expect(() =>
      GenericCsvArtifactRequestSchema.parse({
        fileName: "large.csv",
        columns: Array.from(
          { length: MAX_GENERIC_CSV_COLUMNS },
          (_, index) => `column-${index}`,
        ),
        rows: Array.from({ length: MAX_GENERIC_CSV_ROWS }, () =>
          Array.from({ length: MAX_GENERIC_CSV_COLUMNS }, () => "x".repeat(60)),
        ),
      }),
    ).toThrow("byte limit");

    expect(() =>
      GenericPdfArtifactRequestSchema.parse({
        fileName: "large.pdf",
        title: "Large report",
        sections: Array.from({ length: MAX_GENERIC_PDF_SECTIONS }, () => ({
          heading: "Section",
          body: "中".repeat(MAX_GENERIC_PDF_SECTION_BODY_LENGTH),
        })),
      }),
    ).toThrow("byte limit");
  });

  it(
    "renders a deterministic bounded PDF when supplied a timestamp",
    async () => {
      const document = {
        title: "客户会议纪要",
        sections: [
          { heading: "结论", body: "优先联系德国与法国的经销商。" },
          { heading: "", body: "本文件直接来自当前会话，不依赖研究快照。" },
        ],
      };
      const timestamp = new Date("2026-08-26T08:00:00.000Z");
      const first = await renderGenericPdf(document, { timestamp });
      const second = await renderGenericPdf(document, { timestamp });

      expect(first.equals(second)).toBe(true);
      expect(first.subarray(0, 8).toString("ascii")).toBe("%PDF-1.3");
      expect(first.byteLength).toBeLessThan(1_000_000);
      expect(first.byteLength).toBeLessThanOrEqual(
        MAX_GENERIC_PDF_ARTIFACT_BYTES,
      );
    },
    20_000,
  );

  it("normalizes safe download names and rejects platform-dangerous names", () => {
    expect(requestedArtifactName(" 客户名单 ", "csv")).toBe("客户名单.csv");
    expect(requestedArtifactName("REPORT.PDF", "pdf")).toBe("REPORT.PDF");
    for (const unsafe of [
      ".hidden",
      "CON.csv",
      "a/b.csv",
      "a\\b.csv",
      "bad\u0000.csv",
      "report\u202Efdp.exe",
    ]) {
      expect(() => requestedArtifactName(unsafe, "csv")).toThrow(
        "Artifact fileName is unsafe",
      );
    }
  });
});
