"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  parseThemePreference,
  resolveThemePreference,
  serializeThemePreference,
  themePreferenceStorageKey,
  type ThemePreference,
} from "@/components/theme-state";

type ThemeContextValue = {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  preference: "system",
  setPreference: () => undefined,
});
const darkColorSchemeQuery = "(prefers-color-scheme: dark)";

function applyTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): void {
  const resolvedTheme = resolveThemePreference(
    preference,
    systemPrefersDark,
  );
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolvedTheme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] =
    useState<ThemePreference>(() => {
      if (typeof document === "undefined") {
        return "system";
      }
      return (
        parseThemePreference(
          document.documentElement.dataset.themePreference ?? null,
        ) ?? "system"
      );
    });
  const preferenceRef = useRef<ThemePreference>(preference);

  const updatePreference = useCallback((nextPreference: ThemePreference) => {
    preferenceRef.current = nextPreference;
    setPreferenceState(nextPreference);
    applyTheme(
      nextPreference,
      window.matchMedia(darkColorSchemeQuery).matches,
    );
  }, []);

  const setPreference = useCallback(
    (nextPreference: ThemePreference) => {
      try {
        window.localStorage.setItem(
          themePreferenceStorageKey,
          serializeThemePreference(nextPreference),
        );
      } catch {}
      updatePreference(nextPreference);
    },
    [updatePreference],
  );

  useLayoutEffect(() => {
    applyTheme(
      preference,
      window.matchMedia(darkColorSchemeQuery).matches,
    );
  }, [preference]);

  useEffect(() => {
    const colorScheme = window.matchMedia(darkColorSchemeQuery);

    function handleColorSchemeChange(event: MediaQueryListEvent) {
      if (preferenceRef.current === "system") {
        applyTheme("system", event.matches);
      }
    }

    function handleStorage(event: StorageEvent) {
      if (event.key !== themePreferenceStorageKey) {
        return;
      }
      updatePreference(parseThemePreference(event.newValue) ?? "system");
    }

    colorScheme.addEventListener("change", handleColorSchemeChange);
    window.addEventListener("storage", handleStorage);
    return () => {
      colorScheme.removeEventListener("change", handleColorSchemeChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, [updatePreference]);

  return (
    <ThemeContext.Provider value={{ preference, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
