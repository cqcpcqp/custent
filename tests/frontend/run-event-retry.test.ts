import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiClientError,
  ApiNetworkError,
} from "@/components/api-client";
import {
  RunEventProtocolError,
  RunEventStreamInterruptedError,
} from "@/components/chat-stream";
import {
  abortableDelay,
  isRetryableRunEventError,
  isTransientApiError,
  runEventRetryDelayMs,
} from "@/components/run-event-retry";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("run event retry policy", () => {
  it("retries network failures, transient HTTP responses and truncated streams", () => {
    expect(isTransientApiError(new TypeError("network unavailable"))).toBe(true);
    expect(isTransientApiError(new ApiNetworkError())).toBe(true);
    expect(isTransientApiError(new ApiClientError("INTERNAL", "retry", 500))).toBe(
      true,
    );
    expect(isTransientApiError(new ApiClientError("RATE_LIMIT", "retry", 429))).toBe(
      true,
    );
    expect(
      isRetryableRunEventError(
        new RunEventStreamInterruptedError("incomplete terminal frame"),
      ),
    ).toBe(true);
  });

  it("fails closed for request and protocol contract errors", () => {
    expect(isTransientApiError(new ApiClientError("NOT_FOUND", "stop", 404))).toBe(
      false,
    );
    expect(
      isRetryableRunEventError(new RunEventProtocolError("invalid event schema")),
    ).toBe(false);
    expect(isRetryableRunEventError(new Error("unknown failure"))).toBe(false);
  });

  it("uses deterministic capped exponential backoff", () => {
    expect([1, 2, 3, 4, 5, 6].map(runEventRetryDelayMs)).toEqual([
      800,
      1_600,
      3_200,
      6_400,
      8_000,
      8_000,
    ]);
    expect(() => runEventRetryDelayMs(0)).toThrow(TypeError);
  });

  it("already-aborted delays reject immediately without installing a timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();

    await expect(abortableDelay(800, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes the abort listener when the delay resolves", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const delay = abortableDelay(800, controller.signal);
    const listener = addListener.mock.calls[0]?.[1];
    if (listener === undefined) {
      throw new Error("abort listener was not installed");
    }

    await vi.advanceTimersByTimeAsync(800);
    await expect(delay).resolves.toBeUndefined();
    expect(removeListener).toHaveBeenCalledWith("abort", listener);
  });

  it("clears the timer and removes the listener when aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const delay = abortableDelay(800, controller.signal);
    const listener = addListener.mock.calls[0]?.[1];
    if (listener === undefined) {
      throw new Error("abort listener was not installed");
    }

    controller.abort();
    await expect(delay).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", listener);
  });
});
