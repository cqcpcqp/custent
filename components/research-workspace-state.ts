import type {
  AgentRun,
  AgentRunStatus,
  ArtifactSummary,
  ChatMessage,
  ChatRequest,
  ChatStartResponse,
  ConversationSummary,
  ConversationResponse,
  MessageFeedback,
  RunEvent,
} from "@/lib/contracts";
import type { BufferedRunEvent } from "@/components/run-event-buffer";
import type { RunSubscriptionIntent } from "@/components/run-subscription-policy";

export type ConversationViewState = {
  messages: ChatMessage[];
  runs: AgentRun[];
  eventsByRunId: Record<string, RunEvent[]>;
  messageFeedbackOverrides: Record<
    string,
    { feedback: MessageFeedback | null; revision: number }
  >;
  messageFeedbackRevisions: Record<string, number>;
  isLoaded: boolean;
  isLoading: boolean;
  isStarting: boolean;
  error: string | null;
  loadError: string | null;
};

export type ConversationStateMap = Record<string, ConversationViewState>;

export type ConversationLoadResult =
  | { status: "loaded"; detail: ConversationResponse }
  | {
      status: "superseded" | "failed" | "not_found" | "revision_changed";
    };

export const conversationLoadInvalidatedMessage =
  "加载期间会话已更新，请重新加载。";

export type ConversationMutationOwnerToken = object;

export function claimConversationMutationOwner(
  owners: Map<string, ConversationMutationOwnerToken>,
  conversationId: string,
  candidateOwner: ConversationMutationOwnerToken,
): boolean {
  if (owners.has(conversationId)) {
    return false;
  }
  owners.set(conversationId, candidateOwner);
  return true;
}

export function releaseConversationMutationOwner(
  owners: Map<string, ConversationMutationOwnerToken>,
  conversationId: string,
  candidateOwner: ConversationMutationOwnerToken,
): boolean {
  if (owners.get(conversationId) !== candidateOwner) {
    return false;
  }
  owners.delete(conversationId);
  return true;
}

export async function followSupersededConversationLoad(
  initialLoad: Promise<ConversationLoadResult>,
  latestLoad: () => Promise<ConversationLoadResult> | null,
): Promise<ConversationLoadResult> {
  let result = await initialLoad;
  while (result.status === "superseded") {
    const latestPromise = latestLoad();
    if (latestPromise === null) {
      return { status: "failed" };
    }
    result = await latestPromise;
  }
  return result;
}

export type ConversationStateAction =
  | { type: "reset_all" }
  | { type: "load_started"; conversationId: string }
  | {
      type: "load_succeeded";
      conversationId: string;
      detail: ConversationResponse;
      feedbackDataRevision: number;
    }
  | { type: "load_failed"; conversationId: string; message: string }
  | { type: "load_invalidated"; conversationId: string }
  | {
      type: "conversation_reload_required";
      conversationId: string;
      message: string;
    }
  | { type: "run_starting"; conversationId: string }
  | {
      type: "run_started";
      conversationId: string;
      response: ChatStartResponse;
    }
  | { type: "run_start_failed"; conversationId: string; message: string }
  | { type: "run_updated"; conversationId: string; run: AgentRun }
  | {
      type: "run_events_received";
      conversationId: string;
      observations: readonly BufferedRunEvent[];
    }
  | {
      type: "message_feedback_updated";
      conversationId: string;
      messageId: string;
      feedback: MessageFeedback | null;
      feedbackDataRevision: number;
    }
  | { type: "set_error"; conversationId: string; message: string }
  | { type: "clear_error"; conversationId: string };

export function createConversationViewState(): ConversationViewState {
  return {
    messages: [],
    runs: [],
    eventsByRunId: {},
    messageFeedbackOverrides: {},
    messageFeedbackRevisions: {},
    isLoaded: false,
    isLoading: false,
    isStarting: false,
    error: null,
    loadError: null,
  };
}

export function conversationSummaryRequiresDetailRefresh(
  conversation: ConversationSummary,
  state: ConversationViewState | undefined,
): boolean {
  if (state?.isLoaded !== true) {
    return false;
  }
  if (conversation.selectedRunId === null) {
    if (
      state.runs.length > 0 ||
      state.messages.some((message) => message.runId !== null)
    ) {
      return true;
    }
  } else if (
    !state.runs.some((run) => run.id === conversation.selectedRunId)
  ) {
    return true;
  }

  const localActiveRuns = state.runs.filter((run) =>
    isActiveRunStatus(effectiveRunStatus(run, eventsForRun(state, run.id))),
  );
  if (conversation.activeRun === null) {
    if (localActiveRuns.length > 0) {
      return true;
    }
  } else {
    if (localActiveRuns.length !== 1) {
      return true;
    }
    const localActiveRun = localActiveRuns[0];
    if (
      localActiveRun.id !== conversation.activeRun.id ||
      effectiveRunStatus(
        localActiveRun,
        eventsForRun(state, localActiveRun.id),
      ) !== conversation.activeRun.status ||
      localActiveRun.startedAt !== conversation.activeRun.startedAt
    ) {
      return true;
    }
  }

  const localWaitingRunCount = state.runs.filter(
    (run) =>
      effectiveRunStatus(run, eventsForRun(state, run.id)) === "waiting",
  ).length;
  return localWaitingRunCount !== conversation.waitingRunCount;
}

