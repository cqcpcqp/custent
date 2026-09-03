import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiClientError,
  ApiNetworkError,
  fetchApiResponse,
  getBootstrap,
  isApiAbortError,
  userFacingRequestErrorMessage,
} from "@/components/api-client";
import { accountUsageErrorMessage } from "@/components/account-usage-state";
import { customInstructionsErrorMessage } from "@/components/custom-instructions-settings-state";
import {
  LibraryApiError,
  libraryErrorMessage,
} from "@/components/library-state";
import { sharedLinksErrorMessage } from "@/components/shared-links-manager-state";
import { ApiErrorResponseSchema } from "@/lib/contracts";

const sensitiveDetails =
  "SELECT api_key FROM users; https://provider.internal.example/v1/responses";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("safe API error presentation", () => {
  it.each([
    ["INSUFFICIENT_CREDITS", 402, "可用积分不足，暂时无法开始这次研究。"],
    ["NOT_FOUND", 404, "请求的内容不存在或已不可用。"],
    ["RUN_IN_PROGRESS", 409, "该对话正在处理另一项任务，请稍后再试。"],
    ["INTERNAL_ERROR", 500, "服务暂时无法完成这个请求，请稍后重试。"],
  ] as const)(
    "maps the exact %s/%s pair without rendering its backend message",
    (code, status, expected) => {
      const error = new ApiClientError(code, sensitiveDetails, status);

      expect(userFacingRequestErrorMessage(error, "固定通用文案")).toBe(
        expected,
      );
      expect(error.message).toBe("服务请求失败");
      expect(error.message).not.toContain(sensitiveDetails);
    },
  );

  it("rejects unknown or mismatched API contracts without a presentation fallback", () => {
    for (const error of [
      new ApiClientError("NOT_FOUND", sensitiveDetails, 500),
      new ApiClientError("PROVIDER_PRIVATE_ERROR", sensitiveDetails, 502),
    ]) {
      expect(() =>
        userFacingRequestErrorMessage(error, "固定通用文案"),
      ).toThrow("API error code/status contract violation");
    }

    expect(() =>
      ApiErrorResponseSchema.parse({
        error: { code: "PROVIDER_PRIVATE_ERROR", message: sensitiveDetails },
      }),
    ).toThrow();
    expect(() =>
      ApiErrorResponseSchema.parse({
        error: {
          code: "NOT_FOUND",
          message: sensitiveDetails,
          internalUrl: "https://provider.internal.example",
        },
      }),
    ).toThrow();
    expect(() =>
      ApiErrorResponseSchema.parse({
        error: { code: "NOT_FOUND", message: sensitiveDetails },
        requestId: "internal-request",
      }),
    ).toThrow();
  });

  it("uses fixed generic messages only for non-API client failures", () => {
    for (const error of [new Error(sensitiveDetails), { message: sensitiveDetails }]) {
      const message = userFacingRequestErrorMessage(error, "固定通用文案");
      expect(message).toBe("固定通用文案");
      expect(message).not.toContain("provider.internal.example");
      expect(message).not.toContain("SELECT api_key");
    }
  });

  it("rejects a valid error code paired with the wrong HTTP status at the API boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        Response.json(
          { error: { code: "NOT_FOUND", message: sensitiveDetails } },
          { status: 500 },
        ),
      ),
    );

    await expect(getBootstrap()).rejects.toThrow(
      "API error code/status contract violation",
    );
  });

  it("gives every audited feature a fixed non-sensitive generic message", () => {
    const error = new Error(sensitiveDetails);
    const messages = [
      accountUsageErrorMessage(error),
      customInstructionsErrorMessage(error),
      libraryErrorMessage(error),
      sharedLinksErrorMessage(error),
    ];

    expect(messages).toEqual([
      "暂时无法加载积分与用量，请重试。",
      "自定义指令请求暂时失败，请重试。",
      "资料库请求暂时失败，请重试。",
      "共享链接请求暂时失败，请重试。",
    ]);
    for (const message of messages) {
      expect(message).not.toContain(sensitiveDetails);
    }
  });

  it("discards Library API messages while retaining exact code/status", () => {
    const error = new LibraryApiError("NOT_FOUND", sensitiveDetails, 404);

    expect(error).toMatchObject({
      code: "NOT_FOUND",
      message: "服务请求失败",
      status: 404,
    });
    expect(libraryErrorMessage(error)).toBe(
      "请求的内容不存在或已不可用。",
    );
  });

  it("normalizes network failures and preserves abort cancellation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError(sensitiveDetails)),
    );
    await expect(fetchApiResponse("/api/bootstrap")).rejects.toBeInstanceOf(
      ApiNetworkError,
    );

    const abort = new DOMException(sensitiveDetails, "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValueOnce(abort),
    );
    await expect(fetchApiResponse("/api/bootstrap")).rejects.toBe(abort);
    expect(isApiAbortError(abort)).toBe(true);
  });
});
