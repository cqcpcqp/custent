import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import {
  afterEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

import {
  conversationHeaderMenuPointerIsOutside,
  ConversationHeaderMenu,
} from "@/components/conversation-header-menu";
import type { ConversationSummary } from "@/lib/contracts";

const conversation: ConversationSummary = {
  id: "10000000-0000-4000-8000-000000000001",
  title: "德国泵类买家",
  updatedAt: "2026-08-28T08:00:00.000Z",
  pinnedAt: null,
  archivedAt: null,
  selectedRunId: null,
  activeRun: null,
  waitingRunCount: 0,
  attention: null,
};

type HeaderMenuProps = Parameters<typeof ConversationHeaderMenu>[0];

type InspectableElement = {
  type: unknown;
  props: Record<string, unknown> & {
    children?: unknown;
    onClick?: () => unknown;
    onKeyDown?: (event: unknown) => unknown;
  };
};

type CapturedEffect = () => void | (() => void);

type ExpandedMenuHarness = {
  effects: CapturedEffect[];
  element: InspectableElement;
  menuTabFocusTarget: Mock;
  refs: Array<{ current: unknown }>;
  setIsOpen: Mock;
};

function isInspectableElement(value: unknown): value is InspectableElement {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "props" in value
  );
}

function inspectableElements(
  root: unknown,
  predicate: (element: InspectableElement) => boolean,
): InspectableElement[] {
  const matches: InspectableElement[] = [];

  function visit(value: unknown) {
    if (isInspectableElement(value)) {
      if (predicate(value)) {
        matches.push(value);
      }
      visit(value.props.children);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
    }
  }

  visit(root);
  return matches;
}

function elementText(root: unknown): string {
  if (typeof root === "string" || typeof root === "number") {
    return String(root);
  }
  if (isInspectableElement(root)) {
    return elementText(root.props.children);
  }
  if (Array.isArray(root)) {
    return root.map(elementText).join("");
  }
  return "";
}

function actionButton(
  root: unknown,
  label: "重命名" | "置顶" | "取消置顶" | "归档" | "恢复" | "删除",
): InspectableElement {
  const button = inspectableElements(
    root,
    (element) => element.type === "button" && elementText(element) === label,
  )[0];
  if (button === undefined) {
    throw new Error(`Could not find menu action: ${label}`);
  }
  return button;
}

