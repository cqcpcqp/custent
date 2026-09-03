import { describe, expect, it, vi } from "vitest";

import { ApiClientError } from "@/components/api-client";
import {
  chatSubmissionFailureRecovery,
  chatRequestsHaveSamePayload,
  executeChatSubmissionFailureRecovery,
  isStaleParentChatError,
  reconcilePendingChatRequestAfterConfirmedAttachmentDeletion,
  reconcilePendingChatRequestStoreAfterConfirmedAttachmentDeletion,
  shouldActivateCreatedConversation,
  shouldRetainPendingChatRequest,
  staleParentRecoveryFailedMessage,
  staleParentRecoveryMessage,
} from "@/components/chat-submission-state";
import type { ChatRequest } from "@/lib/contracts";

const request: Extract<ChatRequest, { kind: "append" }> = {
  kind: "append",
  conversationId: "10000000-0000-4000-8000-000000000001",
  parentRunId: "20000000-0000-4000-8000-000000000010",
  message: "分析附件",
  attachmentIds: [
    "20000000-0000-4000-8000-000000000001",
    "30000000-0000-4000-8000-000000000001",
  ],
  requestId: "40000000-0000-4000-8000-000000000001",
  executionProfileId: "standard_research",
};

const editRequest: Extract<ChatRequest, { kind: "edit" }> = {
  kind: "edit",
  conversationId: "10000000-0000-4000-8000-000000000001",
  parentRunId: request.parentRunId,
  sourceMessageId: "60000000-0000-4000-8000-000000000001",
  message: request.message,
  attachmentIds: request.attachmentIds,
  requestId: request.requestId,
  executionProfileId: "standard_research",
};

