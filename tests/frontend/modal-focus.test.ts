import { afterEach, describe, expect, it, vi } from "vitest";

import {
  focusTrapTargetIndex,
  inertBackdropSiblings,
  InertRegistry,
  modalFocusRecoveryTarget,
} from "@/components/modal-focus";

class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  private readonly attributes = new Set<string>();
  private inertValue = false;

  constructor(isModalLayer = false) {
    if (isModalLayer) {
      this.attributes.add("data-modal-layer");
    }
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  contains(candidate: FakeElement): boolean {
    return (
      candidate === this ||
      this.children.some((child) => child.contains(candidate))
    );
  }

  get inert(): boolean {
    return this.inertValue;
  }

  set inert(value: boolean) {
    const oldValue = this.inertValue;
    this.inertValue = value;
    FakeMutationObserver.notifyAttribute(
      this,
      oldValue ? "" : null,
    );
  }

  setChildren(children: FakeElement[]): void {
    this.children = children;
    for (const child of children) {
      child.parentElement = this;
    }
  }

  append(child: FakeElement): void {
    this.children.push(child);
    child.parentElement = this;
    FakeMutationObserver.notifyChildList(this, [child], []);
  }

  remove(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index < 0) {
      return;
    }
    this.children.splice(index, 1);
    child.parentElement = null;
    FakeMutationObserver.notifyChildList(this, [], [child]);
  }
}

class FakeMutationObserver {
  private static readonly registrations: Array<{
    observer: FakeMutationObserver;
    options: MutationObserverInit;
    target: FakeElement;
  }> = [];

  constructor(private readonly callback: MutationCallback) {}

  static notifyAttribute(
    target: FakeElement,
    oldValue: string | null,
  ): void {
    for (const registration of this.registrations) {
      if (
        registration.target === target &&
        registration.options.attributes === true
      ) {
        registration.observer.callback(
          [
            {
              oldValue,
            } as unknown as MutationRecord,
          ],
          registration.observer as unknown as MutationObserver,
        );
      }
    }
  }

  static notifyChildList(
    target: FakeElement,
    addedNodes: FakeElement[],
    removedNodes: FakeElement[],
  ): void {
    for (const registration of this.registrations) {
      if (
        registration.target === target &&
        registration.options.childList === true
      ) {
        registration.observer.callback(
          [
            {
              addedNodes,
              removedNodes,
            } as unknown as MutationRecord,
          ],
          registration.observer as unknown as MutationObserver,
        );
      }
    }
  }

  static reset(): void {
    this.registrations.length = 0;
  }

  disconnect(): void {
    const index = FakeMutationObserver.registrations.findIndex(
      (registration) => registration.observer === this,
    );
    if (index >= 0) {
      FakeMutationObserver.registrations.splice(index, 1);
    }
  }

  observe(target: Node, options: MutationObserverInit): void {
    FakeMutationObserver.registrations.push({
      observer: this,
      options,
      target: target as unknown as FakeElement,
    });
  }

  takeRecords(): MutationRecord[] {
    return [];
  }
}

afterEach(() => {
  FakeMutationObserver.reset();
  vi.unstubAllGlobals();
});

describe("modal focus trap", () => {
  it("keeps focus on the dialog container when no controls are available", () => {
    expect(
      focusTrapTargetIndex({
        activeIndex: -1,
        focusableCount: 0,
        shiftKey: false,
      }),
    ).toBe(-1);
  });

  it("moves outside focus to the first or last control", () => {
    expect(
      focusTrapTargetIndex({
        activeIndex: -1,
        focusableCount: 3,
        shiftKey: false,
      }),
    ).toBe(0);
    expect(
      focusTrapTargetIndex({
        activeIndex: -1,
        focusableCount: 3,
        shiftKey: true,
      }),
    ).toBe(2);
  });

  it("wraps Tab and Shift+Tab only at the dialog boundaries", () => {
    expect(
      focusTrapTargetIndex({
        activeIndex: 2,
        focusableCount: 3,
        shiftKey: false,
      }),
    ).toBe(0);
    expect(
      focusTrapTargetIndex({
        activeIndex: 0,
        focusableCount: 3,
        shiftKey: true,
      }),
    ).toBe(2);
    expect(
      focusTrapTargetIndex({
        activeIndex: 1,
        focusableCount: 3,
        shiftKey: false,
      }),
    ).toBeNull();
  });
});