function menuProps(
  overrides: Partial<HeaderMenuProps> = {},
): HeaderMenuProps {
  return {
    busy: false,
    conversation,
    disabledReason: null,
    onRequestDelete: vi.fn(),
    onRequestRename: vi.fn(),
    onSetArchived: vi.fn(async () => undefined),
    onSetPinned: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function expandedMenuHarness(
  props: HeaderMenuProps,
): Promise<ExpandedMenuHarness> {
  vi.resetModules();
  const effects: CapturedEffect[] = [];
  const refs: Array<{ current: unknown }> = [];
  const setIsOpen = vi.fn();
  const menuTabFocusTarget = vi.fn();

  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    return {
      ...actual,
      useEffect: (effect: CapturedEffect) => {
        effects.push(effect);
      },
      useRef: (initial: unknown) => {
        const ref = { current: initial };
        refs.push(ref);
        return ref;
      },
      useState: () => [true, setIsOpen],
    };
  });
  vi.doMock("@/components/menu-focus", async () => {
    const actual = await vi.importActual<
      typeof import("@/components/menu-focus")
    >("@/components/menu-focus");
    return { ...actual, menuTabFocusTarget };
  });

  try {
    const { ConversationHeaderMenu: InspectableConversationHeaderMenu } =
      await import("@/components/conversation-header-menu");
    const element = InspectableConversationHeaderMenu(
      props,
    ) as InspectableElement;
    return {
      effects,
      element,
      menuTabFocusTarget,
      refs,
      setIsOpen,
    };
  } finally {
    vi.doUnmock("react");
    vi.doUnmock("@/components/menu-focus");
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("conversation header menu", () => {
  it("renders an accessible closed trigger and disables it while busy", () => {
    const menuId = `conversation-header-menu-${conversation.id}`;
    const readyMarkup = renderToStaticMarkup(
      <ConversationHeaderMenu {...menuProps()} />,
    );
    const busyMarkup = renderToStaticMarkup(
      <ConversationHeaderMenu {...menuProps({ busy: true })} />,
    );

    expect(readyMarkup).toContain(`aria-controls="${menuId}"`);
    expect(readyMarkup).toContain('aria-expanded="false"');
    expect(readyMarkup).toContain('aria-haspopup="menu"');
    expect(readyMarkup).toContain('aria-label="对话操作：德国泵类买家"');
    expect(readyMarkup).toContain(
      'class="conversation-header-menu__trigger"',
    );
    expect(readyMarkup).not.toContain('role="menu"');
    expect(busyMarkup).toContain(
      'class="conversation-header-menu__trigger" disabled=""',
    );
  });

  it("renders the complete active-conversation action menu", async () => {
    const harness = await expandedMenuHarness(menuProps());
    const markup = renderToStaticMarkup(
      harness.element as unknown as ReactNode,
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-label="管理对话：德国泵类买家"');
    expect(markup).toContain(
      'class="conversation-header-menu__panel"',
    );
    expect(markup).toContain('role="menu"');
    expect(markup.match(/role="menuitem"/gu)).toHaveLength(4);
    expect(markup).toContain("重命名");
    expect(markup).toContain("置顶");
    expect(markup).toContain("归档");
    expect(markup).toContain('role="separator"');
    expect(markup).toContain(
      'class="conversation-header-menu__danger"',
    );
    expect(markup).toContain("删除");
  });

  it("switches pinned and archived conversations to their inverse actions", async () => {
    const pinnedArchived = {
      ...conversation,
      pinnedAt: "2026-08-28T08:30:00.000Z",
      archivedAt: "2026-08-28T09:00:00.000Z",
    };
    const onSetArchived = vi.fn(async () => undefined);
    const onSetPinned = vi.fn(async () => undefined);
    const harness = await expandedMenuHarness(
      menuProps({
        conversation: pinnedArchived,
        onSetArchived,
        onSetPinned,
      }),
    );

    actionButton(harness.element, "取消置顶").props.onClick?.();
    actionButton(harness.element, "恢复").props.onClick?.();

    expect(onSetPinned).toHaveBeenCalledWith(pinnedArchived, false);
    expect(onSetArchived).toHaveBeenCalledWith(pinnedArchived, false);
  });

  it("uses the exact disabled reason only on protected actions", async () => {
    const disabledReason =
      "该对话仍有正在运行或等待中的研究，请先停止或取消后再操作";
    const harness = await expandedMenuHarness(
      menuProps({ disabledReason }),
    );
    const rename = actionButton(harness.element, "重命名");
    const pin = actionButton(harness.element, "置顶");
    const archive = actionButton(harness.element, "归档");
    const remove = actionButton(harness.element, "删除");

    expect(rename.props.disabled).toBe(false);
    expect(rename.props.title).toBeUndefined();
    expect(pin.props.disabled).toBe(false);
    expect(pin.props.title).toBeUndefined();
    expect(archive.props.disabled).toBe(true);
    expect(archive.props.title).toBe(disabledReason);
    expect(remove.props.disabled).toBe(true);
    expect(remove.props.title).toBe(disabledReason);
  });

  it("passes exact action arguments and restores trigger focus before dialogs", async () => {
    const order: string[] = [];
    const onRequestDelete = vi.fn(() => order.push("delete"));
    const onRequestRename = vi.fn(() => order.push("rename"));
    const onSetArchived = vi.fn(async () => undefined);
    const onSetPinned = vi.fn(async () => undefined);
    const harness = await expandedMenuHarness(
      menuProps({
        onRequestDelete,
        onRequestRename,
        onSetArchived,
        onSetPinned,
      }),
    );
    harness.refs[1]!.current = {
      focus: () => order.push("focus"),
    };

    actionButton(harness.element, "重命名").props.onClick?.();
    expect(order).toEqual(["focus", "rename"]);

    order.length = 0;
    actionButton(harness.element, "删除").props.onClick?.();
    expect(order).toEqual(["focus", "delete"]);

    actionButton(harness.element, "置顶").props.onClick?.();
    actionButton(harness.element, "归档").props.onClick?.();
    expect(onSetPinned).toHaveBeenCalledWith(conversation, true);
    expect(onSetArchived).toHaveBeenCalledWith(conversation, true);
    expect(harness.setIsOpen).toHaveBeenCalledWith(false);
  });

  it("keeps every stale open-menu action inert while busy", async () => {
    const props = menuProps({ busy: true });
    const harness = await expandedMenuHarness(props);
    const actions = ["重命名", "置顶", "归档", "删除"] as const;

    actions.forEach((label) => {
      const action = actionButton(harness.element, label);
      expect(action.props.disabled).toBe(true);
      action.props.onClick?.();
    });

    expect(props.onRequestRename).not.toHaveBeenCalled();
    expect(props.onSetPinned).not.toHaveBeenCalled();
    expect(props.onSetArchived).not.toHaveBeenCalled();
    expect(props.onRequestDelete).not.toHaveBeenCalled();
  });

  it("opens from either arrow key and navigates enabled menu items", async () => {
    const harness = await expandedMenuHarness(menuProps());
    const firstFocus = vi.fn();
    const lastFocus = vi.fn();
    const items = [{ focus: firstFocus }, { focus: lastFocus }];
    harness.refs[2]!.current = {
      querySelectorAll: () => ({
        item: (index: number) => items[index],
        length: items.length,
      }),
    };
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });
    vi.stubGlobal("document", { activeElement: items[0] });
    const trigger = inspectableElements(
      harness.element,
      (element) => element.props["aria-haspopup"] === "menu",
    )[0]!;
    const panel = inspectableElements(
      harness.element,
      (element) => element.props.role === "menu",
    )[0]!;
    const preventOpenDefault = vi.fn();

    trigger.props.onKeyDown?.({
      key: "ArrowUp",
      preventDefault: preventOpenDefault,
    });
    expect(preventOpenDefault).toHaveBeenCalledOnce();
    expect(lastFocus).toHaveBeenCalledOnce();

    const preventNavigationDefault = vi.fn();
    panel.props.onKeyDown?.({
      currentTarget: { querySelectorAll: () => items },
      key: "ArrowDown",
      preventDefault: preventNavigationDefault,
      shiftKey: false,
    });
    expect(preventNavigationDefault).toHaveBeenCalledOnce();
    expect(lastFocus).toHaveBeenCalledTimes(2);
  });

  it("moves Tab outside the menu relative to its trigger", async () => {
    const harness = await expandedMenuHarness(menuProps());
    const trigger = { focus: vi.fn() };
    const target = { focus: vi.fn() };
    const panelNode = { querySelectorAll: () => [] };
    harness.refs[1]!.current = trigger;
    harness.menuTabFocusTarget.mockReturnValue(target);
    vi.stubGlobal("document", { activeElement: null });
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });
    const panel = inspectableElements(
      harness.element,
      (element) => element.props.role === "menu",
    )[0]!;
    const preventDefault = vi.fn();

    panel.props.onKeyDown?.({
      currentTarget: panelNode,
      key: "Tab",
      preventDefault,
      shiftKey: true,
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(harness.menuTabFocusTarget).toHaveBeenCalledWith(
      panelNode,
      trigger,
      true,
    );
    expect(harness.setIsOpen).toHaveBeenCalledWith(false);
    expect(target.focus).toHaveBeenCalledOnce();
  });

  it("closes on outside pointerdown and Escape while preserving inside clicks", async () => {
    class TestNode {}
    const harness = await expandedMenuHarness(menuProps());
    const insideTarget = new TestNode();
    const outsideTarget = new TestNode();
    const triggerFocus = vi.fn();
    const firstItemFocus = vi.fn();
    const documentListeners = new Map<string, (event: never) => void>();
    const windowListeners = new Map<string, (event: never) => void>();
    harness.refs[0]!.current = {
      contains: (target: unknown) => target === insideTarget,
    };
    harness.refs[1]!.current = { focus: triggerFocus };
    harness.refs[2]!.current = {
      querySelectorAll: () => ({
        item: () => ({ focus: firstItemFocus }),
        length: 1,
      }),
    };
    vi.stubGlobal("Node", TestNode);
    vi.stubGlobal("document", {
      addEventListener: (name: string, listener: (event: never) => void) => {
        documentListeners.set(name, listener);
      },
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("window", {
      addEventListener: (name: string, listener: (event: never) => void) => {
        windowListeners.set(name, listener);
      },
      cancelAnimationFrame: vi.fn(),
      removeEventListener: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });

    const cleanup = harness.effects[0]?.();
    expect(firstItemFocus).toHaveBeenCalledOnce();

    documentListeners.get("pointerdown")?.({
      target: insideTarget,
    } as never);
    expect(harness.setIsOpen).not.toHaveBeenCalled();

    documentListeners.get("pointerdown")?.({
      target: outsideTarget,
    } as never);
    expect(harness.setIsOpen).toHaveBeenCalledWith(false);

    harness.setIsOpen.mockClear();
    const preventDefault = vi.fn();
    windowListeners.get("keydown")?.({
      key: "Escape",
      preventDefault,
    } as never);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(harness.setIsOpen).toHaveBeenCalledWith(false);
    expect(triggerFocus).toHaveBeenCalledOnce();

    if (typeof cleanup === "function") {
      cleanup();
    }
  });

  it("classifies pointer targets against the exact menu root", () => {
    const inside = {} as Node;
    const outside = {} as Node;
    const root = { contains: (target: Node | null) => target === inside };

    expect(conversationHeaderMenuPointerIsOutside(root, inside)).toBe(false);
    expect(conversationHeaderMenuPointerIsOutside(root, outside)).toBe(true);
    expect(conversationHeaderMenuPointerIsOutside(root, null)).toBe(false);
    expect(conversationHeaderMenuPointerIsOutside(null, outside)).toBe(true);
  });
});
