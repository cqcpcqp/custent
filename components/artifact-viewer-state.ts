import type { ArtifactSummary } from "@/lib/contracts";

export type ArtifactCsvPreview = {
  columns: string[];
  rows: string[][];
};

export type ArtifactViewerRenderState =
  | { status: "loading" }
  | {
      status: "error";
      reason: "invalid_csv" | "unavailable";
    }
  | {
      status: "ready";
      content:
        | {
            kind: "csv";
            document: ArtifactCsvPreview;
          }
        | {
            kind: "pdf";
            blob: Blob;
          };
    };

export type ArtifactViewerLifecycleState = {
  isOpen: boolean;
  preview: ArtifactViewerRenderState;
};

export function closeArtifactViewerState(
  current: ArtifactViewerLifecycleState,
): ArtifactViewerLifecycleState {
  if (!current.isOpen && current.preview.status === "loading") {
    return current;
  }
  return {
    isOpen: false,
    preview: { status: "loading" },
  };
}

export function artifactPreviewRequestCanCommit(
  activeRequestIdentity: object | null,
  requestIdentity: object,
  aborted: boolean,
): boolean {
  return !aborted && activeRequestIdentity === requestIdentity;
}

export type LoadedArtifactPreview =
  | {
      kind: "csv";
      document: ArtifactCsvPreview;
    }
  | {
      kind: "pdf";
      blob: Blob;
    };

export const ARTIFACT_PDF_MIN_ZOOM = 0.5;
export const ARTIFACT_PDF_MAX_ZOOM = 2;
export const ARTIFACT_PDF_ZOOM_STEP = 0.25;

export function nextArtifactPdfZoom(
  currentZoom: number,
  direction: "in" | "out",
): number {
  if (
    !Number.isFinite(currentZoom) ||
    currentZoom < ARTIFACT_PDF_MIN_ZOOM ||
    currentZoom > ARTIFACT_PDF_MAX_ZOOM
  ) {
    throw new Error("PDF 预览缩放比例无效");
  }

  const requestedZoom =
    currentZoom +
    (direction === "in" ? ARTIFACT_PDF_ZOOM_STEP : -ARTIFACT_PDF_ZOOM_STEP);
  return Math.min(
    ARTIFACT_PDF_MAX_ZOOM,
    Math.max(ARTIFACT_PDF_MIN_ZOOM, requestedZoom),
  );
}

export function artifactPdfViewportScale(
  pageWidth: number,
  availableWidth: number,
  zoom: number,
): number {
  if (
    !Number.isFinite(pageWidth) ||
    !Number.isFinite(availableWidth) ||
    !Number.isFinite(zoom) ||
    pageWidth <= 0 ||
    availableWidth <= 0 ||
    zoom < ARTIFACT_PDF_MIN_ZOOM ||
    zoom > ARTIFACT_PDF_MAX_ZOOM
  ) {
    throw new Error("PDF 预览尺寸无效");
  }

  return (availableWidth / pageWidth) * zoom;
}

export function artifactPdfOutputScale(devicePixelRatio: number): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    throw new Error("PDF 预览像素比例无效");
  }

  return Math.min(devicePixelRatio, 2);
}

export class ArtifactPreviewRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Artifact preview request failed with status ${status}`);
    this.name = "ArtifactPreviewRequestError";
    this.status = status;
  }
}

export class ArtifactCsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactCsvParseError";
  }
}

export function artifactPreviewErrorReason(
  error: unknown,
): Extract<ArtifactViewerRenderState, { status: "error" }>["reason"] {
  return error instanceof ArtifactCsvParseError
    ? "invalid_csv"
    : "unavailable";
}

export function parseArtifactCsv(source: string): ArtifactCsvPreview {
  const input = source.startsWith("\uFEFF") ? source.slice(1) : source;
  if (input.length === 0) {
    throw new ArtifactCsvParseError("CSV 文件为空");
  }
  const parsedRows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let insideQuotedCell = false;
  let quotedCellClosed = false;

  function finishCell(): void {
    row.push(cell);
    cell = "";
    quotedCellClosed = false;
  }

  function finishRow(): void {
    finishCell();
    parsedRows.push(row);
    row = [];
  }

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

    if (insideQuotedCell) {
      if (character !== '"') {
        cell += character;
        continue;
      }
      if (input[index + 1] === '"') {
        cell += '"';
        index += 1;
        continue;
      }
      insideQuotedCell = false;
      quotedCellClosed = true;
      continue;
    }

    if (character === '"') {
      if (cell.length > 0 || quotedCellClosed) {
        throw new ArtifactCsvParseError("CSV 文件包含无效的引号");
      }
      insideQuotedCell = true;
      continue;
    }

    if (character === ",") {
      finishCell();
      continue;
    }

    if (character === "\r" || character === "\n") {
      finishRow();
      if (character === "\r" && input[index + 1] === "\n") {
        index += 1;
      }
      continue;
    }

    if (quotedCellClosed) {
      throw new ArtifactCsvParseError("CSV 文件在引号后包含无效字符");
    }
    cell += character;
  }

  if (insideQuotedCell) {
    throw new ArtifactCsvParseError("CSV 文件包含未闭合的引号");
  }
  if (cell.length > 0 || row.length > 0 || quotedCellClosed) {
    finishRow();
  }
  if (parsedRows.length === 0 || parsedRows[0].length === 0) {
    throw new ArtifactCsvParseError("CSV 文件缺少表头");
  }

  const [columns, ...rows] = parsedRows;
  if (columns.some((column) => column.trim().length === 0)) {
    throw new ArtifactCsvParseError("CSV 文件的表头不能为空");
  }
  for (const parsedRow of rows) {
    if (parsedRow.length !== columns.length) {
      throw new ArtifactCsvParseError(
        "CSV 文件的数据列数与表头不一致",
      );
    }
  }

  return { columns, rows };
}

export async function loadArtifactPreview(
  downloadUrl: string,
  mimeType: ArtifactSummary["mimeType"],
  signal: AbortSignal,
): Promise<LoadedArtifactPreview> {
  const response = await fetch(downloadUrl, {
    method: "GET",
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    throw new ArtifactPreviewRequestError(response.status);
  }

  const blob = await response.blob();
  if (mimeType === "text/csv") {
    return {
      kind: "csv",
      document: parseArtifactCsv(await blob.text()),
    };
  }
  return { kind: "pdf", blob };
}
