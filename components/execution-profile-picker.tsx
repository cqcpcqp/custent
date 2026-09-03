"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { CheckIcon, ChevronDownIcon } from "@/components/icons";
import type {
  ExecutionProfileId,
  ExecutionProfileOption,
} from "@/lib/contracts";

export type ExecutionProfilePickerNavigationKey =
  | "ArrowDown"
  | "ArrowUp"
  | "Home"
  | "End";

export function executionProfilePickerTargetIndex({
  activeIndex,
  itemCount,
  key,
}: {
  activeIndex: number;
  itemCount: number;
  key: ExecutionProfilePickerNavigationKey;
}): number | null {
  if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
    throw new TypeError("执行模式选项数量必须是非负安全整数");
  }
  if (
    !Number.isSafeInteger(activeIndex) ||
    activeIndex < -1 ||
    activeIndex >= itemCount
  ) {
    throw new TypeError("执行模式活动索引不符合选项契约");
  }
  if (itemCount === 0) {
    return null;
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return itemCount - 1;
  }
  if (activeIndex === -1) {
    return key === "ArrowDown" ? 0 : itemCount - 1;
  }
  return key === "ArrowDown"
    ? (activeIndex + 1) % itemCount
    : (activeIndex - 1 + itemCount) % itemCount;
}

type ExecutionProfilePickerProps = {
  options: ExecutionProfileOption[];
  selectedId: ExecutionProfileId;
  scopeKey: string;
  disabled: boolean;
  onChange: (id: ExecutionProfileId) => void;
};

function selectedExecutionProfile(
  options: readonly ExecutionProfileOption[],
  selectedId: ExecutionProfileId,
): { option: ExecutionProfileOption; index: number } {
  if (options.length === 0) {
    throw new TypeError("执行模式目录不能为空");
  }
  const seenIds = new Set<ExecutionProfileId>();
  for (const option of options) {
    if (seenIds.has(option.id)) {
      throw new TypeError(`执行模式目录包含重复 ID：${option.id}`);
    }
    seenIds.add(option.id);
  }
  const index = options.findIndex((option) => option.id === selectedId);
  const option = options[index];
  if (option === undefined) {
    throw new TypeError(`执行模式目录不包含当前选择：${selectedId}`);
  }
  return { option, index };
}

export function ExecutionProfilePicker({
  options,
  selectedId,
  scopeKey,
  disabled,
  onChange,
}: ExecutionProfilePickerProps) {
  const selected = selectedExecutionProfile(options, selectedId);
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const initialFocusIndexRef = useRef(selected.index);
  const generatedId = useId();
  const listboxId = `execution-profile-listbox-${generatedId}`;
  const expanded = isOpen && !disabled;

  useLayoutEffect(() => {
    // Conversation scope changes are committed before paint. Close the
    // transient listbox in that same layout pass and retain focus on the
    // stable picker trigger when keyboard focus was inside the old listbox.
    const activeElement = document.activeElement;
    if (
      activeElement instanceof Node &&
      listboxRef.current?.contains(activeElement)
    ) {
      triggerRef.current?.focus({ preventScroll: true });
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsOpen(false);
  }, [scopeKey]);

  useEffect(() => {
    if (!disabled) {
      return;
    }
    // A disabled picker must not reopen with stale preserved UI state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!expanded) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      const optionElements =
        listboxRef.current?.querySelectorAll<HTMLButtonElement>(
          "[role='option']",
        );
      optionElements?.item(initialFocusIndexRef.current).focus();
    });

    function closeWithoutRestoringFocus() {
      setIsOpen(false);
    }

    function closeAndRestoreFocus() {
      setIsOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }

    function handlePointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        closeWithoutRestoringFocus();
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      closeAndRestoreFocus();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [expanded]);

  function openListbox(initialFocusIndex = selected.index) {
    if (disabled) {
      return;
    }
    initialFocusIndexRef.current = initialFocusIndex;
    setIsOpen(true);
  }

  function closeAndRestoreFocus() {
    setIsOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function selectOption(index: number) {
    const option = options[index];
    if (option === undefined) {
      throw new TypeError(`执行模式选项索引 ${index} 不存在`);
    }
    onChange(option.id);
    closeAndRestoreFocus();
  }

  function handleTriggerKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    const initialFocusIndex = executionProfilePickerTargetIndex({
      activeIndex: -1,
      itemCount: options.length,
      key: event.key,
    });
    if (initialFocusIndex !== null) {
      openListbox(initialFocusIndex);
    }
  }

  function handleListboxKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    if (event.key === "Tab") {
      setIsOpen(false);
      return;
    }
    const optionElements = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "[role='option']",
      ),
    );
    const activeIndex = optionElements.indexOf(
      document.activeElement as HTMLButtonElement,
    );

    if (event.key === "Enter" || event.key === " ") {
      if (activeIndex === -1) {
        return;
      }
      event.preventDefault();
      selectOption(activeIndex);
      return;
    }
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    const nextIndex = executionProfilePickerTargetIndex({
      activeIndex,
      itemCount: optionElements.length,
      key: event.key,
    });
    if (nextIndex !== null) {
      event.preventDefault();
      optionElements[nextIndex]?.focus();
    }
  }

  return (
    <div className="execution-profile-picker" ref={rootRef}>
      <button
        aria-controls={listboxId}
        aria-expanded={expanded}
        aria-haspopup="listbox"
        aria-label={`执行模式：${selected.option.label}`}
        className="execution-profile-picker__trigger"
        disabled={disabled}
        onClick={() => {
          if (expanded) {
            setIsOpen(false);
          } else {
            openListbox();
          }
        }}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        type="button"
      >
        <span>{selected.option.label}</span>
        <ChevronDownIcon aria-hidden="true" />
      </button>

      {expanded ? (
        <div
          aria-label="选择执行模式"
          className="execution-profile-picker__listbox"
          id={listboxId}
          onKeyDown={handleListboxKeyDown}
          ref={listboxRef}
          role="listbox"
        >
          {options.map((option, index) => {
            const isSelected = option.id === selectedId;
            return (
              <button
                aria-selected={isSelected}
                className="execution-profile-picker__option"
                key={option.id}
                onClick={() => selectOption(index)}
                role="option"
                tabIndex={-1}
                type="button"
              >
                <span className="execution-profile-picker__option-copy">
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                <span
                  aria-hidden="true"
                  className="execution-profile-picker__check"
                >
                  {isSelected ? <CheckIcon /> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
