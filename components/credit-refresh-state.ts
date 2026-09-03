import { shouldCommitTerminalCredits } from "@/components/research-workspace-state";

export function nextCreditsRevision(currentRevision: number): number {
  const nextRevision = currentRevision + 1;
  if (!Number.isSafeInteger(nextRevision)) {
    throw new Error("积分数据 revision 已超出安全整数范围");
  }
  return nextRevision;
}

export type CreditOperationSource = "local_mutation" | "snapshot";

export function shouldCommitCreditOperationResponse(input: {
  responseOperationRevision: number;
  currentOperationRevision: number;
  source: CreditOperationSource;
  hasPendingLocalMutation: boolean;
}): boolean {
  if (input.responseOperationRevision !== input.currentOperationRevision) {
    return false;
  }

  return input.source === "local_mutation" || !input.hasPendingLocalMutation;
}

export function shouldCommitCreditMutationResponse(input: {
  responseMutationRevision: number;
  currentMutationRevision: number;
}): boolean {
  return input.responseMutationRevision === input.currentMutationRevision;
}

export function shouldCommitTerminalCreditsAtRevision(input: {
  latestCommittedTerminalEventId: string;
  terminalEventId: string;
  creditMutationRevisionAtRefreshStart: number;
  currentCreditMutationRevision: number;
  nonTerminalCreditSnapshotRevisionAtRefreshStart: number;
  currentNonTerminalCreditSnapshotRevision: number;
}): boolean {
  return (
    input.currentCreditMutationRevision ===
      input.creditMutationRevisionAtRefreshStart &&
    input.currentNonTerminalCreditSnapshotRevision ===
      input.nonTerminalCreditSnapshotRevisionAtRefreshStart &&
    shouldCommitTerminalCredits(
      input.latestCommittedTerminalEventId,
      input.terminalEventId,
    )
  );
}
