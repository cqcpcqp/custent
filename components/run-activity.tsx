"use client";

import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  ActivityIcon,
  AlertIcon,
  AttachmentIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CodeIcon,
  DocumentIcon,
  ExternalLinkIcon,
  RefreshIcon,
  SearchIcon,
  SparklesIcon,
} from "@/components/icons";
import {
  formatAttachmentBytes,
  inputAttachmentTypeLabel,
} from "@/components/input-attachment-state";
import {
  idleRunEventConnectionState,
  runEventConnectionPresentation,
  type RunEventConnectionState,
} from "@/components/run-event-connection-state";
import {
  effectiveRunStatus,
  runCancellationIsPending,
  latestStatusMessage,
  type RunEventReplayState,
} from "@/components/research-workspace-state";
import {
  captureConversationScroll,
  restoredConversationScrollTop,
  type ConversationScrollSnapshot,
} from "@/components/conversation-scroll-state";
import { useModalFocus } from "@/components/modal-focus";
import { closeDesktopPanelAndRestoreFocus } from "@/components/workspace-ux-state";
import type {
  AgentRun,
  AgentRunStatus,
  CodeInterpreterOutput,
  RunEvent,
  RunEventPayload,
  WebSearchAction,
} from "@/lib/contracts";

const eventTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const toolNames: Record<
  Extract<RunEventPayload, { type: "tool_started" }>["toolName"],
  string
> = {
  list_research: "读取研究记录",
  save_research_results: "保存研究结果",
  create_csv: "生成 CSV",
  create_pdf: "生成 PDF",
  create_csv_file: "生成通用 CSV",
  create_pdf_file: "生成通用 PDF",
};

const statusNames: Record<AgentRunStatus, string> = {
  waiting: "等待中",
  queued: "排队中",
  running: "研究中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
  reconciliation_required: "已结束",
};

const terminalStatuses = new Set<AgentRunStatus>([
  "completed",
  "failed",
  "cancelled",
  "reconciliation_required",
]);

const narrowRunActivityPanelMediaQuery = "(max-width: 1180px)";

function subscribeToNarrowRunActivityPanel(
  onStoreChange: () => void,
): () => void {
  const mediaQuery = window.matchMedia(narrowRunActivityPanelMediaQuery);
  mediaQuery.addEventListener("change", onStoreChange);
  return () => mediaQuery.removeEventListener("change", onStoreChange);
}

function narrowRunActivityPanelSnapshot(): boolean {
  return window.matchMedia(narrowRunActivityPanelMediaQuery).matches;
}

export function runActivityPanelIsModal(
  isOpen: boolean,
  isNarrowViewport: boolean,
): boolean {
  return isOpen && isNarrowViewport;
}

export type RunActivityDetailState =
  | Readonly<{ phase: "ready" }>
  | Readonly<{ phase: "loading" }>
  | Readonly<{ phase: "failed"; message: string }>;

export function resolveRunActivityDetailState(input: {
  requestedRunId: string | null;
  run: AgentRun | null;
  conversationState:
    | Readonly<{
        isLoaded: boolean;
        isLoading: boolean;
        loadError: string | null;
      }>
    | undefined;
}): RunActivityDetailState {
  if (input.requestedRunId === null) {
    return { phase: "ready" };
  }
  if (input.run !== null) {
    if (input.run.id !== input.requestedRunId) {
      throw new Error(
        `活动 Run ${input.run.id} 与请求 ${input.requestedRunId} 不一致`,
      );
    }
    return { phase: "ready" };
  }
  if (input.conversationState?.isLoading === true) {
    return { phase: "loading" };
  }
  if (input.conversationState?.loadError !== null &&
      input.conversationState?.loadError !== undefined) {
    return {
      phase: "failed",
      message: input.conversationState.loadError,
    };
  }
  if (input.conversationState?.isLoaded !== true) {
    return { phase: "loading" };
  }
  return {
    phase: "failed",
    message: "已载入对话，但没有找到指定的运行活动。请重新载入。",
  };
}

export function closeRunActivityPanelFromBackdrop(
  event: Pick<
    ReactMouseEvent<HTMLDivElement>,
    "currentTarget" | "preventDefault" | "target"
  >,
  onClose: () => void,
): void {
  if (event.target !== event.currentTarget) {
    return;
  }

  event.preventDefault();
  onClose();
}

export function closeRunActivityPanelFromButton(
  isModalOpen: boolean,
  onClose: () => void,
  returnFocusTarget: Pick<HTMLElement, "focus"> | null,
): void {
  if (isModalOpen) {
    onClose();
    return;
  }
  closeDesktopPanelAndRestoreFocus(onClose, returnFocusTarget);
}

const reasoningSummaryMarkdownElements = [
  "p",
  "strong",
  "em",
  "del",
  "ul",
  "ol",
  "li",
  "blockquote",
  "code",
  "pre",
  "br",
] as const;

type RunActivityScrollContainer = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

type IncompleteActivityOutcome =
  | "interrupted"
  | "failed"
  | "reconciliation_required";

export function rememberRunActivityScrollPosition(
  positions: Map<string, ConversationScrollSnapshot>,
  runId: string,
  container: RunActivityScrollContainer,
): void {
  positions.set(runId, captureConversationScroll(container));
}

export function restoreRunActivityScrollPosition(
  positions: ReadonlyMap<string, ConversationScrollSnapshot>,
  runId: string,
  container: RunActivityScrollContainer,
): void {
  const snapshot = positions.get(runId);
  container.scrollTop =
    snapshot === undefined
      ? 0
      : restoredConversationScrollTop(snapshot, container);
}

export function followLatestRunActivity(
  positions: Map<string, ConversationScrollSnapshot>,
  runId: string,
  container: RunActivityScrollContainer,
): boolean {
  const snapshot = positions.get(runId);
  if (snapshot === undefined || !snapshot.stickToBottom) {
    return false;
  }

  container.scrollTop = restoredConversationScrollTop(snapshot, container);
  rememberRunActivityScrollPosition(positions, runId, container);
  return true;
}

