import { ApiClientError } from "@/components/api-client";
import type { ChatRequest } from "@/lib/contracts";

export const staleParentRecoveryMessage =
  "对话分支已更新，草稿和附件已保留，请确认后重新发送。";
export const staleParentRecoveryFailedMessage =
  "检测到对话分支已变化，但刷新失败。草稿和附件已保留，请先重试加载会话，再重新发送。";

export type ChatSubmissionFailureRecovery = {
  pendingRequest: ChatRequest | undefined;
  reloadConversationId: string | null;
  shouldHandle: boolean;
};

export type ChatSubmissionFailureRecoveryExecution =
  | "not_requested"
  | "reloaded"
  | "superseded"
  | "failed"
  | "not_found"
  | "revision_changed";

export function shouldActivateCreatedConversation(input: {
  requestedConversationId: string | null;
  activeConversationId: string | null;
}): boolean {
  return (
    input.requestedConversationId === null &&
    input.activeConversationId === null
  );
}

export function chatRequestsHaveSamePayload(
  left: ChatRequest,
  right: ChatRequest,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "edit") {
    if (right.kind !== "edit" || left.sourceMessageId !== right.sourceMessageId) {
      return false;
    }
  } else if (right.kind !== "append") {
    return false;
  }
  return (
    left.conversationId === right.conversationId &&
    left.parentRunId === right.parentRunId &&
    left.executionProfileId === right.executionProfileId &&
    left.message === right.message &&
    left.attachmentIds.length === right.attachmentIds.length &&
    left.attachmentIds.every(
      (attachmentId, position) =>
        attachmentId === right.attachmentIds[position],
    )
  );
}

export function shouldRetainPendingChatRequest(error: unknown): boolean {
  return !(
    error instanceof ApiClientError &&
    error.status >= 400 &&
    error.status < 500
  );
}

export function isStaleParentChatError(
  error: unknown,
): error is ApiClientError {
  return (
    error instanceof ApiClientError &&
    error.status === 409 &&
    error.code === "STALE_PARENT"
  );
}

export function chatSubmissionFailureRecovery(input: {
  conversationId: string | null;
  error: unknown;
  pendingRequest: ChatRequest | undefined;
  submittedRequestId: string;
}): ChatSubmissionFailureRecovery {
  const submittedRequestIsStillPending =
    input.pendingRequest?.requestId === input.submittedRequestId;
  if (!submittedRequestIsStillPending) {
    return {
      pendingRequest: input.pendingRequest,
      reloadConversationId: null,
      shouldHandle: false,
    };
  }

  const pendingRequest =
    !shouldRetainPendingChatRequest(input.error)
      ? undefined
      : input.pendingRequest;
  const isStaleParent = isStaleParentChatError(input.error);

  return {
    pendingRequest,
    reloadConversationId: isStaleParent ? input.conversationId : null,
    shouldHandle: true,
  };
}

export async function executeChatSubmissionFailureRecovery(
  recovery: ChatSubmissionFailureRecovery,
  loadConversation: (conversationId: string) => Promise<{
    status:
      | "loaded"
      | "superseded"
      | "failed"
      | "not_found"
      | "revision_changed";
  }>,
): Promise<ChatSubmissionFailureRecoveryExecution> {
  if (recovery.reloadConversationId === null) {
    return "not_requested";
  }
  const result = await loadConversation(recovery.reloadConversationId);
  return result.status === "loaded" ? "reloaded" : result.status;
}

export function reconcilePendingChatRequestAfterConfirmedAttachmentDeletion(
  pendingRequest: ChatRequest | undefined,
  deletedAttachmentId: string,
): ChatRequest | undefined {
  if (
    pendingRequest === undefined ||
    !pendingRequest.attachmentIds.includes(deletedAttachmentId)
  ) {
    return pendingRequest;
  }
  return undefined;
}

export function reconcilePendingChatRequestStoreAfterConfirmedAttachmentDeletion(
  pendingRequests: Map<string, ChatRequest>,
  requestKey: string,
  deletedAttachmentId: string,
): boolean {
  const pendingRequest = pendingRequests.get(requestKey);
  const reconciledPendingRequest =
    reconcilePendingChatRequestAfterConfirmedAttachmentDeletion(
      pendingRequest,
      deletedAttachmentId,
    );
  if (
    pendingRequest === undefined ||
    reconciledPendingRequest !== undefined
  ) {
    return false;
  }
  return pendingRequests.delete(requestKey);
}
