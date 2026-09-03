"use client";

import { useEffect, useRef, type RefObject } from "react";

const focusableSelector = [
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

type ModalRegistration = {
  id: symbol;
  backdrop: HTMLElement | null;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef: RefObject<HTMLElement | null>;
};

const modalStack: ModalRegistration[] = [];

type InertState = {
  count: number;
  expectedInert: boolean;
  managedMutations: InertMutation[];
};

type InertMutation = {
  oldInert: boolean;
  newInert: boolean;
};

export class InertRegistry<Element extends { inert: boolean }> {
  private readonly states = new Map<Element, InertState>();

  private forceInert(element: Element, state: InertState): void {
    if (element.inert) {
      return;
    }

    state.managedMutations.push({ oldInert: false, newInert: true });
    element.inert = true;
  }

  acquire(element: Element): void {
    const current = this.states.get(element);
    if (current !== undefined) {
      current.count += 1;
      this.forceInert(element, current);
      return;
    }

    const state: InertState = {
      count: 1,
      expectedInert: element.inert,
      managedMutations: [],
    };
    this.states.set(element, state);
    this.forceInert(element, state);
  }

  handleMutations(
    element: Element,
    mutations: readonly InertMutation[],
  ): void {
    const current = this.states.get(element);
    if (current === undefined) {
      return;
    }

    for (const mutation of mutations) {
      const managedMutation = current.managedMutations[0];
      if (
        managedMutation !== undefined &&
        managedMutation.oldInert === mutation.oldInert &&
        managedMutation.newInert === mutation.newInert
      ) {
        current.managedMutations.shift();
        continue;
      }
      current.expectedInert = mutation.newInert;
    }

    this.forceInert(element, current);
  }

  release(element: Element): void {
    const current = this.states.get(element);
    if (current === undefined) {
      return;
    }
    if (current.count > 1) {
      current.count -= 1;
      return;
    }

    this.states.delete(element);
    element.inert = current.expectedInert;
  }
}

const inertRegistry = new InertRegistry<HTMLElement>();

type InertObservation = {
  count: number;
  observer: MutationObserver;
};

const inertObservations = new Map<HTMLElement, InertObservation>();

function processInertMutationRecords(
  element: HTMLElement,
  records: readonly MutationRecord[],
): void {
  const mutations = records.map<InertMutation>((record, index) => ({
    oldInert: record.oldValue !== null,
    newInert:
      index + 1 < records.length
        ? records[index + 1]?.oldValue !== null
        : element.inert,
  }));
  inertRegistry.handleMutations(element, mutations);
}

function acquireObservedInert(element: HTMLElement): void {
  const current = inertObservations.get(element);
  if (current !== undefined) {
    processInertMutationRecords(element, current.observer.takeRecords());
    current.count += 1;
    inertRegistry.acquire(element);
    return;
  }

  const observer = new MutationObserver((records) => {
    processInertMutationRecords(element, records);
  });
  observer.observe(element, {
    attributeFilter: ["inert"],
    attributeOldValue: true,
    attributes: true,
  });
  inertObservations.set(element, { count: 1, observer });
  inertRegistry.acquire(element);
}

function releaseObservedInert(element: HTMLElement): void {
  const current = inertObservations.get(element);
  if (current === undefined) {
    inertRegistry.release(element);
    return;
  }

  processInertMutationRecords(element, current.observer.takeRecords());
  if (current.count > 1) {
    current.count -= 1;
    inertRegistry.release(element);
    return;
  }

  current.observer.disconnect();
  inertObservations.delete(element);
  inertRegistry.release(element);
}

function isTopModal(modalId: symbol): boolean {
  return modalStack.at(-1)?.id === modalId;
}

function removeModal(modalId: symbol): void {
  const index = modalStack.findLastIndex((modal) => modal.id === modalId);
  if (index >= 0) {
    modalStack.splice(index, 1);
  }
}

export function inertBackdropSiblings(
  backdrop: HTMLElement,
  lowerModalBackdrops: ReadonlySet<HTMLElement> = new Set(),
  modalContainer: HTMLElement | null = null,
): () => void {
  const parent = backdrop.parentElement;
  if (parent === null) {
    return () => undefined;
  }

  const inertedSiblings = new Set<HTMLElement>();

  function acquireSibling(sibling: HTMLElement): void {
    if (
      sibling === backdrop ||
      inertedSiblings.has(sibling) ||
      (modalContainer !== null &&
        (sibling === modalContainer || sibling.contains(modalContainer))) ||
      (sibling.hasAttribute("data-modal-layer") &&
        !lowerModalBackdrops.has(sibling))
    ) {
      return;
    }
    acquireObservedInert(sibling);
    inertedSiblings.add(sibling);
  }

  for (const sibling of Array.from(parent.children)) {
    if (sibling instanceof HTMLElement) {
      acquireSibling(sibling);
    }
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const removedNode of record.removedNodes) {
        if (
          removedNode instanceof HTMLElement &&
          inertedSiblings.delete(removedNode)
        ) {
          releaseObservedInert(removedNode);
        }
      }
      for (const addedNode of record.addedNodes) {
        if (
          addedNode instanceof HTMLElement &&
          addedNode.parentElement === parent
        ) {
          acquireSibling(addedNode);
        }
      }
    }
  });
  observer.observe(parent, { childList: true });

  return () => {
    observer.disconnect();
    for (const sibling of inertedSiblings) {
      releaseObservedInert(sibling);
    }
    inertedSiblings.clear();
  };
}

function isAvailableFocusTarget(element: HTMLElement): boolean {
  if (!element.isConnected || element.matches(":disabled")) {
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

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => element.tabIndex >= 0 && isAvailableFocusTarget(element),
  );
}