describe("pending chat submission state", () => {
  it("新会话响应只有在用户仍停留于新会话时才接管路由", () => {
    expect(
      shouldActivateCreatedConversation({
        requestedConversationId: null,
        activeConversationId: null,
      }),
    ).toBe(true);
    expect(
      shouldActivateCreatedConversation({
        requestedConversationId: null,
        activeConversationId:
          "10000000-0000-4000-8000-000000000001",
      }),
    ).toBe(false);
  });

  it("reuses a request ID only for the exact conversation, text, and ordered attachments", () => {
    expect(
      chatRequestsHaveSamePayload(request, {
        ...request,
        requestId: "50000000-0000-4000-8000-000000000001",
      }),
    ).toBe(true);
    expect(
      chatRequestsHaveSamePayload(request, {
        ...request,
        conversationId: null,
        parentRunId: null,
      }),
    ).toBe(false);
    expect(
      chatRequestsHaveSamePayload(request, {
        ...request,
        message: "分析另一份附件",
      }),
    ).toBe(false);
    expect(
      chatRequestsHaveSamePayload(request, {
        ...request,
        attachmentIds: [...request.attachmentIds].reverse(),
      }),
    ).toBe(false);
    expect(
      chatRequestsHaveSamePayload(request, {
        ...request,
        executionProfileId: "pro_research",
      }),
    ).toBe(false);
    expect(
      chatRequestsHaveSamePayload(request, {
        ...request,
        parentRunId: "20000000-0000-4000-8000-000000000011",
      }),
    ).toBe(false);
  });

  it("strictly compares edit discriminant and sourceMessageId", () => {
    expect(
      chatRequestsHaveSamePayload(editRequest, {
        ...editRequest,
        requestId: "50000000-0000-4000-8000-000000000001",
      }),
    ).toBe(true);
    expect(chatRequestsHaveSamePayload(request, editRequest)).toBe(false);
    expect(
      chatRequestsHaveSamePayload(editRequest, {
        ...editRequest,
        sourceMessageId: "60000000-0000-4000-8000-000000000002",
      }),
    ).toBe(false);
  });

  it("retains ambiguous network, protocol, and server failures but releases definitive 4xx failures", () => {
    expect(shouldRetainPendingChatRequest(new TypeError("fetch failed"))).toBe(
      true,
    );
    expect(
      shouldRetainPendingChatRequest(
        new ApiClientError("INTERNAL_ERROR", "服务器错误", 500),
      ),
    ).toBe(true);
    expect(
      shouldRetainPendingChatRequest(
        new ApiClientError("INVALID_REQUEST", "请求错误", 400),
      ),
    ).toBe(false);
    expect(
      shouldRetainPendingChatRequest(
        new ApiClientError("RUN_ALREADY_EXISTS", "请求冲突", 409),
      ),
    ).toBe(false);
  });

  it("recognizes STALE_PARENT only from the exact ApiClientError code and status", () => {
    expect(
      isStaleParentChatError(
        new ApiClientError("STALE_PARENT", "分支已变化", 409),
      ),
    ).toBe(true);
    expect(
      isStaleParentChatError(
        new ApiClientError("STALE_PARENT", "服务器错误", 500),
      ),
    ).toBe(false);
    expect(
      isStaleParentChatError(
        new ApiClientError("RUN_IN_PROGRESS", "请求冲突", 409),
      ),
    ).toBe(false);
    expect(isStaleParentChatError(new Error("STALE_PARENT"))).toBe(false);
  });

  it("drops only the submitted stale envelope and preserves a later request", () => {
    const staleError = new ApiClientError(
      "STALE_PARENT",
      "分支已变化",
      409,
    );
    const currentRecovery = chatSubmissionFailureRecovery({
      conversationId: request.conversationId,
      error: staleError,
      pendingRequest: request,
      submittedRequestId: request.requestId,
    });
    expect(currentRecovery).toEqual({
      pendingRequest: undefined,
      reloadConversationId: request.conversationId,
      shouldHandle: true,
    });

    const laterRequest: ChatRequest = {
      ...request,
      requestId: "50000000-0000-4000-8000-000000000001",
    };
    const lateRecovery = chatSubmissionFailureRecovery({
      conversationId: request.conversationId,
      error: staleError,
      pendingRequest: laterRequest,
      submittedRequestId: request.requestId,
    });
    expect(lateRecovery).toEqual({
      pendingRequest: laterRequest,
      reloadConversationId: null,
      shouldHandle: false,
    });
  });

  it("silently ignores a late failure after a later request becomes pending", async () => {
    const laterRequest: ChatRequest = {
      ...request,
      requestId: "50000000-0000-4000-8000-000000000001",
    };
    const loadConversation = vi.fn();
    const recovery = chatSubmissionFailureRecovery({
      conversationId: request.conversationId,
      error: new ApiClientError("STALE_PARENT", "分支已变化", 409),
      pendingRequest: laterRequest,
      submittedRequestId: request.requestId,
    });

    const execution = await executeChatSubmissionFailureRecovery(
      recovery,
      loadConversation,
    );

    expect(execution).toBe("not_requested");
    expect(loadConversation).not.toHaveBeenCalled();
    expect(recovery.pendingRequest).toBe(laterRequest);
  });

  it("retains the exact envelope for ambiguous failures without reloading", () => {
    for (const error of [
      new TypeError("fetch failed"),
      new ApiClientError("INTERNAL_ERROR", "服务器错误", 500),
    ]) {
      const recovery = chatSubmissionFailureRecovery({
        conversationId: request.conversationId,
        error,
        pendingRequest: request,
        submittedRequestId: request.requestId,
      });

      expect(recovery.pendingRequest).toBe(request);
      expect(recovery.reloadConversationId).toBeNull();
      expect(recovery.shouldHandle).toBe(true);
    }
  });

  it("performs one targeted stale reload without any automatic chat start", async () => {
    const localDraft = {
      attachments: request.attachmentIds,
      value: "  分析附件\n",
    };
    const loadConversation = vi.fn(async () => ({
      status: "loaded" as const,
    }));
    const automaticStartChat = vi.fn();
    const recovery = chatSubmissionFailureRecovery({
      conversationId: request.conversationId,
      error: new ApiClientError("STALE_PARENT", "分支已变化", 409),
      pendingRequest: request,
      submittedRequestId: request.requestId,
    });

    const execution = await executeChatSubmissionFailureRecovery(
      recovery,
      loadConversation,
    );

    expect(execution).toBe("reloaded");
    expect(loadConversation).toHaveBeenCalledTimes(1);
    expect(loadConversation).toHaveBeenCalledWith(request.conversationId);
    expect(automaticStartChat).not.toHaveBeenCalled();
    expect(localDraft).toEqual({
      attachments: request.attachmentIds,
      value: "  分析附件\n",
    });
  });

  it("reports revision-changed stale recovery after one reload without restarting chat", async () => {
    const loadConversation = vi.fn(async () => ({
      status: "revision_changed" as const,
    }));
    const automaticStartChat = vi.fn();
    const recovery = chatSubmissionFailureRecovery({
      conversationId: request.conversationId,
      error: new ApiClientError("STALE_PARENT", "分支已变化", 409),
      pendingRequest: request,
      submittedRequestId: request.requestId,
    });

    const execution = await executeChatSubmissionFailureRecovery(
      recovery,
      loadConversation,
    );

    expect(execution).toBe("revision_changed");
    expect(loadConversation).toHaveBeenCalledTimes(1);
    expect(loadConversation).toHaveBeenCalledWith(request.conversationId);
    expect(automaticStartChat).not.toHaveBeenCalled();
  });

  it("uses the same targeted recovery for an edit without changing its value", async () => {
    const editValue = { current: "  更新后的编辑内容\n" };
    const loadConversation = vi.fn(async () => ({
      status: "loaded" as const,
    }));
    const recovery = chatSubmissionFailureRecovery({
      conversationId: editRequest.conversationId,
      error: new ApiClientError("STALE_PARENT", "编辑分支已变化", 409),
      pendingRequest: editRequest,
      submittedRequestId: editRequest.requestId,
    });

    await executeChatSubmissionFailureRecovery(recovery, loadConversation);

    expect(recovery.pendingRequest).toBeUndefined();
    expect(loadConversation).toHaveBeenCalledTimes(1);
    expect(loadConversation).toHaveBeenCalledWith(editRequest.conversationId);
    expect(editValue.current).toBe("  更新后的编辑内容\n");
  });

  it.each([
    ["superseded", "superseded"],
    ["failed", "failed"],
    ["not_found", "not_found"],
    ["revision_changed", "revision_changed"],
  ] as const)(
    "keeps stale recovery status explicit when reload is %s",
    async (loadStatus, expectedExecution) => {
      const recovery = chatSubmissionFailureRecovery({
        conversationId: request.conversationId,
        error: new ApiClientError("STALE_PARENT", "分支已变化", 409),
        pendingRequest: request,
        submittedRequestId: request.requestId,
      });

      await expect(
        executeChatSubmissionFailureRecovery(recovery, async () => ({
          status: loadStatus,
        })),
      ).resolves.toBe(expectedExecution);
    },
  );

  it("keeps success and reload-failure user messages distinct", () => {
    expect(staleParentRecoveryMessage).not.toBe(
      staleParentRecoveryFailedMessage,
    );
  });

  it("clears a pending request only after its attachment is confirmed deleted", () => {
    expect(
      reconcilePendingChatRequestAfterConfirmedAttachmentDeletion(
        request,
        request.attachmentIds[0],
      ),
    ).toBeUndefined();
    expect(
      reconcilePendingChatRequestAfterConfirmedAttachmentDeletion(
        request,
        "70000000-0000-4000-8000-000000000001",
      ),
    ).toBe(request);
    expect(
      reconcilePendingChatRequestAfterConfirmedAttachmentDeletion(
        undefined,
        request.attachmentIds[0],
      ),
    ).toBeUndefined();
  });

  it("removes only the matching pending request from the keyed store", () => {
    const editKey = `edit:${editRequest.conversationId}:${editRequest.sourceMessageId}`;
    const otherKey = "__new_conversation__";
    const pendingRequests = new Map<string, ChatRequest>([
      [editKey, editRequest],
      [otherKey, request],
    ]);

    expect(
      reconcilePendingChatRequestStoreAfterConfirmedAttachmentDeletion(
        pendingRequests,
        editKey,
        editRequest.attachmentIds[0],
      ),
    ).toBe(true);
    expect(pendingRequests.has(editKey)).toBe(false);
    expect(pendingRequests.get(otherKey)).toBe(request);
    expect(
      reconcilePendingChatRequestStoreAfterConfirmedAttachmentDeletion(
        pendingRequests,
        otherKey,
        "70000000-0000-4000-8000-000000000001",
      ),
    ).toBe(false);
    expect(pendingRequests.get(otherKey)).toBe(request);
  });
});