export function visibleConversationDetailRefreshIsCurrent(input: {
  requestedConversationId: string;
  activeConversationId: string | null;
  visibilityState: DocumentVisibilityState;
}): boolean {
  return (
    input.visibilityState === "visible" &&
    input.activeConversationId === input.requestedConversationId
  );
}

export async function refreshIncompatibleBootstrapConversationDetails(input: {
  conversations: readonly ConversationSummary[];
  states: ConversationStateMap;
  loadConversation: (
    conversationId: string,
  ) => Promise<ConversationLoadResult>;
}): Promise<ReadonlySet<string>> {
  const refreshes = input.conversations.flatMap((conversation) =>
    conversationSummaryRequiresDetailRefresh(
      conversation,
      input.states[conversation.id],
    )
      ? [
          input.loadConversation(conversation.id).then((result) => ({
            conversationId: conversation.id,
            result,
          })),
        ]
      : [],
  );
  const results = await Promise.all(refreshes);
  return new Set(
    results.flatMap(({ conversationId, result }) =>
      result.status === "loaded" ? [] : [conversationId],
    ),
  );
}

function compareTimestamped(
  left: { id: string; createdAt: string },
  right: { id: string; createdAt: string },
): number {
  const timestampOrder = left.createdAt.localeCompare(right.createdAt);
  return timestampOrder === 0 ? left.id.localeCompare(right.id) : timestampOrder;
}

function mergeMessages(
  current: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const messages = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    messages.set(message.id, message);
  }
  return [...messages.values()].sort(compareTimestamped);
}

function mergeObservedMessages(
  state: ConversationViewState,
  incoming: ChatMessage[],
  feedbackDataRevision: number,
): Pick<
  ConversationViewState,
  "messages" | "messageFeedbackOverrides" | "messageFeedbackRevisions"
> {
  const observedMessages: ChatMessage[] = [];
  const feedbackOverrides = { ...state.messageFeedbackOverrides };
  const feedbackRevisions = { ...state.messageFeedbackRevisions };
  const currentMessages = new Map(
    state.messages.map((message) => [message.id, message]),
  );

  for (const message of incoming) {
    if (message.role === "user") {
      observedMessages.push(message);
      continue;
    }

    const currentRevision = Object.hasOwn(feedbackRevisions, message.id)
      ? feedbackRevisions[message.id]
      : null;
    if (
      currentRevision !== null &&
      feedbackDataRevision < currentRevision
    ) {
      const currentMessage = currentMessages.get(message.id);
      if (currentMessage === undefined) {
        throw new Error(
          `消息 ${message.id} 有反馈 revision，但当前会话缺少该消息`,
        );
      }
      observedMessages.push({
        ...message,
        feedback: currentMessage.feedback,
      });
      continue;
    }

    observedMessages.push(message);
    feedbackRevisions[message.id] = feedbackDataRevision;
    const feedbackOverride = feedbackOverrides[message.id];
    if (
      feedbackOverride !== undefined &&
      feedbackDataRevision >= feedbackOverride.revision
    ) {
      delete feedbackOverrides[message.id];
    }
  }

  return {
    messages: mergeMessages(state.messages, observedMessages),
    messageFeedbackOverrides: feedbackOverrides,
    messageFeedbackRevisions: feedbackRevisions,
  };
}

function mergeRuns(current: AgentRun[], incoming: AgentRun[]): AgentRun[] {
  const runs = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) {
    runs.set(run.id, run);
  }
  return [...runs.values()].sort(compareTimestamped);
}

function appendRunEvents(
  events: RunEvent[],
  observations: readonly BufferedRunEvent[],
): RunEvent[] {
  const first = observations[0];
  if (first === undefined) {
    throw new Error("运行事件批次不能为空");
  }

  const runId = first.event.runId;
  let previous = events.at(-1);
  for (const { event } of observations) {
    if (event.runId !== runId) {
      throw new Error(
        `运行事件批次混入了另一个 Run：${runId} -> ${event.runId}`,
      );
    }
    if (previous !== undefined && BigInt(event.id) <= BigInt(previous.id)) {
      throw new Error(
        `Run ${event.runId} 事件序号必须严格递增：${previous.id} -> ${event.id}`,
      );
    }
    previous = event;
  }
  return [...events, ...observations.map(({ event }) => event)];
}

function updateConversation(
  states: ConversationStateMap,
  conversationId: string,
  update: (state: ConversationViewState) => ConversationViewState,
): ConversationStateMap {
  const current = states[conversationId] ?? createConversationViewState();
  return { ...states, [conversationId]: update(current) };
}

