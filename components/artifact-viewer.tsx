"use client";

import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";

import {
  artifactPreviewErrorReason,
  artifactPreviewRequestCanCommit,
  closeArtifactViewerState,
  loadArtifactPreview,
  type ArtifactViewerLifecycleState,
  type ArtifactViewerRenderState,
} from "@/components/artifact-viewer-state";
import { ArtifactPdfPreview } from "@/components/artifact-pdf-preview";
import {
  AlertIcon,
  ChevronRightIcon,
  CloseIcon,
  DocumentIcon,
  DownloadIcon,
  RefreshIcon,
} from "@/components/icons";
import { formatAttachmentBytes } from "@/components/input-attachment-state";
import { useModalFocus } from "@/components/modal-focus";
import type { ArtifactSummary } from "@/lib/contracts";

export type PreviewableFileSummary = {
  id: string;
  name: string;
  mimeType: ArtifactSummary["mimeType"];
  sizeBytes: number;
  downloadUrl: string;
  createdAt: string;
};

const artifactDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

type ArtifactViewerDialogProps = {
  artifact: PreviewableFileSummary;
  backdropRef?: RefObject<HTMLDivElement | null>;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  dialogRef?: RefObject<HTMLElement | null>;
  dialogId: string;
  downloadActionRef: RefObject<HTMLAnchorElement | null>;
  onClose: () => void;
  onRetry: () => void;
  previewFocusRef: RefObject<HTMLElement | null>;
  retryButtonRef: RefObject<HTMLButtonElement | null>;
  state: ArtifactViewerRenderState;
  titleId: string;
};

