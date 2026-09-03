import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserRunCompletionNotificationSettingsControl,
  currentBrowserNotificationSettingState,
  type BrowserRunCompletionNotificationSettingState,
} from "@/components/browser-run-completion-notification-settings";

function renderControl(
  state: BrowserRunCompletionNotificationSettingState,
  isRequestingPermission = false,
): string {
  return renderToStaticMarkup(
    <BrowserRunCompletionNotificationSettingsControl
      isRequestingPermission={isRequestingPermission}
      onDisable={() => undefined}
      onEnable={() => undefined}
      state={state}
    />,
  );
}

describe("browser Run-completion notification settings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("presents the browser-local feature as explicitly disabled by default", () => {
    const markup = renderControl({
      error: null,
      isSupported: true,
      permission: "default",
      preference: "disabled",
    });

    expect(markup).toContain("<legend>浏览器通知</legend>");
    expect(markup).toContain(
      "后台 Run 在其他对话中结束时，用系统通知提醒你。",
    );
    expect(markup).toContain('data-browser-notification-state="disabled"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain("首次开启时浏览器会请求通知权限");
    expect(markup).toContain(">开启通知</button>");
  });

  it("shows the exact enabled and permission-requesting states", () => {
    const enabledMarkup = renderControl({
      error: null,
      isSupported: true,
      permission: "granted",
      preference: "enabled",
    });
    expect(enabledMarkup).toContain(
      'data-browser-notification-state="enabled"',
    );
    expect(enabledMarkup).toContain('aria-pressed="true"');
    expect(enabledMarkup).toContain("后台完成通知已开启");
    expect(enabledMarkup).toContain(">关闭通知</button>");

    const requestingMarkup = renderControl(
      {
        error: null,
        isSupported: true,
        permission: "default",
        preference: "disabled",
      },
      true,
    );
    expect(requestingMarkup).toContain("disabled=\"\"");
    expect(requestingMarkup).toContain(">正在请求…</button>");
  });

  it("explains unsupported and browser-blocked states without offering a fake enable path", () => {
    const unsupportedMarkup = renderControl({
      error: null,
      isSupported: false,
      permission: null,
      preference: "disabled",
    });
    expect(unsupportedMarkup).toContain(
      'data-browser-notification-state="unsupported"',
    );
    expect(unsupportedMarkup).toContain("当前浏览器不可用");
    expect(unsupportedMarkup).toContain("跨标签页协调");
    expect(unsupportedMarkup).toContain("disabled=\"\"");
    expect(unsupportedMarkup).toContain(">无法开启</button>");

    const blockedMarkup = renderControl({
      error: null,
      isSupported: true,
      permission: "denied",
      preference: "disabled",
    });
    expect(blockedMarkup).toContain(
      'data-browser-notification-state="blocked"',
    );
    expect(blockedMarkup).toContain("通知权限已被浏览器阻止");
    expect(blockedMarkup).toContain("网站权限中允许通知");
    expect(blockedMarkup).toContain("disabled=\"\"");
    expect(blockedMarkup).toContain(">浏览器已阻止</button>");
  });

  it("shows explicit non-interactive storage failure and retryable permission failure states", () => {
    const storageErrorMarkup = renderControl({
      error: "storage_unavailable",
      isSupported: true,
      permission: "granted",
      preference: "enabled",
    });
    expect(storageErrorMarkup).toContain(
      'data-browser-notification-state="error"',
    );
    expect(storageErrorMarkup).toContain("浏览器存储不可用");
    expect(storageErrorMarkup).toContain("因此不会发送系统通知");
    expect(storageErrorMarkup).toContain("disabled=\"\"");
    expect(storageErrorMarkup).toContain(">当前不可用</button>");
    expect(storageErrorMarkup).toContain('aria-pressed="false"');

    const permissionErrorMarkup = renderControl({
      error: "permission_request_failed",
      isSupported: true,
      permission: "default",
      preference: "disabled",
    });
    expect(permissionErrorMarkup).toContain("通知权限请求失败");
    expect(permissionErrorMarkup).toContain(">重试开启</button>");
    expect(permissionErrorMarkup).not.toContain("disabled=\"\"");
  });

  it("reports storage unavailable when reads work but the write probe fails", () => {
    function FakeNotification() {
      return undefined;
    }
    Object.assign(FakeNotification, {
      permission: "granted",
      requestPermission: async () => "granted",
    });
    vi.stubGlobal("window", {
      Notification: FakeNotification,
      localStorage: {
        getItem: () => "enabled",
        removeItem: () => undefined,
        setItem: () => {
          throw new Error("quota exceeded");
        },
      },
      navigator: {
        locks: {
          request: () => undefined,
        },
      },
    });

    expect(currentBrowserNotificationSettingState()).toEqual({
      error: "storage_unavailable",
      isSupported: true,
      permission: "granted",
      preference: "disabled",
    });
  });

  it("requests Notification permission only from the explicit enable click path", async () => {
    const source = await readFile(
      path.join(
        process.cwd(),
        "components/browser-run-completion-notification-settings.tsx",
      ),
      "utf8",
    );
    const enableHandlerStart = source.indexOf("async function handleEnable()");
    const disableHandlerStart = source.indexOf(
      "function handleDisable()",
      enableHandlerStart,
    );
    const enableHandler = source.slice(
      enableHandlerStart,
      disableHandlerStart,
    );

    expect(enableHandlerStart).toBeGreaterThan(0);
    expect(disableHandlerStart).toBeGreaterThan(enableHandlerStart);
    expect(source.match(/\.requestPermission\(\)/gu)).toHaveLength(1);
    expect(enableHandler).toContain(
      "await window.Notification.requestPermission()",
    );
    expect(source).toContain("onClick={handleClick}");
    expect(source).toContain("onEnable={() => void handleEnable()}");
    expect(source).not.toContain("useEffect");
  });
});
