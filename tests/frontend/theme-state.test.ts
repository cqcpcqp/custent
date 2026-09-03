import { describe, expect, it } from "vitest";

import {
  parseThemePreference,
  resolveThemePreference,
  serializeThemePreference,
  themeInitializationScript,
  themePreferenceStorageKey,
  themePreferences,
} from "@/components/theme-state";

describe("theme preference state", () => {
  it("uses one stable key and an exact three-value wire contract", () => {
    expect(themePreferenceStorageKey).toBe("custent:theme-preference");
    expect(themePreferences).toEqual(["light", "dark", "system"]);

    for (const preference of themePreferences) {
      expect(parseThemePreference(preference)).toBe(preference);
      expect(serializeThemePreference(preference)).toBe(preference);
    }
  });

  it.each([
    null,
    "",
    "LIGHT",
    "Dark",
    "auto",
    " light ",
    '"dark"',
    "true",
  ])("rejects a non-contract preference value: %s", (value) => {
    expect(parseThemePreference(value)).toBeNull();
  });

  it("resolves system without changing explicit preferences", () => {
    expect(resolveThemePreference("light", true)).toBe("light");
    expect(resolveThemePreference("dark", false)).toBe("dark");
    expect(resolveThemePreference("system", false)).toBe("light");
    expect(resolveThemePreference("system", true)).toBe("dark");
  });

  it("ships the same strict contract in the parser-blocking initializer", () => {
    expect(themeInitializationScript).toContain(themePreferenceStorageKey);
    expect(themeInitializationScript).toContain(
      's==="light"||s==="dark"||s==="system"',
    );
    expect(themeInitializationScript).toContain(
      'window.matchMedia("(prefers-color-scheme: dark)").matches',
    );
    expect(themeInitializationScript).toContain("r.dataset.theme=t");
  });

});
