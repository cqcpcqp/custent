import {
  ApiClientError,
  ApiNetworkError,
} from "@/components/api-client";
import { RunEventStreamInterruptedError } from "@/components/chat-stream";

const initialRetryDelayMs = 800;
const maximumRetryDelayMs = 8_000;

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

export function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function isTransientApiError(error: unknown): boolean {
  return (
    error instanceof ApiNetworkError ||
    error instanceof TypeError ||
    (error instanceof ApiClientError &&
      (error.status === 408 || error.status === 429 || error.status >= 500))
  );
}

export function isRetryableRunEventError(error: unknown): boolean {
  return (
    error instanceof RunEventStreamInterruptedError ||
    isTransientApiError(error)
  );
}

export function runEventRetryDelayMs(consecutiveFailures: number): number {
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 1) {
    throw new TypeError("consecutiveFailures must be a positive integer");
  }
  return Math.min(
    initialRetryDelayMs * 2 ** (consecutiveFailures - 1),
    maximumRetryDelayMs,
  );
}
