export const conversationSidebarCollapsedPreferenceKey =
  "custent:conversation-sidebar-collapsed";

export function parseConversationSidebarCollapsedPreference(
  value: string | null,
): boolean | null {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

export function serializeConversationSidebarCollapsedPreference(
  value: boolean,
): "true" | "false" {
  return value ? "true" : "false";
}

export type WorkspaceShortcutState = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  repeat: boolean;
  targetIsEditable: boolean;
};

export type WorkspaceShortcutAction =
  | "new_conversation"
  | "focus_composer"
  | "search_conversations"
  | "show_shortcuts";

export type WorkspaceKeyboardShortcutId =
  | WorkspaceShortcutAction
  | "send_message"
  | "insert_line_break"
  | "close_current_layer";

export const workspaceKeyboardShortcutAriaKeyShortcuts = {
  new_conversation: "Meta+Shift+O Control+Shift+O",
  focus_composer: "Shift+Escape",
  search_conversations: "Meta+K Control+K",
  send_message: "Enter",
  insert_line_break: "Shift+Enter",
  close_current_layer: "Escape",
  show_shortcuts: "Meta+/ Control+/",
} as const satisfies Record<WorkspaceKeyboardShortcutId, string>;

export type WorkspaceKeyboardShortcut = Readonly<{
  id: WorkspaceKeyboardShortcutId;
  label: string;
  macKeys: readonly string[];
  accessibleKeys: string;
  ariaKeyShortcuts: string;
  note?: string;
}>;

export const workspaceKeyboardShortcuts = [
  {
    id: "new_conversation",
    label: "新建研究",
    macKeys: ["⌘", "⇧", "O"],
    accessibleKeys: "Command Shift O；Windows 和 Linux 为 Control Shift O",
    ariaKeyShortcuts:
      workspaceKeyboardShortcutAriaKeyShortcuts.new_conversation,
  },
  {
    id: "focus_composer",
    label: "聚焦研究输入框",
    macKeys: ["⇧", "Esc"],
    accessibleKeys: "Shift Escape",
    ariaKeyShortcuts: workspaceKeyboardShortcutAriaKeyShortcuts.focus_composer,
    note: "当前输入框可用时",
  },
  {
    id: "search_conversations",
    label: "搜索对话",
    macKeys: ["⌘", "K"],
    accessibleKeys: "Command K；Windows 和 Linux 为 Control K",
    ariaKeyShortcuts:
      workspaceKeyboardShortcutAriaKeyShortcuts.search_conversations,
    note: "光标不在输入框时",
  },
  {
    id: "send_message",
    label: "发送消息",
    macKeys: ["Enter"],
    accessibleKeys: "Enter",
    ariaKeyShortcuts: workspaceKeyboardShortcutAriaKeyShortcuts.send_message,
  },
  {
    id: "insert_line_break",
    label: "消息内换行",
    macKeys: ["⇧", "Enter"],
    accessibleKeys: "Shift Enter",
    ariaKeyShortcuts:
      workspaceKeyboardShortcutAriaKeyShortcuts.insert_line_break,
  },
  {
    id: "close_current_layer",
    label: "关闭当前窗口或菜单",
    macKeys: ["Esc"],
    accessibleKeys: "Escape",
    ariaKeyShortcuts:
      workspaceKeyboardShortcutAriaKeyShortcuts.close_current_layer,
  },
  {
    id: "show_shortcuts",
    label: "显示快捷键",
    macKeys: ["⌘", "/"],
    accessibleKeys: "Command 斜杠；Windows 和 Linux 为 Control 斜杠",
    ariaKeyShortcuts: workspaceKeyboardShortcutAriaKeyShortcuts.show_shortcuts,
  },
] as const satisfies readonly WorkspaceKeyboardShortcut[];

export function workspaceShortcutAction(
  state: WorkspaceShortcutState,
): WorkspaceShortcutAction | null {
  if (
    state.altKey ||
    state.isComposing ||
    state.defaultPrevented ||
    state.repeat
  ) {
    return null;
  }

  const key = state.key.toLowerCase();
  const hasExactlyOnePlatformModifier = state.metaKey !== state.ctrlKey;
  if (
    key === "escape" &&
    state.shiftKey &&
    !state.metaKey &&
    !state.ctrlKey
  ) {
    return "focus_composer";
  }
  if (
    key === "o" &&
    state.shiftKey &&
    hasExactlyOnePlatformModifier
  ) {
    return "new_conversation";
  }
  if (!hasExactlyOnePlatformModifier || state.shiftKey) {
    return null;
  }
  if (key === "/") {
    return "show_shortcuts";
  }
  if (key === "k" && !state.targetIsEditable) {
    return "search_conversations";
  }
  return null;
}

export function shouldOpenConversationSearchFromShortcut(
  state: WorkspaceShortcutState,
): boolean {
  return workspaceShortcutAction(state) === "search_conversations";
}

export function documentHasOpenModal(
  root: Pick<Document, "querySelector">,
): boolean {
  return root.querySelector('[aria-modal="true"]') !== null;
}

export function closeDesktopPanelAndRestoreFocus(
  onClose: () => void,
  returnFocusTarget: Pick<HTMLElement, "focus"> | null,
): void {
  onClose();
  if (returnFocusTarget !== null) {
    queueMicrotask(() => returnFocusTarget.focus());
  }
}

export type ConversationArchiveMutationOrigin =
  | "workspace"
  | "conversation_browser";

export function archiveMutationRefreshesConversationBrowser(
  origin: ConversationArchiveMutationOrigin,
): boolean {
  switch (origin) {
    case "workspace":
      return true;
    case "conversation_browser":
      return false;
  }
}