export function conversationStateReducer(
  states: ConversationStateMap,
  action: ConversationStateAction,
): ConversationStateMap {
  switch (action.type) {
    case "reset_all":
      return {};
    case "load_started":
      return updateConversation(states, action.conversationId, (state) => ({
        ...state,
        isLoading: true,
        error: null,
        loadError: null,
      }));
    case "load_succeeded":
      return updateConversation(states, action.conversationId, (state) => {
        const observedMessages = mergeObservedMessages(
          state,
          action.detail.messages,
          action.feedbackDataRevision,
        );
        return {
          ...state,
          ...observedMessages,
          runs: mergeRuns(state.runs, action.detail.runs),
          isLoaded: true,
          isLoading: false,
          error: null,
          loadError: null,
        };
      });
    case "load_failed":
      return updateConversation(states, action.conversationId, (state) => ({
        ...state,
        isLoading: false,
        error: action.message,
        loadError: action.message,
      }));
    case "load_invalidated":
      return updateConversation(states, action.conversationId, (state) =>
        state.isLoaded
          ? {
              ...state,
              isLoading: false,
            }
          : {
              ...state,
              isLoaded: false,
              isLoading: false,
              error: conversationLoadInvalidatedMessage,
              loadError: conversationLoadInvalidatedMessage,
            },
      );
    case "conversation_reload_required":
      return updateConversation(states, action.conversationId, (state) => ({
        ...state,
        isLoaded: false,
        isLoading: false,
        isStarting: false,
        error: action.message,
        loadError: action.message,
      }));
    case "run_starting":
      return updateConversation(states, action.conversationId, (state) => ({
        ...state,
        isStarting: true,
        error: null,
      }));
    case "run_started":
      return updateConversation(states, action.conversationId, (state) => ({
        ...state,
        messages: mergeMessages(state.messages, [action.response.userMessage]),
        runs: mergeRuns(state.runs, [action.response.run]),
        isLoaded: true,
        isStarting: false,
        error: null,
      }));
    case "run_start_failed":
      return updateConversation(states, action.conversationId, (state) => ({
        ...state,
        isStarting: false,
        error: action.message,
      }));
    case "run_updated":
      return updateConversation(states, action.conversationId, (state) => ({
        ...state,
        runs: mergeRuns(state.runs, [action.run]),
      }));
    case "run_events_received":
      return updateConversation(states, action.conversationId, (state) => {
        const first = action.observations[0];
        if (first === undefined) {
          throw new Error("运行事件批次不能为空");
        }
        const events = appendRunEvents(
          state.eventsByRunId[first.event.runId] ?? [],
          action.observations,
        );
        let observedMessages: ReturnType<typeof mergeObservedMessages> | null =
          null;
        for (const observation of action.observations) {
          if (observation.event.payload.type !== "done") {
            continue;
          }
          if (observedMessages !== null) {
            throw new Error(`Run ${first.event.runId} 收到了多个 done 事件`);
          }
          observedMessages = mergeObservedMessages(
            state,
            [observation.event.payload.message],
            observation.feedbackDataRevision,
          );
        }
        return {
          ...state,
          ...(observedMessages ?? {}),
          eventsByRunId: {
            ...state.eventsByRunId,
            [first.event.runId]: events,
          },
        };
      });
    case "message_feedback_updated":
      return updateConversation(states, action.conversationId, (state) => {
        const message = state.messages.find(
          (candidate) => candidate.id === action.messageId,
        );
        if (message === undefined) {
          throw new Error(`待反馈消息 ${action.messageId} 不存在`);
        }
        if (message.role !== "assistant") {
          throw new Error(`用户消息 ${action.messageId} 不能设置反馈`);
        }
        const currentRevision = state.messageFeedbackRevisions[action.messageId];
        if (
          currentRevision !== undefined &&
          action.feedbackDataRevision <= currentRevision
        ) {
          throw new Error(
            `消息 ${action.messageId} 的反馈 revision 必须递增：${currentRevision} -> ${action.feedbackDataRevision}`,
          );
        }
        return {
          ...state,
          messages: state.messages.map((candidate) =>
            candidate.id === action.messageId
              ? { ...candidate, feedback: action.feedback }
              : candidate,
          ),
          messageFeedbackOverrides: {
            ...state.messageFeedbackOverrides,
            [action.messageId]: {
              feedback: action.feedback,
              revision: action.feedbackDataRevision,
            },
          },
          messageFeedbackRevisions: {
            ...state.messageFeedbackRevisions,
            [action.messageId]: action.feedbackDataRevision,
          },
        };
      });
    case "set_error":
      return updateConversation(states, action.conversationId, (state) => ({
        ...state,
        error: action.message,
      }));
    case "clear_error":
      return updateConversation(states, action.conversationId, (state) => ({
        ...state,
        error: null,
        loadError: null,
      }));
  }
}

export function shouldRetryConversationLoad(input: {
  activeConversationId: string | null;
  requestedConversationId: string;
  state: ConversationViewState | undefined;
  hasInFlightRequest: boolean;
}): boolean {
  return (
    input.activeConversationId === input.requestedConversationId &&
    input.hasInFlightRequest === false &&
    input.state?.isLoaded === false &&
    input.state.isLoading === false &&
    input.state.loadError !== null
  );
}

export function conversationLoadFenceStatus<Request>(input: {
  candidateRequest: Request;
  currentRequest: Request | undefined;
  currentObservationRevision: number;
  requestedObservationRevision: number;
}): "current" | "superseded" | "revision_changed" {
  if (input.currentRequest !== input.candidateRequest) {
    return "superseded";
  }
  if (
    input.currentObservationRevision !== input.requestedObservationRevision
  ) {
    return "revision_changed";
  }
  return "current";
}

export function shouldCommitCancelRunResponse(input: {
  observationRevisionAtRequestStart: number;
  currentObservationRevision: number;
}): boolean {
  return (
    input.currentObservationRevision ===
    input.observationRevisionAtRequestStart
  );
}

export function statusEventAdvancesConversationObservation(input: {
  runId: string;
  backgroundRunStatus: AgentRunStatus | null;
  conversation: ConversationSummary | undefined;
}): boolean {
  if (input.backgroundRunStatus === "queued") {
    return true;
  }
  const activeRun = input.conversation?.activeRun;
  return (
    activeRun?.id === input.runId &&
    (activeRun.status !== "running" || activeRun.startedAt === null)
  );
}

