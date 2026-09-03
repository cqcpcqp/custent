import { describe, expect, it } from "vitest";

import { calculateCreditCharge } from "@/lib/credits";

const rates = {
  policyVersion: 1 as const,
  creditsPer1kInputTokens: 1,
  creditsPer1kOutputTokens: 5,
  creditsPerWebSearch: 10,
};

describe("calculateCreditCharge", () => {
  it("rounds each token category up after proportional billing", () => {
    expect(
      calculateCreditCharge(
        { inputTokens: 1_001, outputTokens: 1, webSearches: 2 },
        rates,
      ),
    ).toBe(23);
  });

  it("charges zero for zero usage", () => {
    expect(
      calculateCreditCharge(
        { inputTokens: 0, outputTokens: 0, webSearches: 0 },
        rates,
      ),
    ).toBe(0);
  });

  it("rejects invalid usage rather than coercing it", () => {
    expect(() =>
      calculateCreditCharge(
        { inputTokens: -1, outputTokens: 0, webSearches: 0 },
        rates,
      ),
    ).toThrow("inputTokens must be a nonnegative safe integer");
  });
});
