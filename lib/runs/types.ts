import type {
  AgentRun,
  CapturedRunExecutionConfig,
  CreatedAgentRun,
  RunEventPayload,
} from "@/lib/contracts";
import type { ConversationCustomInstructionsSnapshot } from "@/lib/agent/types";

export type ClaimedAgentRun = {
  run: CreatedAgentRun;
  executionConfig: CapturedRunExecutionConfig;
  userId: string;
  input: string;
  inputAttachmentIds: string[];
  customInstructionsSnapshot: ConversationCustomInstructionsSnapshot | null;
  leaseOwner: string;
  leaseToken: string;
};

export type RunLease = Pick<
  ClaimedAgentRun,
  "leaseOwner" | "leaseToken"
> & {
  runId: string;
};

export type RunEventBatch = {
  run: AgentRun;
  events: Array<{
    id: string;
    runId: string;
    createdAt: string;
    payload: RunEventPayload;
  }>;
};

export type LeaseHeartbeat = {
  owned: boolean;
  cancelRequested: boolean;
};
