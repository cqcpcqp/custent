"use client";

import { useState, useSyncExternalStore } from "react";

import {
  browserRunCompletionNotificationLedgerProbeStorageKey,
  browserRunCompletionNotificationLedgerStorageKey,
  browserRunCompletionNotificationPreferenceChangedEventName,
  browserRunCompletionNotificationPreferenceStorageKey,
  parseBrowserRunCompletionNotificationPreference,
  probeBrowserRunCompletionNotificationStorageWrite,
  readBrowserRunCompletionNotificationStorage,
  serializeBrowserRunCompletionNotificationLedger,
  serializeBrowserRunCompletionNotificationPreference,
  writeBrowserRunCompletionNotificationStorage,
  type BrowserRunCompletionNotificationPreference,
} from "@/components/browser-run-completion-notification-state";

export type BrowserRunCompletionNotificationSettingError =
  | "permission_request_failed"
  | "storage_unavailable";

export type BrowserRunCompletionNotificationSettingState = Readonly<{
  error: BrowserRunCompletionNotificationSettingError | null;
  isSupported: boolean;
  permission: NotificationPermission | null;
  preference: BrowserRunCompletionNotificationPreference;
}>;

type BrowserRunCompletionNotificationSettingsControlProps = Readonly<{
  isRequestingPermission: boolean;
  onDisable: () => void;
  onEnable: () => void;
  state: BrowserRunCompletionNotificationSettingState;
}>;

const unsupportedBrowserNotificationSettingState:
  BrowserRunCompletionNotificationSettingState = {
    error: null,
    isSupported: false,
    permission: null,
    preference: "disabled",
  };

const supportedBrowserNotificationSettingStates = {
  disabled: {
    default: {
      error: null,
      isSupported: true,
      permission: "default",
      preference: "disabled",
    },
    denied: {
      error: null,
      isSupported: true,
      permission: "denied",
      preference: "disabled",
    },
    granted: {
      error: null,
      isSupported: true,
      permission: "granted",
      preference: "disabled",
    },
  },
  enabled: {
    default: {
      error: null,
      isSupported: true,
      permission: "default",
      preference: "enabled",
    },
    denied: {
      error: null,
      isSupported: true,
      permission: "denied",
      preference: "enabled",
    },
    granted: {
      error: null,
      isSupported: true,
      permission: "granted",
      preference: "enabled",
    },
  },
} as const satisfies Record<
  BrowserRunCompletionNotificationPreference,
  Record<NotificationPermission, BrowserRunCompletionNotificationSettingState>
>;

const browserNotificationStorageErrorStates = {
  default: {
    error: "storage_unavailable",
    isSupported: true,
    permission: "default",
    preference: "disabled",
  },
  denied: {
    error: "storage_unavailable",
    isSupported: true,
    permission: "denied",
    preference: "disabled",
  },
  granted: {
    error: "storage_unavailable",
    isSupported: true,
    permission: "granted",
    preference: "disabled",
  },
} as const satisfies Record<
  NotificationPermission,
  BrowserRunCompletionNotificationSettingState
>;

function browserRunCompletionNotificationsAreSupported(): boolean {
  return (
    typeof window.Notification === "function" &&
    typeof window.Notification.requestPermission === "function" &&
    typeof window.navigator.locks?.request === "function"
  );
}

export function currentBrowserNotificationSettingState():
  BrowserRunCompletionNotificationSettingState {
  if (!browserRunCompletionNotificationsAreSupported()) {
    return unsupportedBrowserNotificationSettingState;
  }

  const permission = window.Notification.permission;
  const preferenceRead = readBrowserRunCompletionNotificationStorage(
    () => window.localStorage,
    browserRunCompletionNotificationPreferenceStorageKey,
  );
  const ledgerRead = readBrowserRunCompletionNotificationStorage(
    () => window.localStorage,
    browserRunCompletionNotificationLedgerStorageKey,
  );
  if (
    preferenceRead.status === "unavailable" ||
    ledgerRead.status === "unavailable"
  ) {
    return browserNotificationStorageErrorStates[permission];
  }
  if (
    !probeBrowserRunCompletionNotificationStorageWrite(
      () => window.localStorage,
      browserRunCompletionNotificationLedgerProbeStorageKey,
      ledgerRead.value ?? serializeBrowserRunCompletionNotificationLedger([]),
    )
  ) {
    return browserNotificationStorageErrorStates[permission];
  }
  const preference =
    parseBrowserRunCompletionNotificationPreference(preferenceRead.value) ??
    "disabled";
  return supportedBrowserNotificationSettingStates[preference][
    permission
  ];
}

function subscribeToBrowserNotificationSetting(
  onStoreChange: () => void,
): () => void {
  function handleStorage(event: StorageEvent) {
    if (
      event.key === null ||
      event.key === browserRunCompletionNotificationPreferenceStorageKey
    ) {
      onStoreChange();
    }
  }

  window.addEventListener("focus", onStoreChange);
  window.addEventListener(
    browserRunCompletionNotificationPreferenceChangedEventName,
    onStoreChange,
  );
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener("focus", onStoreChange);
    window.removeEventListener(
      browserRunCompletionNotificationPreferenceChangedEventName,
      onStoreChange,
    );
    window.removeEventListener("storage", handleStorage);
  };
}

