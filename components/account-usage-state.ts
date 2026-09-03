import {
  isApiAbortError,
  userFacingRequestErrorMessage,
} from "@/components/api-client";
import type {
  AccountUsageItem,
  AgentRunStatus,
} from "@/lib/contracts";

export const accountUsagePageSize = 30;

export type AccountUsagePageRequest = Readonly<{
  cursor: string | null;
  limit: number;
}>;

export type AccountUsageResultSurface =
  | "loading"
  | "failure"
  | "empty"
  | "results";

export const accountUsageStatusLabels = {
  waiting: "等待执行",
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  reconciliation_required: "待对账",
} as const satisfies Record<AgentRunStatus, string>;

const accountUsageNumberFormatter = new Intl.NumberFormat("zh-CN");
const accountUsageDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function accountUsageInitialPageRequest(): AccountUsagePageRequest {
  return { cursor: null, limit: accountUsagePageSize };
}

export function accountUsageNextPageRequest(
  cursor: string,
): AccountUsagePageRequest {
  if (cursor.length === 0) {
    throw new TypeError("积分用量分页 cursor 不能为空字符串");
  }
  return { cursor, limit: accountUsagePageSize };
}

export function accountUsageMergePage(
  current: readonly AccountUsageItem[],
  incoming: readonly AccountUsageItem[],
): AccountUsageItem[] {
  const seenRunIds = new Set(current.map((item) => item.runId));
  const merged = [...current];
  for (const item of incoming) {
    if (seenRunIds.has(item.runId)) {
      throw new Error(`积分用量分页返回了重复 Run ${item.runId}`);
    }
    seenRunIds.add(item.runId);
    merged.push(item);
  }
  return merged;
}

export function accountUsageResultSurface(input: {
  isLoading: boolean;
  loadError: string | null;
  itemCount: number;
}): AccountUsageResultSurface {
  if (input.isLoading) {
    return "loading";
  }
  if (input.loadError !== null) {
    return "failure";
  }
  return input.itemCount === 0 ? "empty" : "results";
}

export function formatAccountUsageNumber(value: number | null): string {
  return value === null ? "—" : accountUsageNumberFormatter.format(value);
}

export function formatAccountUsageDate(value: string | null): string {
  return value === null
    ? "—"
    : accountUsageDateFormatter.format(new Date(value));
}

export function accountUsageErrorMessage(error: unknown): string {
  return userFacingRequestErrorMessage(
    error,
    "暂时无法加载积分与用量，请重试。",
  );
}

export function accountUsageIsAbortError(error: unknown): boolean {
  return isApiAbortError(error);
}
