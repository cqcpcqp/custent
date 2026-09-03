import {
  AccountCustomInstructionsResponseSchema,
  AccountUsageResponseSchema,
  ApiErrorResponseSchema,
  BackgroundRunHistoryResponseSchema,
  BranchConversationResponseSchema,
  BootstrapResponseSchema,
  BulkConversationMutationResponseSchema,
  CancelRunResponseSchema,
  ChatStartResponseSchema,
  ConversationResponseSchema,
  CreateConversationResponseSchema,
  DeleteConversationResponseSchema,
  GetConversationShareResponseSchema,
  DeleteInputAttachmentResponseSchema,
  ListConversationSharesResponseSchema,
  ListConversationsResponseSchema,
  PatchMessageFeedbackResponseSchema,
  PatchConversationResponseSchema,
  PutConversationShareResponseSchema,
  RegenerateRunResponseSchema,
  RevokeConversationShareResponseSchema,
  RetryRunResponseSchema,
  UploadInputAttachmentResponseSchema,
  type AccountCustomInstructionsResponse,
  type AccountUsageResponse,
  type BackgroundRunHistoryResponse,
  type BackgroundRunHistoryStatusFilter,
  type BranchConversationRequest,
  type BranchConversationResponse,
  type BootstrapResponse,
  type BulkConversationMutationResponse,
  type CancelRunResponse,
  type ChatRequest,
  type ChatStartResponse,
  type ConversationListView,
  type ConversationResponse,
  type CreateConversationResponse,
  type DeleteConversationResponse,
  type GetConversationShareResponse,
  type DeleteInputAttachmentResponse,
  type ListConversationSharesResponse,
  type ListConversationsResponse,
  type MessageFeedback,
  type PatchConversationRequest,
  type PatchConversationResponse,
  type PutAccountCustomInstructionsRequest,
  type PutConversationShareResponse,
  type PatchMessageFeedbackResponse,
  type RegenerateRunRequest,
  type RegenerateRunResponse,
  type RevokeConversationShareResponse,
  type RetryRunRequest,
  type RetryRunResponse,
  type UploadInputAttachmentResponse,
} from "@/lib/contracts";
import type { AppErrorCode } from "@/lib/errors";

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, _serverMessage: string, status: number) {
    // The response message is part of the fixed wire contract, but it is not
    // a presentation contract. It may contain operational details from an
    // upstream failure, so keep only code/status for exact UI mapping.
    super("服务请求失败");
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
  }
}

export class ApiNetworkError extends Error {
  constructor() {
    super("网络请求失败");
    this.name = "ApiNetworkError";
  }
}

const apiErrorStatuses = {
  ACTIVE_RUN: [409],
  BRANCH_ALREADY_EXISTS: [409],
  CUSTOM_INSTRUCTIONS_REVISION_CONFLICT: [409],
  EMPTY_CONVERSATION: [409],
  INSUFFICIENT_CREDITS: [402],
  INTERNAL_ERROR: [500],
  INVALID_BRANCH_TARGET: [409],
  INVALID_EDIT: [409],
  INVALID_REQUEST: [400, 409, 413, 415],
  NOT_FOUND: [404],
  RUN_ALREADY_EXISTS: [409],
  RUN_CONTEXT_UNAVAILABLE: [409],
  RUN_IN_PROGRESS: [409],
  RUN_NOT_REGENERATABLE: [409],
  RUN_NOT_RETRYABLE: [409],
  RUN_REQUIRES_RECONCILIATION: [409],
  SHARE_NOT_FOUND: [404],
  STALE_PARENT: [409],
} as const satisfies Record<AppErrorCode, readonly number[]>;

type ApiErrorUserMessageKey = {
  [Code in keyof typeof apiErrorStatuses]: `${Code}\u0000${(typeof apiErrorStatuses)[Code][number]}`;
}[keyof typeof apiErrorStatuses];

