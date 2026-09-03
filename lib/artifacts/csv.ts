import type { ResearchCompany, ResearchSnapshot } from "@/lib/domain/research";

import {
  GenericCsvDocumentSchema,
  MAX_GENERIC_CSV_ARTIFACT_BYTES,
  type GenericCsvDocument,
} from "./generic";

type SnapshotContact = ResearchCompany["contacts"][number];

const columns = [
  "company_name",
  "website_url",
  "country",
  "company_type",
  "relevance_summary",
  "contact_name",
  "contact_title",
  "contact_role",
  "public_profile_url",
  "confidence",
  "evidence_claims",
  "source_titles",
  "source_urls",
] as const;

function safeSpreadsheetValue(value: string): string {
  return /^\s*(?:[=+\-@]|\t|\r|\n)/u.test(value) ? `'${value}` : value;
}

function csvCell(value: string): string {
  return `"${safeSpreadsheetValue(value).replaceAll('"', '""')}"`;
}

function evidenceColumns(
  company: ResearchCompany,
  contact: SnapshotContact | null,
): [string, string, string] {
  const evidence =
    contact === null ? company.evidence : [...company.evidence, ...contact.evidence];
  return [
    evidence.map((item) => item.claim).join("\n"),
    evidence.map((item) => item.sourceTitle).join("\n"),
    evidence.map((item) => item.sourceUrl).join("\n"),
  ];
}

function companyRow(
  company: ResearchCompany,
  contact: SnapshotContact | null,
): string[] {
  const [claims, titles, urls] = evidenceColumns(company, contact);
  return [
    company.name,
    company.websiteUrl,
    company.country,
    company.companyType,
    company.relevanceSummary,
    contact?.name ?? "",
    contact?.titleOriginal ?? "",
    contact?.roleCategory ?? "",
    contact?.publicProfileUrl ?? "",
    contact?.confidence ?? "",
    claims,
    titles,
    urls,
  ];
}

export function renderResearchCsv(snapshot: ResearchSnapshot): Buffer {
  const rows = snapshot.companies.flatMap((company) =>
    company.contacts.length === 0
      ? [companyRow(company, null)]
      : company.contacts.map((contact) => companyRow(company, contact)),
  );
  const lines = [
    columns.map(csvCell).join(","),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ];

  return Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

export function renderGenericCsv(document: GenericCsvDocument): Buffer {
  const parsed = GenericCsvDocumentSchema.parse(document);
  const lines = [
    parsed.columns.map(csvCell).join(","),
    ...parsed.rows.map((row) => row.map(csvCell).join(",")),
  ];
  const payload = Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
  if (payload.byteLength > MAX_GENERIC_CSV_ARTIFACT_BYTES) {
    throw new RangeError("Generic CSV artifact exceeds the byte limit");
  }
  return payload;
}
