import { describe, expect, it } from "vitest";

import {
  editChatRequestForTurn,
  projectConversationTimeline,
  resolveLatestReachableLeafRunId,
} from "@/components/research-workspace-state";
import type { AgentRun, ChatMessage } from "@/lib/contracts";
import { TEST_CAPTURED_RUN_EXECUTION_SUMMARY } from "@/tests/fixtures/run-config";

const conversationId = "10000000-0000-4000-8000-000000000001";

function message(input: {
  id: string;
  runId: string;
  role: ChatMessage["role"];
  content: string;
  createdAt: string;
}): ChatMessage {
  return {
    ...input,
    citations: [],
    artifacts: [],
    attachments: [],
    feedback: null,
  };
}

function completedRun(input: {
  id: string;
  inputMessageId: string;
  assistantMessageId: string;
  conversationTurn: string;
  attemptIndex: number;
  predecessorRunId: string | null;
  createdAt: string;
  retryOfRunId?: string | null;
  regenerateOfRunId?: string | null;
}): AgentRun {
  return {
    id: input.id,
    requestId: input.id.replace(/^2/u, "3"),
    conversationId,
    inputMessageId: input.inputMessageId,
    assistantMessageId: input.assistantMessageId,
    status: "completed",
    conversationTurn: input.conversationTurn,
    attemptIndex: input.attemptIndex,
    predecessorRunId: input.predecessorRunId,
    retryOfRunId: input.retryOfRunId ?? null,
    regenerateOfRunId: input.regenerateOfRunId ?? null,
    executionConfig: TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
    failure: null,
    createdAt: input.createdAt,
    startedAt: input.createdAt,
    finishedAt: input.createdAt,
    cancelRequestedAt: null,
  };
}

function branchingFixture() {
  const rootInputId = "40000000-0000-4000-8000-000000000001";
  const olderBranchInputId = "40000000-0000-4000-8000-000000000002";
  const newerBranchInputId = "40000000-0000-4000-8000-000000000003";
  const descendantInputId = "40000000-0000-4000-8000-000000000004";
  const rootFirstId = "20000000-0000-4000-8000-000000000001";
  const rootSecondId = "20000000-0000-4000-8000-000000000002";
  const olderBranchRunId = "20000000-0000-4000-8000-000000000003";
  const newerBranchRunId = "20000000-0000-4000-8000-000000000004";
  const newerBranchSecondId = "20000000-0000-4000-8000-000000000005";
  const descendantRunId = "20000000-0000-4000-8000-000000000006";
  const rootFirstAssistantId = "50000000-0000-4000-8000-000000000001";
  const rootSecondAssistantId = "50000000-0000-4000-8000-000000000002";
  const olderBranchAssistantId = "50000000-0000-4000-8000-000000000003";
  const newerBranchAssistantId = "50000000-0000-4000-8000-000000000004";
  const newerBranchSecondAssistantId =
    "50000000-0000-4000-8000-000000000005";
  const descendantAssistantId = "50000000-0000-4000-8000-000000000006";

  const rootFirst = completedRun({
    id: rootFirstId,
    inputMessageId: rootInputId,
    assistantMessageId: rootFirstAssistantId,
    conversationTurn: "1",
    attemptIndex: 1,
    predecessorRunId: null,
    createdAt: "2026-08-26T08:00:00.000Z",
  });
  const rootSecond = completedRun({
    id: rootSecondId,
    inputMessageId: rootInputId,
    assistantMessageId: rootSecondAssistantId,
    conversationTurn: "1",
    attemptIndex: 2,
    predecessorRunId: null,
    regenerateOfRunId: rootFirstId,
    createdAt: "2026-08-26T08:01:00.000Z",
  });
  const olderBranch = completedRun({
    id: olderBranchRunId,
    inputMessageId: olderBranchInputId,
    assistantMessageId: olderBranchAssistantId,
    conversationTurn: "2",
    attemptIndex: 1,
    predecessorRunId: rootSecondId,
    createdAt: "2026-08-26T08:02:00.000Z",
  });
  const newerBranch = completedRun({
    id: newerBranchRunId,
    inputMessageId: newerBranchInputId,
    assistantMessageId: newerBranchAssistantId,
    conversationTurn: "2",
    attemptIndex: 1,
    predecessorRunId: rootSecondId,
    createdAt: "2026-08-26T08:03:00.000Z",
  });
  const newerBranchSecond = completedRun({
    id: newerBranchSecondId,
    inputMessageId: newerBranchInputId,
    assistantMessageId: newerBranchSecondAssistantId,
    conversationTurn: "2",
    attemptIndex: 2,
    predecessorRunId: rootSecondId,
    regenerateOfRunId: newerBranchRunId,
    createdAt: "2026-08-26T08:04:00.000Z",
  });
  const descendant = completedRun({
    id: descendantRunId,
    inputMessageId: descendantInputId,
    assistantMessageId: descendantAssistantId,
    conversationTurn: "3",
    attemptIndex: 1,
    predecessorRunId: newerBranchSecondId,
    createdAt: "2026-08-26T08:05:00.000Z",
  });
  const runs = [
    descendant,
    olderBranch,
    rootFirst,
    newerBranchSecond,
    rootSecond,
    newerBranch,
  ];
  const messages: ChatMessage[] = [
    message({
      id: rootInputId,
      runId: rootFirstId,
      role: "user",
      content: "根问题",
      createdAt: rootFirst.createdAt,
    }),
    message({
      id: olderBranchInputId,
      runId: olderBranchRunId,
      role: "user",
      content: "旧编辑分支",
      createdAt: olderBranch.createdAt,
    }),
    message({
      id: newerBranchInputId,
      runId: newerBranchRunId,
      role: "user",
      content: "新编辑分支",
      createdAt: newerBranch.createdAt,
    }),
    message({
      id: descendantInputId,
      runId: descendantRunId,
      role: "user",
      content: "继续追问",
      createdAt: descendant.createdAt,
    }),
    ...runs.map((run) =>
      message({
        id: run.assistantMessageId as string,
        runId: run.id,
        role: "assistant",
        content: `回答 ${run.id}`,
        createdAt: run.createdAt,
      }),
    ),
  ];

  return {
    state: { messages, runs },
    rootSecondId,
    olderBranchRunId,
    newerBranchInputId,
    newerBranchSecondId,
    descendantRunId,
  };
}

