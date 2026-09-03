import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { CapturedRunExecutionConfig } from "@/lib/contracts";

import {
  defaultExecutionProfileId,
  getExecutionProfileCatalog,
  resolveRunExecutionConfig,
} from "./catalog";
import { summarizeRunExecutionConfig } from "./repository";

const environment = {
  OPENAI_PROVIDER: "sharesub" as const,
  OPENAI_BASE_URL: "https://provider.example.com/v1",
  OPENAI_MODEL: "gpt-5.2",
  OPENAI_REASONING_MODE_ENABLED: false,
  RUN_RESERVATION_CREDITS: 120,
  CREDITS_PER_1K_INPUT_TOKENS: 3,
  CREDITS_PER_1K_OUTPUT_TOKENS: 9,
  CREDITS_PER_WEB_SEARCH: 15,
};

describe("Run execution profile catalog", () => {
  it("publishes the exact two-mode catalog with a listed default", () => {
    expect(getExecutionProfileCatalog()).toEqual({
      defaultId: "standard_research",
      options: [
        {
          id: "standard_research",
          label: "标准研究",
          description: "适合日常客户检索与快速核验",
        },
        {
          id: "pro_research",
          label: "Pro 深度研究",
          description: "更深入地规划、检索并交叉核验复杂目标",
        },
      ],
    });
    expect(defaultExecutionProfileId).toBe("standard_research");
  });

  it("resolves standard and Pro into complete immutable execution snapshots", () => {
    const standard = resolveRunExecutionConfig(
      "standard_research",
      environment,
    );
    const pro = resolveRunExecutionConfig("pro_research", environment);

    expect(standard).toMatchObject({
      provenance: "captured",
      snapshotVersion: 2,
      executionProfileId: "standard_research",
      profileLabel: "标准研究",
      provider: "sharesub",
      baseUrl: "https://provider.example.com/v1",
      model: "gpt-5.2",
      reasoningMode: "standard",
      reasoningModeEnabled: false,
      reasoningEffort: "medium",
      reasoningSummary: "auto",
      maxAgentTurns: 8,
      billing: {
        policyVersion: 1,
        reservationCredits: 120,
        creditsPer1kInputTokens: 3,
        creditsPer1kOutputTokens: 9,
        creditsPerWebSearch: 15,
      },
    });
    expect(pro).toMatchObject({
      executionProfileId: "pro_research",
      profileLabel: "Pro 深度研究",
      reasoningMode: "pro",
      reasoningEffort: "high",
      maxAgentTurns: 16,
      billing: standard.billing,
    });
    expect(standard.tools).toEqual({
      webSearch: true,
      codeInterpreter: false,
      listResearch: true,
      saveResearchResults: true,
      createCsv: true,
      createPdf: true,
      createCsvFile: true,
      createPdfFile: true,
    });
    expect(pro.tools).toEqual(standard.tools);
  });

  it("captures whether the provider accepts reasoning.mode", () => {
    expect(
      resolveRunExecutionConfig("standard_research", {
        ...environment,
        OPENAI_REASONING_MODE_ENABLED: true,
      }).reasoningModeEnabled,
    ).toBe(true);
  });

  it("exposes only an opaque public summary while keeping exact identity", () => {
    const standard = resolveRunExecutionConfig(
      "standard_research",
      environment,
    );
    const summary = summarizeRunExecutionConfig(standard);

    expect(summary).toEqual({
      provenance: "captured",
      snapshotVersion: 2,
      executionProfileId: "standard_research",
      profileLabel: "标准研究",
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(summarizeRunExecutionConfig(standard)).toEqual(summary);
    expect(
      summarizeRunExecutionConfig({
        ...standard,
        billing: { ...standard.billing, creditsPerWebSearch: 16 },
      }),
    ).not.toEqual(summary);
  });

  it("keeps the historical v1 fingerprint stable after capability backfill", () => {
    const resolved = resolveRunExecutionConfig(
      "standard_research",
      environment,
    );
    const versionOne = {
      ...resolved,
      snapshotVersion: 1 as const,
      reasoningModeEnabled: true,
    };
    const pre028VersionOne = { ...versionOne };
    delete (pre028VersionOne as Partial<CapturedRunExecutionConfig>)
      .reasoningModeEnabled;

    expect(summarizeRunExecutionConfig(versionOne)).toMatchObject({
      provenance: "captured",
      fingerprint:
      createHash("sha256")
        .update(JSON.stringify(pre028VersionOne), "utf8")
        .digest("hex"),
    });
    expect(
      summarizeRunExecutionConfig({
        ...resolved,
        reasoningModeEnabled: true,
      }),
    ).not.toEqual(summarizeRunExecutionConfig(resolved));
  });
});
