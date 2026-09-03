"use client";

import { useEffect } from "react";

import { WorkspaceErrorFallback } from "@/components/workspace-error-fallback";

export default function WorkspaceError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return <WorkspaceErrorFallback onRetry={retry} />;
}
