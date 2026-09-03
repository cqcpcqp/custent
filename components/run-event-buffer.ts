import type { RunEvent } from "@/lib/contracts";

export type BufferedRunEvent = Readonly<{
  event: RunEvent;
  feedbackDataRevision: number;
}>;

export type RunEventCursorSnapshot = Readonly<{
  observedEventId: string | null;
  committedEventId: string | null;
}>;

type RunEventFrameBufferOptions = {
  runId: string;
  initialCommittedEventId: string | null;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  onFlush: (events: readonly BufferedRunEvent[]) => boolean;
};

function parseEventId(eventId: string, label: string): bigint {
  if (!/^\d+$/u.test(eventId)) {
    throw new TypeError(`${label} 必须是无符号整数字符串`);
  }
  return BigInt(eventId);
}

function isTerminalEvent(event: RunEvent): boolean {
  return event.payload.type === "done" || event.payload.type === "error";
}

export class RunEventFrameBuffer {
  readonly runId: string;

  private observedEventId: string | null;
  private committedEventId: string | null;
  private readonly requestFrame: RunEventFrameBufferOptions["requestFrame"];
  private readonly cancelFrame: RunEventFrameBufferOptions["cancelFrame"];
  private readonly onFlush: RunEventFrameBufferOptions["onFlush"];
  private pending: BufferedRunEvent[] = [];
  private frameHandle: number | null = null;

  constructor(options: RunEventFrameBufferOptions) {
    if (options.initialCommittedEventId !== null) {
      parseEventId(options.initialCommittedEventId, "initialCommittedEventId");
    }
    this.runId = options.runId;
    this.observedEventId = options.initialCommittedEventId;
    this.committedEventId = options.initialCommittedEventId;
    this.requestFrame = options.requestFrame;
    this.cancelFrame = options.cancelFrame;
    this.onFlush = options.onFlush;
  }

  beginSubscription(): string | null {
    this.discardPending();
    this.observedEventId = this.committedEventId;
    return this.observedEventId;
  }

  observe(
    observation: BufferedRunEvent,
    commitToReact: boolean,
  ): RunEventCursorSnapshot {
    const { event, feedbackDataRevision } = observation;
    if (event.runId !== this.runId) {
      throw new TypeError(
        `Run ${this.runId} 的缓冲区收到了另一个 Run ${event.runId} 的事件`,
      );
    }
    if (
      !Number.isSafeInteger(feedbackDataRevision) ||
      feedbackDataRevision < 1
    ) {
      throw new TypeError("feedbackDataRevision 必须是正安全整数");
    }

    const eventId = parseEventId(event.id, "event.id");
    if (
      this.observedEventId !== null &&
      eventId <= parseEventId(this.observedEventId, "observedEventId")
    ) {
      throw new TypeError(
        `Run ${this.runId} 事件序号没有严格递增：${this.observedEventId} -> ${event.id}`,
      );
    }
    this.observedEventId = event.id;

    if (commitToReact) {
      this.pending.push(observation);
      if (isTerminalEvent(event)) {
        this.flush();
      } else {
        this.scheduleFlush();
      }
    }

    return this.snapshot();
  }

  flush(): void {
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
    if (this.pending.length === 0) {
      return;
    }

    const pending = this.pending;
    this.pending = [];
    if (!this.onFlush(pending)) {
      return;
    }
    this.committedEventId = pending[pending.length - 1].event.id;
  }

  discardPending(): void {
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.pending = [];
  }

  destroy(): void {
    this.discardPending();
  }

  snapshot(): RunEventCursorSnapshot {
    return {
      observedEventId: this.observedEventId,
      committedEventId: this.committedEventId,
    };
  }

  private scheduleFlush(): void {
    if (this.frameHandle !== null) {
      return;
    }
    this.frameHandle = this.requestFrame(() => {
      this.frameHandle = null;
      this.flush();
    });
  }
}
