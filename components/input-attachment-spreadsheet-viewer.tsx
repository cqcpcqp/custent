"use client";

import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";

import {
  closeInputAttachmentSpreadsheetPreviewState,
  inputAttachmentSpreadsheetPreviewRequestCanCommit,
  loadInputAttachmentSpreadsheetPreview,
  nextSpreadsheetSheetIndex,
  spreadsheetSheetNavigationDirection,
  spreadsheetPreviewErrorReason,
  type InputAttachmentSpreadsheetPreviewLifecycleState,
  type InputAttachmentSpreadsheetPreviewRenderState,
} from "@/components/input-attachment-spreadsheet-viewer-state";
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

export type InputAttachmentSpreadsheetViewerProps = {
  downloadUrl: string;
  name: string;
  sizeBytes: number;
};

type SpreadsheetDialogProps = InputAttachmentSpreadsheetViewerProps & {
  backdropRef?: RefObject<HTMLDivElement | null>;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  dialogRef?: RefObject<HTMLElement | null>;
  dialogId: string;
  downloadActionRef: RefObject<HTMLAnchorElement | null>;
  onClose: () => void;
  onRetry: () => void;
  previewFocusRef: RefObject<HTMLElement | null>;
  retryButtonRef: RefObject<HTMLButtonElement | null>;
  state: InputAttachmentSpreadsheetPreviewRenderState;
  titleId: string;
};

