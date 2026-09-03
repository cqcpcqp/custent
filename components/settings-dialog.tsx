"use client";

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";

import {
  ArchiveIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  MonitorIcon,
  MoonIcon,
  SettingsIcon,
  ShareIcon,
  SparklesIcon,
  SunIcon,
  TrashIcon,
} from "@/components/icons";
import { BrowserRunCompletionNotificationSettings } from "@/components/browser-run-completion-notification-settings";
import {
  ConversationBulkActionDialog,
  type ConversationBulkAction,
  type DataControlMutationResult,
} from "@/components/conversation-mutation-dialogs";
import { CustomInstructionsSettings } from "@/components/custom-instructions-settings";
import { useModalFocus } from "@/components/modal-focus";
import { SharedLinksManager } from "@/components/shared-links-manager";
import { useTheme } from "@/components/theme-provider";
import type { ThemePreference } from "@/components/theme-state";

export const settingsThemeOptions = [
  {
    value: "light",
    label: "浅色",
    description: "始终使用浅色界面",
    icon: SunIcon,
  },
  {
    value: "dark",
    label: "深色",
    description: "始终使用深色界面",
    icon: MoonIcon,
  },
  {
    value: "system",
    label: "跟随系统",
    description: "根据设备外观自动切换",
    icon: MonitorIcon,
  },
] as const satisfies ReadonlyArray<{
  value: ThemePreference;
  label: string;
  description: string;
  icon: typeof SunIcon;
}>;

export const settingsSidebarOptions = [
  {
    value: "expanded",
    label: "展开",
    description: "显示完整导航和对话列表",
    icon: ChevronRightIcon,
  },
  {
    value: "collapsed",
    label: "收起",
    description: "只保留常用入口图标",
    icon: ChevronLeftIcon,
  },
] as const;

type SettingsSurface =
  | "preferences"
  | "custom_instructions"
  | "shared_links";

type ConversationBulkActionNotice = Readonly<{
  action: ConversationBulkAction;
  conversationCount: number;
}>;

export type { DataControlMutationResult } from "@/components/conversation-mutation-dialogs";

export function conversationBulkActionSuccessMessage(
  action: ConversationBulkAction,
  conversationCount: number,
): string {
  const formattedCount = conversationCount.toLocaleString("zh-CN");
  return action === "archive_all"
    ? `已归档 ${formattedCount} 个对话。`
    : `已永久删除 ${formattedCount} 个对话。`;
}

const settingsSurfaceCopy = {
  preferences: {
    title: "设置",
    description: "调整界面、个性化、提醒偏好与账户数据控制",
  },
  custom_instructions: {
    title: "自定义指令",
    description: "设置以后新建对话采用的业务背景与回答偏好",
  },
  shared_links: {
    title: "共享链接",
    description: "集中查看并撤销当前账户创建的公开链接",
  },
} as const satisfies Record<
  SettingsSurface,
  Readonly<{ title: string; description: string }>
>;