export function eventsForRun(
  state: ConversationViewState | undefined,
  runId: string,
): RunEvent[] {
  return state?.eventsByRunId[runId] ?? [];
}

export function textForRun(events: RunEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.payload.type === "delta") {
      text += event.payload.text;
    }
  }
  return text;
}

export function artifactsForRun(events: RunEvent[]): ArtifactSummary[] {
  const artifacts: ArtifactSummary[] = [];
  for (const event of events) {
    if (event.payload.type === "artifact") {
      artifacts.push(event.payload.artifact);
    }
  }
  return artifacts;
}

export function latestStatusMessage(events: RunEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index].payload;
    if (payload.type === "status") {
      return payload.message;
    }
  }
  return null;
}

export function effectiveRunStatus(
  run: AgentRun,
  events: RunEvent[],
): AgentRunStatus {
  if (!isActiveRunStatus(run.status)) {
    return run.status;
  }
  const terminalEvent = events.findLast(
    (event) =>
      event.payload.type === "done" || event.payload.type === "error",
  );
  if (terminalEvent?.payload.type === "done") {
    return "completed";
  }
  if (terminalEvent?.payload.type === "error") {
    if (terminalEvent.payload.error.code === "RUN_CANCELLED") {
      return "cancelled";
    }
    if (terminalEvent.payload.error.code === "RUN_REQUIRES_RECONCILIATION") {
      return "reconciliation_required";
    }
    return "failed";
  }
  if (events.length > 0 && run.status === "queued") {
    return "running";
  }
  return run.status;
}

export function conversationStateHasOutstandingRuns(
  state: ConversationViewState | undefined,
): boolean {
  return (
    state?.runs.some((run) => {
      const status = effectiveRunStatus(run, eventsForRun(state, run.id));
      return status === "waiting" || isActiveRunStatus(status);
    }) ?? false
  );
}

export function isActiveRunStatus(status: AgentRunStatus): boolean {
  return status === "queued" || status === "running";
}

export function runCancellationIsPending(
  run: AgentRun,
  locallyPending: boolean,
): boolean {
  return (
    locallyPending ||
    (isActiveRunStatus(run.status) && run.cancelRequestedAt !== null)
  );
}

export function latestRun(state: ConversationViewState | undefined) {
  return state?.runs.at(-1) ?? null;
}

export function runForMessage(
  state: ConversationViewState | undefined,
  message: ChatMessage,
): AgentRun | null {
  if (message.runId === null) {
    return null;
  }
  return state?.runs.find((run) => run.id === message.runId) ?? null;
}

export type ConversationAttemptProjection = {
  run: AgentRun;
  assistantMessage: ChatMessage | null;
};

export function selectedConversationAttemptIndex(
  attempts: readonly ConversationAttemptProjection[],
  selectedRunId: string | null,
): number {
  if (attempts.length === 0) {
    throw new Error("会话 Turn 缺少可选择的 attempt");
  }
  if (selectedRunId === null) {
    throw new Error("会话 Turn 缺少明确选中的 Run");
  }
  const index = attempts.findIndex(
    (attempt) => attempt.run.id === selectedRunId,
  );
  if (index === -1) {
    throw new Error(`选中的 Run ${selectedRunId} 不属于当前 Turn`);
  }
  return index;
}

export type ConversationTurnProjection = {
  kind: "turn";
  conversationTurn: string;
  inputMessage: ChatMessage;
  attempts: ConversationAttemptProjection[];
  selectedAttemptIndex: number;
  branches: ConversationInputBranchProjection[];
  selectedBranchIndex: number;
};

export type ConversationInputBranchProjection = {
  inputMessageId: string;
  latestAttemptRunId: string;
};

export function editChatRequestForTurn(input: {
  conversationId: string;
  turn: ConversationTurnProjection;
  message: string;
  attachmentIds: string[];
  requestId: string;
}): ChatRequest {
  const firstAttempt = input.turn.attempts[0];
  if (
    firstAttempt === undefined ||
    firstAttempt.run.attemptIndex !== 1 ||
    input.turn.inputMessage.role !== "user" ||
    input.turn.inputMessage.runId !== firstAttempt.run.id ||
    firstAttempt.run.inputMessageId !== input.turn.inputMessage.id
  ) {
    throw new Error(
      `用户消息 ${input.turn.inputMessage.id} 缺少合法的首个 Run`,
    );
  }
  if (firstAttempt.run.executionConfig.provenance !== "captured") {
    throw new Error(
      `用户消息 ${input.turn.inputMessage.id} 的执行配置不可用于编辑`,
    );
  }
  const message = input.message.trim();
  const attachmentIds = [...input.attachmentIds];
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new Error("编辑消息的附件 ID 不能重复");
  }
  if (message.length === 0 && attachmentIds.length === 0) {
    throw new Error("编辑后的消息和附件不能同时为空");
  }
  return {
    kind: "edit",
    conversationId: input.conversationId,
    parentRunId: firstAttempt.run.predecessorRunId,
    sourceMessageId: input.turn.inputMessage.id,
    executionProfileId:
      firstAttempt.run.executionConfig.executionProfileId,
    message,
    attachmentIds,
    requestId: input.requestId,
  };
}

export type StandaloneConversationMessageProjection = {
  kind: "standalone_message";
  message: ChatMessage;
};

