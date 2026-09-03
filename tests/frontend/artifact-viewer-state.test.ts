import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ARTIFACT_PDF_MAX_ZOOM,
  ARTIFACT_PDF_MIN_ZOOM,
  ArtifactCsvParseError,
  ArtifactPreviewRequestError,
  artifactPdfOutputScale,
  artifactPdfViewportScale,
  artifactPreviewErrorReason,
  artifactPreviewRequestCanCommit,
  closeArtifactViewerState,
  loadArtifactPreview,
  nextArtifactPdfZoom,
  parseArtifactCsv,
} from "@/components/artifact-viewer-state";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("artifact preview loading", () => {
  it("fetches the fixed download URL as a Blob and parses CSV quoting", async () => {
    const csv =
      '\uFEFF"company","note"\r\n"Acme, Inc.","first line\nsecond ""line"""\r\n';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob([csv], { type: "text/csv" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const preview = await loadArtifactPreview(
      "/api/artifacts/10000000-0000-4000-8000-000000000001/download",
      "text/csv",
      controller.signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/artifacts/10000000-0000-4000-8000-000000000001/download",
      {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      },
    );
    expect(preview).toEqual({
      kind: "csv",
      document: {
        columns: ["company", "note"],
        rows: [["Acme, Inc.", 'first line\nsecond "line"']],
      },
    });
  });

  it("returns the downloaded PDF Blob without switching to the download URL", async () => {
    const payload = new Blob(["%PDF-1.7"], { type: "application/pdf" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(payload, { status: 200 })),
    );

    const preview = await loadArtifactPreview(
      "/api/artifacts/10000000-0000-4000-8000-000000000002/download",
      "application/pdf",
      new AbortController().signal,
    );

    expect(preview.kind).toBe("pdf");
    if (preview.kind === "pdf") {
      expect(await preview.blob.text()).toBe("%PDF-1.7");
    }
  });

  it("uses a historical input attachment download URL and its fixed MIME contract unchanged", async () => {
    const downloadUrl =
      "/api/input-attachments/60000000-0000-4000-8000-000000000010/content";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob(["company\r\nAcme\r\n"], { type: "text/csv" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(
      loadArtifactPreview(downloadUrl, "text/csv", controller.signal),
    ).resolves.toEqual({
      kind: "csv",
      document: { columns: ["company"], rows: [["Acme"]] },
    });
    expect(fetchMock).toHaveBeenCalledWith(downloadUrl, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
  });

  it("rejects a failed binary response without interpreting another response shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );

    await expect(
      loadArtifactPreview(
        "/api/artifacts/10000000-0000-4000-8000-000000000003/download",
        "text/csv",
        new AbortController().signal,
      ),
    ).rejects.toEqual(new ArtifactPreviewRequestError(404));
  });

  it("rejects empty and malformed CSV payloads with the typed parse error", async () => {
    for (const csv of ["", '"company","country"\r\n"Acme"\r\n']) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(new Blob([csv], { type: "text/csv" }), {
            status: 200,
          }),
        ),
      );

      await expect(
        loadArtifactPreview(
          "/api/artifacts/10000000-0000-4000-8000-000000000004/download",
          "text/csv",
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(ArtifactCsvParseError);
    }
  });
});

describe("artifact viewer lifecycle state", () => {
  it("drops ready PDF and CSV payload references as part of the close transition", () => {
    const pdfBlob = new Blob(["%PDF-1.7"], { type: "application/pdf" });
    const csvDocument = {
      columns: ["company"],
      rows: [["Acme"]],
    };

    const closedPdf = closeArtifactViewerState({
      isOpen: true,
      preview: {
        status: "ready",
        content: { kind: "pdf", blob: pdfBlob },
      },
    });
    const closedCsv = closeArtifactViewerState({
      isOpen: true,
      preview: {
        status: "ready",
        content: { kind: "csv", document: csvDocument },
      },
    });

    expect(closedPdf).toEqual({
      isOpen: false,
      preview: { status: "loading" },
    });
    expect(closedCsv).toEqual({
      isOpen: false,
      preview: { status: "loading" },
    });
    expect(closedPdf.preview).not.toHaveProperty("content");
    expect(closedCsv.preview).not.toHaveProperty("content");
  });

  it("rejects a late completion after close, abort, retry, or a later open", () => {
    const requestIdentity = {};
    const laterRequestIdentity = {};

    expect(
      artifactPreviewRequestCanCommit(
        requestIdentity,
        requestIdentity,
        false,
      ),
    ).toBe(true);
    expect(
      artifactPreviewRequestCanCommit(null, requestIdentity, false),
    ).toBe(false);
    expect(
      artifactPreviewRequestCanCommit(
        laterRequestIdentity,
        requestIdentity,
        false,
      ),
    ).toBe(false);
    expect(
      artifactPreviewRequestCanCommit(
        requestIdentity,
        requestIdentity,
        true,
      ),
    ).toBe(false);
  });
});

describe("artifact CSV parser", () => {
  it("preserves empty cells and a quoted carriage return", () => {
    expect(
      parseArtifactCsv('"a","b","c"\r\n"","x\ry",""\r\n'),
    ).toEqual({
      columns: ["a", "b", "c"],
      rows: [["", "x\ry", ""]],
    });
  });

  it("rejects malformed rows instead of inventing missing cells", () => {
    expect(() => parseArtifactCsv('"a","b"\r\n"one"\r\n')).toThrow(
      "CSV 文件的数据列数与表头不一致",
    );
    expect(() => parseArtifactCsv('"a","b\r\n')).toThrow(
      "CSV 文件包含未闭合的引号",
    );
  });

  it("rejects empty CSV documents and blank headers as typed parse failures", () => {
    for (const source of ["", "\uFEFF", "\r\n", '"company",""\r\n']) {
      expect(() => parseArtifactCsv(source)).toThrow(ArtifactCsvParseError);
    }
    expect(() => parseArtifactCsv("")).toThrow("CSV 文件为空");
    expect(() => parseArtifactCsv("\r\n")).toThrow(
      "CSV 文件的表头不能为空",
    );
  });

  it("classifies only local CSV parse failures as a fixed invalid-file state", () => {
    expect(
      artifactPreviewErrorReason(new ArtifactCsvParseError("invalid")),
    ).toBe("invalid_csv");
    expect(artifactPreviewErrorReason(new ArtifactPreviewRequestError(503)))
      .toBe("unavailable");
    expect(artifactPreviewErrorReason(new TypeError("network"))).toBe(
      "unavailable",
    );
  });
});

describe("artifact PDF canvas sizing", () => {
  it("fits a page to the available width and applies the selected zoom", () => {
    expect(artifactPdfViewportScale(612, 816, 1)).toBeCloseTo(4 / 3);
    expect(artifactPdfViewportScale(612, 816, 1.5)).toBeCloseTo(2);
  });

  it("steps and clamps zoom within the viewer limits", () => {
    expect(nextArtifactPdfZoom(1, "in")).toBe(1.25);
    expect(nextArtifactPdfZoom(1, "out")).toBe(0.75);
    expect(nextArtifactPdfZoom(ARTIFACT_PDF_MAX_ZOOM, "in")).toBe(
      ARTIFACT_PDF_MAX_ZOOM,
    );
    expect(nextArtifactPdfZoom(ARTIFACT_PDF_MIN_ZOOM, "out")).toBe(
      ARTIFACT_PDF_MIN_ZOOM,
    );
    expect(() => nextArtifactPdfZoom(3, "out")).toThrow(
      "PDF 预览缩放比例无效",
    );
  });

  it("caps HiDPI rendering and rejects impossible dimensions", () => {
    expect(artifactPdfOutputScale(1)).toBe(1);
    expect(artifactPdfOutputScale(3)).toBe(2);
    expect(() => artifactPdfOutputScale(0)).toThrow(
      "PDF 预览像素比例无效",
    );
    expect(() => artifactPdfViewportScale(0, 800, 1)).toThrow(
      "PDF 预览尺寸无效",
    );
    expect(() => artifactPdfViewportScale(600, 800, 3)).toThrow(
      "PDF 预览尺寸无效",
    );
  });
});
