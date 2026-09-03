export type MenuNavigationKey =
  | "ArrowDown"
  | "ArrowUp"
  | "Home"
  | "End";

const tabTargetSelector = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable='true']",
  "[tabindex]",
].join(",");

export function menuNavigationTargetIndex({
  activeIndex,
  itemCount,
  key,
}: {
  activeIndex: number;
  itemCount: number;
  key: MenuNavigationKey;
}): number | null {
  if (itemCount <= 0) {
    return null;
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return itemCount - 1;
  }
  if (activeIndex < 0) {
    return key === "ArrowDown" ? 0 : itemCount - 1;
  }
  if (key === "ArrowDown") {
    return (activeIndex + 1) % itemCount;
  }
  return (activeIndex - 1 + itemCount) % itemCount;
}

export function menuTabTargetIndex({
  activeIndex,
  itemIsInsideMenu,
  shiftKey,
}: {
  activeIndex: number;
  itemIsInsideMenu: readonly boolean[];
  shiftKey: boolean;
}): number | null {
  const itemCount = itemIsInsideMenu.length;
  if (itemCount === 0) {
    return null;
  }

  let index = activeIndex;
  for (let offset = 0; offset < itemCount; offset += 1) {
    index =
      index < 0
        ? shiftKey
          ? itemCount - 1
          : 0
        : (index + (shiftKey ? -1 : 1) + itemCount) % itemCount;
    if (itemIsInsideMenu[index] === false) {
      return index;
    }
  }
  return null;
}

function isAvailableTabTarget(element: HTMLElement): boolean {
  if (element.tabIndex < 0 || element.matches(":disabled")) {
    return false;
  }
  if (element.closest("[hidden], [inert], [aria-hidden='true']") !== null) {
    return false;
  }

  let current: HTMLElement | null = element;
  while (current !== null) {
    const style = window.getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    ) {
      return false;
    }
    current = current.parentElement;
  }
  return true;
}

function pageTabTargets(): HTMLElement[] {
  const targets = Array.from(
    document.querySelectorAll<HTMLElement>(tabTargetSelector),
  ).filter(isAvailableTabTarget);
  const domOrder = new Map(targets.map((target, index) => [target, index]));
  const positiveTabIndexTargets = targets
    .filter((target) => target.tabIndex > 0)
    .sort(
      (left, right) =>
        left.tabIndex - right.tabIndex ||
        (domOrder.get(left) ?? 0) - (domOrder.get(right) ?? 0),
    );
  return [
    ...positiveTabIndexTargets,
    ...targets.filter((target) => target.tabIndex === 0),
  ];
}

export function menuTabFocusTarget(
  menu: HTMLElement,
  activeElement: Element | null,
  shiftKey: boolean,
): HTMLElement | null {
  const candidates = pageTabTargets();
  const targetIndex = menuTabTargetIndex({
    activeIndex:
      activeElement instanceof HTMLElement
        ? candidates.indexOf(activeElement)
        : -1,
    itemIsInsideMenu: candidates.map((candidate) => menu.contains(candidate)),
    shiftKey,
  });
  return targetIndex === null ? null : (candidates[targetIndex] ?? null);
}

export function focusTriggerBeforeOpeningDialog(
  trigger: Pick<HTMLElement, "focus"> | null,
  openDialog: () => void,
): void {
  trigger?.focus();
  openDialog();
}