export type ConversationTimelineItem =
  | ConversationTurnProjection
  | StandaloneConversationMessageProjection;

type ConversationInputGroup = {
  conversationTurn: string;
  predecessorRunId: string | null;
  inputMessage: ChatMessage;
  attempts: ConversationAttemptProjection[];
};

type ConversationRunGraph = {
  groups: ConversationInputGroup[];
  groupByRunId: Map<string, ConversationInputGroup>;
  runsById: Map<string, AgentRun>;
  standaloneMessages: ChatMessage[];
};

function compareInputGroups(
  left: ConversationInputGroup,
  right: ConversationInputGroup,
): number {
  const leftFirstRun = left.attempts[0]?.run;
  const rightFirstRun = right.attempts[0]?.run;
  if (leftFirstRun === undefined || rightFirstRun === undefined) {
    throw new Error("会话输入分支缺少首个 attempt");
  }
  return compareTimestamped(leftFirstRun, rightFirstRun);
}

function buildConversationRunGraph(
  state: Pick<ConversationViewState, "messages" | "runs">,
): ConversationRunGraph {
  const messagesById = new Map<string, ChatMessage>();
  for (const message of state.messages) {
    if (messagesById.has(message.id)) {
      throw new Error(`会话时间线包含重复消息 ${message.id}`);
    }
    messagesById.set(message.id, message);
  }

  const runsById = new Map<string, AgentRun>();
  const runsByInputMessageId = new Map<string, AgentRun[]>();
  let conversationId: string | null = null;
  for (const run of state.runs) {
    if (runsById.has(run.id)) {
      throw new Error(`会话时间线包含重复 Run ${run.id}`);
    }
    if (conversationId === null) {
      conversationId = run.conversationId;
    } else if (run.conversationId !== conversationId) {
      throw new Error(
        `会话时间线混入了不同 conversationId 的 Run ${run.id}`,
      );
    }
    if (run.inputMessageId === null) {
      throw new Error(`Run ${run.id} 缺少 inputMessageId`);
    }
    runsById.set(run.id, run);
    const inputRuns = runsByInputMessageId.get(run.inputMessageId);
    if (inputRuns === undefined) {
      runsByInputMessageId.set(run.inputMessageId, [run]);
    } else {
      inputRuns.push(run);
    }
  }

  const consumedMessageIds = new Set<string>();
  const groups: ConversationInputGroup[] = [];
  const groupByRunId = new Map<string, ConversationInputGroup>();

  for (const [inputMessageId, inputRuns] of runsByInputMessageId) {
    const attempts = [...inputRuns].sort(
      (left, right) => left.attemptIndex - right.attemptIndex,
    );
    const firstAttempt = attempts[0];
    if (firstAttempt === undefined) {
      throw new Error(`输入消息 ${inputMessageId} 缺少首个 attempt`);
    }
    const inputMessage = messagesById.get(inputMessageId);
    if (inputMessage === undefined) {
      throw new Error(`会话 Turn 缺少输入消息 ${inputMessageId}`);
    }
    if (inputMessage.role !== "user" || inputMessage.runId !== firstAttempt.id) {
      throw new Error(
        `输入消息 ${inputMessage.id} 与首个 Run ${firstAttempt.id} 关联不一致`,
      );
    }

    const projectedAttempts: ConversationAttemptProjection[] = [];
    let previousAttempt: AgentRun | null = null;
    for (const run of attempts) {
      const expectedAttemptIndex = (previousAttempt?.attemptIndex ?? 0) + 1;
      if (run.attemptIndex !== expectedAttemptIndex) {
        throw new Error(
          `输入消息 ${inputMessageId} 的 attemptIndex 不连续：期望 ${expectedAttemptIndex}，收到 ${run.attemptIndex}`,
        );
      }
      if (
        run.conversationTurn !== firstAttempt.conversationTurn ||
        run.predecessorRunId !== firstAttempt.predecessorRunId
      ) {
        throw new Error(
          `输入消息 ${inputMessageId} 的 attempts 没有复用相同深度和 predecessor`,
        );
      }
      if (previousAttempt === null) {
        if (run.retryOfRunId !== null || run.regenerateOfRunId !== null) {
          throw new Error(
            `输入消息 ${inputMessageId} 的首个 Run ${run.id} 不应包含 attempt 来源`,
          );
        }
      } else {
        const hasRetrySource = run.retryOfRunId === previousAttempt.id;
        const hasRegenerateSource =
          run.regenerateOfRunId === previousAttempt.id;
        if (
          hasRetrySource === hasRegenerateSource ||
          (run.retryOfRunId !== null && !hasRetrySource) ||
          (run.regenerateOfRunId !== null && !hasRegenerateSource)
        ) {
          throw new Error(
            `输入消息 ${inputMessageId} 的 Run ${run.id} attempt 来源不符合链`,
          );
        }
        if (
          hasRetrySource &&
          previousAttempt.status !== "failed" &&
          previousAttempt.status !== "cancelled"
        ) {
          throw new Error(
            `输入消息 ${inputMessageId} 的 Run ${run.id} retry 来源不是失败或取消的 Run`,
          );
        }
        if (hasRegenerateSource && previousAttempt.status !== "completed") {
          throw new Error(
            `输入消息 ${inputMessageId} 的 Run ${run.id} regenerate 来源不是已完成 Run`,
          );
        }
      }
      if (run.assistantMessageId === null) {
        throw new Error(`Run ${run.id} 缺少 assistantMessageId`);
      }
      const assistantMessage = messagesById.get(run.assistantMessageId) ?? null;
      if (assistantMessage !== null) {
        if (
          assistantMessage.role !== "assistant" ||
          assistantMessage.runId !== run.id
        ) {
          throw new Error(
            `Run ${run.id} 的 assistant 消息 ${assistantMessage.id} 关联不一致`,
          );
        }
        consumedMessageIds.add(assistantMessage.id);
      } else if (run.status === "completed") {
        throw new Error(`已完成 Run ${run.id} 缺少 assistant 消息`);
      }
      projectedAttempts.push({ run, assistantMessage });
      previousAttempt = run;
    }

    consumedMessageIds.add(inputMessage.id);
    const group: ConversationInputGroup = {
      conversationTurn: firstAttempt.conversationTurn,
      predecessorRunId: firstAttempt.predecessorRunId,
      inputMessage,
      attempts: projectedAttempts,
    };
    groups.push(group);
    for (const attempt of projectedAttempts) {
      groupByRunId.set(attempt.run.id, group);
    }
  }

  for (const group of groups) {
    const depth = BigInt(group.conversationTurn);
    if (group.predecessorRunId === null) {
      if (depth !== 1n) {
        throw new Error(
          `根输入消息 ${group.inputMessage.id} 的 conversationTurn 必须为 1`,
        );
      }
      continue;
    }
    const predecessor = runsById.get(group.predecessorRunId);
    if (predecessor === undefined) {
      throw new Error(
        `输入消息 ${group.inputMessage.id} 引用了不存在的 predecessor Run ${group.predecessorRunId}`,
      );
    }
    if (BigInt(predecessor.conversationTurn) + 1n !== depth) {
      throw new Error(
        `输入消息 ${group.inputMessage.id} 的 predecessor 深度不连续`,
      );
    }
  }

  const standaloneMessages: ChatMessage[] = [];
  for (const message of state.messages) {
    if (consumedMessageIds.has(message.id)) {
      continue;
    }
    if (message.runId === null) {
      standaloneMessages.push(message);
      continue;
    }
    if (!runsById.has(message.runId)) {
      throw new Error(
        `消息 ${message.id} 引用了不存在的 Run ${message.runId}`,
      );
    }
    throw new Error(
      `消息 ${message.id} 未匹配 Run ${message.runId} 声明的消息 ID`,
    );
  }

  return {
    groups,
    groupByRunId,
    runsById,
    standaloneMessages,
  };
}

