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
  closeInputAttachmentTextViewerState,
  inputAttachmentSourcePreviewRequestCanCommit,
  loadInputAttachmentSourcePreview,
  type InputAttachmentSourcePreviewMimeType,
  type InputAttachmentTextViewerLifecycleState,
  type InputAttachmentTextViewerRenderState,
} from "@/components/input-attachment-text-viewer-state";
import {
  AlertIcon,
  ChevronRightIcon,
  CloseIcon,
  DocumentIcon,
  DownloadIcon,
  RefreshIcon,
} from "@/components/icons";
import {
  formatAttachmentBytes,
  inputAttachmentTypeLabel,
} from "@/components/input-attachment-state";
import { useModalFocus } from "@/components/modal-focus";

export type InputAttachmentTextViewerProps = {
  downloadUrl: string;
  mimeType: InputAttachmentSourcePreviewMimeType;
  name: string;
  sizeBytes: number;
};

type InputAttachmentTextViewerDialogProps =
  InputAttachmentTextViewerProps & {
    backdropRef?: RefObject<HTMLDivElement | null>;
    closeButtonRef: RefObject<HTMLButtonElement | null>;
    dialogRef?: RefObject<HTMLElement | null>;
    dialogId: string;
    downloadActionRef: RefObject<HTMLAnchorElement | null>;
    onClose: () => void;
    onRetry: () => void;
    previewFocusRef: RefObject<HTMLElement | null>;
    retryButtonRef: RefObject<HTMLButtonElement | null>;
    state: InputAttachmentTextViewerRenderState;
    titleId: string;
  };

const sourcePreviewShortLabels: Record<
  InputAttachmentSourcePreviewMimeType,
  string
> = {
  "text/plain": "TXT",
  "text/markdown": "MD",
  "application/json": "JSON",
};

function sourcePreviewTypeClass(
  mimeType: InputAttachmentSourcePreviewMimeType,
): string {
  switch (mimeType) {
    case "text/plain":
      return "txt";
    case "text/markdown":
      return "markdown";
    case "application/json":
      return "json";
  }
}

