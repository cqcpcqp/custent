import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));

vi.mock("@/components/research-workspace", () => ({
  ResearchWorkspace: ({
    route,
  }: {
    route:
      | { kind: "conversation"; conversationId: string | null }
      | { kind: "library"; tab: "research"; snapshotId: string | null }
      | { kind: "library"; tab: "artifacts"; snapshotId: null };
  }) => (
    <div
      data-route={
        route.kind === "conversation"
          ? `conversation:${route.conversationId ?? "new"}`
          : `library:${route.tab}:${route.snapshotId ?? "index"}`
      }
    >
      persistent workspace
    </div>
  ),
}));

import { WorkspaceRouteShell } from "@/components/workspace-route-shell";

function renderShell(pathname: string): string {
  mocks.pathname = pathname;
  return renderToStaticMarkup(
    <WorkspaceRouteShell>
      <main>route content</main>
    </WorkspaceRouteShell>,
  );
}

describe("workspace route shell", () => {
  beforeEach(() => {
    mocks.pathname = "/";
  });

  it("renders one shared workspace for both new and existing conversations", () => {
    const newConversation = renderShell("/");
    const existingConversation = renderShell(
      "/c/11111111-1111-4111-8111-111111111111",
    );

    expect(newConversation).toContain('data-route="conversation:new"');
    expect(newConversation).toContain("<main>route content</main>");
    expect(existingConversation).toContain(
      'data-route="conversation:11111111-1111-4111-8111-111111111111"',
    );
    expect(existingConversation).toContain("<main>route content</main>");
  });

  it("renders library surfaces through the same persistent workspace", () => {
    const libraryAlias = renderShell("/library");
    const research = renderShell("/library/research");
    const artifacts = renderShell("/library/artifacts");
    const snapshot = renderShell(
      "/library/research/22222222-2222-4222-8222-222222222222",
    );

    expect(libraryAlias).toContain('data-route="library:research:index"');
    expect(research).toContain('data-route="library:research:index"');
    expect(artifacts).toContain('data-route="library:artifacts:index"');
    expect(libraryAlias).toContain("<main>route content</main>");
    expect(research).toContain("<main>route content</main>");
    expect(artifacts).toContain("<main>route content</main>");
    expect(snapshot).toContain(
      'data-route="library:research:22222222-2222-4222-8222-222222222222"',
    );
    expect(snapshot).toContain("<main>route content</main>");
  });

  it("passes non-workspace and invalid conversation routes to Next", () => {
    expect(renderShell("/another-page")).toBe("<main>route content</main>");
    expect(renderShell("/c/not-a-uuid")).toBe("<main>route content</main>");
  });
});
