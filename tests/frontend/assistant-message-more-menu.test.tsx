import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

import {
  AssistantMessageMoreMenu,
  assistantMessageMoreMenuPointerIsOutside,
  assistantMessageMoreMenuPosition,
  type MessageBranchToNewConversationControls,
} from "@/components/message-branch-action";
import type { AgentRun, ChatMessage } from "@/lib/contracts";
import { TEST_CAPTURED_RUN_EXECUTION_SUMMARY } from "@/tests/fixtures/run-config";

const conversationId = "10000000-0000-4000-8000-000000000001";
const runId = "20000000-0000-4000-8000-000000000001";
const userMessageId = "30000000-0000-4000-8000-000000000001";
const assistantMessageId = "40000000-0000-4000-8000-000000000001";

const assistantMessage: ChatMessage = {
  id: assistantMessageId,
  runId,
  role: "assistant",
  content: "已完成买家研究。",
  citations: [],
  artifacts: [],
  attachments: [],
  feedback: null,
  createdAt: "2026-08-28T08:01:00.000Z",
};

const completedRun: AgentRun = {
  id: runId,
  requestId: "50000000-0000-4000-8000-000000000001",
  conversationId,
  inputMessageId: userMessageId,
  assistantMessageId,
  status: "completed",
  conversationTurn: "1",
  attemptIndex: 1,
  predecessorRunId: null,
  retryOfRunId: null,
  regenerateOfRunId: null,
  executionConfig: TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
  failure: null,
  createdAt: "2026-08-28T08:00:00.000Z",
  startedAt: "2026-08-28T08:00:01.000Z",
  finishedAt: "2026-08-28T08:01:00.000Z",
  cancelRequestedAt: null,
};

function controls(
  input: Partial<MessageBranchToNewConversationControls> = {},
): MessageBranchToNewConversationControls {
  return {
    disabledReason: null,
    isPending: false,
    onBranch: vi.fn(),
    ...input,
  };
}

function renderMenu(
  branchControls: MessageBranchToNewConversationControls,
): string {
  return renderToStaticMarkup(
    <AssistantMessageMoreMenu
      controls={branchControls}
      events={[]}
      message={assistantMessage}
      run={completedRun}
    />,
  );
}

