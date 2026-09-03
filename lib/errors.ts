export const APP_ERROR_CODES = [
  "BRANCH_ALREADY_EXISTS",
  "INVALID_REQUEST",
  "INVALID_BRANCH_TARGET",
  "NOT_FOUND",
  "INSUFFICIENT_CREDITS",
  "RUN_ALREADY_EXISTS",
  "RUN_NOT_RETRYABLE",
  "RUN_NOT_REGENERATABLE",
  "RUN_CONTEXT_UNAVAILABLE",
  "STALE_PARENT",
  "INVALID_EDIT",
  "RUN_IN_PROGRESS",
  "ACTIVE_RUN",
  "EMPTY_CONVERSATION",
  "SHARE_NOT_FOUND",
  "CUSTOM_INSTRUCTIONS_REVISION_CONFLICT",
  "RUN_REQUIRES_RECONCILIATION",
  "INTERNAL_ERROR",
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AppError";
  }
}
