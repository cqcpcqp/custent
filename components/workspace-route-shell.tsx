"use client";

import { usePathname } from "next/navigation";
import { Fragment, type ReactNode } from "react";

import { matchWorkspaceRoute } from "@/components/conversation-route";
import { ResearchWorkspace } from "@/components/research-workspace";

export function WorkspaceRouteShell({ children }: { children: ReactNode }) {
  const route = matchWorkspaceRoute(usePathname());
  if (route.kind === "passthrough") {
    return children;
  }
  return (
    <Fragment>
      <ResearchWorkspace route={route.route} />
      {children}
    </Fragment>
  );
}