export function SettingsDialog({
  isSidebarCollapsed,
  onArchiveAllConversations,
  onClose,
  onDeleteAllConversations,
  onSidebarCollapsedChange,
  returnFocusRef,
}: {
  isSidebarCollapsed: boolean;
  onArchiveAllConversations: () => Promise<DataControlMutationResult>;
  onClose: () => void;
  onDeleteAllConversations: () => Promise<DataControlMutationResult>;
  onSidebarCollapsedChange: (collapsed: boolean) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const { preference: themePreference, setPreference: setThemePreference } =
    useTheme();
  const [surface, setSurface] = useState<SettingsSurface>("preferences");
  const [conversationBulkAction, setConversationBulkAction] =
    useState<ConversationBulkAction | null>(null);
  const [conversationBulkActionNotice, setConversationBulkActionNotice] =
    useState<ConversationBulkActionNotice | null>(null);
  const archiveAllConversationsButtonRef = useRef<HTMLButtonElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const deleteAllConversationsButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const manageCustomInstructionsButtonRef = useRef<HTMLButtonElement>(null);
  const manageSharedLinksButtonRef = useRef<HTMLButtonElement>(null);
  const previousSurfaceRef = useRef<SettingsSurface>(surface);

  useModalFocus({
    backdropRef,
    canClose: true,
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
    onClose,
    returnFocusRef,
  });

  useEffect(() => {
    const previousSurface = previousSurfaceRef.current;
    previousSurfaceRef.current = surface;
    if (previousSurface === surface) {
      return;
    }
    if (surface !== "preferences") {
      backButtonRef.current?.focus();
    } else if (previousSurface === "custom_instructions") {
      manageCustomInstructionsButtonRef.current?.focus();
    } else {
      manageSharedLinksButtonRef.current?.focus();
    }
  }, [surface]);

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      event.preventDefault();
      onClose();
    }
  }

  function openConversationBulkAction(action: ConversationBulkAction) {
    setConversationBulkActionNotice(null);
    setConversationBulkAction(action);
  }

  const surfaceCopy = settingsSurfaceCopy[surface];

  return (
    <>
      <div
        className="settings-dialog-backdrop"
        data-modal-layer=""
        onMouseDown={handleBackdropMouseDown}
        ref={backdropRef}
      >
        <section
          aria-describedby="settings-dialog-description"
          aria-labelledby="settings-dialog-title"
          aria-modal="true"
          className="settings-dialog"
          id="workspace-settings-dialog"
          ref={dialogRef}
          role="dialog"
          tabIndex={-1}
        >
          <header className="settings-dialog__header">
            <span className="settings-dialog__identity">
              {surface !== "preferences" ? (
                <button
                  aria-label="返回设置"
                  className="settings-dialog__back"
                  onClick={() => setSurface("preferences")}
                  ref={backButtonRef}
                  type="button"
                >
                  <ChevronLeftIcon />
                </button>
              ) : (
                <span aria-hidden="true">
                  <SettingsIcon />
                </span>
              )}
              <span>
                <strong id="settings-dialog-title">
                  {surfaceCopy.title}
                </strong>
                <small id="settings-dialog-description">
                  {surfaceCopy.description}
                </small>
              </span>
            </span>
            <button
              aria-label="关闭设置"
              className="icon-button"
              onClick={onClose}
              ref={closeButtonRef}
              type="button"
            >
              <CloseIcon />
            </button>
          </header>

          {surface === "shared_links" ? (
            <div className="settings-dialog__body settings-dialog__body--shared-links">
              <SharedLinksManager />
            </div>
          ) : surface === "custom_instructions" ? (
            <div className="settings-dialog__body settings-dialog__body--custom-instructions">
              <CustomInstructionsSettings />
            </div>
          ) : (
            <div className="settings-dialog__body">
            <p className="settings-dialog__local-note">
              界面与提醒偏好只保存在当前浏览器；数据控制会直接管理当前账户的数据。
            </p>

            <fieldset className="settings-dialog__section">
              <legend>界面主题</legend>
              <p>选择浅色、深色，或跟随设备的系统外观。</p>
              <div className="settings-dialog__options">
                {settingsThemeOptions.map((option) => {
                  const OptionIcon = option.icon;
                  return (
                    <label
                      className="settings-dialog__option"
                      data-theme-value={option.value}
                      key={option.value}
                    >
                      <input
                        checked={themePreference === option.value}
                        name="workspace-theme-preference"
                        onChange={() => setThemePreference(option.value)}
                        type="radio"
                        value={option.value}
                      />
                      <span className="settings-dialog__option-icon">
                        <OptionIcon />
                      </span>
                      <span className="settings-dialog__option-copy">
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                      <span
                        aria-hidden="true"
                        className="settings-dialog__option-indicator"
                      />
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <fieldset className="settings-dialog__section">
              <legend>桌面侧边栏</legend>
              <p>选择宽屏窗口中默认保留的导航宽度。</p>
              <div className="settings-dialog__options settings-dialog__options--compact">
                {settingsSidebarOptions.map((option) => {
                  const OptionIcon = option.icon;
                  const isSelected =
                    isSidebarCollapsed === (option.value === "collapsed");
                  return (
                    <label
                      className="settings-dialog__option"
                      data-sidebar-value={option.value}
                      key={option.value}
                    >
                      <input
                        checked={isSelected}
                        name="workspace-sidebar-preference"
                        onChange={() =>
                          onSidebarCollapsedChange(
                            option.value === "collapsed",
                          )
                        }
                        type="radio"
                        value={option.value}
                      />
                      <span className="settings-dialog__option-icon">
                        <OptionIcon />
                      </span>
                      <span className="settings-dialog__option-copy">
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                      <span
                        aria-hidden="true"
                        className="settings-dialog__option-indicator"
                      />
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <BrowserRunCompletionNotificationSettings />

            <fieldset className="settings-dialog__section">
              <legend>个性化</legend>
              <p>告诉 Agent 你的业务背景和希望采用的回答方式。</p>
              <button
                className="settings-dialog__data-control"
                onClick={() => setSurface("custom_instructions")}
                ref={manageCustomInstructionsButtonRef}
                type="button"
              >
                <span className="settings-dialog__data-control-icon">
                  <SparklesIcon />
                </span>
                <span>
                  <strong>自定义指令</strong>
                  <small>为以后新建的对话设置背景、目标市场与回答偏好</small>
                </span>
                <span>
                  设置
                  <ChevronRightIcon />
                </span>
              </button>
            </fieldset>

              <fieldset className="settings-dialog__section">
                <legend>数据控制</legend>
                <p>管理共享链接，并归档或永久删除当前账户中的对话。</p>
                {conversationBulkActionNotice === null ? null : (
                  <p
                    className="settings-dialog__data-control-notice"
                    role="status"
                  >
                    <CheckIcon />
                    {conversationBulkActionSuccessMessage(
                      conversationBulkActionNotice.action,
                      conversationBulkActionNotice.conversationCount,
                    )}
                  </p>
                )}
                <div className="settings-dialog__data-controls">
                  <button
                    className="settings-dialog__data-control"
                    onClick={() => setSurface("shared_links")}
                    ref={manageSharedLinksButtonRef}
                    type="button"
                  >
                    <span className="settings-dialog__data-control-icon">
                      <ShareIcon />
                    </span>
                    <span>
                      <strong>共享链接</strong>
                      <small>打开或撤销通过公开链接共享的对话快照</small>
                    </span>
                    <span>
                      管理
                      <ChevronRightIcon />
                    </span>
                  </button>
                  <button
                    aria-controls="conversation-bulk-action-dialog"
                    aria-expanded={conversationBulkAction === "archive_all"}
                    aria-haspopup="dialog"
                    className="settings-dialog__data-control"
                    onClick={() => openConversationBulkAction("archive_all")}
                    ref={archiveAllConversationsButtonRef}
                    type="button"
                  >
                    <span className="settings-dialog__data-control-icon">
                      <ArchiveIcon />
                    </span>
                    <span>
                      <strong>归档所有对话</strong>
                      <small>将所有未归档对话移到“已归档”，之后仍可恢复</small>
                    </span>
                    <span>
                      归档
                      <ChevronRightIcon />
                    </span>
                  </button>
                  <button
                    aria-controls="conversation-bulk-action-dialog"
                    aria-expanded={conversationBulkAction === "delete_all"}
                    aria-haspopup="dialog"
                    className="settings-dialog__data-control settings-dialog__data-control--danger"
                    onClick={() => openConversationBulkAction("delete_all")}
                    ref={deleteAllConversationsButtonRef}
                    type="button"
                  >
                    <span className="settings-dialog__data-control-icon">
                      <TrashIcon />
                    </span>
                    <span>
                      <strong>删除所有对话</strong>
                      <small>永久删除当前账户中的全部对话，包括已归档对话</small>
                    </span>
                    <span>
                      删除
                      <ChevronRightIcon />
                    </span>
                  </button>
                </div>
              </fieldset>
            </div>
          )}
        </section>
      </div>
      {conversationBulkAction === null ? null : (
        <ConversationBulkActionDialog
          action={conversationBulkAction}
          onClose={() => setConversationBulkAction(null)}
          onComplete={(conversationCount) => {
            setConversationBulkActionNotice({
              action: conversationBulkAction,
              conversationCount,
            });
            setConversationBulkAction(null);
          }}
          onConfirm={
            conversationBulkAction === "archive_all"
              ? onArchiveAllConversations
              : onDeleteAllConversations
          }
          returnFocusRef={
            conversationBulkAction === "archive_all"
              ? archiveAllConversationsButtonRef
              : deleteAllConversationsButtonRef
          }
        />
      )}
    </>
  );
}
