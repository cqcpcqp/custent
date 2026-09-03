import {
  ApiClientError,
  assertApiClientErrorContract,
  fetchApiResponse,
  isApiAbortError,
  userFacingRequestErrorMessage,
} from "@/components/api-client";
import {
  ApiErrorResponseSchema,
  GetLibraryResearchResponseSchema,
  ListLibraryArtifactsResponseSchema,
  ListLibraryResearchResponseSchema,
  type GetLibraryResearchResponse,
  type LibraryArtifactItem,
  type LibraryResearchItem,
  type ListLibraryArtifactsResponse,
  type ListLibraryResearchResponse,
} from "@/lib/contracts";

export const libraryPageSize = 24;

const libraryLoadMoreScrollThreshold = 120;

export type LibraryTab = "research" | "artifacts";

export type LibraryPageRequest = Readonly<{
  cursor: string | null;
  limit: number;
}>;

export type LibraryResultSurface =
  | "loading"
  | "failure"
  | "empty"
  | "results";

export class LibraryApiError extends ApiClientError {
  constructor(code: string, message: string, status: number) {
    super(code, message, status);
    this.name = "LibraryApiError";
  }
}

async function throwLibraryApiError(response: Response): Promise<never> {
  const payload = ApiErrorResponseSchema.parse(await response.json());
  const error = new LibraryApiError(
    payload.error.code,
    payload.error.message,
    response.status,
  );
  assertApiClientErrorContract(error);
  throw error;
}

function assertLibraryPageRequest(request: LibraryPageRequest): void {
  if (
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 50
  ) {
    throw new RangeError("资料库分页 limit 必须是 1 到 50 的安全整数");
  }
  if (request.cursor !== null && request.cursor.length === 0) {
    throw new TypeError("资料库分页 cursor 不能为空字符串");
  }
}

export function libraryPageRequestUrl(
  tab: LibraryTab,
  request: LibraryPageRequest,
): string {
  assertLibraryPageRequest(request);
  const searchParams = new URLSearchParams({ limit: String(request.limit) });
  if (request.cursor !== null) {
    searchParams.set("cursor", request.cursor);
  }
  return `/api/library/${tab}?${searchParams.toString()}`;
}

export function libraryInitialPageRequest(): LibraryPageRequest {
  return { cursor: null, limit: libraryPageSize };
}

export function libraryNextPageRequest(cursor: string): LibraryPageRequest {
  const request = { cursor, limit: libraryPageSize } as const;
  assertLibraryPageRequest(request);
  return request;
}

export async function fetchLibraryResearchPage(
  request: LibraryPageRequest,
  signal?: AbortSignal,
): Promise<ListLibraryResearchResponse> {
  const response = await fetchApiResponse(libraryPageRequestUrl("research", request), {
    method: "GET",
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    return throwLibraryApiError(response);
  }
  return ListLibraryResearchResponseSchema.parse(await response.json());
}

export async function fetchLibraryArtifactPage(
  request: LibraryPageRequest,
  signal?: AbortSignal,
): Promise<ListLibraryArtifactsResponse> {
  const response = await fetchApiResponse(libraryPageRequestUrl("artifacts", request), {
    method: "GET",
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    return throwLibraryApiError(response);
  }
  return ListLibraryArtifactsResponseSchema.parse(await response.json());
}

export async function fetchLibraryResearchDetail(
  snapshotId: string,
  signal?: AbortSignal,
): Promise<GetLibraryResearchResponse> {
  const response = await fetchApiResponse(
    `/api/library/research/${encodeURIComponent(snapshotId)}`,
    {
      method: "GET",
      cache: "no-store",
      signal,
    },
  );
  if (!response.ok) {
    return throwLibraryApiError(response);
  }
  return GetLibraryResearchResponseSchema.parse(await response.json());
}

export function libraryRequestKey(
  tab: LibraryTab,
  refreshVersion: number,
): string {
  if (!Number.isSafeInteger(refreshVersion) || refreshVersion < 0) {
    throw new RangeError("资料库 refreshVersion 必须是非负安全整数");
  }
  return `${tab}\u0000${refreshVersion}`;
}

export function libraryTabForKey(
  currentTab: LibraryTab,
  key: string,
): LibraryTab | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowRight":
      return currentTab === "research" ? "artifacts" : "research";
    case "Home":
      return "research";
    case "End":
      return "artifacts";
    default:
      return null;
  }
}

export function libraryResultSurface({
  isLoading,
  loadError,
  itemCount,
}: {
  isLoading: boolean;
  loadError: string | null;
  itemCount: number;
}): LibraryResultSurface {
  if (isLoading) {
    return "loading";
  }
  if (loadError !== null) {
    return "failure";
  }
  return itemCount === 0 ? "empty" : "results";
}

type LibraryRenderablePageState = Readonly<{
  error: string | null;
  requestKey: string;
}>;

/**
 * Keep the latest successful page mounted while a newer request is in flight.
 * A failed page is only renderable for its exact request so an old error can
 * never replace a new request's loading state.
 */
export function libraryPageForRender<T extends LibraryRenderablePageState>(
  page: T | null,
  requestKey: string,
): T | null {
  if (page === null) {
    return null;
  }
  if (page.requestKey === requestKey || page.error === null) {
    return page;
  }
  return null;
}

type LibraryIdentifiedItem = Readonly<{ id: string }>;

export function libraryMergePage<T extends LibraryIdentifiedItem>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const ids = new Set(current.map((item) => item.id));
  const merged = [...current];
  for (const item of incoming) {
    if (ids.has(item.id)) {
      throw new Error(`资料库分页返回了重复条目 ${item.id}`);
    }
    ids.add(item.id);
    merged.push(item);
  }
  return merged;
}

export function libraryPageRequestCanCommit({
  controller,
  currentController,
  currentRequestKey,
  requestKey,
}: {
  controller: AbortController;
  currentController: AbortController | null;
  currentRequestKey: string;
  requestKey: string;
}): boolean {
  return (
    !controller.signal.aborted &&
    currentController === controller &&
    currentRequestKey === requestKey
  );
}

export function libraryDetailRequestCanCommit({
  controller,
  currentController,
  currentSnapshotId,
  snapshotId,
}: {
  controller: AbortController;
  currentController: AbortController | null;
  currentSnapshotId: string | null;
  snapshotId: string;
}): boolean {
  return (
    !controller.signal.aborted &&
    currentController === controller &&
    currentSnapshotId === snapshotId
  );
}

export function libraryScrollIsNearEnd({
  clientHeight,
  scrollHeight,
  scrollTop,
}: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}): boolean {
  return scrollHeight - scrollTop - clientHeight <= libraryLoadMoreScrollThreshold;
}

export function libraryErrorMessage(error: unknown): string {
  return userFacingRequestErrorMessage(
    error,
    "资料库请求暂时失败，请重试。",
  );
}

export function isLibraryAbortError(error: unknown): boolean {
  return isApiAbortError(error);
}

export type LibraryResearchPageState = Readonly<{
  requestKey: string;
  items: LibraryResearchItem[];
  nextCursor: string | null;
  error: string | null;
}>;

export type LibraryArtifactPageState = Readonly<{
  requestKey: string;
  items: LibraryArtifactItem[];
  nextCursor: string | null;
  error: string | null;
}>;