describe("modal background inertness", () => {
  it("reference-counts inert state and restores the original value", () => {
    const registry = new InertRegistry<{ inert: boolean }>();
    const initiallyInteractive = { inert: false };
    const initiallyInert = { inert: true };

    registry.acquire(initiallyInteractive);
    registry.acquire(initiallyInteractive);
    registry.acquire(initiallyInert);
    expect(initiallyInteractive.inert).toBe(true);
    expect(initiallyInert.inert).toBe(true);

    registry.release(initiallyInteractive);
    expect(initiallyInteractive.inert).toBe(true);
    registry.release(initiallyInteractive);
    registry.release(initiallyInert);
    expect(initiallyInteractive.inert).toBe(false);
    expect(initiallyInert.inert).toBe(true);
  });

  it("tracks the latest external inert intent while keeping the modal background inert", () => {
    vi.stubGlobal("HTMLElement", FakeElement);
    vi.stubGlobal("MutationObserver", FakeMutationObserver);

    const parent = new FakeElement();
    const latestFalse = new FakeElement();
    const latestTrue = new FakeElement();
    const backdrop = new FakeElement(true);
    parent.setChildren([latestFalse, latestTrue, backdrop]);

    const release = inertBackdropSiblings(
      backdrop as unknown as HTMLElement,
    );
    expect(latestFalse.inert).toBe(true);
    expect(latestTrue.inert).toBe(true);

    latestFalse.inert = false;
    latestTrue.inert = false;
    expect(latestFalse.inert).toBe(true);
    expect(latestTrue.inert).toBe(true);

    latestTrue.inert = true;
    release();
    expect(latestFalse.inert).toBe(false);
    expect(latestTrue.inert).toBe(true);
  });

  it("releases removed siblings and acquires them again when re-added", () => {
    vi.stubGlobal("HTMLElement", FakeElement);
    vi.stubGlobal("MutationObserver", FakeMutationObserver);

    const parent = new FakeElement();
    const page = new FakeElement();
    const backdrop = new FakeElement(true);
    parent.setChildren([page, backdrop]);

    const release = inertBackdropSiblings(
      backdrop as unknown as HTMLElement,
    );
    expect(page.inert).toBe(true);

    parent.remove(page);
    expect(page.inert).toBe(false);

    parent.append(page);
    expect(page.inert).toBe(true);

    release();
    expect(page.inert).toBe(false);
  });

  it("keeps a sibling modal container interactive while inerting the page", () => {
    vi.stubGlobal("HTMLElement", FakeElement);
    vi.stubGlobal("MutationObserver", FakeMutationObserver);

    const parent = new FakeElement();
    const page = new FakeElement();
    const backdrop = new FakeElement(true);
    const drawer = new FakeElement();
    parent.setChildren([page, backdrop, drawer]);

    const release = inertBackdropSiblings(
      backdrop as unknown as HTMLElement,
      new Set(),
      drawer as unknown as HTMLElement,
    );

    expect(page.inert).toBe(true);
    expect(drawer.inert).toBe(false);

    release();
    expect(page.inert).toBe(false);
    expect(drawer.inert).toBe(false);
  });

  it("inerts dynamic page siblings while letting a new top modal own the stack", () => {
    vi.stubGlobal("HTMLElement", FakeElement);
    vi.stubGlobal("MutationObserver", FakeMutationObserver);

    const parent = new FakeElement();
    const page = new FakeElement();
    const lowerBackdrop = new FakeElement(true);
    const topBackdrop = new FakeElement(true);
    parent.setChildren([page, lowerBackdrop, topBackdrop]);

    const releaseLower = inertBackdropSiblings(
      lowerBackdrop as unknown as HTMLElement,
    );
    expect(page.inert).toBe(true);
    expect(topBackdrop.inert).toBe(false);

    const releaseTop = inertBackdropSiblings(
      topBackdrop as unknown as HTMLElement,
      new Set([lowerBackdrop as unknown as HTMLElement]),
    );
    expect(lowerBackdrop.inert).toBe(true);
    expect(topBackdrop.inert).toBe(false);

    const notification = new FakeElement();
    const futureTopBackdrop = new FakeElement(true);
    parent.append(notification);
    parent.append(futureTopBackdrop);
    expect(notification.inert).toBe(true);
    expect(futureTopBackdrop.inert).toBe(false);

    releaseTop();
    expect(lowerBackdrop.inert).toBe(false);
    expect(page.inert).toBe(true);
    expect(notification.inert).toBe(true);

    releaseLower();
    expect(page.inert).toBe(false);
    expect(notification.inert).toBe(false);
  });
});