describe("conversation branch projection", () => {
  it("沿 selected attempt 的 predecessor 投影，并保留用户分支与回答版本位置", () => {
    const fixture = branchingFixture();
    const timeline = projectConversationTimeline(
      fixture.state,
      fixture.descendantRunId,
    ).filter((item) => item.kind === "turn");

    expect(timeline).toHaveLength(3);
    expect(timeline[0]).toMatchObject({
      conversationTurn: "1",
      selectedAttemptIndex: 1,
    });
    expect(timeline[1]).toMatchObject({
      conversationTurn: "2",
      inputMessage: { id: fixture.newerBranchInputId },
      selectedAttemptIndex: 1,
      selectedBranchIndex: 1,
      branches: [
        { latestAttemptRunId: fixture.olderBranchRunId },
        { latestAttemptRunId: fixture.newerBranchSecondId },
      ],
    });
    expect(timeline[2]).toMatchObject({
      conversationTurn: "3",
      selectedAttemptIndex: 0,
    });
  });

  it("从目标回答确定性选择 newest child branch、该 input 最新 attempt 和后续 leaf", () => {
    const fixture = branchingFixture();

    expect(
      resolveLatestReachableLeafRunId(
        fixture.state,
        fixture.rootSecondId,
      ),
    ).toBe(fixture.descendantRunId);
    expect(
      resolveLatestReachableLeafRunId(
        fixture.state,
        fixture.olderBranchRunId,
      ),
    ).toBe(fixture.olderBranchRunId);
  });

  it("编辑请求使用 input attempt1 的 predecessor，并采用显式附件顺序", () => {
    const fixture = branchingFixture();
    const timeline = projectConversationTimeline(
      fixture.state,
      fixture.descendantRunId,
    ).filter((item) => item.kind === "turn");
    const selectedTurn = timeline[1];
    if (selectedTurn === undefined) {
      throw new Error("测试分支缺少第二 Turn");
    }
    const attachmentOne = {
      id: "60000000-0000-4000-8000-000000000001",
      kind: "file" as const,
      name: "catalog.pdf",
      mimeType: "application/pdf" as const,
      sizeBytes: 1024,
      downloadUrl: "/attachments/one",
      createdAt: "2026-08-26T08:03:00.000Z",
    };
    const attachmentTwo = {
      ...attachmentOne,
      id: "60000000-0000-4000-8000-000000000002",
      name: "brief.pdf",
      downloadUrl: "/attachments/two",
    };

    expect(
      editChatRequestForTurn({
        conversationId,
        turn: {
          ...selectedTurn,
          inputMessage: {
            ...selectedTurn.inputMessage,
            attachments: [attachmentOne, attachmentTwo],
          },
        },
        message: "  编辑后的问题  ",
        attachmentIds: [attachmentTwo.id, attachmentOne.id],
        requestId: "70000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({
      kind: "edit",
      conversationId,
      parentRunId: fixture.rootSecondId,
      sourceMessageId: fixture.newerBranchInputId,
      executionProfileId: "standard_research",
      message: "编辑后的问题",
      attachmentIds: [attachmentTwo.id, attachmentOne.id],
      requestId: "70000000-0000-4000-8000-000000000001",
    });
  });

  it("非空图缺少或引用未知 selectedRunId 时显式失败", () => {
    const fixture = branchingFixture();

    expect(() =>
      projectConversationTimeline(fixture.state, null),
    ).toThrow("缺少 selectedRunId");
    expect(() =>
      projectConversationTimeline(
        fixture.state,
        "20000000-0000-4000-8000-000000000099",
      ),
    ).toThrow("不属于当前会话");
  });
});
