"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  BranchIcon,
  MoreIcon,
  RefreshIcon,
} from "@/components/icons";
import {
  menuNavigationTargetIndex,
  menuTabFocusTarget,
  type MenuNavigationKey,
} from "@/components/menu-focus";
import { effectiveRunStatus } from "@/components/research-workspace-state";
import type { AgentRun, ChatMessage, RunEvent } from "@/lib/contracts";

export type MessageBranchToNewConversationTarget = {
  conversationId: string;
  messageId: string;
  role: ChatMessage["role"];
  runId: string;
};

export type MessageBranchToNewConversationControls = {
  disabledReason: string | null;
  isPending: boolean;
  onBranch: (
    target: MessageBranchToNewConversationTarget,
    trigger: HTMLButtonElement,
  ) => void;
};

export type MessageBranchToNewConversationState = {
  disabledReason: string | null;
  isPending: boolean;
  target: MessageBranchToNewConversationTarget;
};

const activeRunDisabledReason =
  "研究正在运行或等待中，完成或停止后才能在新对话中分支";
const pendingBranchLabel = "正在创建新对话分支";

type ContainsNode = {
  contains: (target: Node | null) => boolean;
};

type AssistantMessageMoreMenuState = {
  initialFocus: "first" | "last";
  left: number;
  top: number;
  triggerLeft: number;
  triggerTop: number;
};

export const assistantMessageMoreMenuHeight = 56;
export const assistantMessageMoreMenuWidth = 220;

export function assistantMessageMoreMenuPosition({
  gap = 6,
  gutter = 8,
  menuHeight = assistantMessageMoreMenuHeight,
  menuWidth = assistantMessageMoreMenuWidth,
  trigger,
  viewportHeight,
  viewportWidth,
}: {
  gap?: number;
  gutter?: number;
  menuHeight?: number;
  menuWidth?: number;
  trigger: Pick<DOMRectReadOnly, "bottom" | "left" | "top">;
  viewportHeight: number;
  viewportWidth: number;
}): Pick<AssistantMessageMoreMenuState, "left" | "top"> {
  const maximumLeft = Math.max(gutter, viewportWidth - menuWidth - gutter);
  const left = Math.min(Math.max(trigger.left, gutter), maximumLeft);
  const belowTop = trigger.bottom + gap;
  const preferredTop =
    belowTop + menuHeight <= viewportHeight - gutter
      ? belowTop
      : trigger.top - gap - menuHeight;
  const maximumTop = Math.max(gutter, viewportHeight - menuHeight - gutter);

  return {
    left,
    top: Math.min(Math.max(preferredTop, gutter), maximumTop),
  };
}

export function assistantMessageMoreMenuPointerIsOutside(
  panel: ContainsNode | null,
  trigger: ContainsNode | null,
  target: Node | null,
): boolean {
  return (
    target !== null &&
    (panel === null || !panel.contains(target)) &&
    (trigger === null || !trigger.contains(target))
  );
}

export function messageBranchToNewConversationState(input: {
  controls: MessageBranchToNewConversationControls;
  events: RunEvent[];
  message: ChatMessage;
  run: AgentRun | null;
}): MessageBranchToNewConversationState | null {
  const { controls, events, message, run } = input;
  if (run === null || message.runId === null) {
    return null;
  }
  if (message.runId !== run.id) {
    throw new Error(
      `消息 ${message.id} 绑定的 Run ${message.runId} 与分支目标 ${run.id} 不一致`,
    );
  }
  const expectedMessageId =
    message.role === "user" ? run.inputMessageId : run.assistantMessageId;
  if (expectedMessageId !== message.id) {
    throw new Error(
      `${message.role === "user" ? "用户消息" : "助手消息"} ${message.id} 不属于 Run ${run.id}`,
    );
  }

  const status = effectiveRunStatus(run, events);
  const disabledReason = controls.isPending
    ? pendingBranchLabel
    : status === "waiting" || status === "queued" || status === "running"
      ? activeRunDisabledReason
      : controls.disabledReason;

  return {
    disabledReason,
    isPending: controls.isPending,
    target: {
      conversationId: run.conversationId,
      messageId: message.id,
      role: message.role,
      runId: run.id,
    },
  };
}

export function MessageBranchToNewConversationAction({
  controls,
  events,
  message,
  run,
}: {
  controls: MessageBranchToNewConversationControls;
  events: RunEvent[];
  message: ChatMessage;
  run: AgentRun | null;
}) {
  const state = messageBranchToNewConversationState({
    controls,
    events,
    message,
    run,
  });
  if (state === null) {
    return null;
  }

  const label = state.isPending
    ? pendingBranchLabel
    : state.disabledReason === null
      ? "在新对话中分支"
      : `在新对话中分支不可用：${state.disabledReason}`;

  return (
    <span aria-busy={state.isPending} className="message-branch-action">
      <button
        aria-label={label}
        className={`message-action-button${
          state.isPending ? " message-branch-action--pending" : ""
        }`}
        disabled={state.disabledReason !== null}
        onClick={(event) => {
          if (state.disabledReason === null) {
            controls.onBranch(state.target, event.currentTarget);
          }
        }}
        title={label}
        type="button"
      >
        {state.isPending ? <RefreshIcon /> : <BranchIcon />}
      </button>
      {state.isPending ? (
        <span aria-live="polite" className="visually-hidden" role="status">
          {pendingBranchLabel}
        </span>
      ) : null}
    </span>
  );
}