describe("modal focus recovery", () => {
  it("restores an available page opener before fallback page controls", () => {
    const menuButton = { available: true };
    const firstPageControl = { available: true };

    expect(
      modalFocusRecoveryTarget({
        hasLowerModal: false,
        lowerModalTargets: [],
        pageTargets: [firstPageControl],
        previouslyFocused: menuButton,
        isAvailable: (target) => target.available,
        isInLowerModal: () => false,
      }),
    ).toBe(menuButton);
  });

  it("restores an available opener inside the lower modal before its initial target", () => {
    const lowerOpener = { available: true, scope: "lower" };
    const lowerInitialTarget = { available: true, scope: "lower" };
    const firstPageTarget = { available: true, scope: "page" };

    expect(
      modalFocusRecoveryTarget({
        hasLowerModal: true,
        lowerModalTargets: [lowerInitialTarget],
        pageTargets: [firstPageTarget],
        previouslyFocused: lowerOpener,
        isAvailable: (target) => target.available,
        isInLowerModal: (target) => target.scope === "lower",
      }),
    ).toBe(lowerOpener);
  });

  it("falls back inside the lower modal and never escapes to the page behind it", () => {
    const lowerInitialTarget = { available: true, scope: "lower" };
    const removedLowerOpener = { available: false, scope: "lower" };
    const previousPageTarget = { available: true, scope: "page" };
    const firstPageTarget = { available: true, scope: "page" };

    expect(
      modalFocusRecoveryTarget({
        hasLowerModal: true,
        lowerModalTargets: [lowerInitialTarget],
        pageTargets: [firstPageTarget],
        previouslyFocused: removedLowerOpener,
        isAvailable: (target) => target.available,
        isInLowerModal: (target) => target.scope === "lower",
      }),
    ).toBe(lowerInitialTarget);
    expect(
      modalFocusRecoveryTarget({
        hasLowerModal: true,
        lowerModalTargets: [lowerInitialTarget],
        pageTargets: [firstPageTarget],
        previouslyFocused: previousPageTarget,
        isAvailable: (target) => target.available,
        isInLowerModal: (target) => target.scope === "lower",
      }),
    ).toBe(lowerInitialTarget);
    expect(
      modalFocusRecoveryTarget({
        hasLowerModal: true,
        lowerModalTargets: [{ available: false, scope: "lower" }],
        pageTargets: [firstPageTarget],
        previouslyFocused: previousPageTarget,
        isAvailable: (target) => target.available,
        isInLowerModal: (target) => target.scope === "lower",
      }),
    ).toBeNull();
  });

  it("uses the first visible page target when the opener was removed", () => {
    const removedOpener = { available: false };
    const hiddenPageTarget = { available: false };
    const visiblePageTarget = { available: true };

    expect(
      modalFocusRecoveryTarget({
        hasLowerModal: false,
        lowerModalTargets: [],
        pageTargets: [hiddenPageTarget, visiblePageTarget],
        previouslyFocused: removedOpener,
        isAvailable: (target) => target.available,
        isInLowerModal: () => false,
      }),
    ).toBe(visiblePageTarget);
  });
});
