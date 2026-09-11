import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClientId } from "@/components/client-id";
import { ChatRequestSchema } from "@/lib/contracts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("client IDs on HTTP", () => {
  it("generates UUID v4 request IDs without crypto.randomUUID", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    });

    const ids = Array.from({ length: 100 }, () => createClientId());
    expect(new Set(ids).size).toBe(ids.length);
    for (const requestId of ids) {
      expect(requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(ChatRequestSchema.safeParse({
        kind: "append",
        conversationId: null,
        parentRunId: null,
        message: "研究目标公司",
        attachmentIds: [],
        requestId,
        executionProfileId: "standard_research",
      }).success).toBe(true);
    }
  });

  it.each([
    [0x00, "00000000-0000-4000-8000-000000000000"],
    [0xff, "ffffffff-ffff-4fff-bfff-ffffffffffff"],
  ])("sets version and variant bits for random byte %i", (byte, expected) => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(byte),
    });
    expect(createClientId()).toBe(expected);
  });
});