function siblingInputGroups(
  graph: ConversationRunGraph,
  group: ConversationInputGroup,
): ConversationInputGroup[] {
  return graph.groups
    .filter(
      (candidate) =>
        candidate.conversationTurn === group.conversationTurn &&
        candidate.predecessorRunId === group.predecessorRunId,
    )
    .sort(compareInputGroups);
}

function latestAttempt(group: ConversationInputGroup): ConversationAttemptProjection {
  const attempt = group.attempts.at(-1);
  if (attempt === undefined) {
    throw new Error(`输入消息 ${group.inputMessage.id} 缺少最新 attempt`);
  }
  return attempt;
}

export function resolveLatestReachableLeafRunId(
  state: Pick<ConversationViewState, "messages" | "runs">,
  selectedRunId: string,
): string {
  const graph = buildConversationRunGraph(state);
  let currentRun = graph.runsById.get(selectedRunId);
  if (currentRun === undefined) {
    throw new Error(`待选择的 Run ${selectedRunId} 不存在`);
  }
  const visited = new Set<string>();

  while (true) {
    if (visited.has(currentRun.id)) {
      throw new Error(`会话 Run 图包含循环：${currentRun.id}`);
    }
    visited.add(currentRun.id);
    const childGroups = graph.groups
      .filter((group) => group.predecessorRunId === currentRun?.id)
      .sort(compareInputGroups);
    const newestChild = childGroups.at(-1);
    if (newestChild === undefined) {
      return currentRun.id;
    }
    currentRun = latestAttempt(newestChild).run;
  }
}

function mergeStandaloneMessagesIntoTurns(
  turns: ConversationTurnProjection[],
  standaloneMessages: ChatMessage[],
): ConversationTimelineItem[] {
  const messages = [...standaloneMessages].sort(compareTimestamped);
  const timeline: ConversationTimelineItem[] = [];
  let messageIndex = 0;

  for (const turn of turns) {
    while (
      messageIndex < messages.length &&
      compareTimestamped(messages[messageIndex], turn.inputMessage) < 0
    ) {
      timeline.push({
        kind: "standalone_message",
        message: messages[messageIndex],
      });
      messageIndex += 1;
    }
    timeline.push(turn);
  }

  for (; messageIndex < messages.length; messageIndex += 1) {
    timeline.push({
      kind: "standalone_message",
      message: messages[messageIndex],
    });
  }
  return timeline;
}

