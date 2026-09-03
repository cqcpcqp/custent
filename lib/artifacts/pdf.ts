import { createRequire } from "node:module";

import PDFDocument from "pdfkit";

import type { ResearchCompany, ResearchSnapshot } from "@/lib/domain/research";

import {
  GenericPdfDocumentSchema,
  MAX_GENERIC_PDF_ARTIFACT_BYTES,
  type GenericPdfDocument,
} from "./generic";

const require = createRequire(import.meta.url);

function defaultFontPath(): string {
  return require.resolve(
    /* turbopackIgnore: true */
    // PDFKit/fontkit accepts WOFF2 here but produces an invalid embedded font
    // that renders as a blank page in standards-compliant PDF viewers.
    "@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff",
  );
}

function writeEvidence(
  doc: PDFKit.PDFDocument,
  evidence: ResearchCompany["evidence"],
): void {
  for (const item of evidence) {
    doc.fontSize(9).fillColor("#334155").text(`• ${item.claim}`);
    doc
      .fontSize(8)
      .fillColor("#2563eb")
      .text(`${item.sourceTitle}: ${item.sourceUrl}`, {
        link: item.sourceUrl,
        underline: true,
      });
  }
}

export async function renderResearchPdf(
  snapshot: ResearchSnapshot,
  options: { fontPath?: string } = {},
): Promise<Buffer> {
  const timestamp = new Date(snapshot.createdAt);
  if (Number.isNaN(timestamp.getTime())) {
    throw new TypeError("snapshot.createdAt must be a valid ISO timestamp");
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 48, right: 48, bottom: 48, left: 48 },
      compress: false,
      info: {
        Title: snapshot.title,
        Author: "Custent",
        Subject: "Overseas customer research",
        CreationDate: timestamp,
        ModDate: timestamp,
      },
    });

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.font(options.fontPath ?? defaultFontPath());
    doc.fontSize(22).fillColor("#0f172a").text(snapshot.title);
    doc.moveDown(0.5);
    doc
      .fontSize(9)
      .fillColor("#64748b")
      .text(`Research snapshot: ${snapshot.id}`)
      .text(`Created at: ${snapshot.createdAt}`);
    doc.moveDown();
    doc.fontSize(13).fillColor("#0f172a").text("Query summary");
    doc.fontSize(10).fillColor("#334155").text(snapshot.querySummary);
    doc.moveDown();
    doc.fontSize(13).fillColor("#0f172a").text("Limitations");
    doc.fontSize(10).fillColor("#334155").text(snapshot.limitations);
    doc.moveDown(1.25);

    snapshot.companies.forEach((company, companyIndex) => {
      doc
        .fontSize(15)
        .fillColor("#0f172a")
        .text(`${companyIndex + 1}. ${company.name}`);
      doc
        .fontSize(9)
        .fillColor("#475569")
        .text(`${company.country} · ${company.companyType}`)
        .fillColor("#2563eb")
        .text(company.websiteUrl, { link: company.websiteUrl, underline: true });
      doc.fontSize(10).fillColor("#334155").text(company.relevanceSummary);
      doc.moveDown(0.4);
      doc.fontSize(11).fillColor("#0f172a").text("Company evidence");
      writeEvidence(doc, company.evidence);

      if (company.contacts.length > 0) {
        doc.moveDown(0.4);
        doc.fontSize(11).fillColor("#0f172a").text("Public contacts");
        company.contacts.forEach((contact) => {
          doc
            .fontSize(10)
            .fillColor("#1e293b")
            .text(
              `${contact.name} — ${contact.titleOriginal} (${contact.roleCategory}, confidence ${contact.confidence})`,
            );
          if (contact.publicProfileUrl !== null) {
            doc
              .fontSize(8)
              .fillColor("#2563eb")
              .text(contact.publicProfileUrl, {
                link: contact.publicProfileUrl,
                underline: true,
              });
          }
          writeEvidence(doc, contact.evidence);
        });
      }
      doc.moveDown(1.2);
    });

    doc.end();
  });
}

export async function renderGenericPdf(
  document: GenericPdfDocument,
  options: { fontPath?: string; timestamp?: Date } = {},
): Promise<Buffer> {
  const parsed = GenericPdfDocumentSchema.parse(document);
  const timestamp = options.timestamp ?? new Date();
  if (Number.isNaN(timestamp.getTime())) {
    throw new TypeError("timestamp must be a valid Date");
  }

  const payload = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 48, right: 48, bottom: 48, left: 48 },
      compress: false,
      info: {
        Title: parsed.title,
        Author: "Custent",
        Subject: "Conversation-generated document",
        CreationDate: timestamp,
        ModDate: timestamp,
      },
    });

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.font(options.fontPath ?? defaultFontPath());
    doc.fontSize(22).fillColor("#0f172a").text(parsed.title);
    doc.moveDown(1);

    parsed.sections.forEach((section) => {
      if (section.heading.trim().length > 0) {
        doc.fontSize(14).fillColor("#0f172a").text(section.heading);
        doc.moveDown(0.35);
      }
      doc.fontSize(10).fillColor("#334155").text(section.body, {
        lineGap: 2,
      });
      doc.moveDown(1);
    });

    doc.end();
  });

  if (payload.byteLength > MAX_GENERIC_PDF_ARTIFACT_BYTES) {
    throw new RangeError("Generic PDF artifact exceeds the byte limit");
  }
  return payload;
}
