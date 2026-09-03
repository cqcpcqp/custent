import { describe, expect, it } from "vitest";

import { renderResearchCsv, renderResearchPdf } from "@/lib/artifacts";
import type { ResearchSnapshot } from "@/lib/domain/research";

const snapshot: ResearchSnapshot = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "德国工业买家清单",
  querySummary: "寻找采购工业泵的德国进口商。",
  limitations: "仅使用公开网页，未验证线下采购意向。",
  createdAt: "2026-08-24T08:00:00.000Z",
  companies: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      name: "=Example GmbH",
      websiteUrl: "https://example.com",
      country: "Germany",
      companyType: "importer",
      relevanceSummary: "公开目录显示其进口工业泵。",
      evidence: [
        {
          claim: "The company imports industrial pumps.",
          sourceUrl: "https://example.com/catalog",
          sourceTitle: "Product catalog",
          supports: "business_fit",
        },
      ],
      contacts: [
        {
          name: "Erika Muster",
          titleOriginal: "Head of Procurement",
          roleCategory: "procurement",
          publicProfileUrl: "https://example.com/team/erika",
          confidence: "A",
          evidence: [
            {
              claim: "The public team page identifies the procurement lead.",
              sourceUrl: "https://example.com/team/erika",
              sourceTitle: "Team",
              supports: "contact_role",
            },
          ],
        },
      ],
    },
  ],
};

describe("research artifact rendering", () => {
  it("renders deterministic UTF-8 CSV with spreadsheet-injection protection", () => {
    const first = renderResearchCsv(snapshot);
    const second = renderResearchCsv(structuredClone(snapshot));

    expect(first.equals(second)).toBe(true);
    expect(first.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(
      true,
    );
    const text = first.toString("utf8");
    expect(text).toContain("\"'=Example GmbH\"");
    expect(text).toContain("https://example.com/catalog");
    expect(text.endsWith("\r\n")).toBe(true);
  });

  it(
    "renders byte-for-byte deterministic PDF without a browser",
    async () => {
      const first = await renderResearchPdf(snapshot);
      const second = await renderResearchPdf(structuredClone(snapshot));

      expect(first.subarray(0, 8).toString("ascii")).toBe("%PDF-1.3");
      expect(first.byteLength).toBeGreaterThan(10_000);
      expect(first.byteLength).toBeLessThan(1_000_000);
      expect(first.equals(second)).toBe(true);
    },
    30_000,
  );
});