export function projectConversationTimeline(
  state: Pick<ConversationViewState, "messages" | "runs">,
  selectedRunId: string | null,
): ConversationTimelineItem[] {
  const graph = buildConversationRunGraph(state);
  if (selectedRunId === null) {
    if (
      state.runs.length > 0 ||
      state.messages.some((message) => message.runId !== null)
    ) {
      throw new Error("包含 Run 数据的会话缺少 selectedRunId");
    }
    return mergeStandaloneMessagesIntoTurns([], graph.standaloneMessages);
  }

  let currentRun = graph.runsById.get(selectedRunId);
  if (currentRun === undefined) {
    throw new Error(`selectedRunId ${selectedRunId} 不属于当前会话`);
  }
  const reversedTurns: ConversationTurnProjection[] = [];
  const visitedRunIds = new Set<string>();

  while (true) {
    if (visitedRunIds.has(currentRun.id)) {
      throw new Error(`selected predecessor 链包含循环：${currentRun.id}`);
    }
    visitedRunIds.add(currentRun.id);
    const group = graph.groupByRunId.get(currentRun.id);
    if (group === undefined) {
      throw new Error(`Run ${currentRun.id} 缺少输入消息分组`);
    }
    const selectedAttemptIndex = selectedConversationAttemptIndex(
      group.attempts,
      currentRun.id,
    );
    const branches = siblingInputGroups(graph, group).map((branch) => ({
      inputMessageId: branch.inputMessage.id,
      latestAttemptRunId: latestAttempt(branch).run.id,
    }));
    const selectedBranchIndex = branches.findIndex(
      (branch) => branch.inputMessageId === group.inputMessage.id,
    );
    if (selectedBranchIndex === -1) {
      throw new Error(`输入消息 ${group.inputMessage.id} 缺少自身分支位置`);
    }
    reversedTurns.push({
      kind: "turn",
      conversationTurn: group.conversationTurn,
      inputMessage: group.inputMessage,
      attempts: group.attempts,
      selectedAttemptIndex,
      branches,
      selectedBranchIndex,
    });

    if (group.predecessorRunId === null) {
      break;
    }
    currentRun = graph.runsById.get(group.predecessorRunId);
    if (currentRun === undefined) {
      throw new Error(
        `selected predecessor Run ${group.predecessorRunId} 不存在`,
      );
    }
  }

  const turns = reversedTurns.reverse();
  for (let index = 0; index < turns.length; index += 1) {
    const expectedTurn = BigInt(index + 1);
    if (BigInt(turns[index].conversationTurn) !== expectedTurn) {
      throw new Error(
        `selected 路径 Turn 序号不连续：期望 ${expectedTurn}，收到 ${turns[index].conversationTurn}`,
      );
    }
  }
  return mergeStandaloneMessagesIntoTurns(turns, graph.standaloneMessages);
}

export function projectLoadedConversationTimeline(
  state: ConversationViewState | undefined,
  selectedRunId: string | null,
): ConversationTimelineItem[] {
  if (state?.isLoaded !== true) {
    return [];
  }
  return projectConversationTimeline(state, selectedRunId);
}

function requiredRun(
  state: ConversationViewState,
  runId: string,
  description: string,
): AgentRun {
  const run = state.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) {
    throw new Error(`${description} ${runId} 不存在`);
  }
  return run;
}

export function waitingRunIsBlocked(
  state: ConversationViewState,
  waitingRun: AgentRun,
): boolean {
  if (waitingRun.status !== "waiting") {
    throw new Error(`Run ${waitingRun.id} 不是 waiting`);
  }

  const visited = new Set<string>([waitingRun.id]);
  let current = waitingRun;
  while (true) {
    if (current.predecessorRunId === null) {
      throw new Error(`waiting Run ${current.id} 缺少 predecessorRunId`);
    }
    const predecessor = requiredRun(
      state,
      current.predecessorRunId,
      `waiting Run ${current.id} 的 predecessor`,
    );
    if (predecessor.conversationId !== waitingRun.conversationId) {
      throw new Error(`waiting Run ${current.id} 引用了其他会话的 predecessor`);
    }
    if (visited.has(predecessor.id)) {
      throw new Error(`waiting predecessor 链包含循环：${predecessor.id}`);
    }
    visited.add(predecessor.id);

    const status = effectiveRunStatus(
      predecessor,
      eventsForRun(state, predecessor.id),
    );
    if (
      status === "failed" ||
      status === "cancelled" ||
      status === "reconciliation_required"
    ) {
      return true;
    }
    if (status !== "waiting") {
      return false;
    }
    current = predecessor;
  }
}

export function canRetryRun(
  state: ConversationViewState,
  run: AgentRun,
): boolean {
  const stateRun = requiredRun(state, run.id, "待判断重试的 Run");
  if (stateRun.conversationId !== run.conversationId) {
    throw new Error(`Run ${run.id} 与当前会话状态不一致`);
  }
  const status = effectiveRunStatus(
    stateRun,
    eventsForRun(state, stateRun.id),
  );
  if (
    (status !== "failed" && status !== "cancelled") ||
    stateRun.inputMessageId === null
  ) {
    return false;
  }
  if (
    state.runs.some(
      (candidate) =>
        candidate.inputMessageId === stateRun.inputMessageId &&
        candidate.attemptIndex > stateRun.attemptIndex,
    )
  ) {
    return false;
  }
  return !state.runs.some(
    (candidate) =>
      candidate.predecessorRunId === stateRun.id &&
      candidate.status !== "waiting",
  );
}

export function activityRunForSelection(
  state: ConversationViewState | undefined,
  selectedRunId: string | null,
  activeRun: AgentRun | null,
): AgentRun | null {
  if (selectedRunId !== null) {
    return state?.runs.find((run) => run.id === selectedRunId) ?? null;
  }
  return activeRun ?? latestRun(state);
}

