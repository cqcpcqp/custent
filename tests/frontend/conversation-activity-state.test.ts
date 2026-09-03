import { describe, expect, it } from "vitest";

import {
  closedConversationActivityView,
  conversationActivityView,
  removeConversationActivityView,
  updateConversationActivityView,
} from "@/components/conversation-activity-state";

describe("conversation activity state", () => {
  it("starts closed without a selected run", () => {
    expect(conversationActivityView({}, "conversation-a")).toEqual(
      closedConversationActivityView,
    );
  });

  it("keeps panel open state and selected run isolated by conversation", () => {
    let views = updateConversationActivityView({}, "conversation-a", {
      isOpen: true,
      runId: "run-a",
    });
    views = updateConversationActivityView(views, "conversation-b", {
      runId: "run-b",
    });

    expect(conversationActivityView(views, "conversation-a")).toEqual({
      isOpen: true,
      runId: "run-a",
    });
    expect(conversationActivityView(views, "conversation-b")).toEqual({
      isOpen: false,
      runId: "run-b",
    });
  });

  it("updates a new run without closing an already open panel", () => {
    const open = updateConversationActivityView({}, "conversation-a", {
      isOpen: true,
      runId: "run-a",
    });
    const updated = updateConversationActivityView(open, "conversation-a", {
      runId: "run-a-next",
    });

    expect(conversationActivityView(updated, "conversation-a")).toEqual({
      isOpen: true,
      runId: "run-a-next",
    });
  });

  it("removes only the deleted conversation memory", () => {
    const views = {
      "conversation-a": { isOpen: true, runId: "run-a" },
      "conversation-b": { isOpen: false, runId: "run-b" },
    };

    expect(removeConversationActivityView(views, "conversation-a")).toEqual({
      "conversation-b": { isOpen: false, runId: "run-b" },
    });
  });
});
