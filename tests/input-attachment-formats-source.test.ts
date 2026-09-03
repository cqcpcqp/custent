import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  INPUT_ATTACHMENT_FILE_MIME_TYPES,
  INPUT_ATTACHMENT_IMAGE_MIME_TYPES,
  INPUT_ATTACHMENT_MIME_TYPES,
} from "@/lib/input-attachment-formats";

function constraintBody(sql: string, constraintName: string): string {
  const expression = new RegExp(
    `ADD CONSTRAINT ${constraintName} CHECK \\(([\\s\\S]*?)\\n  \\)(?:,|;)`,
    "u",
  ).exec(sql)?.[1];
  if (expression === undefined) {
    throw new Error(`Migration constraint ${constraintName} was not found`);
  }
  return expression;
}

function mimeLiterals(sql: string): string[] {
  return [...sql.matchAll(/'([^']+\/[^']+)'/gu)].map((match) => match[1]);
}

function kindMimeBlock(sql: string, kind: "file" | "image"): string {
  const expression = new RegExp(
    `kind = '${kind}'[\\s\\S]*?mime_type IN \\(([\\s\\S]*?)\\n      \\)`,
    "u",
  ).exec(sql)?.[1];
  if (expression === undefined) {
    throw new Error(`Migration MIME block for ${kind} was not found`);
  }
  return expression;
}

describe("017 attachment format source contract", () => {
  it("keeps the migration MIME allowlists exactly equal to the TypeScript contract", async () => {
    const migration = await readFile(
      path.resolve(
        process.cwd(),
        "db/migrations/017_input_attachment_formats.sql",
      ),
      "utf8",
    );
    const mimeConstraint = constraintBody(
      migration,
      "input_attachments_mime_type_check",
    );
    const kindConstraint = constraintBody(
      migration,
      "input_attachments_kind_mime_type_check",
    );

    expect(mimeLiterals(mimeConstraint)).toEqual([
      ...INPUT_ATTACHMENT_MIME_TYPES,
    ]);
    expect(mimeLiterals(kindMimeBlock(kindConstraint, "image"))).toEqual([
      ...INPUT_ATTACHMENT_IMAGE_MIME_TYPES,
    ]);
    expect(mimeLiterals(kindMimeBlock(kindConstraint, "file"))).toEqual([
      ...INPUT_ATTACHMENT_FILE_MIME_TYPES,
    ]);
  });

  it("keeps every repeatable assertion valid pair equal to the TypeScript contract", async () => {
    const assertion = await readFile(
      path.resolve(
        process.cwd(),
        "db/assertions/017_input_attachment_formats.sql",
      ),
      "utf8",
    );
    const assertedPairs = [
      ...assertion.matchAll(/\(\s*'(file|image)'\s*,\s*'([^']+)'\s*\)/gu),
    ].map((match) => [match[1], match[2]]);
    const expectedPairs = [
      ...INPUT_ATTACHMENT_FILE_MIME_TYPES.map((mimeType) => ["file", mimeType]),
      ...INPUT_ATTACHMENT_IMAGE_MIME_TYPES.map((mimeType) => ["image", mimeType]),
    ];

    expect(assertedPairs).toEqual(expectedPairs);
  });
});