export function formatRunDuration(
  run: AgentRun,
  now: number = Date.now(),
): string {
  const startedAt = new Date(run.startedAt ?? run.createdAt).getTime();
  const finishedAt =
    run.finishedAt === null ? now : new Date(run.finishedAt).getTime();
  const totalSeconds = Math.max(0, Math.floor((finishedAt - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds} 秒` : `${minutes} 分 ${seconds} 秒`;
}

type ActivityItem =
  | {
      key: string;
      kind: "reasoning";
      createdAt: string;
      updatedAt: string;
      itemId: string;
      summaryIndex: number;
      lastProviderSequence: number;
      text: string;
    }
  | {
      key: string;
      kind: "web_search";
      createdAt: string;
      updatedAt: string;
      callId: string;
      phase: Extract<RunEventPayload, { type: "web_search" }>["phase"];
      lastProviderSequence: number;
      action: WebSearchAction | null;
      incompleteOutcome: IncompleteActivityOutcome | null;
    }
  | {
      key: string;
      kind: "tool";
      createdAt: string;
      updatedAt: string;
      callId: string;
      toolName: Extract<RunEventPayload, { type: "tool_started" }>["toolName"];
      title: string;
      input: string;
      output: string | null;
      completedAt: string | null;
      incompleteOutcome: IncompleteActivityOutcome | null;
    }
  | {
      key: string;
      kind: "code_interpreter";
      createdAt: string;
      updatedAt: string;
      callId: string;
      outputIndex: number;
      lastProviderSequence: number;
      phase:
        | "in_progress"
        | "writing_code"
        | "interpreting"
        | "completed"
        | "incomplete"
        | "failed";
      streamedCode: string;
      finalCode: string | null;
      hasResult: boolean;
      outputs: CodeInterpreterOutput[] | null;
      incompleteOutcome: IncompleteActivityOutcome | null;
    }
  | {
      key: string;
      kind: "event";
      createdAt: string;
      updatedAt: string;
      payload: Exclude<
        RunEventPayload,
        | { type: "delta" }
        | { type: "reasoning" }
        | { type: "web_search" }
        | { type: "code_interpreter_status" }
        | { type: "code_interpreter_code" }
        | { type: "code_interpreter_result" }
        | { type: "tool_started" }
        | { type: "tool_completed" }
      >;
    };

function incompleteActivityOutcome(
  payload: Extract<RunEventPayload, { type: "done" | "error" }>,
): IncompleteActivityOutcome {
  if (payload.type === "done" || payload.error.code === "RUN_CANCELLED") {
    return "interrupted";
  }
  if (payload.error.code === "RUN_REQUIRES_RECONCILIATION") {
    return "reconciliation_required";
  }
  return "failed";
}

function resolveIncompleteActivityItems(
  grouped: Map<string, ActivityItem>,
  outcome: IncompleteActivityOutcome,
): void {
  for (const item of grouped.values()) {
    if (
      item.kind === "web_search" &&
      item.phase !== "completed" &&
      item.phase !== "failed"
    ) {
      item.incompleteOutcome = outcome;
      continue;
    }
    if (item.kind === "tool" && item.completedAt === null) {
      item.incompleteOutcome = outcome;
      continue;
    }
    if (
      item.kind === "code_interpreter" &&
      item.phase !== "completed" &&
      item.phase !== "incomplete" &&
      item.phase !== "failed"
    ) {
      item.incompleteOutcome = outcome;
    }
  }
}

export function buildActivityItems(events: RunEvent[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  const grouped = new Map<string, ActivityItem>();

  for (const event of events) {
    const { payload } = event;
    if (payload.type === "delta") {
      continue;
    }

    if (payload.type === "reasoning") {
      const key = `reasoning:${payload.itemId}:${payload.summaryIndex}`;
      const existing = grouped.get(key);
      if (existing === undefined) {
        const item: ActivityItem = {
          key,
          kind: "reasoning",
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
          itemId: payload.itemId,
          summaryIndex: payload.summaryIndex,
          lastProviderSequence: payload.providerSequence,
          text: payload.text,
        };
        grouped.set(key, item);
        items.push(item);
      } else {
        if (existing.kind !== "reasoning") {
          throw new Error(`活动聚合键冲突：${key}`);
        }
        if (payload.providerSequence <= existing.lastProviderSequence) {
          throw new Error(`分析摘要 ${key} 的 providerSequence 没有严格递增`);
        }
        existing.lastProviderSequence = payload.providerSequence;
        existing.updatedAt = event.createdAt;
        existing.text += payload.text;
      }
      continue;
    }

    if (payload.type === "web_search") {
      const key = `web_search:${payload.callId}`;
      const existing = grouped.get(key);
      if (existing === undefined) {
        const item: ActivityItem = {
          key,
          kind: "web_search",
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
          callId: payload.callId,
          phase: payload.phase,
          lastProviderSequence: payload.providerSequence,
          action: payload.action,
          incompleteOutcome: null,
        };
        grouped.set(key, item);
        items.push(item);
      } else {
        if (existing.kind !== "web_search") {
          throw new Error(`活动聚合键冲突：${key}`);
        }
        if (payload.providerSequence <= existing.lastProviderSequence) {
          throw new Error(`网页搜索 ${key} 的 providerSequence 没有严格递增`);
        }
        existing.phase = payload.phase;
        existing.lastProviderSequence = payload.providerSequence;
        existing.action = payload.action;
        existing.updatedAt = event.createdAt;
        if (payload.phase === "completed" || payload.phase === "failed") {
          existing.incompleteOutcome = null;
        }
      }
      continue;
    }

    if (
      payload.type === "code_interpreter_status" ||
      payload.type === "code_interpreter_code" ||
      payload.type === "code_interpreter_result"
    ) {
      const key = `code_interpreter:${payload.callId}`;
      const existing = grouped.get(key);
      if (existing === undefined) {
        const item: ActivityItem = {
          key,
          kind: "code_interpreter",
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
          callId: payload.callId,
          outputIndex: payload.outputIndex,
          lastProviderSequence: payload.providerSequence,
          phase:
            payload.type === "code_interpreter_code"
              ? "writing_code"
              : payload.phase,
          streamedCode:
            payload.type === "code_interpreter_code" ? payload.code : "",
          finalCode:
            payload.type === "code_interpreter_result" ? payload.code : null,
          hasResult: payload.type === "code_interpreter_result",
          outputs:
            payload.type === "code_interpreter_result"
              ? payload.outputs
              : null,
          incompleteOutcome: null,
        };
        grouped.set(key, item);
        items.push(item);
      } else {
        if (existing.kind !== "code_interpreter") {
          throw new Error(`活动聚合键冲突：${key}`);
        }
        if (existing.outputIndex !== payload.outputIndex) {
          throw new Error(`Python 执行 ${key} 的 outputIndex 前后不一致`);
        }
        if (payload.providerSequence <= existing.lastProviderSequence) {
          throw new Error(`Python 执行 ${key} 的 providerSequence 没有严格递增`);
        }
        existing.lastProviderSequence = payload.providerSequence;
        existing.updatedAt = event.createdAt;
        existing.incompleteOutcome = null;
        if (payload.type === "code_interpreter_code") {
          existing.phase = "writing_code";
          existing.streamedCode =
            payload.update === "delta"
              ? existing.streamedCode + payload.code
              : payload.code;
        } else if (payload.type === "code_interpreter_status") {
          existing.phase = payload.phase;
        } else {
          existing.phase = payload.phase;
          existing.finalCode = payload.code;
          existing.hasResult = true;
          existing.outputs = payload.outputs;
        }
      }
      continue;
    }

    if (payload.type === "tool_started") {
      const key = `tool:${payload.callId}`;
      if (grouped.has(key)) {
        throw new Error(`本地工具 ${payload.callId} 收到重复的 started 事件`);
      }
      const item: ActivityItem = {
        key,
        kind: "tool",
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        callId: payload.callId,
        toolName: payload.toolName,
        title: payload.title,
        input: payload.input,
        output: null,
        completedAt: null,
        incompleteOutcome: null,
      };
      grouped.set(key, item);
      items.push(item);
      continue;
    }

    if (payload.type === "tool_completed") {
      const key = `tool:${payload.callId}`;
      const existing = grouped.get(key);
      if (existing === undefined || existing.kind !== "tool") {
        throw new Error(`本地工具 ${payload.callId} 缺少 started 事件`);
      }
      if (existing.toolName !== payload.toolName) {
        throw new Error(`本地工具 ${payload.callId} 的 toolName 前后不一致`);
      }
      existing.title = payload.title;
      existing.output = payload.output;
      existing.completedAt = event.createdAt;
      existing.updatedAt = event.createdAt;
      existing.incompleteOutcome = null;
      continue;
    }

    if (payload.type === "done" || payload.type === "error") {
      resolveIncompleteActivityItems(
        grouped,
        incompleteActivityOutcome(payload),
      );
    }

    items.push({
      key: `event:${event.id}`,
      kind: "event",
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
      payload,
    });
  }

  return items;
}

export function activityEventCount(events: RunEvent[]): number {
  return buildActivityItems(events).length;
}

function isAnalysisOrToolActivity(item: ActivityItem): boolean {
  return (
    item.kind === "reasoning" ||
    item.kind === "web_search" ||
    item.kind === "code_interpreter" ||
    item.kind === "tool"
  );
}

export function analysisAndToolActivityCount(events: RunEvent[]): number {
  return buildActivityItems(events).filter(isAnalysisOrToolActivity).length;
}

type AnalysisAndToolActivityCounts = {
  reasoningSummaryCount: number;
  toolCallCount: number;
  codeInterpreterCount: number;
  webActivityCount: number;
};

function analysisAndToolActivityCounts(
  events: RunEvent[],
): AnalysisAndToolActivityCounts {
  const counts: AnalysisAndToolActivityCounts = {
    reasoningSummaryCount: 0,
    toolCallCount: 0,
    codeInterpreterCount: 0,
    webActivityCount: 0,
  };

  for (const item of buildActivityItems(events)) {
    switch (item.kind) {
      case "reasoning":
        counts.reasoningSummaryCount += 1;
        break;
      case "tool":
        counts.toolCallCount += 1;
        break;
      case "web_search":
        counts.webActivityCount += 1;
        break;
      case "code_interpreter":
        counts.codeInterpreterCount += 1;
        break;
      case "event":
        break;
    }
  }

  return counts;
}

function activityCountSummary(counts: AnalysisAndToolActivityCounts): string {
  const parts = [
    counts.webActivityCount === 0
      ? null
      : `${counts.webActivityCount} 项网页活动`,
    counts.toolCallCount === 0
      ? null
      : `${counts.toolCallCount} 次工具调用`,
    counts.codeInterpreterCount === 0
      ? null
      : `${counts.codeInterpreterCount} 次 Python 执行`,
    counts.reasoningSummaryCount === 0
      ? null
      : `${counts.reasoningSummaryCount} 条分析摘要`,
  ].filter((part): part is string => part !== null);

  return parts.length === 0 ? "尚无可展示活动" : parts.join(" · ");
}

function useDurationNow(status: AgentRunStatus): number {
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (status === "waiting" || terminalStatuses.has(status)) {
      return;
    }
    const updateNow = () => setNow(Date.now());
    const initialTimer = window.setTimeout(updateNow, 0);
    const interval = window.setInterval(updateNow, 1_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [status]);

  return now;
}

function eventIcon(item: ActivityItem) {
  switch (item.kind) {
    case "reasoning":
      return <SparklesIcon />;
    case "web_search":
      return <SearchIcon />;
    case "tool":
      return <DocumentIcon />;
    case "code_interpreter":
      return <CodeIcon />;
    case "event":
      switch (item.payload.type) {
        case "artifact":
          return <DocumentIcon />;
        case "attachment":
          return <AttachmentIcon />;
        case "done":
          return <CheckIcon />;
        case "error":
          return <AlertIcon />;
        case "status":
          return item.payload.phase === "searching" ? <SearchIcon /> : <ActivityIcon />;
      }
  }
}

function webSearchTitle(
  phase: Extract<RunEventPayload, { type: "web_search" }>["phase"],
): string {
  switch (phase) {
    case "in_progress":
      return "已启动网页搜索";
    case "searching":
      return "正在搜索公开网页";
    case "completed":
      return "网页搜索完成";
    case "failed":
      return "网页搜索失败";
  }
}

function incompleteWebSearchTitle(
  outcome: IncompleteActivityOutcome,
): string {
  switch (outcome) {
    case "interrupted":
      return "网页搜索已中断";
    case "failed":
      return "网页搜索失败";
    case "reconciliation_required":
      return "网页搜索未完成";
  }
}

function incompleteActivityMeta(outcome: IncompleteActivityOutcome): string {
  switch (outcome) {
    case "interrupted":
      return "已中断";
    case "failed":
      return "失败";
    case "reconciliation_required":
      return "已中断";
  }
}

function terminalErrorMeta(
  error: Extract<RunEventPayload, { type: "error" }>["error"],
): string {
  if (error.code === "RUN_CANCELLED") {
    return "运行已停止";
  }
  if (error.code === "RUN_REQUIRES_RECONCILIATION") {
    return "生成已结束，费用待确认";
  }
  return "运行失败";
}

function terminalErrorTitle(
  error: Extract<RunEventPayload, { type: "error" }>["error"],
): string {
  if (error.code === "RUN_CANCELLED") {
    return "运行已停止";
  }
  if (error.code === "RUN_REQUIRES_RECONCILIATION") {
    return "生成已结束";
  }
  return "运行未能完成";
}

function activityItemFailed(item: ActivityItem): boolean {
  if (
    item.kind !== "web_search" &&
    item.kind !== "tool" &&
    item.kind !== "code_interpreter"
  ) {
    return false;
  }
  return (
    (item.kind === "web_search" && item.phase === "failed") ||
    (item.kind === "code_interpreter" &&
      (item.phase === "failed" || item.phase === "incomplete")) ||
    item.incompleteOutcome === "failed" ||
    item.incompleteOutcome === "reconciliation_required"
  );
}

function completedWebSearchTitle(action: WebSearchAction): string {
  switch (action.type) {
    case "search":
      return "已搜索公开网页";
    case "open_page":
      return "已打开网页";
    case "find_in_page":
      return "已在网页内查找";
  }
}

function webSearchQueries(action: Extract<WebSearchAction, { type: "search" }>): string[] {
  const queries = [...action.queries];
  if (action.query !== null && !queries.includes(action.query)) {
    queries.unshift(action.query);
  }
  return queries;
}

function sourceHost(url: string): string {
  return new URL(url).hostname.replace(/^www\./u, "");
}

function uniqueSourceLinks(
  sources: Extract<WebSearchAction, { type: "search" }>["sources"],
): Array<{ url: string; label: string }> {
  const seenHosts = new Set<string>();
  const links: Array<{ url: string; label: string }> = [];

  for (const source of sources) {
    const label = sourceHost(source.url);
    if (seenHosts.has(label)) {
      continue;
    }
    seenHosts.add(label);
    links.push({ url: source.url, label });
  }

  return links;
}

function compactReasoningSummary(content: string): string {
  const firstTwoLines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 2)
    .join("  \n");
  const codePoints = Array.from(firstTwoLines);

  return codePoints.length <= 240
    ? firstTwoLines
    : `${codePoints.slice(0, 239).join("")}…`;
}

function formatStepDuration(startedAt: string, completedAt: string): string {
  const milliseconds = Math.max(
    0,
    new Date(completedAt).getTime() - new Date(startedAt).getTime(),
  );
  return milliseconds < 1_000
    ? `${milliseconds} 毫秒`
    : `${(milliseconds / 1_000).toFixed(1)} 秒`;
}

function ReasoningSummaryMarkdown({
  compact = false,
  content,
}: {
  compact?: boolean;
  content: string;
}) {
  return (
    <div
      className={`activity-event__reasoning-summary${
        compact ? " activity-event__reasoning-summary--compact" : ""
      }`}
    >
      <ReactMarkdown
        allowedElements={reasoningSummaryMarkdownElements}
        remarkPlugins={[remarkGfm]}
        skipHtml
        unwrapDisallowed
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function ActivityData({ label, value }: { label: string; value: string }) {
  return (
    <div className="activity-event__data">
      <span>{label}</span>
      <pre>{value}</pre>
    </div>
  );
}

function ToolActivityDetails({
  input,
  output,
}: {
  input: string;
  output: string | null;
}) {
  return (
    <details className="activity-event__tool-details">
      <summary>
        <span>
          {output === null ? "查看工具输入" : "查看工具输入与输出"}
        </span>
        <ChevronDownIcon />
      </summary>
      <div className="activity-event__tool-details-body">
        <ActivityData label="输入" value={input} />
        {output === null ? null : <ActivityData label="输出" value={output} />}
      </div>
    </details>
  );
}

function displayedCode(
  item: Extract<ActivityItem, { kind: "code_interpreter" }>,
): string {
  return item.hasResult && item.finalCode !== null
    ? item.finalCode
    : item.streamedCode;
}

function compactPythonCode(code: string): string {
  const firstLines = code.split(/\r?\n/u).slice(0, 4).join("\n");
  const codePoints = Array.from(firstLines);
  return codePoints.length <= 280
    ? firstLines
    : `${codePoints.slice(0, 279).join("")}…`;
}

function CodeInterpreterActivityDetails({
  compact,
  item,
}: {
  compact: boolean;
  item: Extract<ActivityItem, { kind: "code_interpreter" }>;
}) {
  const code = displayedCode(item);
  const logs =
    item.outputs === null
      ? []
      : item.outputs
          .filter(
            (output): output is Extract<
              CodeInterpreterOutput,
              { type: "logs" }
            > => output.type === "logs",
          )
          .map((output) => output.logs);

  return (
    <>
      {code.length === 0 ? null : (
        <ActivityData
          label="Python"
          value={compact ? compactPythonCode(code) : code}
        />
      )}
      {compact || logs.length === 0 ? null : (
        <ActivityData label="执行输出" value={logs.join("\n")} />
      )}
    </>
  );
}

function SearchActivityDetails({
  queries,
  sources,
}: {
  queries: string[];
  sources: Extract<WebSearchAction, { type: "search" }>["sources"];
}) {
  return (
    <details className="activity-event__search-details">
      <summary>
        <span>查看查询与全部来源</span>
        <ChevronDownIcon />
      </summary>
      <div className="activity-event__search-details-body">
        {queries.length === 0 ? null : (
          <ActivityData label="查询" value={queries.join("\n")} />
        )}
        {sources.length === 0 ? null : (
          <div className="activity-event__sources activity-event__sources--all">
            <span>全部来源</span>
            <div>
              {sources.map((source, index) => (
                <a
                  href={source.url}
                  key={`${source.url}-${index}`}
                  rel="noreferrer"
                  target="_blank"
                  title={source.url}
                >
                  <span>{sourceHost(source.url)}</span>
                  <ExternalLinkIcon />
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

function ActivityEventRow({
  compact,
  item,
}: {
  compact: boolean;
  item: ActivityItem;
}) {
  let title: string;
  let meta: string;
  let input: string | null = null;
  let output: string | null = null;
  let links: Array<{ url: string; label: string }> = [];
  let linksLabel: string | null = "来源域名";
  let sourceOverflowCount = 0;
  let searchDetails: {
    queries: string[];
    sources: Extract<WebSearchAction, { type: "search" }>["sources"];
  } | null = null;

  switch (item.kind) {
    case "reasoning":
      title = "分析摘要";
      meta = `摘要 ${item.summaryIndex + 1}`;
      output = compact ? compactReasoningSummary(item.text) : item.text;
      break;
    case "web_search":
      title =
        item.incompleteOutcome !== null
          ? incompleteWebSearchTitle(item.incompleteOutcome)
          : item.action === null || item.phase === "failed"
            ? webSearchTitle(item.phase)
            : completedWebSearchTitle(item.action);
      meta = `网页搜索 · ${
        item.incompleteOutcome !== null
          ? incompleteActivityMeta(item.incompleteOutcome)
          : item.phase === "completed"
            ? "已完成"
            : item.phase === "failed"
              ? "失败"
              : "运行中"
      }`;
      if (item.action !== null) {
        switch (item.action.type) {
          case "search": {
            const uniqueLinks = uniqueSourceLinks(item.action.sources);
            if (
              item.incompleteOutcome === null &&
              item.phase !== "failed"
            ) {
              meta = `返回 ${item.action.sources.length} 个来源`;
            }
            linksLabel = null;
            links = uniqueLinks.slice(0, 3);
            sourceOverflowCount = Math.max(0, uniqueLinks.length - 3);
            if (!compact) {
              searchDetails = {
                queries: webSearchQueries(item.action),
                sources: item.action.sources,
              };
            }
            break;
          }
          case "open_page":
            linksLabel = compact ? null : "打开网页";
            if (item.action.url !== null) {
              links = [
                {
                  url: item.action.url,
                  label: sourceHost(item.action.url),
                },
              ];
            }
            break;
          case "find_in_page":
            input = compact ? null : item.action.pattern;
            linksLabel = compact ? null : "页内查找目标";
            links = [
              {
                url: item.action.url,
                label: sourceHost(item.action.url),
              },
            ];
            break;
        }
      }
      break;
    case "tool":
      title = item.title;
      input = item.input;
      output = item.output;
      meta = item.completedAt === null
        ? `${toolNames[item.toolName]} · ${
            item.incompleteOutcome === null
              ? "运行中"
              : incompleteActivityMeta(item.incompleteOutcome)
          }`
        : `${toolNames[item.toolName]} · 已完成 · ${formatStepDuration(item.createdAt, item.completedAt)}`;
      break;
    case "code_interpreter": {
      title =
        item.incompleteOutcome !== null
          ? "Python 执行已中断"
          : item.phase === "in_progress"
            ? "正在准备 Python"
            : item.phase === "writing_code"
              ? "正在编写 Python"
              : item.phase === "interpreting"
                ? "正在运行 Python"
                : item.phase === "completed"
                  ? "Python 执行完成"
                  : item.phase === "incomplete"
                    ? "Python 执行未完成"
                    : "Python 执行失败";
      const outputs = item.outputs === null ? [] : item.outputs;
      const logCount = outputs.filter((output) => output.type === "logs").length;
      const imageOutputs = outputs.filter(
        (output): output is Extract<
          CodeInterpreterOutput,
          { type: "image" }
        > => output.type === "image",
      );
      meta =
        item.incompleteOutcome !== null
          ? `Code Interpreter · ${incompleteActivityMeta(item.incompleteOutcome)}`
          : item.phase === "completed"
            ? `Code Interpreter · 已完成${
                logCount + imageOutputs.length === 0
                  ? ""
                  : ` · ${logCount + imageOutputs.length} 项输出`
              }`
            : item.phase === "failed"
              ? "Code Interpreter · 失败"
              : item.phase === "incomplete"
                ? "Code Interpreter · 未完成"
                : "Code Interpreter · 运行中";
      linksLabel = compact ? null : "生成图像";
      links = imageOutputs.map((output, index) => ({
        url: output.url,
        label: `打开图像 ${index + 1}`,
      }));
      break;
    }
    case "event":
      switch (item.payload.type) {
        case "status":
          title = item.payload.message;
          meta = "状态更新";
          break;
        case "artifact":
          title = `已生成 ${item.payload.artifact.name}`;
          meta = item.payload.artifact.mimeType === "text/csv" ? "CSV 文件" : "PDF 文件";
          break;
        case "attachment":
          title = `已读取附件 ${item.payload.attachment.name}`;
          meta = `${inputAttachmentTypeLabel(
            item.payload.attachment.mimeType,
          )} · ${formatAttachmentBytes(item.payload.attachment.sizeBytes)}`;
          break;
        case "done":
          title = "研究回答已完成";
          meta = "运行完成";
          break;
        case "error":
          title = terminalErrorTitle(item.payload.error);
          meta = terminalErrorMeta(item.payload.error);
          break;
      }
      break;
  }

  return (
    <li
      className={`activity-event activity-event--${item.kind}${
        activityItemFailed(item)
          ? " activity-event--failed"
          : ""
      }`}
    >
      <span className="activity-event__icon">{eventIcon(item)}</span>
      <div className="activity-event__body">
        <div className="activity-event__heading">
          <strong>{title}</strong>
          {compact ? null : (
            <time dateTime={item.updatedAt}>
              {eventTimeFormatter.format(new Date(item.updatedAt))}
            </time>
          )}
        </div>
        <small>{meta}</small>
        {item.kind === "tool" ? (
          compact ? null : (
            <ToolActivityDetails input={item.input} output={item.output} />
          )
        ) : item.kind === "code_interpreter" ? (
          <CodeInterpreterActivityDetails compact={compact} item={item} />
        ) : (
          <>
            {input === null || input.length === 0 ? null : (
              <ActivityData label="输入" value={input} />
            )}
            {output === null || output.length === 0
              ? null
              : item.kind === "reasoning" && compact
                ? (
                    <ReasoningSummaryMarkdown compact content={output} />
                  )
                : (
                    <div className="activity-event__data">
                      <span>
                        {item.kind === "reasoning" ? "摘要" : "输出"}
                      </span>
                      {item.kind === "reasoning" ? (
                        <ReasoningSummaryMarkdown content={output} />
                      ) : (
                        <pre>{output}</pre>
                      )}
                    </div>
                  )}
          </>
        )}
        {links.length === 0 ? null : (
          <div className="activity-event__sources">
            {linksLabel === null ? null : <span>{linksLabel}</span>}
            <div>
              {links.map((link, index) => (
                <a
                  href={link.url}
                  key={`${link.url}-${index}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  <span>{link.label}</span>
                  <ExternalLinkIcon />
                </a>
              ))}
              {sourceOverflowCount === 0 ? null : (
                <span
                  aria-label={`另有 ${sourceOverflowCount} 个来源域名`}
                  className="activity-event__sources-overflow"
                >
                  +{sourceOverflowCount}
                </span>
              )}
            </div>
          </div>
        )}
        {searchDetails === null ||
        (searchDetails.queries.length === 0 &&
          searchDetails.sources.length === 0) ? null : (
          <SearchActivityDetails
            queries={searchDetails.queries}
            sources={searchDetails.sources}
          />
        )}
      </div>
    </li>
  );
}

