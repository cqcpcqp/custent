import type {
  BootstrapResponse,
  ConversationSummary,
  ConversationResponse,
} from "@/lib/contracts";

export type TerminalRefreshSource = "conversation" | "bootstrap";

type TerminalRefreshOptions = {
  signal: AbortSignal;
  isCurrent: () => boolean;
  shouldRefreshBootstrap: () => boolean;
  loadConversation: (signal: AbortSignal) => Promise<ConversationResponse>;
  loadBootstrap: (signal: AbortSignal) => Promise<BootstrapResponse>;
  commitConversation: (detail: ConversationResponse) => void;
  commitBootstrap: (bootstrap: BootstrapResponse) => void;
  isRetryable: (error: unknown) => boolean;
  waitBeforeRetry: (
    source: TerminalRefreshSource,
    consecutiveFailures: number,
    signal: AbortSignal,
  ) => Promise<void>;
  onPermanentFailure: (
    source: TerminalRefreshSource,
    error: unknown,
  ) => void;
};

function terminalRefreshIsCurrent(
  signal: AbortSignal,
  isCurrent: () => boolean,
): boolean {
  return !signal.aborted && isCurrent();
}

async function retryTerminalRefreshRequest<T>(input: {
  source: TerminalRefreshSource;
  signal: AbortSignal;
  isCurrent: () => boolean;
  load: (signal: AbortSignal) => Promise<T>;
  commit: (value: T) => void;
  isRetryable: (error: unknown) => boolean;
  waitBeforeRetry: TerminalRefreshOptions["waitBeforeRetry"];
  onPermanentFailure: TerminalRefreshOptions["onPermanentFailure"];
}): Promise<void> {
  let consecutiveFailures = 0;

  while (terminalRefreshIsCurrent(input.signal, input.isCurrent)) {
    let value: T;
    try {
      value = await input.load(input.signal);
    } catch (error) {
      if (!terminalRefreshIsCurrent(input.signal, input.isCurrent)) {
        return;
      }
      if (!input.isRetryable(error)) {
        input.onPermanentFailure(input.source, error);
        return;
      }

      consecutiveFailures += 1;
      try {
        await input.waitBeforeRetry(
          input.source,
          consecutiveFailures,
          input.signal,
        );
      } catch (waitError) {
        if (!terminalRefreshIsCurrent(input.signal, input.isCurrent)) {
          return;
        }
        throw waitError;
      }
      continue;
    }

    if (!terminalRefreshIsCurrent(input.signal, input.isCurrent)) {
      return;
    }
    input.commit(value);
    return;
  }
}

export async function refreshTerminalSources(
  options: TerminalRefreshOptions,
): Promise<void> {
  await Promise.all([
    retryTerminalRefreshRequest({
      source: "conversation",
      signal: options.signal,
      isCurrent: options.isCurrent,
      load: options.loadConversation,
      commit: options.commitConversation,
      isRetryable: options.isRetryable,
      waitBeforeRetry: options.waitBeforeRetry,
      onPermanentFailure: options.onPermanentFailure,
    }),
    retryTerminalRefreshRequest({
      source: "bootstrap",
      signal: options.signal,
      isCurrent: () =>
        options.isCurrent() && options.shouldRefreshBootstrap(),
      load: options.loadBootstrap,
      commit: options.commitBootstrap,
      isRetryable: options.isRetryable,
      waitBeforeRetry: options.waitBeforeRetry,
      onPermanentFailure: options.onPermanentFailure,
    }),
  ]);
}

export function mergeTerminalConversationSummary(
  current: ConversationSummary | undefined,
  incoming: ConversationSummary,
  terminalRunId: string,
): ConversationSummary {
  if (
    current?.activeRun !== null &&
    current?.activeRun !== undefined &&
    current.activeRun.id !== terminalRunId &&
    (incoming.activeRun === null || incoming.activeRun.id === terminalRunId)
  ) {
    return { ...incoming, activeRun: current.activeRun };
  }

  return incoming;
}
