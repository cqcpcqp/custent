import { describe, expect, it } from "vitest";

import {
  followLatestRunActivity,
  rememberRunActivityScrollPosition,
  restoreRunActivityScrollPosition,
} from "@/components/run-activity";

describe("run activity panel scroll memory", () => {
  it("restores each run independently when switching away and back", () => {
    const positions = new Map();
    const container = {
      scrollTop: 420,
      scrollHeight: 2_000,
      clientHeight: 500,
    };

    rememberRunActivityScrollPosition(positions, "run-a", container);
    restoreRunActivityScrollPosition(positions, "run-b", container);
    expect(container.scrollTop).toBe(0);

    container.scrollTop = 85;
    rememberRunActivityScrollPosition(positions, "run-b", container);
    restoreRunActivityScrollPosition(positions, "run-a", container);
    expect(container.scrollTop).toBe(420);

    restoreRunActivityScrollPosition(positions, "run-b", container);
    expect(container.scrollTop).toBe(85);
    expect(positions.get("run-a")?.scrollTop).toBe(420);
    expect(positions.get("run-b")?.scrollTop).toBe(85);
  });

  it("refreshes the stored position when the same run scrolls again", () => {
    const positions = new Map();
    const container = {
      scrollTop: 120,
      scrollHeight: 2_000,
      clientHeight: 500,
    };

    rememberRunActivityScrollPosition(positions, "run-a", container);
    container.scrollTop = 760;
    rememberRunActivityScrollPosition(positions, "run-a", container);
    container.scrollTop = 0;
    restoreRunActivityScrollPosition(positions, "run-a", container);

    expect(container.scrollTop).toBe(760);
    expect(positions.size).toBe(1);
  });

  it("follows new activity when the user was near the bottom", () => {
    const positions = new Map();
    const container = {
      scrollTop: 1_452,
      scrollHeight: 2_000,
      clientHeight: 500,
    };

    rememberRunActivityScrollPosition(positions, "run-a", container);
    container.scrollHeight = 2_400;

    expect(followLatestRunActivity(positions, "run-a", container)).toBe(true);
    expect(container.scrollTop).toBe(1_900);
    expect(positions.get("run-a")?.stickToBottom).toBe(true);
  });

  it("does not steal the scroll position after the user scrolls up", () => {
    const positions = new Map();
    const container = {
      scrollTop: 700,
      scrollHeight: 2_000,
      clientHeight: 500,
    };

    rememberRunActivityScrollPosition(positions, "run-a", container);
    container.scrollHeight = 2_400;

    expect(followLatestRunActivity(positions, "run-a", container)).toBe(false);
    expect(container.scrollTop).toBe(700);
  });

  it("restores a sticky run to its latest activity after switching back", () => {
    const positions = new Map();
    const container = {
      scrollTop: 1_500,
      scrollHeight: 2_000,
      clientHeight: 500,
    };

    rememberRunActivityScrollPosition(positions, "run-a", container);
    container.scrollTop = 200;
    container.scrollHeight = 2_800;
    restoreRunActivityScrollPosition(positions, "run-a", container);

    expect(container.scrollTop).toBe(2_300);
  });
});