function publishBrowserNotificationPreferenceChange(): void {
  window.dispatchEvent(
    new Event(
      browserRunCompletionNotificationPreferenceChangedEventName,
    ),
  );
}

function writeBrowserNotificationPreference(
  preference: BrowserRunCompletionNotificationPreference,
): boolean {
  if (
    !writeBrowserRunCompletionNotificationStorage(
      () => window.localStorage,
      browserRunCompletionNotificationPreferenceStorageKey,
      serializeBrowserRunCompletionNotificationPreference(preference),
    )
  ) {
    return false;
  }
  try {
    publishBrowserNotificationPreferenceChange();
  } catch {
    return false;
  }
  return true;
}

export function BrowserRunCompletionNotificationSettingsControl({
  isRequestingPermission,
  onDisable,
  onEnable,
  state,
}: BrowserRunCompletionNotificationSettingsControlProps) {
  const isEnabled =
    state.isSupported &&
    state.error === null &&
    state.preference === "enabled" &&
    state.permission === "granted";
  const canDisableBlockedPreference =
    state.isSupported &&
    state.preference === "enabled" &&
    state.permission === "denied";

  let status = "disabled";
  let title = "后台完成通知";
  let description =
    "仅在开启后发送；首次开启时浏览器会请求通知权限。";
  let buttonLabel = "开启通知";
  let isButtonDisabled = isRequestingPermission;
  let handleClick = onEnable;

  if (state.error === "storage_unavailable") {
    status = "error";
    title = "浏览器存储不可用";
    description =
      "无法安全保存通知设置和跨标签页去重记录，因此不会发送系统通知。";
    buttonLabel = "当前不可用";
    isButtonDisabled = true;
  } else if (!state.isSupported) {
    status = "unsupported";
    title = "当前浏览器不可用";
    description = "需要浏览器同时支持系统通知和跨标签页协调。";
    buttonLabel = "无法开启";
    isButtonDisabled = true;
  } else if (state.error === "permission_request_failed") {
    status = "error";
    title = "通知权限请求失败";
    description = "浏览器未完成通知权限请求，请稍后重试。";
    buttonLabel = "重试开启";
  } else if (state.permission === "denied") {
    status = "blocked";
    title = "通知权限已被浏览器阻止";
    description =
      "请先在浏览器的网站权限中允许通知，再返回这里开启。";
    buttonLabel = canDisableBlockedPreference
      ? "关闭通知"
      : "浏览器已阻止";
    isButtonDisabled =
      isRequestingPermission || !canDisableBlockedPreference;
    handleClick = onDisable;
  } else if (isEnabled) {
    status = "enabled";
    title = "后台完成通知已开启";
    description =
      "后台 Run 结束时，即使你正在查看其他对话，也会发送系统通知。";
    buttonLabel = "关闭通知";
    handleClick = onDisable;
  }

  if (isRequestingPermission) {
    buttonLabel = "正在请求…";
  }

  return (
    <fieldset className="settings-dialog__section">
      <legend>浏览器通知</legend>
      <p>后台 Run 在其他对话中结束时，用系统通知提醒你。</p>
      <div
        className={`settings-dialog__notification settings-dialog__notification--${status}`}
        data-browser-notification-state={status}
      >
        <span className="settings-dialog__notification-copy">
          <strong>{title}</strong>
          <small>{description}</small>
        </span>
        <button
          aria-pressed={state.isSupported ? isEnabled : undefined}
          disabled={isButtonDisabled}
          onClick={handleClick}
          type="button"
        >
          {buttonLabel}
        </button>
      </div>
    </fieldset>
  );
}

export function BrowserRunCompletionNotificationSettings() {
  const state = useSyncExternalStore(
    subscribeToBrowserNotificationSetting,
    currentBrowserNotificationSettingState,
    () => unsupportedBrowserNotificationSettingState,
  );
  const [isRequestingPermission, setIsRequestingPermission] =
    useState(false);
  const [operationError, setOperationError] =
    useState<BrowserRunCompletionNotificationSettingError | null>(null);

  async function handleEnable() {
    if (!browserRunCompletionNotificationsAreSupported()) {
      return;
    }

    setOperationError(null);
    setIsRequestingPermission(true);
    try {
      let permission: NotificationPermission;
      try {
        permission = await window.Notification.requestPermission();
      } catch {
        setOperationError("permission_request_failed");
        return;
      }
      if (
        !writeBrowserNotificationPreference(
          permission === "granted" ? "enabled" : "disabled",
        )
      ) {
        setOperationError("storage_unavailable");
      }
    } finally {
      setIsRequestingPermission(false);
    }
  }

  function handleDisable() {
    setOperationError(null);
    if (!writeBrowserNotificationPreference("disabled")) {
      setOperationError("storage_unavailable");
    }
  }

  const visibleState =
    operationError === null ? state : { ...state, error: operationError };

  return (
    <BrowserRunCompletionNotificationSettingsControl
      isRequestingPermission={isRequestingPermission}
      onDisable={handleDisable}
      onEnable={() => void handleEnable()}
      state={visibleState}
    />
  );
}
