import { z } from "zod";

import {
  isSafeRequestedArtifactFileName,
  MAX_REQUESTED_ARTIFACT_FILE_NAME_LENGTH,
} from "./naming";

export const MAX_GENERIC_CSV_COLUMNS = 40;
export const MAX_GENERIC_CSV_ROWS = 1_000;
export const MAX_GENERIC_CSV_CELL_LENGTH = 2_000;
export const MAX_GENERIC_CSV_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_GENERIC_PDF_SECTIONS = 30;
export const MAX_GENERIC_PDF_SECTION_BODY_LENGTH = 5_000;
export const MAX_GENERIC_PDF_INPUT_BYTES = 128 * 1024;
export const MAX_GENERIC_CSV_ARTIFACT_BYTES = 5 * 1024 * 1024;
// A configured CJK font can contribute roughly 10 MiB before document text.
export const MAX_GENERIC_PDF_ARTIFACT_BYTES = 20 * 1024 * 1024;

const TextWithoutNullSchema = z
  .string()
  .refine((value) => !value.includes("\u0000"), "Text must not contain NUL");

export const RequestedArtifactFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_REQUESTED_ARTIFACT_FILE_NAME_LENGTH)
  .refine(isSafeRequestedArtifactFileName, "Unsafe artifact fileName");

const GenericCsvColumnSchema = TextWithoutNullSchema.trim().min(1).max(200);
const GenericCsvCellSchema = TextWithoutNullSchema.max(
  MAX_GENERIC_CSV_CELL_LENGTH,
);

const GenericCsvDocumentShape = {
  columns: z
    .array(GenericCsvColumnSchema)
    .min(1)
    .max(MAX_GENERIC_CSV_COLUMNS),
  rows: z
    .array(z.array(GenericCsvCellSchema).max(MAX_GENERIC_CSV_COLUMNS))
    .max(MAX_GENERIC_CSV_ROWS),
};

function validateCsvDocument(
  value: { columns: string[]; rows: string[][] },
  context: z.core.$RefinementCtx,
): void {
  const duplicateColumns = value.columns.filter(
    (column, index) => value.columns.indexOf(column) !== index,
  );
  if (duplicateColumns.length > 0) {
    context.addIssue({
      code: "custom",
      message: "CSV column names must be unique",
      path: ["columns"],
      input: value,
    });
  }

  value.rows.forEach((row, index) => {
    if (row.length !== value.columns.length) {
      context.addIssue({
        code: "custom",
        message: "Every CSV row must have exactly one cell per column",
        path: ["rows", index],
        input: row,
      });
    }
  });

  const inputBytes = Buffer.byteLength(
    JSON.stringify([value.columns, value.rows]),
    "utf8",
  );
  if (inputBytes > MAX_GENERIC_CSV_INPUT_BYTES) {
    context.addIssue({
      code: "too_big",
      maximum: MAX_GENERIC_CSV_INPUT_BYTES,
      origin: "string",
      message: "CSV input exceeds the byte limit",
      path: ["rows"],
      input: value,
    });
  }
}

export const GenericCsvDocumentSchema = z
  .object(GenericCsvDocumentShape)
  .strict()
  .superRefine(validateCsvDocument);

export const GenericCsvArtifactRequestSchema = z
  .object({
    fileName: RequestedArtifactFileNameSchema,
    ...GenericCsvDocumentShape,
  })
  .strict()
  .superRefine(validateCsvDocument);

const GenericPdfSectionSchema = z
  .object({
    heading: TextWithoutNullSchema.max(200),
    body: TextWithoutNullSchema.min(1).max(
      MAX_GENERIC_PDF_SECTION_BODY_LENGTH,
    ),
  })
  .strict();

const GenericPdfDocumentShape = {
  title: TextWithoutNullSchema.trim().min(1).max(300),
  sections: z
    .array(GenericPdfSectionSchema)
    .min(1)
    .max(MAX_GENERIC_PDF_SECTIONS),
};

function validatePdfDocument(
  value: { title: string; sections: { heading: string; body: string }[] },
  context: z.core.$RefinementCtx,
): void {
  const inputBytes = Buffer.byteLength(
    JSON.stringify([value.title, value.sections]),
    "utf8",
  );
  if (inputBytes > MAX_GENERIC_PDF_INPUT_BYTES) {
    context.addIssue({
      code: "too_big",
      maximum: MAX_GENERIC_PDF_INPUT_BYTES,
      origin: "string",
      message: "PDF input exceeds the byte limit",
      path: ["sections"],
      input: value,
    });
  }
}

export const GenericPdfDocumentSchema = z
  .object(GenericPdfDocumentShape)
  .strict()
  .superRefine(validatePdfDocument);

export const GenericPdfArtifactRequestSchema = z
  .object({
    fileName: RequestedArtifactFileNameSchema,
    ...GenericPdfDocumentShape,
  })
  .strict()
  .superRefine(validatePdfDocument);

export type GenericCsvDocument = z.infer<typeof GenericCsvDocumentSchema>;
export type GenericCsvArtifactRequest = z.infer<
  typeof GenericCsvArtifactRequestSchema
>;
export type GenericPdfDocument = z.infer<typeof GenericPdfDocumentSchema>;
export type GenericPdfArtifactRequest = z.infer<
  typeof GenericPdfArtifactRequestSchema
>;
