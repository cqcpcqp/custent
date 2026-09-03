import { describe, expect, it } from "vitest";

import {
  beginBootstrapRevalidation,
  initialBootstrapRevalidationQueueState,
  isWorkspaceCrossTabMessage,
  planBootstrapRevalidationRequest,
  requestBootstrapRevalidation,
  settleBootstrapRevalidation,
  workspaceBootstrapChangedMessage,
} from "@/components/workspace-cross-tab-sync";

describe("workspace cross-tab sync", () => {
  it("keeps a pre-bootstrap full invalidation dirty until initialization", () => {
    const beforeBootstrap = planBootstrapRevalidationRequest({
      state: initialBootstrapRevalidationQueueState,
      requestKind: "full",
      bootstrapIsReady: false,
      hasScheduledOrRunningRequest: false,
    });

    expect(beforeBootstrap).toEqual({
      state: { requested: "full", consecutiveFailures: 0 },
      shouldSchedule: false,
    });
    const afterInitialization = planBootstrapRevalidationRequest({
      state: beforeBootstrap.state,
      requestKind: "full",
      bootstrapIsReady: true,
      hasScheduledOrRunningRequest: false,
    });
    expect(afterInitialization.shouldSchedule).toBe(true);
    expect(
      settleBootstrapRevalidation(
        beginBootstrapRevalidation(afterInitialization.state),
        "full",
        "success",
      ),
    ).toEqual(initialBootstrapRevalidationQueueState);
  });

  it("keeps a transiently failed request dirty with its exact kind", () => {
    const started = beginBootstrapRevalidation(
      requestBootstrapRevalidation(
        initialBootstrapRevalidationQueueState,
        "background_poll",
      ),
    );

    expect(
      settleBootstrapRevalidation(
        started,
        "background_poll",
        "retryable_failure",
      ),
    ).toEqual({ requested: "background_poll", consecutiveFailures: 1 });
  });

  it("retains a newer invalidation that arrives while a request runs", () => {
    const started = beginBootstrapRevalidation(
      requestBootstrapRevalidation(
        initialBootstrapRevalidationQueueState,
        "full",
      ),
    );
    const requestedWhileRunning = requestBootstrapRevalidation(
      started,
      "full",
    );

    expect(
      settleBootstrapRevalidation(
        requestedWhileRunning,
        "full",
        "success",
      ),
    ).toEqual({ requested: "full", consecutiveFailures: 0 });
  });

  it("always gives full revalidation priority over a background poll", () => {
    const poll = requestBootstrapRevalidation(
      initialBootstrapRevalidationQueueState,
      "background_poll",
    );
    const full = requestBootstrapRevalidation(poll, "full");
    const duplicatePoll = requestBootstrapRevalidation(
      full,
      "background_poll",
    );

    expect(full).toEqual({ requested: "full", consecutiveFailures: 0 });
    expect(duplicatePoll).toBe(full);
  });

  it("does not let a failed poll replace a full request queued during it", () => {
    const runningPoll = beginBootstrapRevalidation(
      requestBootstrapRevalidation(
        initialBootstrapRevalidationQueueState,
        "background_poll",
      ),
    );
    const fullQueuedDuringPoll = requestBootstrapRevalidation(
      runningPoll,
      "full",
    );

    expect(
      settleBootstrapRevalidation(
        fullQueuedDuringPoll,
        "background_poll",
        "retryable_failure",
      ),
    ).toEqual({ requested: "full", consecutiveFailures: 1 });
  });

  it("clears backoff after a settled success without dropping queued work", () => {
    expect(
      settleBootstrapRevalidation(
        { requested: "full", consecutiveFailures: 3 },
        "background_poll",
        "success",
      ),
    ).toEqual({ requested: "full", consecutiveFailures: 0 });
  });

  it("rejects starting an empty queue", () => {
    expect(() =>
      beginBootstrapRevalidation(initialBootstrapRevalidationQueueState),
    ).toThrow("没有待处理的 bootstrap revalidation 请求");
  });

  it("recognizes only the fixed bootstrap revalidation signal", () => {
    expect(
      isWorkspaceCrossTabMessage(workspaceBootstrapChangedMessage),
    ).toBe(true);
    expect(
      isWorkspaceCrossTabMessage({ type: "bootstrap_changed", version: 1 }),
    ).toBe(true);
    expect(isWorkspaceCrossTabMessage(null)).toBe(false);
    expect(isWorkspaceCrossTabMessage("bootstrap_changed")).toBe(false);
    expect(
      isWorkspaceCrossTabMessage({ type: "bootstrap_changed", version: 2 }),
    ).toBe(false);
  });
});