export function ActivityTimeline({
  events,
  compact = false,
  emptyMessage = "运行活动会实时显示在这里",
  variant = "complete",
}: {
  events: RunEvent[];
  compact?: boolean;
  emptyMessage?: string;
  variant?: "complete" | "analysis_and_tools";
}) {
  const activityItems = useMemo(() => {
    const items = buildActivityItems(events);
    return variant === "analysis_and_tools"
      ? items.filter(isAnalysisOrToolActivity)
      : items;
  }, [events, variant]);
  const renderedItems = compact ? activityItems.slice(-4) : activityItems;

  if (renderedItems.length === 0) {
    return (
      <div className="activity-empty">
        <ActivityIcon />
        <span>{emptyMessage}</span>
      </div>
    );
  }

  return (
    <ol className={`activity-timeline${compact ? " activity-timeline--compact" : ""}`}>
      {renderedItems.map((item) => (
        <ActivityEventRow compact={compact} item={item} key={item.key} />
      ))}
    </ol>
  );
}

export function RunProcessCard({
  run,
  events,
  isActivityPanelOpen = false,
  onOpenActivity,
  connectionState = idleRunEventConnectionState,
}: {
  run: AgentRun;
  events: RunEvent[];
  isActivityPanelOpen?: boolean;
  onOpenActivity: (runId: string, surface?: "inline" | "panel") => void;
  connectionState?: RunEventConnectionState;
}) {
  const status = effectiveRunStatus(run, events);
  const isStopping = runCancellationIsPending(run, false);
  const [isInlineOpen, setIsInlineOpen] = useState(
    () => status === "queued" || status === "running",
  );
  const now = useDurationNow(status);
  if (status === "waiting" && events.length !== 0) {
    throw new Error(`等待中的 Run ${run.id} 不应包含活动事件`);
  }

  if (status === "waiting") {
    return (
      <section
        className="run-process-card run-process-card--waiting"
        role="status"
      >
        <div className="run-process-card__waiting">
          <span className="run-process-card__state">
            <ActivityIcon />
            <strong>等待中</strong>
            <small>等待前一轮成功完成，尚未开始运行</small>
          </span>
        </div>
      </section>
    );
  }

  const countSummary = activityCountSummary(
    analysisAndToolActivityCounts(events),
  );
  const connectionPresentation = runEventConnectionPresentation(
    connectionState,
  );
  const duration = formatRunDuration(run, now);
  const terminalLabel = status === "reconciliation_required" && run.cancelRequestedAt !== null
    ? "已停止"
    : statusNames[status];
  const headline = status === "completed"
    ? `思考了 ${duration}`
    : status === "queued"
      ? `${isStopping ? "正在停止" : "排队中"} · ${duration}`
      : status === "running"
        ? `${isStopping ? "正在停止" : "正在思考"} · ${duration}`
      : terminalStatuses.has(status)
        ? `思考了 ${duration} · ${terminalLabel}`
        : statusNames[status];
  const attentionConnection =
    connectionPresentation !== null &&
    (connectionPresentation.tone === "warning" ||
      connectionPresentation.tone === "danger")
      ? connectionPresentation
      : null;
  const inlineActivityId = `run-${run.id}-inline-activity`;
  const inlineEmptyMessage =
    status === "queued" || status === "running"
      ? "分析、搜索和工具活动会实时显示在这里"
      : "这次运行没有保存可展示的分析、搜索或工具活动";

  return (
    <section className={`run-process-card run-process-card--${status}`}>
      <details
        className="run-process-card__disclosure"
        onToggle={(event) => {
          const nextIsInlineOpen = event.currentTarget.open;
          setIsInlineOpen(nextIsInlineOpen);
          if (nextIsInlineOpen) {
            onOpenActivity(run.id, "inline");
          }
        }}
        open={isInlineOpen}
      >
        <summary
          aria-controls={isInlineOpen ? inlineActivityId : undefined}
          aria-expanded={isInlineOpen}
          aria-label={`${isInlineOpen ? "收起" : "展开"}${headline}的思考与工具活动`}
          className="run-process-card__toggle"
        >
          <span className="run-process-card__state">
            <ActivityIcon />
            <strong>{headline}</strong>
            <small>{countSummary}</small>
            {attentionConnection === null ? null : (
              <span
                className={`run-process-card__connection run-process-card__connection--${attentionConnection.tone}`}
              >
                {attentionConnection.label}
              </span>
            )}
          </span>
          <span aria-hidden="true" className="run-process-card__chevron">
            <span>过程</span>
            <ChevronDownIcon />
          </span>
        </summary>
        {isInlineOpen ? (
          <div className="run-process-card__content" id={inlineActivityId}>
            <div className="run-process-card__content-heading">
              <span>
                <strong>思考与工具活动</strong>
                <small>这里显示最近 4 项，完整记录保留在活动面板</small>
              </span>
              <button
                aria-controls="run-activity-panel"
                aria-expanded={isActivityPanelOpen}
                className="run-process-card__open-panel"
                onClick={() => onOpenActivity(run.id, "panel")}
                type="button"
              >
                <ExternalLinkIcon />
                查看完整活动
              </button>
            </div>
            {attentionConnection === null ? null : (
              <p className="run-process-card__notice">
                {attentionConnection.detail}
              </p>
            )}
            <div className="run-process-card__timeline">
              <ActivityTimeline
                compact
                emptyMessage={inlineEmptyMessage}
                events={events}
                variant="analysis_and_tools"
              />
            </div>
          </div>
        ) : null}
      </details>
      {attentionConnection === null ? null : (
        <span
          className="visually-hidden"
          role={attentionConnection.tone === "danger" ? "alert" : "status"}
        >
          {attentionConnection.label}：{attentionConnection.detail}
        </span>
      )}
    </section>
  );
}

