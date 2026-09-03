export const themePreferenceStorageKey = "custent:theme-preference";

export const themePreferences = ["light", "dark", "system"] as const;

export type ThemePreference = (typeof themePreferences)[number];
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export function parseThemePreference(
  value: string | null,
): ThemePreference | null {
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }
  return null;
}

export function serializeThemePreference(
  preference: ThemePreference,
): ThemePreference {
  return preference;
}

export function resolveThemePreference(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") {
    return systemPrefersDark ? "dark" : "light";
  }
  return preference;
}

const serializedThemeStorageKey = JSON.stringify(themePreferenceStorageKey);

/** Runs synchronously in the document head before the browser's first paint. */
export const themeInitializationScript = `(function(){try{var s=window.localStorage.getItem(${serializedThemeStorageKey});var p=s==="light"||s==="dark"||s==="system"?s:"system";var t=p==="system"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p;var r=document.documentElement;r.dataset.theme=t;r.dataset.themePreference=p;r.style.colorScheme=t}catch(e){}})();`;
