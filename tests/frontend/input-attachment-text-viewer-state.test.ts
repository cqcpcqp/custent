import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InputAttachmentSourceInvariantError,
  InputAttachmentSourcePreviewRequestError,
  closeInputAttachmentTextViewerState,
  inputAttachmentSourcePreviewRequestCanCommit,
  isInputAttachmentSourcePreviewMimeType,
  loadInputAttachmentSourcePreview,
  prepareInputAttachmentSourcePreview,
} from "@/components/input-attachment-text-viewer-state";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("input attachment source preview loading", () => {
  it("fetches the fixed private content URL without caching and preserves TXT source", async () => {
    const source = "first\r\n<script>alert('source only')</script>\r\n";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(source, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const downloadUrl =
      "/api/input-attachments/60000000-0000-4000-8000-000000000020/content";

    await expect(
      loadInputAttachmentSourcePreview(
        downloadUrl,
        "text/plain",
        controller.signal,
      ),
    ).resolves.toEqual({
      lineCount: 3,
      presentation: "source",
      source,
    });
    expect(fetchMock).toHaveBeenCalledWith(downloadUrl, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
  });

  it("keeps Markdown as source instead of activating rich content", () => {
    const source = "# Buyers\n\n![remote](https://example.com/pixel.png)";

    expect(
      prepareInputAttachmentSourcePreview(source, "text/markdown"),
    ).toEqual({
      lineCount: 3,
      presentation: "source",
      source,
    });
  });

  it("formats validated JSON while retaining explicit source semantics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"company":"Acme","countries":["US","DE"]}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      loadInputAttachmentSourcePreview(
        "/api/input-attachments/60000000-0000-4000-8000-000000000021/content",
        "application/json",
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      lineCount: 7,
      presentation: "formatted-json-source",
      source:
        '{\n  "company": "Acme",\n  "countries": [\n    "US",\n    "DE"\n  ]\n}',
    });
  });

  it("formats JSON without rounding numeric lexemes or removing duplicate keys", () => {
    expect(
      prepareInputAttachmentSourcePreview(
        '{"id":9223372036854775807,"duplicate":1,"duplicate":2,"note":"a, b: c"}',
        "application/json",
      ),
    ).toEqual({
      lineCount: 6,
      presentation: "formatted-json-source",
      source:
        '{\n  "id": 9223372036854775807,\n  "duplicate": 1,\n  "duplicate": 2,\n  "note": "a, b: c"\n}',
    });
  });

  it("treats invalid JSON as a violated upload invariant instead of falling back to raw text", () => {
    expect(() =>
      prepareInputAttachmentSourcePreview("{invalid", "application/json"),
    ).toThrow(InputAttachmentSourceInvariantError);
    expect(() =>
      prepareInputAttachmentSourcePreview("{invalid", "application/json"),
    ).toThrow("Validated JSON input attachment contained invalid JSON");
  });

  it("rejects a non-success response without interpreting another response shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "NOT_FOUND", message: "附件不存在。" },
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    await expect(
      loadInputAttachmentSourcePreview(
        "/api/input-attachments/60000000-0000-4000-8000-000000000022/content",
        "text/plain",
        new AbortController().signal,
      ),
    ).rejects.toEqual(new InputAttachmentSourcePreviewRequestError(404));
  });

  it("recognizes exactly the three source-preview MIME types", () => {
    expect(isInputAttachmentSourcePreviewMimeType("text/plain")).toBe(true);
    expect(isInputAttachmentSourcePreviewMimeType("text/markdown")).toBe(
      true,
    );
    expect(isInputAttachmentSourcePreviewMimeType("application/json")).toBe(
      true,
    );
    expect(isInputAttachmentSourcePreviewMimeType("text/csv")).toBe(false);
    expect(isInputAttachmentSourcePreviewMimeType("application/pdf")).toBe(
      false,
    );
    expect(
      isInputAttachmentSourcePreviewMimeType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(false);
  });
});

describe("input attachment source preview lifecycle", () => {
  it("drops loaded source when the viewer closes", () => {
    expect(
      closeInputAttachmentTextViewerState({
        isOpen: true,
        preview: {
          status: "ready",
          content: {
            lineCount: 1,
            presentation: "source",
            source: "buyers",
          },
        },
      }),
    ).toEqual({
      isOpen: false,
      preview: { status: "loading" },
    });
  });

  it("rejects late completion after close, abort, retry, or a later open", () => {
    const requestIdentity = {};
    const laterRequestIdentity = {};

    expect(
      inputAttachmentSourcePreviewRequestCanCommit(
        requestIdentity,
        requestIdentity,
        false,
      ),
    ).toBe(true);
    expect(
      inputAttachmentSourcePreviewRequestCanCommit(
        null,
        requestIdentity,
        false,
      ),
    ).toBe(false);
    expect(
      inputAttachmentSourcePreviewRequestCanCommit(
        laterRequestIdentity,
        requestIdentity,
        false,
      ),
    ).toBe(false);
    expect(
      inputAttachmentSourcePreviewRequestCanCommit(
        requestIdentity,
        requestIdentity,
        true,
      ),
    ).toBe(false);
  });

});
