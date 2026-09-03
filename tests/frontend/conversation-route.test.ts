import { describe, expect, it } from "vitest";

import {
  conversationRoute,
  libraryResearchRoute,
  libraryRoute,
  matchWorkspaceRoute,
} from "@/components/conversation-route";

describe("conversationRoute", () => {
  it("creates the ChatGPT-style conversation path", () => {
    expect(
      conversationRoute("11111111-1111-4111-8111-111111111111"),
    ).toBe("/c/11111111-1111-4111-8111-111111111111");
  });

  it("creates the fixed library paths", () => {
    expect(libraryRoute()).toBe("/library/research");
    expect(libraryRoute("research")).toBe("/library/research");
    expect(libraryRoute("artifacts")).toBe("/library/artifacts");
    expect(
      libraryResearchRoute("22222222-2222-4222-8222-222222222222"),
    ).toBe("/library/research/22222222-2222-4222-8222-222222222222");
    expect(libraryResearchRoute("snapshot/with?segments")).toBe(
      "/library/research/snapshot%2Fwith%3Fsegments",
    );
  });

  it("encodes path-breaking input even though callers use UUID contracts", () => {
    expect(conversationRoute("conversation/with?segments")).toBe(
      "/c/conversation%2Fwith%3Fsegments",
    );
  });

  it("matches only the fixed workspace URL contract", () => {
    expect(matchWorkspaceRoute("/")).toEqual({
      kind: "workspace",
      route: { kind: "conversation", conversationId: null },
    });
    expect(
      matchWorkspaceRoute("/c/11111111-1111-4111-8111-111111111111"),
    ).toEqual({
      kind: "workspace",
      route: {
        kind: "conversation",
        conversationId: "11111111-1111-4111-8111-111111111111",
      },
    });
    expect(
      matchWorkspaceRoute("/c/%31%31%31%31%31%31%31%31-1111-4111-8111-111111111111"),
    ).toEqual({
      kind: "workspace",
      route: {
        kind: "conversation",
        conversationId: "11111111-1111-4111-8111-111111111111",
      },
    });
    expect(matchWorkspaceRoute("/library")).toEqual({
      kind: "workspace",
      route: { kind: "library", tab: "research", snapshotId: null },
    });
    expect(matchWorkspaceRoute("/library/research")).toEqual({
      kind: "workspace",
      route: { kind: "library", tab: "research", snapshotId: null },
    });
    expect(matchWorkspaceRoute("/library/artifacts")).toEqual({
      kind: "workspace",
      route: { kind: "library", tab: "artifacts", snapshotId: null },
    });
    expect(
      matchWorkspaceRoute(
        "/library/research/22222222-2222-4222-8222-222222222222",
      ),
    ).toEqual({
      kind: "workspace",
      route: {
        kind: "library",
        tab: "research",
        snapshotId: "22222222-2222-4222-8222-222222222222",
      },
    });
    expect(
      matchWorkspaceRoute(
        "/library/research/%32%32%32%32%32%32%32%32-2222-4222-8222-222222222222",
      ),
    ).toEqual({
      kind: "workspace",
      route: {
        kind: "library",
        tab: "research",
        snapshotId: "22222222-2222-4222-8222-222222222222",
      },
    });
    expect(matchWorkspaceRoute("/c/not-a-uuid")).toEqual({
      kind: "passthrough",
    });
    expect(matchWorkspaceRoute("/c/%E0%A4%A")).toEqual({
      kind: "passthrough",
    });
    expect(matchWorkspaceRoute("/library/research/not-a-uuid")).toEqual({
      kind: "passthrough",
    });
    expect(matchWorkspaceRoute("/library/research/%E0%A4%A")).toEqual({
      kind: "passthrough",
    });
    expect(matchWorkspaceRoute("/library/another-page")).toEqual({
      kind: "passthrough",
    });
    expect(matchWorkspaceRoute("/library/artifacts/another-page")).toEqual({
      kind: "passthrough",
    });
    expect(matchWorkspaceRoute("/another-page")).toEqual({
      kind: "passthrough",
    });
  });
});
