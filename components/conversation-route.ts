import { z } from "zod";

import type { LibraryTab } from "@/components/library-state";

export const ConversationIdSchema = z.string().uuid();
export const ResearchSnapshotIdSchema = z.string().uuid();

export type WorkspaceSurfaceRoute =
  | { kind: "conversation"; conversationId: string | null }
  | {
      kind: "library";
      tab: "research";
      snapshotId: string | null;
    }
  | {
      kind: "library";
      tab: "artifacts";
      snapshotId: null;
    };

export type WorkspaceRouteMatch =
  | { kind: "workspace"; route: WorkspaceSurfaceRoute }
  | { kind: "passthrough" };

export function conversationRoute(conversationId: string): string {
  return `/c/${encodeURIComponent(conversationId)}`;
}

export function libraryRoute(tab: LibraryTab = "research"): string {
  return `/library/${tab}`;
}

export function libraryResearchRoute(snapshotId: string): string {
  return `/library/research/${encodeURIComponent(snapshotId)}`;
}

export function matchWorkspaceRoute(pathname: string): WorkspaceRouteMatch {
  if (pathname === "/") {
    return {
      kind: "workspace",
      route: { kind: "conversation", conversationId: null },
    };
  }

  if (pathname === "/library" || pathname === "/library/research") {
    return {
      kind: "workspace",
      route: { kind: "library", tab: "research", snapshotId: null },
    };
  }

  if (pathname === "/library/artifacts") {
    return {
      kind: "workspace",
      route: { kind: "library", tab: "artifacts", snapshotId: null },
    };
  }

  const researchSnapshotMatch = /^\/library\/research\/([^/]+)$/u.exec(
    pathname,
  );
  if (researchSnapshotMatch !== null) {
    let routeSegment: string;
    try {
      routeSegment = decodeURIComponent(researchSnapshotMatch[1]);
    } catch {
      return { kind: "passthrough" };
    }
    const snapshotId = ResearchSnapshotIdSchema.safeParse(routeSegment);
    return snapshotId.success
      ? {
          kind: "workspace",
          route: {
            kind: "library",
            tab: "research",
            snapshotId: snapshotId.data,
          },
        }
      : { kind: "passthrough" };
  }

  const match = /^\/c\/([^/]+)$/u.exec(pathname);
  if (match === null) {
    return { kind: "passthrough" };
  }
  let routeSegment: string;
  try {
    routeSegment = decodeURIComponent(match[1]);
  } catch {
    return { kind: "passthrough" };
  }
  const conversationId = ConversationIdSchema.safeParse(routeSegment);
  return conversationId.success
    ? {
        kind: "workspace",
        route: { kind: "conversation", conversationId: conversationId.data },
      }
    : { kind: "passthrough" };
}
