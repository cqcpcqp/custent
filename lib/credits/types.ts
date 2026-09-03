import type { CreditBalance } from "@/lib/contracts";

export type RunStatus =
  | "waiting"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "reconciliation_required";

export type RunUsage = {
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
};

export type CreditRates = {
  creditsPer1kInputTokens: number;
  creditsPer1kOutputTokens: number;
  creditsPerWebSearch: number;
};

export type CreditBillingPolicy = CreditRates & {
  policyVersion: 1;
};

export type RunRecord = {
  id: string;
  requestId: string;
  userId: string;
  conversationId: string;
  status: RunStatus;
  conversationTurn: string;
  attemptIndex: number;
  predecessorRunId: string | null;
  retryOfRunId: string | null;
  regenerateOfRunId: string | null;
  reservationCredits: number;
  chargedCredits: number | null;
  usage: RunUsage | null;
  reconciliationReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type RunMutationResult = {
  run: RunRecord;
  credits: CreditBalance;
};