export type RunEventReplayState =
  | "not_loaded"
  | "replaying"
  | "loaded"
  | "failed";
export type RunEventSubscriptionMode = "none" | "follow" | "replay_once";

export function shouldMarkConversationRead(input: {
  activeConversationId: string | null;
  conversationId: string;
  visibilityState: DocumentVisibilityState;
}): boolean {
  return (
    input.activeConversationId === input.conversationId &&
    input.visibilityState === "visible"
  );
}

export function conversationSummaryAtReadWatermark(
  conversation: ConversationSummary,
  readThroughTerminalEventId: string | null,
): ConversationSummary {
  if (
    readThroughTerminalEventId === null ||
    conversation.attention === null ||
    BigInt(conversation.attention.terminalEventId) >
      BigInt(readThroughTerminalEventId)
  ) {
    return conversation;
  }
  return { ...conversation, attention: null };
}

export function conversationStateShowsTerminalResult(
  state: ConversationViewState | undefined,
  runId: string,
  terminalEventId: string,
): boolean {
  if (
    state?.messages.some(
      (message) => message.role === "assistant" && message.runId === runId,
    ) === true
  ) {
    return true;
  }

  const run = state?.runs.find((candidate) => candidate.id === runId);
  if (
    run !== undefined &&
    (run.status === "failed" ||
      run.status === "cancelled" ||
      run.status === "reconciliation_required")
  ) {
    return true;
  }

  return (
    state?.eventsByRunId[runId]?.some(
      (event) =>
        event.id === terminalEventId &&
        (event.payload.type === "done" || event.payload.type === "error"),
    ) === true
  );
}

export function shouldCommitTerminalCredits(
  committedTerminalEventId: string,
  candidateTerminalEventId: string,
): boolean {
  return BigInt(candidateTerminalEventId) > BigInt(committedTerminalEventId);
}

export function advanceConversationRefreshFence(
  currentTerminalEventId: string | null,
  candidateTerminalEventId: string,
): string {
  if (
    currentTerminalEventId === null ||
    BigInt(candidateTerminalEventId) > BigInt(currentTerminalEventId)
  ) {
    return candidateTerminalEventId;
  }
  return currentTerminalEventId;
}

export function conversationRefreshIsCurrent(
  fencedTerminalEventId: string,
  resultTerminalEventId: string,
): boolean {
  return fencedTerminalEventId === resultTerminalEventId;
}

export function runEventSubscriptionMode(
  run: AgentRun | undefined,
  events: RunEvent[],
  replayState: RunEventReplayState,
): RunEventSubscriptionMode {
  if (replayState !== "not_loaded") {
    return "none";
  }
  if (run?.status === "waiting") {
    return "none";
  }
  if (
    run !== undefined &&
    !isActiveRunStatus(effectiveRunStatus(run, events))
  ) {
    return "replay_once";
  }
  return "follow";
}

export function shouldSubscribeToRun(
  run: AgentRun | undefined,
  events: RunEvent[],
  replayState: RunEventReplayState,
): boolean {
  return runEventSubscriptionMode(run, events, replayState) !== "none";
}

export type LoadedRunSubscriptionRequest = {
  run: AgentRun;
  existingEvents: RunEvent[];
  intent: RunSubscriptionIntent;
};

export function loadedRunSubscriptionRequests(
  stateBeforeLoad: ConversationViewState | undefined,
  loadedRuns: AgentRun[],
  selectedRunId: string | null,
  replayStates: ReadonlyMap<string, RunEventReplayState>,
): LoadedRunSubscriptionRequest[] {
  return loadedRuns.flatMap((run) => {
    const existingEvents = eventsForRun(stateBeforeLoad, run.id);
    const replayState = replayStates.get(run.id) ?? "not_loaded";
    const status = effectiveRunStatus(run, existingEvents);
    const intent: RunSubscriptionIntent | null = isActiveRunStatus(status)
      ? "active"
      : run.id === selectedRunId
        ? "activity"
        : null;
    return intent !== null &&
      shouldSubscribeToRun(run, existingEvents, replayState)
      ? [{ run, existingEvents, intent }]
      : [];
  });
}

export type TerminalRunPlacement = {
  run: AgentRun;
  afterUserMessageId: string | null;
};

export function terminalRunsWithoutAssistantMessages(
  state: ConversationViewState,
): TerminalRunPlacement[] {
  const assistantMessageIds = new Set(
    state.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.id),
  );
  const assistantRunIds = new Set(
    state.messages.flatMap((message) =>
      message.role === "assistant" && message.runId !== null
        ? [message.runId]
        : [],
    ),
  );
  const userMessageIds = new Set(
    state.messages
      .filter((message) => message.role === "user")
      .map((message) => message.id),
  );

  return state.runs.flatMap((run) => {
    const status = effectiveRunStatus(run, eventsForRun(state, run.id));
    if (
      status === "waiting" ||
      isActiveRunStatus(status) ||
      status === "completed"
    ) {
      return [];
    }
    const hasAssistantMessage =
      assistantRunIds.has(run.id) ||
      (run.assistantMessageId !== null &&
        assistantMessageIds.has(run.assistantMessageId));
    if (hasAssistantMessage) {
      return [];
    }
    return [
      {
        run,
        afterUserMessageId:
          run.inputMessageId !== null && userMessageIds.has(run.inputMessageId)
            ? run.inputMessageId
            : null,
      },
    ];
  });
}