export function InputAttachmentSpreadsheetViewerDialog({
  backdropRef,
  closeButtonRef,
  dialogRef,
  dialogId,
  downloadActionRef,
  downloadUrl,
  name,
  onClose,
  onRetry,
  previewFocusRef,
  retryButtonRef,
  sizeBytes,
  state,
  titleId,
}: SpreadsheetDialogProps) {
  const [selectedSheetIndex, setSelectedSheetIndex] = useState(0);
  const sheetTabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      event.preventDefault();
      onClose();
    }
  }

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
    sheetCount: number,
  ) {
    const direction = spreadsheetSheetNavigationDirection(event.key);
    if (direction === null) {
      return;
    }
    event.preventDefault();
    const nextIndex = nextSpreadsheetSheetIndex(
      currentIndex,
      direction,
      sheetCount,
    );
    setSelectedSheetIndex(nextIndex);
    sheetTabRefs.current[nextIndex]?.focus();
  }

  const selectedSheet =
    state.status === "ready"
      ? state.content.sheets[selectedSheetIndex]
      : undefined;
  const tabPanelId = `${dialogId}-sheet-panel`;

  return (
    <div
      className="artifact-viewer-backdrop input-attachment-spreadsheet-viewer-backdrop"
      data-modal-layer=""
      onMouseDown={handleBackdropMouseDown}
      ref={backdropRef}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="artifact-viewer input-attachment-spreadsheet-viewer"
        id={dialogId}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="artifact-viewer__header">
          <span className="artifact-viewer__title">
            <span className="artifact-viewer__file input-attachment-spreadsheet-viewer__file">
              <DocumentIcon />
              <small>XLSX</small>
            </span>
            <span>
              <strong id={titleId}>
                <span className="visually-hidden">表格预览：</span>
                {name}
              </strong>
              <small>XLSX · {formatAttachmentBytes(sizeBytes)}</small>
            </span>
          </span>
          <span className="artifact-viewer__actions">
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
              aria-label={`关闭表格预览：${name}`}
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
          className="artifact-viewer__canvas input-attachment-spreadsheet-viewer__canvas"
        >
          {state.status === "loading" ? (
            <div className="artifact-viewer__loading" role="status">
              <span aria-hidden="true" />
              <strong>正在载入 XLSX 预览</strong>
              <small>原文件仍可直接下载</small>
            </div>
          ) : state.status === "error" ? (
            <div className="artifact-viewer__error" role="alert">
              <AlertIcon />
              {state.reason === "invalid_xlsx" ? (
                <>
                  <strong>无法显示 XLSX 表格预览</strong>
                  <p>
                    文件结构或大小超出安全预览范围。你仍可使用上方下载按钮打开原文件。
                  </p>
                </>
              ) : (
                <>
                  <strong>暂时无法载入 XLSX 预览</strong>
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
          ) : selectedSheet === undefined ? (
            <div className="artifact-viewer__error" role="alert">
              <AlertIcon />
              <strong>无法显示 XLSX 表格预览</strong>
            </div>
          ) : (
            <div className="input-attachment-spreadsheet-viewer__workspace">
              <div
                aria-label={`${name} 工作表`}
                className="input-attachment-spreadsheet-viewer__tabs"
                role="tablist"
              >
                {state.content.sheets.map((sheet, index) => {
                  const isSelected = index === selectedSheetIndex;
                  return (
                    <button
                      aria-controls={tabPanelId}
                      aria-selected={isSelected}
                      id={`${dialogId}-sheet-tab-${index}`}
                      key={`${index}-${sheet.name}`}
                      onClick={() => setSelectedSheetIndex(index)}
                      onKeyDown={(event) =>
                        handleTabKeyDown(
                          event,
                          index,
                          state.content.sheets.length,
                        )
                      }
                      ref={(element) => {
                        sheetTabRefs.current[index] = element;
                      }}
                      role="tab"
                      tabIndex={isSelected ? 0 : -1}
                      type="button"
                    >
                      {sheet.name}
                    </button>
                  );
                })}
              </div>
              <div
                aria-labelledby={`${dialogId}-sheet-tab-${selectedSheetIndex}`}
                className="artifact-viewer__sheet input-attachment-spreadsheet-viewer__sheet"
                id={tabPanelId}
                ref={(element) => {
                  previewFocusRef.current = element;
                }}
                role="tabpanel"
                tabIndex={0}
              >
                <div className="artifact-viewer__sheet-meta input-attachment-spreadsheet-viewer__sheet-meta">
                  <span>只读预览</span>
                  <span>{selectedSheet.rows.length} 行</span>
                  <span>{selectedSheet.columnLabels.length} 列</span>
                </div>
                {selectedSheet.columnLabels.length === 0 ? (
                  <div className="input-attachment-spreadsheet-viewer__empty">
                    <DocumentIcon />
                    <strong>这个工作表没有可显示的单元格</strong>
                  </div>
                ) : (
                  <table>
                    <caption className="visually-hidden">
                      {selectedSheet.name}，共 {selectedSheet.rows.length} 行、
                      {selectedSheet.columnLabels.length} 列
                    </caption>
                    <thead>
                      <tr>
                        <th aria-label="行号" className="input-attachment-spreadsheet-viewer__row-heading" />
                        {selectedSheet.columnLabels.map((label) => (
                          <th key={label} scope="col">
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {selectedSheet.rows.map((row, rowIndex) => (
                        <tr key={selectedSheet.rowNumbers[rowIndex]}>
                          <th
                            className="input-attachment-spreadsheet-viewer__row-heading"
                            scope="row"
                          >
                            {selectedSheet.rowNumbers[rowIndex]}
                          </th>
                          {row.map((cell, columnIndex) => (
                            <td key={selectedSheet.columnLabels[columnIndex]}>
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export function InputAttachmentSpreadsheetViewer({
  downloadUrl,
  name,
  sizeBytes,
}: InputAttachmentSpreadsheetViewerProps) {
  const [loadRevision, setLoadRevision] = useState(0);
  const [viewerState, setViewerState] =
    useState<InputAttachmentSpreadsheetPreviewLifecycleState>({
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
  const dialogId = `${generatedId}-input-attachment-spreadsheet-dialog`;
  const titleId = `${generatedId}-input-attachment-spreadsheet-title`;

  const closeViewer = useCallback(() => {
    activePreviewRequestRef.current = null;
    activePreviewControllerRef.current?.abort();
    activePreviewControllerRef.current = null;
    setViewerState(closeInputAttachmentSpreadsheetPreviewState);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const controller = new AbortController();
    const requestIdentity = {};
    activePreviewControllerRef.current = controller;
    activePreviewRequestRef.current = requestIdentity;

    void loadInputAttachmentSpreadsheetPreview(downloadUrl, controller.signal)
      .then((preview) => {
        if (
          !inputAttachmentSpreadsheetPreviewRequestCanCommit(
            activePreviewRequestRef.current,
            requestIdentity,
            controller.signal.aborted,
          )
        ) {
          return;
        }
        setViewerState((current) =>
          current.isOpen &&
          inputAttachmentSpreadsheetPreviewRequestCanCommit(
            activePreviewRequestRef.current,
            requestIdentity,
            controller.signal.aborted,
          )
            ? { ...current, preview: { status: "ready", content: preview } }
            : current,
        );
      })
      .catch((error: unknown) => {
        if (
          !inputAttachmentSpreadsheetPreviewRequestCanCommit(
            activePreviewRequestRef.current,
            requestIdentity,
            controller.signal.aborted,
          )
        ) {
          return;
        }
        setViewerState((current) =>
          current.isOpen &&
          inputAttachmentSpreadsheetPreviewRequestCanCommit(
            activePreviewRequestRef.current,
            requestIdentity,
            controller.signal.aborted,
          )
            ? {
                ...current,
                preview: {
                  status: "error",
                  reason: spreadsheetPreviewErrorReason(error),
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
  }, [downloadUrl, isOpen, loadRevision]);

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
    setViewerState({ isOpen: true, preview: { status: "loading" } });
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
        aria-label={`预览表格：${name}`}
        className="message-input-attachment message-input-attachment--file"
        onClick={openViewer}
        type="button"
      >
        <span className="message-input-attachment__file-icon input-attachment-spreadsheet-viewer__trigger-icon">
          <DocumentIcon />
          <small>XLSX</small>
        </span>
        <span className="message-input-attachment__copy">
          <strong>{name}</strong>
          <small>XLSX · {formatAttachmentBytes(sizeBytes)}</small>
        </span>
        <ChevronRightIcon />
      </button>
      {isOpen
        ? createPortal(
            <InputAttachmentSpreadsheetViewerDialog
              backdropRef={backdropRef}
              closeButtonRef={closeButtonRef}
              dialogRef={dialogRef}
              dialogId={dialogId}
              downloadActionRef={downloadActionRef}
              downloadUrl={downloadUrl}
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