export function InputAttachmentTextViewerDialog({
  backdropRef,
  closeButtonRef,
  dialogRef,
  dialogId,
  downloadActionRef,
  downloadUrl,
  mimeType,
  name,
  onClose,
  onRetry,
  previewFocusRef,
  retryButtonRef,
  sizeBytes,
  state,
  titleId,
}: InputAttachmentTextViewerDialogProps) {
  const fileType = inputAttachmentTypeLabel(mimeType);
  const shortLabel = sourcePreviewShortLabels[mimeType];

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div
      className="artifact-viewer-backdrop input-attachment-text-viewer-backdrop"
      data-modal-layer=""
      onMouseDown={handleBackdropMouseDown}
      ref={backdropRef}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="artifact-viewer input-attachment-text-viewer"
        id={dialogId}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="artifact-viewer__header input-attachment-text-viewer__header">
          <span className="artifact-viewer__title input-attachment-text-viewer__title">
            <span
              className={`artifact-viewer__file input-attachment-text-viewer__file input-attachment-text-viewer__file--${sourcePreviewTypeClass(mimeType)}`}
            >
              <DocumentIcon />
              <small>{shortLabel}</small>
            </span>
            <span>
              <strong id={titleId}>
                <span className="visually-hidden">附件源码预览：</span>
                {name}
              </strong>
              <small>
                {fileType} 源码 · {formatAttachmentBytes(sizeBytes)}
              </small>
            </span>
          </span>
          <span className="artifact-viewer__actions input-attachment-text-viewer__actions">
            <a
              aria-label={`下载原文件：${name}`}
              className="artifact-viewer__action artifact-viewer__action--download"
              download
              href={downloadUrl}
              ref={downloadActionRef}
            >
              <DownloadIcon />
              <span>下载</span>
            </a>
            <button
              aria-label={`关闭源码预览：${name}`}
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
          className="artifact-viewer__canvas input-attachment-text-viewer__canvas"
        >
          {state.status === "loading" ? (
            <div className="artifact-viewer__loading" role="status">
              <span aria-hidden="true" />
              <strong>正在载入源码预览</strong>
              <small>原文件仍可直接下载</small>
            </div>
          ) : state.status === "error" ? (
            <div className="artifact-viewer__error" role="alert">
              <AlertIcon />
              <strong>暂时无法载入源码预览</strong>
              <p>请重试，或使用上方下载按钮打开原文件。</p>
              <button onClick={onRetry} ref={retryButtonRef} type="button">
                <RefreshIcon />
                重新载入
              </button>
            </div>
          ) : (
            <div
              aria-label={`${name} ${fileType} 源码预览`}
              className="input-attachment-text-viewer__source"
              ref={(element) => {
                previewFocusRef.current = element;
              }}
              role="region"
              tabIndex={0}
            >
              <div className="input-attachment-text-viewer__source-meta">
                <span>源码预览</span>
                <span>{state.content.lineCount} 行</span>
                {state.content.presentation === "formatted-json-source" ? (
                  <span>JSON 已格式化</span>
                ) : null}
              </div>
              <pre>
                <code>{state.content.source}</code>
              </pre>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export function InputAttachmentTextViewer({
  downloadUrl,
  mimeType,
  name,
  sizeBytes,
}: InputAttachmentTextViewerProps) {
  const [loadRevision, setLoadRevision] = useState(0);
  const [viewerState, setViewerState] =
    useState<InputAttachmentTextViewerLifecycleState>({
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
  const dialogId = `${generatedId}-input-attachment-text-dialog`;
  const titleId = `${generatedId}-input-attachment-text-title`;
  const closeViewer = useCallback(() => {
    activePreviewRequestRef.current = null;
    activePreviewControllerRef.current?.abort();
    activePreviewControllerRef.current = null;
    setViewerState(closeInputAttachmentTextViewerState);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const controller = new AbortController();
    const requestIdentity = {};
    activePreviewControllerRef.current = controller;
    activePreviewRequestRef.current = requestIdentity;

    void loadInputAttachmentSourcePreview(
      downloadUrl,
      mimeType,
      controller.signal,
    )
      .then((preview) => {
        if (
          !inputAttachmentSourcePreviewRequestCanCommit(
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
            !inputAttachmentSourcePreviewRequestCanCommit(
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
      .catch(() => {
        if (
          !inputAttachmentSourcePreviewRequestCanCommit(
            activePreviewRequestRef.current,
            requestIdentity,
            controller.signal.aborted,
          )
        ) {
          return;
        }
        setViewerState((current) =>
          current.isOpen &&
          inputAttachmentSourcePreviewRequestCanCommit(
            activePreviewRequestRef.current,
            requestIdentity,
            controller.signal.aborted,
          )
            ? { ...current, preview: { status: "error" } }
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
  }, [downloadUrl, isOpen, loadRevision, mimeType]);

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

  const fileType = inputAttachmentTypeLabel(mimeType);

  return (
    <>
      <button
        aria-controls={isOpen ? dialogId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={`预览源码：${name}`}
        className="message-input-attachment message-input-attachment--file"
        onClick={openViewer}
        type="button"
      >
        <span className="message-input-attachment__file-icon">
          <DocumentIcon />
          <small>{sourcePreviewShortLabels[mimeType]}</small>
        </span>
        <span className="message-input-attachment__copy">
          <strong>{name}</strong>
          <small>
            {fileType} 源码 · {formatAttachmentBytes(sizeBytes)}
          </small>
        </span>
        <ChevronRightIcon />
      </button>
      {isOpen
        ? createPortal(
            <InputAttachmentTextViewerDialog
              backdropRef={backdropRef}
              closeButtonRef={closeButtonRef}
              dialogRef={dialogRef}
              dialogId={dialogId}
              downloadActionRef={downloadActionRef}
              downloadUrl={downloadUrl}
              mimeType={mimeType}
              name={name}
              onClose={closeViewer}
              onRetry={retryPreview}
              previewFocusRef={previewFocusRef}
              retryButtonRef={retryButtonRef}
              sizeBytes={sizeBytes}
              state={state}
              titleId={titleId}
            />,
            document.body,
          )
        : null}
    </>
  );
}
