"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist";

import {
  ARTIFACT_PDF_MAX_ZOOM,
  ARTIFACT_PDF_MIN_ZOOM,
  artifactPdfOutputScale,
  artifactPdfViewportScale,
  nextArtifactPdfZoom,
} from "@/components/artifact-viewer-state";
import { AlertIcon, RefreshIcon } from "@/components/icons";

const PDF_PAGE_HORIZONTAL_GUTTER = 48;

type PdfDocumentState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; document: PDFDocumentProxy };

type ArtifactPdfPreviewProps = {
  blob: Blob;
  fileName: string;
  onRetry: () => void;
  previewFocusRef: RefObject<HTMLElement | null>;
};

async function loadPdfJs() {
  const pdfjs = await import("pdfjs-dist");

  // PDF.js requires an explicit worker source. This URL form lets Next emit
  // the installed, version-matched module worker as a local build asset.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  return pdfjs;
}

type ArtifactPdfPageProps = {
  availableWidth: number;
  document: PDFDocumentProxy;
  onRenderError: () => void;
  pageCount: number;
  pageNumber: number;
  scrollRootRef: RefObject<HTMLDivElement | null>;
  zoom: number;
};

type ArtifactPdfPageCanvasProps = Omit<
  ArtifactPdfPageProps,
  "pageCount" | "scrollRootRef"
> & {
  onRendered: (size: { height: number; width: number }) => void;
};

function ArtifactPdfPageCanvas({
  availableWidth,
  document,
  onRenderError,
  onRendered,
  pageNumber,
  zoom,
}: ArtifactPdfPageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"loading" | "ready">("loading");

  useEffect(() => {
    let disposed = false;
    let page: PDFPageProxy | null = null;
    let renderTask: RenderTask | null = null;

    async function renderPage() {
      try {
        page = await document.getPage(pageNumber);
        if (disposed) {
          return;
        }

        const canvas = canvasRef.current;
        if (canvas === null) {
          throw new Error("PDF 预览画布不存在");
        }
        const context = canvas.getContext("2d", { alpha: false });
        if (context === null) {
          throw new Error("PDF 预览画布不可用");
        }

        const baseViewport = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: artifactPdfViewportScale(
            baseViewport.width,
            availableWidth,
            zoom,
          ),
        });
        const outputScale = artifactPdfOutputScale(window.devicePixelRatio);

        canvas.width = Math.ceil(viewport.width * outputScale);
        canvas.height = Math.ceil(viewport.height * outputScale);
        canvas.style.width = `${Math.ceil(viewport.width)}px`;
        canvas.style.height = `${Math.ceil(viewport.height)}px`;

        renderTask = page.render({
          canvas,
          canvasContext: context,
          transform:
            outputScale === 1
              ? undefined
              : [outputScale, 0, 0, outputScale, 0, 0],
          viewport,
        });
        await renderTask.promise;

        if (!disposed) {
          onRendered({
            height: Math.ceil(viewport.height),
            width: Math.ceil(viewport.width),
          });
          setStatus("ready");
        }
      } catch {
        if (!disposed) {
          onRenderError();
        }
      } finally {
        page?.cleanup();
      }
    }

    void renderPage();

    return () => {
      disposed = true;
      renderTask?.cancel();
    };
  }, [availableWidth, document, onRenderError, onRendered, pageNumber, zoom]);

  return (
    <>
      {status === "loading" ? (
        <span className="artifact-viewer__pdf-page-loading" role="status">
          正在渲染第 {pageNumber} 页
        </span>
      ) : null}
      <canvas
        aria-label={`第 ${pageNumber} 页`}
        className={
          status === "ready"
            ? "artifact-viewer__pdf-page-canvas artifact-viewer__pdf-page-canvas--ready"
            : "artifact-viewer__pdf-page-canvas"
        }
        ref={canvasRef}
        role="img"
      />
    </>
  );
}

function ArtifactPdfPage({
  availableWidth,
  document,
  onRenderError,
  pageCount,
  pageNumber,
  scrollRootRef,
  zoom,
}: ArtifactPdfPageProps) {
  const [isNearViewport, setIsNearViewport] = useState(false);
  const [isCanvasReady, setIsCanvasReady] = useState(false);
  const [renderedSize, setRenderedSize] = useState<{
    height: number;
    width: number;
  } | null>(null);
  const pageRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const pageElement = pageRef.current;
    const scrollRoot = scrollRootRef.current;
    if (pageElement === null || scrollRoot === null) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsNearViewport(entry.isIntersecting);
        if (entry.isIntersecting) {
          setIsCanvasReady(false);
        }
      },
      {
        root: scrollRoot,
        rootMargin: "800px 0px",
      },
    );
    observer.observe(pageElement);

    return () => {
      observer.disconnect();
    };
  }, [scrollRootRef]);

  const handleRendered = useCallback(
    (size: { height: number; width: number }) => {
      setRenderedSize(size);
      setIsCanvasReady(true);
    },
    [],
  );

  const placeholderWidth = Math.ceil(availableWidth * zoom);
  const pageSize = renderedSize ?? {
    height: Math.ceil(placeholderWidth * Math.SQRT2),
    width: placeholderWidth,
  };

  return (
    <figure
      aria-busy={isNearViewport && !isCanvasReady}
      aria-label={`第 ${pageNumber} 页，共 ${pageCount} 页`}
      className="artifact-viewer__pdf-page"
      ref={pageRef}
      style={{ height: pageSize.height, width: pageSize.width }}
    >
      {isNearViewport ? (
        <ArtifactPdfPageCanvas
          availableWidth={availableWidth}
          document={document}
          onRendered={handleRendered}
          onRenderError={onRenderError}
          pageNumber={pageNumber}
          zoom={zoom}
        />
      ) : (
        <span
          aria-hidden="true"
          className="artifact-viewer__pdf-page-placeholder"
        >
          第 {pageNumber} 页
        </span>
      )}
      <figcaption>
        {pageNumber} / {pageCount}
      </figcaption>
    </figure>
  );
}