function openingTag(markup: string, marker: string): string {
  const markerIndex = markup.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Could not find markup marker: ${marker}`);
  }
  const start = markup.lastIndexOf("<", markerIndex);
  const end = markup.indexOf(">", markerIndex);
  if (start === -1 || end === -1) {
    throw new Error(`Could not find opening tag for marker: ${marker}`);
  }
  return markup.slice(start, end + 1);
}

type InspectableElement = {
  type: unknown;
  props: Record<string, unknown> & {
    children?: unknown;
    onClick?: (event?: unknown) => unknown;
    onKeyDown?: (event: unknown) => unknown;
  };
};

type CapturedEffect = () => void | (() => void);

type MoreMenuOpenState = {
  initialFocus: "first" | "last";
  left: number;
  top: number;
  triggerLeft: number;
  triggerTop: number;
};

type MoreMenuHarness = {
  effects: CapturedEffect[];
  element: InspectableElement;
  menuTabFocusTarget: Mock;
  refs: Array<{ current: unknown }>;
  setMenuState: Mock;
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

async function moreMenuHarness(
  branchControls: MessageBranchToNewConversationControls,
  menuState: MoreMenuOpenState | null,
): Promise<MoreMenuHarness> {
  vi.resetModules();
  const effects: CapturedEffect[] = [];
  const refs: Array<{ current: unknown }> = [];
  const setMenuState = vi.fn();
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
      useState: () => [menuState, setMenuState],
    };
  });
  vi.doMock("react-dom", () => ({
    createPortal: (children: ReactNode) => children,
  }));
  vi.doMock("@/components/menu-focus", async () => {
    const actual = await vi.importActual<
      typeof import("@/components/menu-focus")
    >("@/components/menu-focus");
    return { ...actual, menuTabFocusTarget };
  });
  vi.stubGlobal("document", { activeElement: null, body: {} });

  try {
    const { AssistantMessageMoreMenu: InspectableAssistantMessageMoreMenu } =
      await import("@/components/message-branch-action");
    const element = InspectableAssistantMessageMoreMenu({
      controls: branchControls,
      events: [],
      message: assistantMessage,
      run: completedRun,
    }) as InspectableElement;
    return {
      effects,
      element,
      menuTabFocusTarget,
      refs,
      setMenuState,
    };
  } finally {
    vi.doUnmock("react");
    vi.doUnmock("react-dom");
    vi.doUnmock("@/components/menu-focus");
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("assistant message More menu", () => {
  it("renders a persistent accessible trigger and keeps it disabled while pending", () => {
    const menuId = `assistant-message-more-menu-${assistantMessageId}`;
    const readyMarkup = renderMenu(controls());
    const pendingMarkup = renderMenu(controls({ isPending: true }));

    expect(readyMarkup).toContain(`aria-controls="${menuId}"`);
    expect(readyMarkup).toContain('aria-expanded="false"');
    expect(readyMarkup).toContain('aria-haspopup="menu"');
    expect(readyMarkup).toContain('aria-label="更多回答操作"');
    expect(readyMarkup).not.toContain('role="menu"');
    expect(openingTag(pendingMarkup, "正在创建新对话分支")).toContain(
      "disabled",
    );
    expect(pendingMarkup).toContain(`aria-controls="${menuId}"`);
    expect(pendingMarkup).toContain('aria-busy="true"');
    expect(pendingMarkup).toContain('role="status"');
  });

  it("places the fixed portal below when it fits and above near the viewport edge", () => {
    expect(
      assistantMessageMoreMenuPosition({
        trigger: { top: 100, bottom: 128, left: 200 },
        viewportHeight: 720,
        viewportWidth: 1280,
      }),
    ).toEqual({ left: 200, top: 134 });
    expect(
      assistantMessageMoreMenuPosition({
        trigger: { top: 680, bottom: 708, left: 1200 },
        viewportHeight: 720,
        viewportWidth: 1280,
      }),
    ).toEqual({ left: 1052, top: 618 });
    expect(
      assistantMessageMoreMenuPosition({
        trigger: { top: 2, bottom: 30, left: -20 },
        viewportHeight: 60,
        viewportWidth: 180,
      }),
    ).toEqual({ left: 8, top: 8 });
  });

  it("opens from either trigger arrow and records a clamped portal position", async () => {
    const harness = await moreMenuHarness(controls(), null);
    const trigger = inspectableElements(
      harness.element,
      (element) => element.props["aria-haspopup"] === "menu",
    )[0]!;
    const currentTarget = {
      getBoundingClientRect: () => ({ top: 100, bottom: 128, left: 200 }),
    };
    vi.stubGlobal("window", { innerHeight: 720, innerWidth: 1280 });
    const preventDefault = vi.fn();

    trigger.props.onKeyDown?.({
      currentTarget,
      key: "ArrowUp",
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(harness.setMenuState).toHaveBeenCalledWith({
      initialFocus: "last",
      left: 200,
      top: 134,
      triggerLeft: 200,
      triggerTop: 100,
    });

    harness.setMenuState.mockClear();
    trigger.props.onKeyDown?.({
      currentTarget,
      key: "ArrowDown",
      preventDefault,
    });
    expect(harness.setMenuState).toHaveBeenCalledWith({
      initialFocus: "first",
      left: 200,
      top: 134,
      triggerLeft: 200,
      triggerTop: 100,
    });
  });

  it("navigates with arrows, Home, and End and moves Tab outside the portal", async () => {
    const harness = await moreMenuHarness(controls(), {
      initialFocus: "first",
      left: 200,
      top: 134,
      triggerLeft: 200,
      triggerTop: 100,
    });
    const first = { focus: vi.fn() };
    const second = { focus: vi.fn() };
    const items = [first, second];
    const trigger = { focus: vi.fn() };
    const tabTarget = { focus: vi.fn() };
    const panelNode = { querySelectorAll: () => items };
    harness.refs[1]!.current = trigger;
    harness.menuTabFocusTarget.mockReturnValue(tabTarget);
    vi.stubGlobal("document", { activeElement: first, body: {} });
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

    for (const [key, expectedFocus] of [
      ["ArrowDown", second.focus],
      ["ArrowUp", second.focus],
      ["Home", first.focus],
      ["End", second.focus],
    ] as const) {
      const preventDefault = vi.fn();
      panel.props.onKeyDown?.({
        currentTarget: panelNode,
        key,
        preventDefault,
        shiftKey: false,
      });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(expectedFocus).toHaveBeenCalledWith({ preventScroll: true });
    }

    const preventTabDefault = vi.fn();
    panel.props.onKeyDown?.({
      currentTarget: panelNode,
      key: "Tab",
      preventDefault: preventTabDefault,
      shiftKey: true,
    });
    expect(preventTabDefault).toHaveBeenCalledOnce();
    expect(harness.menuTabFocusTarget).toHaveBeenCalledWith(
      panelNode,
      trigger,
      true,
    );
    expect(harness.setMenuState).toHaveBeenCalledWith(null);
    expect(tabTarget.focus).toHaveBeenCalledOnce();
  });

  it("closes on outside pointer, scroll, resize, and Escape but preserves inside pointers", async () => {
    class TestNode {}
    const harness = await moreMenuHarness(controls(), {
      initialFocus: "first",
      left: 200,
      top: 134,
      triggerLeft: 200,
      triggerTop: 100,
    });
    const panelTarget = new TestNode();
    const triggerTarget = new TestNode();
    const outsideTarget = new TestNode();
    const triggerFocus = vi.fn();
    const firstItemFocus = vi.fn();
    const documentListeners = new Map<string, (event: never) => void>();
    const windowListeners = new Map<string, (event: never) => void>();
    harness.refs[0]!.current = {
      contains: (target: unknown) => target === panelTarget,
      querySelectorAll: () => ({
        item: () => ({ focus: firstItemFocus }),
        length: 1,
      }),
    };
    let triggerTop = 100;
    harness.refs[1]!.current = {
      contains: (target: unknown) => target === triggerTarget,
      focus: triggerFocus,
      getBoundingClientRect: () => ({ left: 200, top: triggerTop }),
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
    expect(firstItemFocus).toHaveBeenCalledWith({ preventScroll: true });

    documentListeners.get("pointerdown")?.({ target: panelTarget } as never);
    documentListeners.get("pointerdown")?.({ target: triggerTarget } as never);
    expect(harness.setMenuState).not.toHaveBeenCalled();

    documentListeners.get("pointerdown")?.({ target: outsideTarget } as never);
    expect(harness.setMenuState).toHaveBeenCalledWith(null);

    harness.setMenuState.mockClear();
    documentListeners.get("scroll")?.({} as never);
    expect(harness.setMenuState).not.toHaveBeenCalled();

    triggerTop = 99;
    documentListeners.get("scroll")?.({} as never);
    expect(harness.setMenuState).toHaveBeenCalledOnce();
    expect(harness.setMenuState).toHaveBeenCalledWith(null);

    harness.setMenuState.mockClear();
    windowListeners.get("resize")?.({} as never);
    expect(harness.setMenuState).toHaveBeenCalledOnce();
    expect(harness.setMenuState).toHaveBeenCalledWith(null);

    harness.setMenuState.mockClear();
    const preventDefault = vi.fn();
    windowListeners.get("keydown")?.({
      defaultPrevented: false,
      key: "Escape",
      preventDefault,
    } as never);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(harness.setMenuState).toHaveBeenCalledWith(null);
    expect(triggerFocus).toHaveBeenCalledWith({ preventScroll: true });

    if (typeof cleanup === "function") {
      cleanup();
    }
  });

  it("passes the persistent More trigger to the existing branch callback", async () => {
    const onBranch = vi.fn();
    const harness = await moreMenuHarness(controls({ onBranch }), {
      initialFocus: "first",
      left: 200,
      top: 134,
      triggerLeft: 200,
      triggerTop: 100,
    });
    const persistentTrigger = { focus: vi.fn() } as unknown as HTMLButtonElement;
    harness.refs[1]!.current = persistentTrigger;
    const menuItem = inspectableElements(
      harness.element,
      (element) =>
        element.type === "button" &&
        element.props.role === "menuitem" &&
        elementText(element) === "在新对话中分支",
    )[0]!;

    menuItem.props.onClick?.();

    expect(harness.setMenuState).toHaveBeenCalledWith(null);
    expect(onBranch).toHaveBeenCalledOnce();
    expect(onBranch).toHaveBeenCalledWith(
      {
        conversationId,
        messageId: assistantMessageId,
        role: "assistant",
        runId,
      },
      persistentTrigger,
    );
  });

  it("keeps a caller-disabled branch item focusable and exposes its exact reason", async () => {
    const onBranch = vi.fn();
    const disabledReason = "当前会话正在进行其他变更";
    const harness = await moreMenuHarness(
      controls({ disabledReason, onBranch }),
      {
        initialFocus: "first",
        left: 200,
        top: 134,
        triggerLeft: 200,
        triggerTop: 100,
      },
    );
    const menuItem = inspectableElements(
      harness.element,
      (element) =>
        element.type === "button" && element.props.role === "menuitem",
    )[0]!;

    expect(menuItem.props["aria-disabled"]).toBe(true);
    expect(menuItem.props.disabled).toBeUndefined();
    expect(menuItem.props["aria-label"]).toBe(
      `在新对话中分支不可用：${disabledReason}`,
    );

    menuItem.props.onClick?.();
    expect(onBranch).not.toHaveBeenCalled();
    expect(harness.setMenuState).not.toHaveBeenCalled();
  });

  it("classifies portal pointer targets against both the panel and trigger", () => {
    const panelTarget = {} as Node;
    const triggerTarget = {} as Node;
    const outsideTarget = {} as Node;
    const panel = { contains: (target: Node | null) => target === panelTarget };
    const trigger = {
      contains: (target: Node | null) => target === triggerTarget,
    };

    expect(
      assistantMessageMoreMenuPointerIsOutside(
        panel,
        trigger,
        panelTarget,
      ),
    ).toBe(false);
    expect(
      assistantMessageMoreMenuPointerIsOutside(
        panel,
        trigger,
        triggerTarget,
      ),
    ).toBe(false);
    expect(
      assistantMessageMoreMenuPointerIsOutside(
        panel,
        trigger,
        outsideTarget,
      ),
    ).toBe(true);
    expect(
      assistantMessageMoreMenuPointerIsOutside(null, null, outsideTarget),
    ).toBe(true);
    expect(
      assistantMessageMoreMenuPointerIsOutside(panel, trigger, null),
    ).toBe(false);
  });

  it("styles the response menu as a fixed portal in light, dark, and mobile layouts", async () => {
    const styles = await readFile(
      path.join(process.cwd(), "app/globals.css"),
      "utf8",
    );
    const menuStyles = styles.slice(
      styles.indexOf(".assistant-message-more-menu {"),
    );

    expect(menuStyles).toMatch(
      /\.assistant-message-more-menu \{[\s\S]*?position: fixed;[\s\S]*?z-index: 65;[\s\S]*?width: 220px;/u,
    );
    expect(styles).toContain(
      'html[data-theme="dark"] .assistant-message-more-menu,',
    );
    expect(styles).toMatch(
      /@media \(max-width: 600px\) \{[\s\S]*?\.assistant-message-more-menu button,/u,
    );
  });
});
