import { describe, expect, it } from "vitest";

import {
  nextCreditsRevision,
  shouldCommitCreditOperationResponse,
  shouldCommitCreditMutationResponse,
  shouldCommitTerminalCreditsAtRevision,
} from "@/components/credit-refresh-state";

describe("credit refresh state", () => {
  it("rejects an older focus revalidation after a terminal snapshot starts", () => {
    const focusRevalidationRevision = nextCreditsRevision(0);
    const terminalSnapshotRevision = nextCreditsRevision(
      focusRevalidationRevision,
    );

    expect(
      shouldCommitCreditOperationResponse({
        responseOperationRevision: focusRevalidationRevision,
        currentOperationRevision: terminalSnapshotRevision,
        source: "snapshot",
        hasPendingLocalMutation: false,
      }),
    ).toBe(false);
    expect(
      shouldCommitCreditOperationResponse({
        responseOperationRevision: terminalSnapshotRevision,
        currentOperationRevision: terminalSnapshotRevision,
        source: "snapshot",
        hasPendingLocalMutation: false,
      }),
    ).toBe(true);
  });

  it("rejects an older mutation response after a newer snapshot starts", () => {
    const mutationRevision = nextCreditsRevision(0);
    const snapshotRevision = nextCreditsRevision(mutationRevision);

    expect(
      shouldCommitCreditOperationResponse({
        responseOperationRevision: mutationRevision,
        currentOperationRevision: snapshotRevision,
        source: "local_mutation",
        hasPendingLocalMutation: false,
      }),
    ).toBe(false);
    expect(
      shouldCommitCreditOperationResponse({
        responseOperationRevision: snapshotRevision,
        currentOperationRevision: snapshotRevision,
        source: "snapshot",
        hasPendingLocalMutation: false,
      }),
    ).toBe(true);
  });

  it("rejects the newest snapshot while a local mutation is pending", () => {
    const mutationRevision = nextCreditsRevision(0);
    const snapshotRevision = nextCreditsRevision(mutationRevision);

    expect(
      shouldCommitCreditOperationResponse({
        responseOperationRevision: snapshotRevision,
        currentOperationRevision: snapshotRevision,
        source: "snapshot",
        hasPendingLocalMutation: true,
      }),
    ).toBe(false);
  });

  it("accepts the latest local mutation while that mutation is pending", () => {
    const mutationRevision = nextCreditsRevision(0);

    expect(
      shouldCommitCreditOperationResponse({
        responseOperationRevision: mutationRevision,
        currentOperationRevision: mutationRevision,
        source: "local_mutation",
        hasPendingLocalMutation: true,
      }),
    ).toBe(true);
  });

  it("accepts a new terminal refresh while no newer credit write occurred", () => {
    expect(
      shouldCommitTerminalCreditsAtRevision({
        latestCommittedTerminalEventId: "10",
        terminalEventId: "11",
        creditMutationRevisionAtRefreshStart: 3,
        currentCreditMutationRevision: 3,
        nonTerminalCreditSnapshotRevisionAtRefreshStart: 5,
        currentNonTerminalCreditSnapshotRevision: 5,
      }),
    ).toBe(true);
  });

  it("rejects a late terminal refresh after another conversation reserved credits", () => {
    expect(
      shouldCommitTerminalCreditsAtRevision({
        latestCommittedTerminalEventId: "10",
        terminalEventId: "11",
        creditMutationRevisionAtRefreshStart: 3,
        currentCreditMutationRevision: 4,
        nonTerminalCreditSnapshotRevisionAtRefreshStart: 5,
        currentNonTerminalCreditSnapshotRevision: 5,
      }),
    ).toBe(false);
  });

  it("rejects an older terminal event even when the credit revision is unchanged", () => {
    expect(
      shouldCommitTerminalCreditsAtRevision({
        latestCommittedTerminalEventId: "12",
        terminalEventId: "11",
        creditMutationRevisionAtRefreshStart: 3,
        currentCreditMutationRevision: 3,
        nonTerminalCreditSnapshotRevisionAtRefreshStart: 5,
        currentNonTerminalCreditSnapshotRevision: 5,
      }),
    ).toBe(false);
  });

  it("accepts a newer concurrent terminal after an older terminal commits", () => {
    const creditMutationRevisionAtRefreshStart = 3;
    let currentCreditMutationRevision = 3;
    const nonTerminalCreditSnapshotRevisionAtRefreshStart = 5;
    const currentNonTerminalCreditSnapshotRevision = 5;
    let latestCommittedTerminalEventId = "10";

    expect(
      shouldCommitTerminalCreditsAtRevision({
        latestCommittedTerminalEventId,
        terminalEventId: "11",
        creditMutationRevisionAtRefreshStart,
        currentCreditMutationRevision,
        nonTerminalCreditSnapshotRevisionAtRefreshStart,
        currentNonTerminalCreditSnapshotRevision,
      }),
    ).toBe(true);
    latestCommittedTerminalEventId = "11";

    expect(
      shouldCommitTerminalCreditsAtRevision({
        latestCommittedTerminalEventId,
        terminalEventId: "12",
        creditMutationRevisionAtRefreshStart,
        currentCreditMutationRevision,
        nonTerminalCreditSnapshotRevisionAtRefreshStart,
        currentNonTerminalCreditSnapshotRevision,
      }),
    ).toBe(true);

    currentCreditMutationRevision = nextCreditsRevision(
      currentCreditMutationRevision,
    );
    expect(
      shouldCommitTerminalCreditsAtRevision({
        latestCommittedTerminalEventId,
        terminalEventId: "13",
        creditMutationRevisionAtRefreshStart,
        currentCreditMutationRevision,
        nonTerminalCreditSnapshotRevisionAtRefreshStart,
        currentNonTerminalCreditSnapshotRevision,
      }),
    ).toBe(false);
  });

  it("rejects a terminal snapshot after a mutation response commits", () => {
    expect(
      shouldCommitTerminalCreditsAtRevision({
        latestCommittedTerminalEventId: "10",
        terminalEventId: "11",
        creditMutationRevisionAtRefreshStart: 3,
        currentCreditMutationRevision: 3,
        nonTerminalCreditSnapshotRevisionAtRefreshStart: 5,
        currentNonTerminalCreditSnapshotRevision: 6,
      }),
    ).toBe(false);
  });

  it("advances shared credit operation revisions monotonically and safely", () => {
    expect(nextCreditsRevision(8)).toBe(9);
    expect(() => nextCreditsRevision(Number.MAX_SAFE_INTEGER)).toThrow(
      "积分数据 revision 已超出安全整数范围",
    );
  });

  it("accepts only the newest initiated mutation response", () => {
    const firstMutationRevision = nextCreditsRevision(0);
    const secondMutationRevision = nextCreditsRevision(firstMutationRevision);

    expect(
      shouldCommitCreditMutationResponse({
        responseMutationRevision: secondMutationRevision,
        currentMutationRevision: secondMutationRevision,
      }),
    ).toBe(true);
    expect(
      shouldCommitCreditMutationResponse({
        responseMutationRevision: firstMutationRevision,
        currentMutationRevision: secondMutationRevision,
      }),
    ).toBe(false);
  });
});