function preferredFocusTarget(
  container: HTMLElement,
  initialFocus: HTMLElement | null,
): HTMLElement {
  return (
    initialFocus !== null && isAvailableFocusTarget(initialFocus)
      ? initialFocus
      : (focusableElements(container)[0] ?? container)
  );
}

function focusPreferredTarget(
  container: HTMLElement,
  initialFocus: HTMLElement | null,
): void {
  preferredFocusTarget(container, initialFocus).focus();
}

export function modalFocusRecoveryTarget<T>({
  hasLowerModal,
  lowerModalTargets,
  pageTargets,
  previouslyFocused,
  isAvailable,
  isInLowerModal,
}: {
  hasLowerModal: boolean;
  lowerModalTargets: readonly T[];
  pageTargets: readonly T[];
  previouslyFocused: T | null;
  isAvailable: (target: T) => boolean;
  isInLowerModal: (target: T) => boolean;
}): T | null {
  if (hasLowerModal) {
    if (
      previouslyFocused !== null &&
      isInLowerModal(previouslyFocused) &&
      isAvailable(previouslyFocused)
    ) {
      return previouslyFocused;
    }
    return lowerModalTargets.find(isAvailable) ?? null;
  }
  if (previouslyFocused !== null && isAvailable(previouslyFocused)) {
    return previouslyFocused;
  }
  return pageTargets.find(isAvailable) ?? null;
}

export function focusTrapTargetIndex({
  activeIndex,
  focusableCount,
  shiftKey,
}: {
  activeIndex: number;
  focusableCount: number;
  shiftKey: boolean;
}): number | null {
  if (focusableCount === 0) {
    return -1;
  }
  if (activeIndex < 0) {
    return shiftKey ? focusableCount - 1 : 0;
  }
  if (shiftKey && activeIndex === 0) {
    return focusableCount - 1;
  }
  if (!shiftKey && activeIndex === focusableCount - 1) {
    return 0;
  }
  return null;
}

export function useModalFocus({
  backdropRef,
  canClose,
  containerRef,
  enabled = true,
  initialFocusRef,
  onClose,
  returnFocusRef,
}: {
  backdropRef: RefObject<HTMLElement | null>;
  canClose: boolean;
  containerRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
  initialFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}): void {
  const modalIdRef = useRef(Symbol("modal"));
  const canCloseRef = useRef(canClose);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    canCloseRef.current = canClose;
  }, [canClose]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const modalId = modalIdRef.current;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const requestedReturnFocus = returnFocusRef?.current ?? null;
    const backdrop = backdropRef.current;
    const lowerModalBackdrops = new Set(
      modalStack.flatMap((modal) =>
        modal.backdrop === null ? [] : [modal.backdrop],
      ),
    );
    modalStack.push({
      id: modalId,
      backdrop,
      containerRef,
      initialFocusRef,
    });
    const releaseBackgroundInert =
      backdrop === null
        ? () => undefined
        : inertBackdropSiblings(
            backdrop,
            lowerModalBackdrops,
            containerRef.current,
          );

    const focusFrame = window.requestAnimationFrame(() => {
      const container = containerRef.current;
      if (container !== null && isTopModal(modalId)) {
        focusPreferredTarget(container, initialFocusRef.current);
      }
    });

    function handleKeyDown(event: KeyboardEvent): void {
      if (!isTopModal(modalId)) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        if (canCloseRef.current) {
          onCloseRef.current();
        }
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const container = containerRef.current;
      if (container === null) {
        return;
      }
      const candidates = focusableElements(container);
      const activeIndex =
        document.activeElement instanceof HTMLElement
          ? candidates.indexOf(document.activeElement)
          : -1;
      const targetIndex = focusTrapTargetIndex({
        activeIndex,
        focusableCount: candidates.length,
        shiftKey: event.shiftKey,
      });
      if (targetIndex === null) {
        return;
      }

      event.preventDefault();
      if (targetIndex === -1) {
        container.focus();
      } else {
        candidates[targetIndex]?.focus();
      }
    }

    function handleFocusIn(event: FocusEvent): void {
      if (!isTopModal(modalId)) {
        return;
      }
      const container = containerRef.current;
      const target = event.target;
      if (
        container !== null &&
        target instanceof Node &&
        !container.contains(target)
      ) {
        focusPreferredTarget(container, initialFocusRef.current);
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);

      const wasTopModal = isTopModal(modalId);
      removeModal(modalId);
      releaseBackgroundInert();

      if (!wasTopModal) {
        return;
      }

      const lowerModal = modalStack.at(-1);
      const lowerContainer = lowerModal?.containerRef.current ?? null;
      const lowerModalTargets =
        lowerModal === undefined || lowerContainer === null
          ? []
          : [
              preferredFocusTarget(
                lowerContainer,
                lowerModal.initialFocusRef.current,
              ),
            ];
      const pageTargets =
        document.body === null
          ? []
          : focusableElements(document.body).filter(
              (target) => target.closest("[data-modal-layer]") === null,
            );
      const recoveryTarget = modalFocusRecoveryTarget({
        hasLowerModal: lowerModal !== undefined,
        lowerModalTargets,
        pageTargets,
        previouslyFocused: requestedReturnFocus ?? previouslyFocused,
        isAvailable: (target) =>
          target !== document.body &&
          target !== document.documentElement &&
          isAvailableFocusTarget(target),
        isInLowerModal: (target) =>
          lowerContainer !== null && lowerContainer.contains(target),
      });
      recoveryTarget?.focus();
    };
  }, [backdropRef, containerRef, enabled, initialFocusRef, returnFocusRef]);
}
