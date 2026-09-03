import { describe, expect, it, vi } from "vitest";

import {
  focusTriggerBeforeOpeningDialog,
  menuNavigationTargetIndex,
  menuTabTargetIndex,
} from "@/components/menu-focus";

describe("menu keyboard focus", () => {
  it("focuses the first or last item when focus starts outside the menu", () => {
    expect(
      menuNavigationTargetIndex({
        activeIndex: -1,
        itemCount: 4,
        key: "ArrowDown",
      }),
    ).toBe(0);
    expect(
      menuNavigationTargetIndex({
        activeIndex: -1,
        itemCount: 4,
        key: "ArrowUp",
      }),
    ).toBe(3);
  });

  it("wraps arrow navigation and supports Home and End", () => {
    expect(
      menuNavigationTargetIndex({
        activeIndex: 3,
        itemCount: 4,
        key: "ArrowDown",
      }),
    ).toBe(0);
    expect(
      menuNavigationTargetIndex({
        activeIndex: 0,
        itemCount: 4,
        key: "ArrowUp",
      }),
    ).toBe(3);
    expect(
      menuNavigationTargetIndex({
        activeIndex: 2,
        itemCount: 4,
        key: "Home",
      }),
    ).toBe(0);
    expect(
      menuNavigationTargetIndex({
        activeIndex: 1,
        itemCount: 4,
        key: "End",
      }),
    ).toBe(3);
  });

  it("focuses the stable trigger before mounting a dialog", () => {
    const order: string[] = [];
    const trigger = {
      focus: vi.fn(() => order.push("focus")),
    };

    focusTriggerBeforeOpeningDialog(trigger, () => order.push("dialog"));

    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(order).toEqual(["focus", "dialog"]);
  });

  it("moves Tab to the next non-menu target in either direction", () => {
    const itemIsInsideMenu = [false, true, true, true, false];

    expect(
      menuTabTargetIndex({
        activeIndex: 1,
        itemIsInsideMenu,
        shiftKey: false,
      }),
    ).toBe(4);
    expect(
      menuTabTargetIndex({
        activeIndex: 3,
        itemIsInsideMenu,
        shiftKey: true,
      }),
    ).toBe(0);
  });

  it("wraps to a stable page target and rejects an all-menu sequence", () => {
    expect(
      menuTabTargetIndex({
        activeIndex: 1,
        itemIsInsideMenu: [false, true],
        shiftKey: false,
      }),
    ).toBe(0);
    expect(
      menuTabTargetIndex({
        activeIndex: 0,
        itemIsInsideMenu: [true, true],
        shiftKey: false,
      }),
    ).toBeNull();
  });
});