export function AssistantMessageMoreMenu({
  controls,
  events,
  message,
  run,
}: {
  controls: MessageBranchToNewConversationControls;
  events: RunEvent[];
  message: ChatMessage;
  run: AgentRun | null;
}) {
  const state = messageBranchToNewConversationState({
    controls,
    events,
    message,
    run,
  });
  const [menuState, setMenuState] =
    useState<AssistantMessageMoreMenuState | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuMustClose = state === null || state.isPending;

  useEffect(() => {
    if (menuState === null) {
      return;
    }
    if (menuMustClose) {
      const closeFrame = window.requestAnimationFrame(() => {
        setMenuState(null);
      });
      return () => window.cancelAnimationFrame(closeFrame);
    }
    const openMenuState = menuState;

    const focusFrame = window.requestAnimationFrame(() => {
      const items = panelRef.current?.querySelectorAll<HTMLButtonElement>(
        "[role='menuitem']",
      );
      const focusTarget =
        openMenuState.initialFocus === "last"
          ? items?.item((items?.length ?? 1) - 1)
          : items?.item(0);
      focusTarget?.focus({ preventScroll: true });
    });

    function closeAndRestoreFocus() {
      setMenuState(null);
      window.requestAnimationFrame(() =>
        triggerRef.current?.focus({ preventScroll: true }),
      );
    }

    function handlePointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        assistantMessageMoreMenuPointerIsOutside(
          panelRef.current,
          triggerRef.current,
          event.target,
        )
      ) {
        setMenuState(null);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      closeAndRestoreFocus();
    }

    function handleScroll() {
      const trigger = triggerRef.current;
      if (trigger === null) {
        setMenuState(null);
        return;
      }
      const triggerRect = trigger.getBoundingClientRect();
      if (
        Math.abs(triggerRect.left - openMenuState.triggerLeft) > 0.5 ||
        Math.abs(triggerRect.top - openMenuState.triggerTop) > 0.5
      ) {
        setMenuState(null);
      }
    }

    function handleResize() {
      setMenuState(null);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("scroll", handleScroll, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
    };
  }, [menuMustClose, menuState]);

  if (state !== null && state.target.role !== "assistant") {
    throw new Error("助手消息更多菜单只能绑定助手回答");
  }

  if (state === null) {
    return null;
  }

  const visibleMenuState = menuMustClose ? null : menuState;
  const isOpen = visibleMenuState !== null;
  const menuId = `assistant-message-more-menu-${message.id}`;
  const branchLabel = state.isPending
    ? pendingBranchLabel
    : state.disabledReason === null
      ? "在新对话中分支"
      : `在新对话中分支不可用：${state.disabledReason}`;

  function openMenu(
    initialFocus: AssistantMessageMoreMenuState["initialFocus"],
    trigger: HTMLButtonElement,
  ) {
    if (state === null || state.isPending) {
      return;
    }
    if (menuState !== null) {
      const items = panelRef.current?.querySelectorAll<HTMLButtonElement>(
        "[role='menuitem']",
      );
      const focusTarget =
        initialFocus === "last"
          ? items?.item((items?.length ?? 1) - 1)
          : items?.item(0);
      focusTarget?.focus({ preventScroll: true });
      return;
    }

    const triggerRect = trigger.getBoundingClientRect();
    setMenuState({
      initialFocus,
      ...assistantMessageMoreMenuPosition({
        trigger: triggerRect,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
      }),
      triggerLeft: triggerRect.left,
      triggerTop: triggerRect.top,
    });
  }

  function handleTriggerKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    openMenu(event.key === "ArrowUp" ? "last" : "first", event.currentTarget);
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      event.preventDefault();
      const target = menuTabFocusTarget(
        event.currentTarget,
        triggerRef.current ?? document.activeElement,
        event.shiftKey,
      );
      setMenuState(null);
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

    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "[role='menuitem']",
      ),
    );
    const nextIndex = menuNavigationTargetIndex({
      activeIndex: items.indexOf(
        document.activeElement as HTMLButtonElement,
      ),
      itemCount: items.length,
      key: event.key as MenuNavigationKey,
    });
    if (nextIndex !== null) {
      event.preventDefault();
      items[nextIndex]?.focus({ preventScroll: true });
    }
  }

  return (
    <span
      aria-busy={state.isPending}
      className="assistant-message-more"
    >
      <button
        aria-controls={menuId}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={state.isPending ? pendingBranchLabel : "更多回答操作"}
        className="message-action-button assistant-message-more__trigger"
        disabled={state.isPending}
        onClick={(event) => {
          if (menuState === null) {
            openMenu("first", event.currentTarget);
          } else {
            setMenuState(null);
          }
        }}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        title={state.isPending ? pendingBranchLabel : "更多"}
        type="button"
      >
        <MoreIcon />
      </button>
      {state.isPending ? (
        <span aria-live="polite" className="visually-hidden" role="status">
          {pendingBranchLabel}
        </span>
      ) : null}
      {visibleMenuState === null
        ? null
        : createPortal(
            <div
              aria-label="更多回答操作"
              className="assistant-message-more-menu"
              id={menuId}
              onKeyDown={handleMenuKeyDown}
              ref={panelRef}
              role="menu"
              style={{
                left: visibleMenuState.left,
                top: visibleMenuState.top,
              }}
            >
              <button
                aria-disabled={state.disabledReason !== null}
                aria-label={branchLabel}
                onClick={() => {
                  if (state.disabledReason !== null) {
                    return;
                  }
                  const persistentTrigger = triggerRef.current;
                  if (persistentTrigger === null) {
                    throw new Error("助手消息更多菜单缺少持久触发器");
                  }
                  setMenuState(null);
                  controls.onBranch(state.target, persistentTrigger);
                }}
                role="menuitem"
                title={branchLabel}
                type="button"
              >
                <BranchIcon />
                <span>在新对话中分支</span>
              </button>
            </div>,
            document.body,
          )}
    </span>
  );
}
