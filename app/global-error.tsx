"use client";

import { useEffect, useLayoutEffect, useState } from "react";

import {
  parseThemePreference,
  themePreferenceStorageKey,
  type ThemePreference,
} from "@/components/theme-state";
import {
  WorkspaceErrorFallback,
  workspaceErrorDocumentClassName,
} from "@/components/workspace-error-fallback";

function readInitialThemePreference(): ThemePreference {
  if (typeof document === "undefined") {
    return "system";
  }

  try {
    const storedPreference = parseThemePreference(
      window.localStorage.getItem(themePreferenceStorageKey),
    );
    if (storedPreference !== null) {
      return storedPreference;
    }
  } catch {}

  return (
    parseThemePreference(
      document.documentElement.dataset.themePreference ?? null,
    ) ??
    parseThemePreference(document.documentElement.dataset.theme ?? null) ??
    "system"
  );
}

export default function GlobalWorkspaceError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const [themePreference] = useState<ThemePreference>(
    readInitialThemePreference,
  );

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = themePreference;
    root.dataset.themePreference = themePreference;
    root.style.colorScheme =
      themePreference === "system" ? "light dark" : themePreference;
  }, [themePreference]);

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html
      data-theme={themePreference}
      data-theme-preference={themePreference}
      lang="zh-CN"
      suppressHydrationWarning
    >
      <head>
        <title>工作区错误 - 外贸研究助手</title>
      </head>
      <body className={workspaceErrorDocumentClassName}>
        <WorkspaceErrorFallback onRetry={retry} />
      </body>
    </html>
  );
}
