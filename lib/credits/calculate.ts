import { getEnv } from "@/lib/env";

import type {
  CreditBillingPolicy,
  CreditRates,
  RunUsage,
} from "./types";

function assertNonnegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer`);
  }
}

export function getCreditRates(): CreditRates {
  const env = getEnv();
  return {
    creditsPer1kInputTokens: env.CREDITS_PER_1K_INPUT_TOKENS,
    creditsPer1kOutputTokens: env.CREDITS_PER_1K_OUTPUT_TOKENS,
    creditsPerWebSearch: env.CREDITS_PER_WEB_SEARCH,
  };
}

export function calculateCreditCharge(
  usage: RunUsage,
  policy: CreditBillingPolicy,
): number {
  switch (policy.policyVersion) {
    case 1:
      return calculateCreditChargeV1(usage, policy);
  }
}

export function calculateCreditChargeV1(
  usage: RunUsage,
  rates: CreditRates,
): number {
  assertNonnegativeInteger(usage.inputTokens, "inputTokens");
  assertNonnegativeInteger(usage.outputTokens, "outputTokens");
  assertNonnegativeInteger(usage.webSearches, "webSearches");
  assertNonnegativeInteger(
    rates.creditsPer1kInputTokens,
    "creditsPer1kInputTokens",
  );
  assertNonnegativeInteger(
    rates.creditsPer1kOutputTokens,
    "creditsPer1kOutputTokens",
  );
  assertNonnegativeInteger(
    rates.creditsPerWebSearch,
    "creditsPerWebSearch",
  );

  const inputCredits = Math.ceil(
    (usage.inputTokens * rates.creditsPer1kInputTokens) / 1_000,
  );
  const outputCredits = Math.ceil(
    (usage.outputTokens * rates.creditsPer1kOutputTokens) / 1_000,
  );
  const searchCredits = usage.webSearches * rates.creditsPerWebSearch;
  const charge = inputCredits + outputCredits + searchCredits;

  if (!Number.isSafeInteger(charge)) {
    throw new RangeError("Calculated credit charge exceeds the safe integer range");
  }

  return charge;
}