export function ArtifactViewerDialog({
  artifact,
  backdropRef,
  closeButtonRef,
  dialogRef,
  dialogId,
  downloadActionRef,
  onClose,
  onRetry,
  previewFocusRef,
  retryButtonRef,
  state,
  titleId,
}: ArtifactViewerDialogProps) {
  const fileType = artifact.mimeType === "text/csv" ? "CSV" : "PDF";

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div
      className="artifact-viewer-backdrop"
      data-modal-layer=""
      onMouseDown={handleBackdropMouseDown}
      ref={backdropRef}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="artifact-viewer"
        id={dialogId}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="artifact-viewer__header">
          <span className="artifact-viewer__title">
            <span
              className={`artifact-viewer__file artifact-viewer__file--${fileType.toLowerCase()}`}
            >
              <DocumentIcon />
              <small>{fileType}</small>
            </span>
            <span>
              <strong id={titleId}>
                <span className="visually-hidden">文件预览：</span>
                {artifact.name}
              </strong>
              <small>
                {fileType} · {formatAttachmentBytes(artifact.sizeBytes)}
              </small>
            </span>
          </span>
          <span className="artifact-viewer__actions">
            <a
              aria-label={`下载文件：${artifact.name}`}
              className="artifact-viewer__action artifact-viewer__action--download"
              download
              href={artifact.downloadUrl}
              ref={downloadActionRef}
            >
              <DownloadIcon />
              <span>下载</span>
            </a>
            <button
              aria-label={`关闭文件预览：${artifact.name}`}
              className="artifact-viewer__action"
              onClick={onClose}
              ref={closeButtonRef}
              type="button"
            >
              <CloseIcon />
              <span>关闭</span>
            </button>
          </span>
        </header>

        <div
          aria-busy={state.status === "loading"}
          className={`artifact-viewer__canvas artifact-viewer__canvas--${fileType.toLowerCase()}`}
        >
          {state.status === "loading" ? (
            <div className="artifact-viewer__loading" role="status">
              <span aria-hidden="true" />
              <strong>正在载入{fileType}预览</strong>
              <small>文件仍可直接下载</small>
            </div>
          ) : state.status === "error" ? (
            <div className="artifact-viewer__error" role="alert">
              <AlertIcon />
              {state.reason === "invalid_csv" ? (
                <>
                  <strong>无法显示 CSV 表格预览</strong>
                  <p>
                    文件为空或不符合严格 CSV 格式。你仍可使用上方下载按钮打开原文件。
                  </p>
                </>
              ) : (
                <>
                  <strong>暂时无法载入预览</strong>
                  <p>请重试，或使用上方下载按钮打开原文件。</p>
                  <button
                    onClick={onRetry}
                    ref={retryButtonRef}
                    type="button"
                  >
                    <RefreshIcon />
                    重新载入
                  </button>
                </>
              )}
            </div>
          ) : state.content.kind === "pdf" ? (
            <ArtifactPdfPreview
              blob={state.content.blob}
              fileName={artifact.name}
              onRetry={onRetry}
              previewFocusRef={previewFocusRef}
            />
          ) : (
            <div
              aria-label={`${artifact.name} CSV 表格预览`}
              className="artifact-viewer__sheet"
              ref={(element) => {
                previewFocusRef.current = element;
              }}
              role="region"
              tabIndex={0}
            >
              <div className="artifact-viewer__sheet-meta">
                <span>{state.content.document.rows.length} 行</span>
                <span>{state.content.document.columns.length} 列</span>
              </div>
              <table>
                <caption className="visually-hidden">
                  {artifact.name}，共 {state.content.document.rows.length} 行、
                  {state.content.document.columns.length} 列
                </caption>
                <thead>
                  <tr>
                    {state.content.document.columns.map((column, index) => (
                      <th key={`${index}-${column}`} scope="col">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {state.content.document.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, columnIndex) => (
                        <td key={columnIndex}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export function ArtifactViewer({
  artifact,
  variant = "artifact",
}: {
  artifact: PreviewableFileSummary;
  variant?: "artifact" | "input-attachment";
}) {
  const [loadRevision, setLoadRevision] = useState(0);
  const [viewerState, setViewerState] = useState<ArtifactViewerLifecycleState>({
    isOpen: false,
    preview: { status: "loading" },
  });
  const { isOpen, preview: state } = viewerState;
  const activePreviewControllerRef = useRef<AbortController | null>(null);
  const activePreviewRequestRef = useRef<object | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const downloadActionRef = useRef<HTMLAnchorElement>(null);
  const previewFocusRef = useRef<HTMLElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const generatedId = useId();
  const dialogId = `${generatedId}-artifact-dialog`;
  const titleId = `${generatedId}-artifact-title`;
  const closeViewer = useCallback(() => {
    activePreviewRequestRef.current = null;
    activePreviewControllerRef.current?.abort();
    activePreviewControllerRef.current = null;
    setViewerState(closeArtifactViewerState);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const controller = new AbortController();
    const requestIdentity = {};
    activePreviewControllerRef.current = controller;
    activePreviewRequestRef.current = requestIdentity;

    void loadArtifactPreview(
      artifact.downloadUrl,
      artifact.mimeType,
      controller.signal,
    )
      .then((preview) => {
        if (
          !artifactPreviewRequestCanCommit(
            activePreviewRequestRef.current,
            requestIdentity,
            controller.signal.aborted,
          )
        ) {
          return;
        }
        setViewerState((current) => {
          if (
            !current.isOpen ||
            !artifactPreviewRequestCanCommit(
              activePreviewRequestRef.current,
              requestIdentity,
              controller.signal.aborted,
            )
          ) {
            return current;
          }
          return {
            ...current,
            preview: { status: "ready", content: preview },
          };
        });
      })
      .catch((error: unknown) => {
        if (
          !artifactPreviewRequestCanCommit(
            activePreviewRequestRef.current,
            requestIdentity,
            controller.signal.aborted,
          )
        ) {
          return;
        }
        setViewerState((current) =>
          current.isOpen &&
          artifactPreviewRequestCanCommit(
            activePreviewRequestRef.current,
            requestIdentity,
            controller.signal.aborted,
          )
            ? {
                ...current,
                preview: {
                  status: "error",
                  reason: artifactPreviewErrorReason(error),
                },
              }
            : current,
        );
      });

    return () => {
      controller.abort();
      if (activePreviewControllerRef.current === controller) {
        activePreviewControllerRef.current = null;
      }
      if (activePreviewRequestRef.current === requestIdentity) {
        activePreviewRequestRef.current = null;
      }
    };
  }, [artifact.downloadUrl, artifact.mimeType, isOpen, loadRevision]);

  useModalFocus({
    backdropRef,
    canClose: true,
    containerRef: dialogRef,
    enabled: isOpen,
    initialFocusRef: closeButtonRef,
    onClose: closeViewer,
    returnFocusRef,
  });

  function openViewer(event: MouseEvent<HTMLButtonElement>) {
    returnFocusRef.current = event.currentTarget;
    activePreviewRequestRef.current = null;
    activePreviewControllerRef.current?.abort();
    activePreviewControllerRef.current = null;
    setViewerState({
      isOpen: true,
      preview: { status: "loading" },
    });
  }

  function retryPreview() {
    activePreviewRequestRef.current = null;
    activePreviewControllerRef.current?.abort();
    activePreviewControllerRef.current = null;
    setViewerState((current) => ({
      ...current,
      preview: { status: "loading" },
    }));
    setLoadRevision((revision) => revision + 1);
  }

  return (
    <>
      <button
        aria-controls={isOpen ? dialogId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={`预览文件：${artifact.name}`}
        className={
          variant === "artifact"
            ? "artifact-card"
            : "message-input-attachment message-input-attachment--file"
        }
        onClick={openViewer}
        type="button"
      >
        {variant === "artifact" ? (
          <>
            <span
              className={`artifact-card__file artifact-card__file--${
                artifact.mimeType === "text/csv" ? "csv" : "pdf"
              }`}
            >
              <DocumentIcon />
              <small>
                {artifact.mimeType === "text/csv" ? "CSV" : "PDF"}
              </small>
            </span>
            <span className="artifact-card__copy">
              <strong>{artifact.name}</strong>
              <small>
                {formatAttachmentBytes(artifact.sizeBytes)} · {" "}
                {artifactDateFormatter.format(new Date(artifact.createdAt))}
              </small>
            </span>
            <span className="artifact-card__open">
              <ChevronRightIcon />
            </span>
          </>
        ) : (
          <>
            <span className="message-input-attachment__file-icon">
              <DocumentIcon />
              <small>
                {artifact.mimeType === "text/csv" ? "CSV" : "PDF"}
              </small>
            </span>
            <span className="message-input-attachment__copy">
              <strong>{artifact.name}</strong>
              <small>
                {artifact.mimeType === "text/csv" ? "CSV" : "PDF"} · {" "}
                {formatAttachmentBytes(artifact.sizeBytes)}
              </small>
            </span>
            <ChevronRightIcon />
          </>
        )}
      </button>
      {isOpen
        ? createPortal(
            <ArtifactViewerDialog
              artifact={artifact}
              backdropRef={backdropRef}
              closeButtonRef={closeButtonRef}
              dialogRef={dialogRef}
              dialogId={dialogId}
              downloadActionRef={downloadActionRef}
              onClose={closeViewer}
              onRetry={retryPreview}
              previewFocusRef={previewFocusRef}
              retryButtonRef={retryButtonRef}
              state={state}
              titleId={titleId}
            />,
            document.body,
          )
        : null}
    </>
  );
}

export function ArtifactCards({ artifacts }: { artifacts: ArtifactSummary[] }) {
  if (artifacts.length === 0) {
    return null;
  }

  return (
    <section aria-label="生成文件" className="artifact-section">
      <div className="message-section-label">
        <DocumentIcon />
        <span>研究文件</span>
        <span className="message-section-label__count">{artifacts.length}</span>
      </div>
      <div className="artifact-grid">
        {artifacts.map((artifact) => (
          <ArtifactViewer artifact={artifact} key={artifact.id} />
        ))}
      </div>
    </section>
  );
}
