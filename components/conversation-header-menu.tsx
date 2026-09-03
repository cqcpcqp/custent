"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  ArchiveIcon,
  MoreIcon,
  PencilIcon,
  PinIcon,
  RestoreIcon,
  TrashIcon,
} from "@/components/icons";
import {
  focusTriggerBeforeOpeningDialog,
  menuNavigationTargetIndex,
  menuTabFocusTarget,
  type MenuNavigationKey,
} from "@/components/menu-focus";
import type { ConversationSummary } from "@/lib/contracts";

type ConversationHeaderMenuProps = {
  conversation: ConversationSummary;
  busy: boolean;
  disabledReason: string | null;
  onRequestRename: (conversation: ConversationSummary) => void;
  onSetPinned: (
    conversation: ConversationSummary,
    pinned: boolean,
  ) => Promise<void>;
  onSetArchived: (
    conversation: ConversationSummary,
    archived: boolean,
  ) => Promise<void>;
  onRequestDelete: (conversation: ConversationSummary) => void;
};

type ContainsNode = {
  contains: (target: Node | null) => boolean;
};

export function conversationHeaderMenuPointerIsOutside(
  root: ContainsNode | null,
  target: Node | null,
): boolean {
  return target !== null && (root === null || !root.contains(target));
}

export function ConversationHeaderMenu({
  conversation,
  busy,
  disabledReason,
  onRequestRename,
  onSetPinned,
  onSetArchived,
  onRequestDelete,
}: ConversationHeaderMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<"first" | "last">("first");
  const menuId = `conversation-header-menu-${conversation.id}`;
  const isPinned = conversation.pinnedAt !== null;
  const isArchived = conversation.archivedAt !== null;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      const items = panelRef.current?.querySelectorAll<HTMLButtonElement>(
        "[role='menuitem']:not(:disabled)",
      );
      const focusTarget =
        initialFocusRef.current === "last"
          ? items?.item((items?.length ?? 1) - 1)
          : items?.item(0);
      focusTarget?.focus();
    });

    function closeAndRestoreFocus() {
      setIsOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }

    function handlePointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        conversationHeaderMenuPointerIsOutside(rootRef.current, event.target)
      ) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      closeAndRestoreFocus();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  function openMenu(initialFocus: "first" | "last") {
    if (busy) {
      return;
    }

    initialFocusRef.current = initialFocus;
    if (isOpen) {
      window.requestAnimationFrame(() => {
        const items = panelRef.current?.querySelectorAll<HTMLButtonElement>(
          "[role='menuitem']:not(:disabled)",
        );
        const focusTarget =
          initialFocus === "last"
            ? items?.item((items?.length ?? 1) - 1)
            : items?.item(0);
        focusTarget?.focus();
      });
      return;
    }
    setIsOpen(true);
  }

  function handleTriggerKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }

    event.preventDefault();
    openMenu(event.key === "ArrowUp" ? "last" : "first");
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      event.preventDefault();
      const target = menuTabFocusTarget(
        event.currentTarget,
        triggerRef.current ?? document.activeElement,
        event.shiftKey,
      );
      setIsOpen(false);
      window.requestAnimationFrame(() => target?.focus());
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

    const itemElements = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "[role='menuitem']:not(:disabled)",
      ),
    );
    const activeIndex = itemElements.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const nextIndex = menuNavigationTargetIndex({
      activeIndex,
      itemCount: itemElements.length,
      key: event.key as MenuNavigationKey,
    });
    if (nextIndex !== null) {
      event.preventDefault();
      itemElements[nextIndex]?.focus();
    }
  }

  return (
    <div className="conversation-header-menu" ref={rootRef}>
      <button
        aria-controls={menuId}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={`对话操作：${conversation.title}`}
        className="conversation-header-menu__trigger"
        disabled={busy}
        onClick={() => {
          if (isOpen) {
            setIsOpen(false);
          } else {
            openMenu("first");
          }
        }}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        type="button"
      >
        <MoreIcon />
      </button>

      {isOpen ? (
        <div
          aria-label={`管理对话：${conversation.title}`}
          className="conversation-header-menu__panel"
          id={menuId}
          onKeyDown={handleMenuKeyDown}
          ref={panelRef}
          role="menu"
        >
          <button
            disabled={busy}
            onClick={() => {
              if (busy) {
                return;
              }
              focusTriggerBeforeOpeningDialog(triggerRef.current, () => {
                setIsOpen(false);
                onRequestRename(conversation);
              });
            }}
            role="menuitem"
            type="button"
          >
            <PencilIcon />
            重命名
          </button>
          <button
            disabled={busy}
            onClick={() => {
              if (busy) {
                return;
              }
              setIsOpen(false);
              void onSetPinned(conversation, !isPinned);
            }}
            role="menuitem"
            type="button"
          >
            <PinIcon />
            {isPinned ? "取消置顶" : "置顶"}
          </button>
          <button
            disabled={busy || disabledReason !== null}
            onClick={() => {
              if (busy || disabledReason !== null) {
                return;
              }
              setIsOpen(false);
              void onSetArchived(conversation, !isArchived);
            }}
            role="menuitem"
            title={disabledReason ?? undefined}
            type="button"
          >
            {isArchived ? <RestoreIcon /> : <ArchiveIcon />}
            {isArchived ? "恢复" : "归档"}
          </button>
          <div
            className="conversation-header-menu__separator"
            role="separator"
          />
          <button
            className="conversation-header-menu__danger"
            disabled={busy || disabledReason !== null}
            onClick={() => {
              if (busy || disabledReason !== null) {
                return;
              }
              focusTriggerBeforeOpeningDialog(triggerRef.current, () => {
                setIsOpen(false);
                onRequestDelete(conversation);
              });
            }}
            role="menuitem"
            title={disabledReason ?? undefined}
            type="button"
          >
            <TrashIcon />
            删除
          </button>
        </div>
      ) : null}
    </div>
  );
}