const apiErrorUserMessages = {
  "ACTIVE_RUN\u0000409": "该对话仍有正在运行或等待中的任务，请稍后再试。",
  "BRANCH_ALREADY_EXISTS\u0000409":
    "这个分支请求已经处理，请刷新对话后重试。",
  "CUSTOM_INSTRUCTIONS_REVISION_CONFLICT\u0000409":
    "自定义指令已在其他页面更新，请重新加载后再保存。",
  "EMPTY_CONVERSATION\u0000409": "空对话暂时不能创建分享链接。",
  "INSUFFICIENT_CREDITS\u0000402": "可用积分不足，暂时无法开始这次研究。",
  "INTERNAL_ERROR\u0000500": "服务暂时无法完成这个请求，请稍后重试。",
  "INVALID_BRANCH_TARGET\u0000409":
    "只能从当前分支中已完成的回答创建新对话。",
  "INVALID_EDIT\u0000409": "这条消息已发生变化，请刷新对话后重试。",
  "INVALID_REQUEST\u0000400": "请求内容无效，请刷新后重试。",
  "INVALID_REQUEST\u0000409": "请求状态已发生变化，请刷新后重试。",
  "INVALID_REQUEST\u0000413": "附件超过了当前大小或数量限制。",
  "INVALID_REQUEST\u0000415": "附件格式不受支持或文件内容无效。",
  "NOT_FOUND\u0000404": "请求的内容不存在或已不可用。",
  "RUN_ALREADY_EXISTS\u0000409":
    "这个请求已经处理，请刷新对话查看最新状态。",
  "RUN_CONTEXT_UNAVAILABLE\u0000409":
    "这次运行的完整上下文不可用，暂时无法继续。",
  "RUN_IN_PROGRESS\u0000409":
    "该对话正在处理另一项任务，请稍后再试。",
  "RUN_NOT_REGENERATABLE\u0000409":
    "这条回答已不是最新可重新生成的版本，请刷新后重试。",
  "RUN_NOT_RETRYABLE\u0000409":
    "这次运行已不再支持重试，请刷新对话查看最新状态。",
  "RUN_REQUIRES_RECONCILIATION\u0000409":
    "这次运行需要先完成积分核对，暂时不能继续。",
  "SHARE_NOT_FOUND\u0000404": "分享链接不存在或已发生变化。",
  "STALE_PARENT\u0000409": "对话分支已更新，请刷新后重试。",
} as const satisfies Record<ApiErrorUserMessageKey, string>;

function apiErrorUserMessage(error: ApiClientError): string {
  const knownStatuses = Object.hasOwn(apiErrorStatuses, error.code)
    ? (apiErrorStatuses[error.code as AppErrorCode] as readonly number[])
    : undefined;
  if (knownStatuses === undefined || !knownStatuses.includes(error.status)) {
    throw new TypeError("API error code/status contract violation");
  }
  const key = `${error.code}\u0000${error.status}` as ApiErrorUserMessageKey;
  return apiErrorUserMessages[key];
}

export function assertApiClientErrorContract(error: ApiClientError): void {
  apiErrorUserMessage(error);
}

export function isApiAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function userFacingRequestErrorMessage(
  error: unknown,
  fallbackMessage: string,
): string {
  if (error instanceof ApiNetworkError) {
    return "网络连接失败，请检查网络后重试。";
  }
  if (error instanceof ApiClientError) {
    return apiErrorUserMessage(error);
  }
  return fallbackMessage;
}

export async function fetchApiResponse(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (isApiAbortError(error)) {
      throw error;
    }
    if (
      error instanceof TypeError ||
      (error instanceof DOMException && error.name === "NetworkError")
    ) {
      throw new ApiNetworkError();
    }
    throw error;
  }
}

async function throwApiError(response: Response): Promise<never> {
  const payload = ApiErrorResponseSchema.parse(await response.json());
  const error = new ApiClientError(
    payload.error.code,
    payload.error.message,
    response.status,
  );
  assertApiClientErrorContract(error);
  throw error;
}

