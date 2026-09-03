"use client";

import { useRef, type MouseEvent } from "react";

import { CloseIcon, KeyboardIcon } from "@/components/icons";
import { useModalFocus } from "@/components/modal-focus";
import { workspaceKeyboardShortcuts } from "@/components/workspace-ux-state";

export function KeyboardShortcutsDialog({ onClose }: { onClose: () => void }) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useModalFocus({
    backdropRef,
    canClose: true,
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
    onClose,
  });

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  return (
    <div
      className="conversation-mutation-backdrop keyboard-shortcuts-backdrop"
      data-modal-layer=""
      onMouseDown={handleBackdropMouseDown}
      ref={backdropRef}
    >
      <section
        aria-describedby="keyboard-shortcuts-dialog-description"
        aria-labelledby="keyboard-shortcuts-dialog-title"
        aria-modal="true"
        className="conversation-mutation-dialog keyboard-shortcuts-dialog"
        id="keyboard-shortcuts-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="conversation-mutation-dialog__header">
          <span className="conversation-mutation-dialog__icon">
            <KeyboardIcon />
          </span>
          <span>
            <strong id="keyboard-shortcuts-dialog-title">快捷键</strong>
            <small id="keyboard-shortcuts-dialog-description">
              当前研究工作区中可以直接使用的操作
            </small>
          </span>
          <button
            aria-label="关闭快捷键"
            className="icon-button"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="keyboard-shortcuts-dialog__body">
          <ul aria-label="工作区快捷键">
            {workspaceKeyboardShortcuts.map((shortcut) => (
              <li key={shortcut.id}>
                <span className="keyboard-shortcuts-dialog__copy">
                  <strong>{shortcut.label}</strong>
                  {"note" in shortcut ? (
                    <small>{shortcut.note}</small>
                  ) : null}
                </span>
                <span className="keyboard-shortcuts-dialog__keys">
                  <span className="visually-hidden">
                    {shortcut.accessibleKeys}
                  </span>
                  {shortcut.macKeys.map((key) => (
                    <kbd aria-hidden="true" key={key}>
                      {key}
                    </kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <p className="keyboard-shortcuts-dialog__platform-note">
            Windows 和 Linux 使用 <kbd>Ctrl</kbd> 代替 <kbd>⌘</kbd>。
          </p>
        </div>
      </section>
    </div>
  );
}