export function RunActivityPanel({
  run,
  events,
  isOpen,
  detailState,
  onClose,
  onRetryLoad,
  onRetryConnection,
  connectionState,
  replayState,
  returnFocusRef,
}: {
  run: AgentRun | null;
  events: RunEvent[];
  isOpen: boolean;
  detailState: RunActivityDetailState;
  onClose: () => void;
  onRetryLoad: () => void;
  onRetryConnection: (runId: string) => void;
  connectionState: RunEventConnectionState;
  replayState: RunEventReplayState;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  const status = run === null ? null : effectiveRunStatus(run, events);
  const isStopping =
    run !== null && runCancellationIsPending(run, false);
  const now = useDurationNow(status ?? "completed");
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const scrollPositionsRef = useRef(
    new Map<string, ConversationScrollSnapshot>(),
  );
  const pendingScrollRestoreRef = useRef<{
    runId: string;
    scrollTop: number;
  } | null>(null);
  const scrollRunId = run?.id ?? null;
  const hasScrollContainer = status !== null && status !== "waiting";
  const isNarrowViewport = useSyncExternalStore(
    subscribeToNarrowRunActivityPanel,
    narrowRunActivityPanelSnapshot,
    () => false,
  );
  const isModalOpen = runActivityPanelIsModal(isOpen, isNarrowViewport);

  useModalFocus({
    backdropRef,
    canClose: true,
    containerRef: panelRef,
    enabled: isModalOpen,
    initialFocusRef: closeButtonRef,
    onClose,
    returnFocusRef,
  });

  useEffect(() => {
    if (!isOpen || isModalOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      closeDesktopPanelAndRestoreFocus(
        onClose,
        returnFocusRef?.current ?? null,
      );
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isModalOpen, isOpen, onClose, returnFocusRef]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!isOpen || scrollRunId === null || container === null) {
      return;
    }
    const scrollPositions = scrollPositionsRef.current;

    restoreRunActivityScrollPosition(
      scrollPositions,
      scrollRunId,
      container,
    );
    pendingScrollRestoreRef.current = {
      runId: scrollRunId,
      scrollTop: container.scrollTop,
    };
    if (!scrollPositions.has(scrollRunId)) {
      rememberRunActivityScrollPosition(
        scrollPositions,
        scrollRunId,
        container,
      );
    }
  }, [hasScrollContainer, isOpen, scrollRunId]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!isOpen || scrollRunId === null || container === null) {
      return;
    }
    if (
      followLatestRunActivity(
        scrollPositionsRef.current,
        scrollRunId,
        container,
      )
    ) {
      pendingScrollRestoreRef.current = {
        runId: scrollRunId,
        scrollTop: container.scrollTop,
      };
    }
  }, [events, hasScrollContainer, isOpen, scrollRunId]);

  if (status === "waiting" && events.length !== 0) {
    throw new Error(`等待中的 Run ${run?.id ?? "unknown"} 不应包含活动事件`);
  }
  if (detailState.phase !== "ready" && run !== null) {
    throw new Error("运行详情尚未就绪时不应包含 Run");
  }
  const headline =
    isStopping
      ? "正在停止"
      : status === null || terminalStatuses.has(status)
      ? status === null
        ? null
        : status === "reconciliation_required" && run !== null && run.cancelRequestedAt !== null
          ? "已停止"
          : statusNames[status]
      : latestStatusMessage(events) ?? statusNames[status];
  const connectionPresentation = runEventConnectionPresentation(
    connectionState,
  );
  const executionProfileLabel =
    run?.executionConfig.provenance === "captured"
      ? run.executionConfig.profileLabel
      : run === null
        ? null
        : "旧版配置未知";
  const panelMeta =
    detailState.phase === "loading"
      ? "正在载入运行活动"
      : detailState.phase === "failed"
        ? "运行活动载入失败"
        : run === null || status === null
          ? "当前研究"
          : status === "waiting"
            ? `${executionProfileLabel} · 等待前一轮运行`
            : `${executionProfileLabel} · ${headline} · ${formatRunDuration(run, now)} · ${activityEventCount(events)} 项活动`;
  const emptyMessage =
    connectionState.phase === "connecting"
      ? connectionState.mode === "follow"
        ? "正在连接运行活动…"
        : "正在载入运行活动…"
      : connectionState.phase === "connected"
        ? connectionState.mode === "follow"
          ? "已连接，正在等待新的运行活动…"
          : "已连接，正在读取运行活动…"
        : connectionState.phase === "reconnecting"
          ? "页面连接中断，正在从断点重新连接…"
          : connectionState.phase === "failed"
            ? "页面未能载入运行活动"
            : replayState === "replaying"
      ? "正在载入运行活动…"
      : status !== null && terminalStatuses.has(status)
        ? "这次运行没有保存可展示的活动"
        : "运行活动会实时显示在这里";

  return (
    <>
      <div
        aria-hidden="true"
        className={`activity-backdrop${isModalOpen ? " activity-backdrop--visible" : ""}`}
        data-modal-layer={isModalOpen ? "" : undefined}
        onMouseDown={(event) =>
          closeRunActivityPanelFromBackdrop(event, onClose)
        }
        ref={backdropRef}
      />
      <aside
        aria-hidden={!isOpen}
        aria-label="运行活动"
        aria-modal={isModalOpen ? "true" : undefined}
        aria-busy={detailState.phase === "loading" || undefined}
        className={`activity-panel${isOpen ? " activity-panel--open" : ""}`}
        id="run-activity-panel"
        inert={!isOpen}
        ref={panelRef}
        role={isModalOpen ? "dialog" : undefined}
        tabIndex={isModalOpen ? -1 : undefined}
      >
      <header className="activity-panel__header">
        <span className="activity-panel__title">
          <ActivityIcon />
          <span>
            <strong>活动</strong>
            <small>{panelMeta}</small>
          </span>
        </span>
        <button
          aria-label="关闭活动面板"
          className="icon-button"
          onClick={() =>
            closeRunActivityPanelFromButton(
              isModalOpen,
              onClose,
              returnFocusRef?.current ?? null,
            )
          }
          ref={closeButtonRef}
          type="button"
        >
          <CloseIcon />
        </button>
      </header>

      {detailState.phase === "loading" ? (
        <div className="activity-panel__blank" role="status">
          <ActivityIcon />
          <strong>正在载入运行活动</strong>
          <p>正在打开目标对话并读取这次运行的活动记录。</p>
        </div>
      ) : detailState.phase === "failed" ? (
        <div className="activity-panel__blank" role="alert">
          <AlertIcon />
          <strong>暂时无法载入运行活动</strong>
          <p>{detailState.message}</p>
          <button
            className="terminal-run-notice__retry"
            onClick={onRetryLoad}
            type="button"
          >
            <RefreshIcon />
            重新载入
          </button>
        </div>
      ) : run === null || status === null ? (
        <div className="activity-panel__blank">
          <ActivityIcon />
          <strong>还没有运行活动</strong>
          <p>开始一项研究后，分析摘要、搜索和工具执行会显示在这里。</p>
        </div>
      ) : status === "waiting" ? (
        <div className="activity-panel__blank activity-panel__blank--waiting">
          <ActivityIcon />
          <strong>尚未开始运行</strong>
          <p>这轮研究正在等待前一轮完成，目前没有可展示的活动。</p>
        </div>
      ) : (
        <>
          {connectionPresentation === null ||
          (connectionPresentation.tone !== "warning" &&
            connectionPresentation.tone !== "danger") ? null : (
            <div
              className={`activity-panel__connection activity-panel__connection--${connectionPresentation.tone}`}
              role={
                connectionPresentation.tone === "danger" ? "alert" : "status"
              }
            >
              <span className="activity-panel__connection-copy">
                <strong>{connectionPresentation.label}</strong>
                <small>{connectionPresentation.detail}</small>
              </span>
              {connectionState.phase === "failed" ? (
                <button
                  onClick={() => onRetryConnection(run.id)}
                  type="button"
                >
                  <RefreshIcon />
                  重试连接
                </button>
              ) : null}
            </div>
          )}
          <details className="activity-panel__notice">
            <summary>
              <span>关于活动与思考过程</span>
              <ChevronDownIcon />
            </summary>
            <p>
              这里仅展示模型提供的分析摘要和真实工具活动，不展示或伪造隐藏思维链。
            </p>
          </details>
          <div
            className="activity-panel__scroll"
            onScroll={(event) => {
              if (scrollRunId !== null) {
                const pendingRestore = pendingScrollRestoreRef.current;
                if (
                  pendingRestore !== null &&
                  pendingRestore.runId === scrollRunId &&
                  pendingRestore.scrollTop === event.currentTarget.scrollTop
                ) {
                  pendingScrollRestoreRef.current = null;
                  return;
                }
                pendingScrollRestoreRef.current = null;
                rememberRunActivityScrollPosition(
                  scrollPositionsRef.current,
                  scrollRunId,
                  event.currentTarget,
                );
              }
            }}
            ref={scrollContainerRef}
          >
            <ActivityTimeline emptyMessage={emptyMessage} events={events} />
          </div>
        </>
      )}
      </aside>
    </>
  );
}