export function ArtifactPdfPreview({
  blob,
  fileName,
  onRetry,
  previewFocusRef,
}: ArtifactPdfPreviewProps) {
  const [documentState, setDocumentState] = useState<PdfDocumentState>({
    status: "loading",
  });
  const [availableWidth, setAvailableWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;

    async function loadDocument() {
      try {
        const [pdfjs, data] = await Promise.all([
          loadPdfJs(),
          blob.arrayBuffer(),
        ]);
        if (disposed) {
          return;
        }

        loadingTask = pdfjs.getDocument({ data });
        loadingTaskRef.current = loadingTask;
        const document = await loadingTask.promise;
        if (!disposed) {
          setDocumentState({ status: "ready", document });
        }
      } catch {
        if (loadingTaskRef.current === loadingTask) {
          loadingTaskRef.current = null;
          void loadingTask?.destroy();
        }
        if (!disposed) {
          setDocumentState({ status: "error" });
        }
      }
    }

    void loadDocument();

    return () => {
      disposed = true;
      if (loadingTaskRef.current === loadingTask) {
        loadingTaskRef.current = null;
        void loadingTask?.destroy();
      }
    };
  }, [blob]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (scrollElement === null) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      setAvailableWidth(
        Math.max(
          1,
          Math.floor(entry.contentRect.width - PDF_PAGE_HORIZONTAL_GUTTER),
        ),
      );
    });
    observer.observe(scrollElement);

    return () => {
      observer.disconnect();
    };
  }, []);

  const handleRenderError = useCallback(() => {
    const loadingTask = loadingTaskRef.current;
    loadingTaskRef.current = null;
    void loadingTask?.destroy();
    setDocumentState({ status: "error" });
  }, []);

  const pageCount =
    documentState.status === "ready" ? documentState.document.numPages : 0;
  const isLoading =
    documentState.status === "loading" ||
    (documentState.status === "ready" && availableWidth === 0);

  return (
    <div
      aria-busy={isLoading}
      aria-label={`${fileName} PDF 文档预览`}
      className="artifact-viewer__pdf"
      ref={(element) => {
        scrollRef.current = element;
        previewFocusRef.current = element;
      }}
      role="region"
      tabIndex={0}
    >
      {documentState.status === "error" ? (
        <div
          className="artifact-viewer__error artifact-viewer__pdf-message"
          role="alert"
        >
          <AlertIcon />
          <strong>暂时无法渲染 PDF</strong>
          <p>请重新载入，或使用上方下载按钮打开原文件。</p>
          <button onClick={onRetry} type="button">
            <RefreshIcon />
            重新载入
          </button>
        </div>
      ) : isLoading ? (
        <div
          className="artifact-viewer__loading artifact-viewer__pdf-message"
          role="status"
        >
          <span aria-hidden="true" />
          <strong>正在解析 PDF 文档</strong>
          <small>页面将在载入后自动适应窗口宽度</small>
        </div>
      ) : documentState.status === "ready" ? (
        <>
          <div
            aria-label="PDF 缩放工具"
            className="artifact-viewer__pdf-toolbar"
            role="toolbar"
          >
            <span>{pageCount} 页</span>
            <span className="artifact-viewer__pdf-zoom">
              <button
                aria-label="缩小 PDF"
                disabled={zoom === ARTIFACT_PDF_MIN_ZOOM}
                onClick={() =>
                  setZoom((current) => nextArtifactPdfZoom(current, "out"))
                }
                type="button"
              >
                −
              </button>
              <button
                aria-label="恢复 PDF 适应宽度"
                disabled={zoom === 1}
                onClick={() => setZoom(1)}
                type="button"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                aria-label="放大 PDF"
                disabled={zoom === ARTIFACT_PDF_MAX_ZOOM}
                onClick={() =>
                  setZoom((current) => nextArtifactPdfZoom(current, "in"))
                }
                type="button"
              >
                +
              </button>
            </span>
          </div>
          <div className="artifact-viewer__pdf-pages">
            {Array.from({ length: pageCount }, (_, index) => {
              const pageNumber = index + 1;
              return (
                <ArtifactPdfPage
                  availableWidth={availableWidth}
                  document={documentState.document}
                  key={`${pageNumber}-${availableWidth}-${zoom}`}
                  onRenderError={handleRenderError}
                  pageCount={pageCount}
                  pageNumber={pageNumber}
                  scrollRootRef={scrollRef}
                  zoom={zoom}
                />
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
