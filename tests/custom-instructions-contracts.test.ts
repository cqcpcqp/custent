import { describe, expect, it } from "vitest";

import {
  AccountCustomInstructionsResponseSchema,
  AccountCustomInstructionsSchema,
  PutAccountCustomInstructionsRequestSchema,
} from "@/lib/contracts";

const updatedAt = "2026-09-01T03:00:00.000Z";

describe("custom instructions contracts", () => {
  it("preserves raw content for enabled account settings", () => {
    const customInstructions = {
      enabled: true,
      content: "  Always answer in Chinese.\n",
      revision: 7,
      updatedAt,
    };

    expect(AccountCustomInstructionsSchema.parse(customInstructions)).toEqual(
      customInstructions,
    );
    expect(
      AccountCustomInstructionsResponseSchema.parse({ customInstructions }),
    ).toEqual({ customInstructions });
  });

  it("permits disabled settings to retain empty or whitespace content", () => {
    expect(
      PutAccountCustomInstructionsRequestSchema.parse({
        enabled: false,
        content: " \n ",
        expectedRevision: 0,
      }),
    ).toEqual({
      enabled: false,
      content: " \n ",
      expectedRevision: 0,
    });
  });

  it("rejects enabled settings without non-whitespace content", () => {
    expect(() =>
      PutAccountCustomInstructionsRequestSchema.parse({
        enabled: true,
        content: " \n\t ",
        expectedRevision: 0,
      }),
    ).toThrow();
    expect(() =>
      AccountCustomInstructionsSchema.parse({
        enabled: true,
        content: "\u00a0",
        revision: 1,
        updatedAt,
      }),
    ).toThrow();
  });

  it("enforces content length, PostgreSQL revision range, and strict keys", () => {
    expect(
      PutAccountCustomInstructionsRequestSchema.parse({
        enabled: true,
        content: "x".repeat(4_000),
        expectedRevision: 2_147_483_647,
      }).content,
    ).toHaveLength(4_000);

    for (const request of [
      {
        enabled: true,
        content: "x".repeat(4_001),
        expectedRevision: 0,
      },
      { enabled: true, content: "valid", expectedRevision: -1 },
      {
        enabled: true,
        content: "valid",
        expectedRevision: 2_147_483_648,
      },
      {
        enabled: true,
        content: "valid",
        expectedRevision: 0,
        unknown: true,
      },
    ]) {
      expect(() =>
        PutAccountCustomInstructionsRequestSchema.parse(request),
      ).toThrow();
    }
  });
});
