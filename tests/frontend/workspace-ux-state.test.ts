import { describe, expect, it } from "vitest";

import {
  archiveMutationRefreshesConversationBrowser,
  conversationSidebarCollapsedPreferenceKey,
  documentHasOpenModal,
  parseConversationSidebarCollapsedPreference,
  serializeConversationSidebarCollapsedPreference,
  shouldOpenConversationSearchFromShortcut,
  workspaceKeyboardShortcuts,
  workspaceKeyboardShortcutAriaKeyShortcuts,
  workspaceShortcutAction,
  type WorkspaceShortcutState,
} from "@/components/workspace-ux-state";

function shortcutState(
  overrides: Partial<WorkspaceShortcutState> = {},
): WorkspaceShortcutState {
  return {
    key: "k",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    defaultPrevented: false,
    repeat: false,
    targetIsEditable: false,
    ...overrides,
  };
}

describe("workspace UX state", () => {
  it("uses one stable key and an exact boolean wire format for sidebar state", () => {
    expect(conversationSidebarCollapsedPreferenceKey).toBe(
      "custent:conversation-sidebar-collapsed",
    );
    expect(serializeConversationSidebarCollapsedPreference(true)).toBe(
      "true",
    );
    expect(serializeConversationSidebarCollapsedPreference(false)).toBe(
      "false",
    );
    expect(parseConversationSidebarCollapsedPreference("true")).toBe(true);
    expect(parseConversationSidebarCollapsedPreference("false")).toBe(false);
  });

  it.each([null, "TRUE", "False", "1", "0", " true ", "\"true\""])(
    "rejects a non-contract sidebar preference value: %s",
    (value) => {
      expect(parseConversationSidebarCollapsedPreference(value)).toBeNull();
    },
  );

  it("maps only Command/Control K outside editable content to conversation search", () => {
    expect(workspaceShortcutAction(shortcutState())).toBe(
      "search_conversations",
    );
    expect(
      workspaceShortcutAction(
        shortcutState({ metaKey: false, ctrlKey: true }),
      ),
    ).toBe("search_conversations");
    expect(workspaceShortcutAction(shortcutState({ key: "K" }))).toBe(
      "search_conversations",
    );
    expect(
      workspaceShortcutAction(shortcutState({ targetIsEditable: true })),
    ).toBeNull();
    expect(shouldOpenConversationSearchFromShortcut(shortcutState())).toBe(
      true,
    );
  });

  it("maps Command/Control slash to the shortcut dialog even inside editable content", () => {
    expect(
      workspaceShortcutAction(
        shortcutState({ key: "/", targetIsEditable: true }),
      ),
    ).toBe("show_shortcuts");
    expect(
      workspaceShortcutAction(
        shortcutState({
          key: "/",
          metaKey: false,
          ctrlKey: true,
          targetIsEditable: true,
        }),
      ),
    ).toBe("show_shortcuts");
  });

  it("maps Command/Control Shift O to a new conversation from every focus surface", () => {
    expect(
      workspaceShortcutAction(shortcutState({ key: "o", shiftKey: true })),
    ).toBe("new_conversation");
    expect(
      workspaceShortcutAction(
        shortcutState({
          key: "O",
          metaKey: false,
          ctrlKey: true,
          shiftKey: true,
          targetIsEditable: true,
        }),
      ),
    ).toBe("new_conversation");
  });

  it("maps only unmodified Shift Escape to composer focus", () => {
    expect(
      workspaceShortcutAction(
        shortcutState({
          key: "Escape",
          metaKey: false,
          shiftKey: true,
        }),
      ),
    ).toBe("focus_composer");
    expect(
      workspaceShortcutAction(
        shortcutState({
          key: "Escape",
          metaKey: false,
          shiftKey: true,
          targetIsEditable: true,
        }),
      ),
    ).toBe("focus_composer");
  });

  it.each([
    { metaKey: false },
    { key: "/", metaKey: false },
    { key: "p" },
    { altKey: true },
    { key: "/", altKey: true },
    { shiftKey: true },
    { key: "/", shiftKey: true },
    { isComposing: true },
    { key: "/", isComposing: true },
    { defaultPrevented: true },
    { key: "/", defaultPrevented: true },
    { repeat: true },
    { key: "/", repeat: true },
    { metaKey: true, ctrlKey: true },
    { key: "/", metaKey: true, ctrlKey: true },
  ] satisfies Array<Partial<WorkspaceShortcutState>>)(
    "rejects an invalid, modified, repeated, or already-handled shortcut: %o",
    (overrides) => {
      expect(workspaceShortcutAction(shortcutState(overrides))).toBeNull();
    },
  );

  it.each([
    { altKey: true },
    { isComposing: true },
    { defaultPrevented: true },
    { repeat: true },
  ] satisfies Array<Partial<WorkspaceShortcutState>>)(
    "applies the common event guard to new-conversation and focus shortcuts: %o",
    (overrides) => {
      expect(
        workspaceShortcutAction(
          shortcutState({ key: "o", shiftKey: true, ...overrides }),
        ),
      ).toBeNull();
      expect(
        workspaceShortcutAction(
          shortcutState({
            key: "Escape",
            metaKey: false,
            shiftKey: true,
            ...overrides,
          }),
        ),
      ).toBeNull();
    },
  );

  it("rejects incomplete or over-modified new-conversation and focus shortcuts", () => {
    expect(workspaceShortcutAction(shortcutState({ key: "o" }))).toBeNull();
    expect(
      workspaceShortcutAction(
        shortcutState({
          key: "o",
          metaKey: false,
          shiftKey: true,
        }),
      ),
    ).toBeNull();
    expect(
      workspaceShortcutAction(
        shortcutState({ key: "o", ctrlKey: true, shiftKey: true }),
      ),
    ).toBeNull();
    expect(
      workspaceShortcutAction(
        shortcutState({ key: "Escape", shiftKey: true }),
      ),
    ).toBeNull();
    expect(
      workspaceShortcutAction(
        shortcutState({
          key: "Escape",
          metaKey: false,
          ctrlKey: true,
          shiftKey: true,
        }),
      ),
    ).toBeNull();
  });

  it("does not expose actions for display-only send and plain close shortcuts", () => {
    expect(
      workspaceShortcutAction(shortcutState({ key: "Enter" })),
    ).toBeNull();
    expect(
      workspaceShortcutAction(shortcutState({ key: "Escape" })),
    ).toBeNull();
  });

  it("publishes exactly the seven truthful shortcuts shown by the product", () => {
    expect(
      workspaceKeyboardShortcuts.map(
        ({ ariaKeyShortcuts, label, macKeys }) => ({
          ariaKeyShortcuts,
          label,
          macKeys,
        }),
      ),
    ).toEqual([
      {
        ariaKeyShortcuts: "Meta+Shift+O Control+Shift+O",
        label: "新建研究",
        macKeys: ["⌘", "⇧", "O"],
      },
      {
        ariaKeyShortcuts: "Shift+Escape",
        label: "聚焦研究输入框",
        macKeys: ["⇧", "Esc"],
      },
      {
        ariaKeyShortcuts: "Meta+K Control+K",
        label: "搜索对话",
        macKeys: ["⌘", "K"],
      },
      {
        ariaKeyShortcuts: "Enter",
        label: "发送消息",
        macKeys: ["Enter"],
      },
      {
        ariaKeyShortcuts: "Shift+Enter",
        label: "消息内换行",
        macKeys: ["⇧", "Enter"],
      },
      {
        ariaKeyShortcuts: "Escape",
        label: "关闭当前窗口或菜单",
        macKeys: ["Esc"],
      },
      {
        ariaKeyShortcuts: "Meta+/ Control+/",
        label: "显示快捷键",
        macKeys: ["⌘", "/"],
      },
    ]);
    expect(new Set(workspaceKeyboardShortcuts.map(({ id }) => id)).size).toBe(
      7,
    );
    expect(workspaceKeyboardShortcutAriaKeyShortcuts).toEqual({
      new_conversation: "Meta+Shift+O Control+Shift+O",
      focus_composer: "Shift+Escape",
      search_conversations: "Meta+K Control+K",
      send_message: "Enter",
      insert_line_break: "Shift+Enter",
      close_current_layer: "Escape",
      show_shortcuts: "Meta+/ Control+/",
    });
  });

  it("blocks the search shortcut behind every aria modal kind", () => {
    const selectors: string[] = [];
    const root = {
      querySelector: (selector: string) => {
        selectors.push(selector);
        return {} as Element;
      },
    };

    expect(documentHasOpenModal(root)).toBe(true);
    expect(selectors).toEqual(['[aria-modal="true"]']);
    expect(
      documentHasOpenModal({ querySelector: () => null }),
    ).toBe(false);
  });

  it("lets an in-dialog restore remove its own row before any list refresh", () => {
    expect(archiveMutationRefreshesConversationBrowser("workspace")).toBe(
      true,
    );
    expect(
      archiveMutationRefreshesConversationBrowser("conversation_browser"),
    ).toBe(false);
  });
});