export async function getBootstrap(
  signal?: AbortSignal,
): Promise<BootstrapResponse> {
  const response = await fetchApiResponse("/api/bootstrap", {
    method: "GET",
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    return throwApiError(response);
  }

  return BootstrapResponseSchema.parse(await response.json());
}

export async function getAccountUsage(
  input: {
    cursor: string | null;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<AccountUsageResponse> {
  const searchParams = new URLSearchParams({ limit: String(input.limit) });
  if (input.cursor !== null) {
    searchParams.set("cursor", input.cursor);
  }
  const response = await fetchApiResponse(
    `/api/account/usage?${searchParams.toString()}`,
    {
      method: "GET",
      cache: "no-store",
      signal,
    },
  );

  if (!response.ok) {
    return throwApiError(response);
  }

  return AccountUsageResponseSchema.parse(await response.json());
}

export async function getAccountCustomInstructions(
  signal?: AbortSignal,
): Promise<AccountCustomInstructionsResponse> {
  const response = await fetchApiResponse("/api/account/custom-instructions", {
    method: "GET",
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    return throwApiError(response);
  }

  return AccountCustomInstructionsResponseSchema.parse(await response.json());
}

export async function putAccountCustomInstructions(
  request: PutAccountCustomInstructionsRequest,
  signal?: AbortSignal,
): Promise<AccountCustomInstructionsResponse> {
  const response = await fetchApiResponse("/api/account/custom-instructions", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    return throwApiError(response);
  }

  return AccountCustomInstructionsResponseSchema.parse(await response.json());
}

export async function getBackgroundRunHistory(
  input: {
    status: BackgroundRunHistoryStatusFilter;
    cursor: string | null;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<BackgroundRunHistoryResponse> {
  const searchParams = new URLSearchParams({
    status: input.status,
    limit: String(input.limit),
  });
  if (input.cursor !== null) {
    searchParams.set("cursor", input.cursor);
  }
  const response = await fetchApiResponse(
    `/api/runs/history?${searchParams.toString()}`,
    {
      method: "GET",
      cache: "no-store",
      signal,
    },
  );

  if (!response.ok) {
    return throwApiError(response);
  }

  return BackgroundRunHistoryResponseSchema.parse(await response.json());
}

export async function getConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ConversationResponse> {
  const response = await fetchApiResponse(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
    {
      method: "GET",
      cache: "no-store",
      signal,
    },
  );

  if (!response.ok) {
    return throwApiError(response);
  }

  return ConversationResponseSchema.parse(await response.json());
}

export async function createConversation(
  signal?: AbortSignal,
): Promise<CreateConversationResponse> {
  const response = await fetchApiResponse("/api/conversations", {
    method: "POST",
    signal,
  });

  if (!response.ok) {
    return throwApiError(response);
  }

  return CreateConversationResponseSchema.parse(await response.json());
}

export async function branchConversation(
  sourceConversationId: string,
  request: BranchConversationRequest,
  signal?: AbortSignal,
): Promise<BranchConversationResponse> {
  const response = await fetchApiResponse(
    `/api/conversations/${encodeURIComponent(sourceConversationId)}/branches`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    },
  );

  if (!response.ok) {
    return throwApiError(response);
  }

  return BranchConversationResponseSchema.parse(await response.json());
}

export async function listConversations(
  input: {
    view: ConversationListView;
    query: string;
    cursor: string | null;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<ListConversationsResponse> {
  const searchParams = new URLSearchParams({
    view: input.view,
    query: input.query,
    limit: String(input.limit),
  });
  if (input.cursor !== null) {
    searchParams.set("cursor", input.cursor);
  }
  const response = await fetchApiResponse(`/api/conversations?${searchParams.toString()}`, {
    method: "GET",
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    return throwApiError(response);
  }

  return ListConversationsResponseSchema.parse(await response.json());
}

export async function patchConversation(
  conversationId: string,
  request: PatchConversationRequest,
  signal?: AbortSignal,
): Promise<PatchConversationResponse> {
  const response = await fetchApiResponse(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    },
  );

  if (!response.ok) {
    return throwApiError(response);
  }

  return PatchConversationResponseSchema.parse(await response.json());
}

export async function deleteConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<DeleteConversationResponse> {
  const response = await fetchApiResponse(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
    { method: "DELETE", signal },
  );

  if (!response.ok) {
    return throwApiError(response);
  }

  return DeleteConversationResponseSchema.parse(await response.json());
}

export async function archiveAllConversations(
  signal?: AbortSignal,
): Promise<BulkConversationMutationResponse> {
  const response = await fetchApiResponse("/api/conversations", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "archive_all" }),
    signal,
  });

  if (!response.ok) {
    return throwApiError(response);
  }

  return BulkConversationMutationResponseSchema.parse(await response.json());
}

export async function deleteAllConversations(
  signal?: AbortSignal,
): Promise<BulkConversationMutationResponse> {
  const response = await fetchApiResponse("/api/conversations", {
    method: "DELETE",
    signal,
  });

  if (!response.ok) {
    return throwApiError(response);
  }

  return BulkConversationMutationResponseSchema.parse(await response.json());
}

export async function getConversationShare(
  conversationId: string,
  signal?: AbortSignal,
): Promise<GetConversationShareResponse> {
  const response = await fetchApiResponse(
    `/api/conversations/${encodeURIComponent(conversationId)}/share`,
    {
      method: "GET",
      cache: "no-store",
      signal,
    },
  );

  if (!response.ok) {
    return throwApiError(response);
  }

  return GetConversationShareResponseSchema.parse(await response.json());
}

export async function listConversationShares(
  input: {
    cursor: string | null;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<ListConversationSharesResponse> {
  const searchParams = new URLSearchParams({ limit: String(input.limit) });
  if (input.cursor !== null) {
    searchParams.set("cursor", input.cursor);
  }
  const response = await fetchApiResponse(
    `/api/conversation-shares?${searchParams.toString()}`,
    {
      method: "GET",
      cache: "no-store",
      signal,
    },
  );

  if (!response.ok) {
    return throwApiError(response);
  }

  return ListConversationSharesResponseSchema.parse(await response.json());
}

export async function putConversationShare(
  conversationId: string,
  signal?: AbortSignal,
): Promise<PutConversationShareResponse> {
  const response = await fetchApiResponse(
    `/api/conversations/${encodeURIComponent(conversationId)}/share`,
    {
      method: "PUT",
      signal,
    },
  );

  if (!response.ok) {
    return throwApiError(response);
  }

  return PutConversationShareResponseSchema.parse(await response.json());
}

export async function revokeConversationShare(
  conversationId: string,
  expectedPublicId: string,
  signal?: AbortSignal,
): Promise<RevokeConversationShareResponse> {
  const searchParams = new URLSearchParams({ publicId: expectedPublicId });
  const response = await fetchApiResponse(
    `/api/conversations/${encodeURIComponent(conversationId)}/share?${searchParams.toString()}`,
    {
      method: "DELETE",
      signal,
    },
  );

  if (!response.ok) {
    return throwApiError(response);
  }

  return RevokeConversationShareResponseSchema.parse(await response.json());
}

export async function patchMessageFeedback(
  messageId: string,
  feedback: MessageFeedback | null,
  signal?: AbortSignal,
): Promise<PatchMessageFeedbackResponse> {
  const response = await fetchApiResponse(
    `/api/messages/${encodeURIComponent(messageId)}/feedback`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
      signal,
    },
  );

  if (!response.ok) {
    return throwApiError(response);
  }

  return PatchMessageFeedbackResponseSchema.parse(await response.json());
}

export async function uploadInputAttachment(
  file: File,
  signal?: AbortSignal,
): Promise<UploadInputAttachmentResponse> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetchApiResponse("/api/input-attachments", {
    method: "POST",
    body: formData,
    signal,
  });

  if (!response.ok) {
    return throwApiError(response);
  }

  return UploadInputAttachmentResponseSchema.parse(await response.json());
}

export async function getStagedInputAttachment(
  attachmentId: string,
  signal?: AbortSignal,
): Promise<UploadInputAttachmentResponse> {
  const response = await fetchApiResponse(
    `/api/input-attachments/${encodeURIComponent(attachmentId)}`,
    { method: "GET", cache: "no-store", signal },
  );

  if (!response.ok) {
    return throwApiError(response);
  }

  return UploadInputAttachmentResponseSchema.parse(await response.json());
}

export async function deleteInputAttachment(
  attachmentId: string,
  signal?: AbortSignal,
): Promise<DeleteInputAttachmentResponse> {
  const response = await fetchApiResponse(
    `/api/input-attachments/${encodeURIComponent(attachmentId)}`,
    { method: "DELETE", signal },
  );

  if (!response.ok) {
    return throwApiError(response);
  }

  return DeleteInputAttachmentResponseSchema.parse(await response.json());
}

export async function startChat(
  request: ChatRequest,
  signal?: AbortSignal,
): Promise<ChatStartResponse> {
  const response = await fetchApiResponse("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    return throwApiError(response);
  }

  return ChatStartResponseSchema.parse(await response.json());
}

export async function openRunEventStream(
  runId: string,
  signal: AbortSignal,
  lastEventId: string | null,
): Promise<ReadableStream<Uint8Array>> {
  const headers = new Headers();
  if (lastEventId !== null) {
    headers.set("Last-Event-ID", lastEventId);
  }
  const response = await fetchApiResponse(
    `/api/runs/${encodeURIComponent(runId)}/events`,
    {
      method: "GET",
      cache: "no-store",
      headers,
      signal,
    },
  );

  if (!response.ok) {
    return throwApiError(response);
  }

  const contentType = response.headers.get("content-type");
  if (contentType === null || !contentType.startsWith("text/event-stream")) {
    throw new Error("运行活动接口返回了非 SSE 响应");
  }

  if (response.body === null) {
    throw new Error("运行活动接口未返回响应流");
  }

  return response.body;
}

export async function cancelRun(runId: string): Promise<CancelRunResponse> {
  const response = await fetchApiResponse(
    `/api/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  );

  if (!response.ok) {
    return throwApiError(response);
  }

  return CancelRunResponseSchema.parse(await response.json());
}

export async function retryRun(
  runId: string,
  request: RetryRunRequest,
  signal?: AbortSignal,
): Promise<RetryRunResponse> {
  const response = await fetchApiResponse(
    `/api/runs/${encodeURIComponent(runId)}/retry`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    },
  );

  if (!response.ok) {
    return throwApiError(response);
  }

  return RetryRunResponseSchema.parse(await response.json());
}

export async function regenerateRun(
  runId: string,
  request: RegenerateRunRequest,
  signal?: AbortSignal,
): Promise<RegenerateRunResponse> {
  const response = await fetchApiResponse(
    `/api/runs/${encodeURIComponent(runId)}/regenerate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    },
  );

  if (!response.ok) {
    return throwApiError(response);
  }

  return RegenerateRunResponseSchema.parse(await response.json());
}
