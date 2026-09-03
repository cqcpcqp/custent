"use client";

import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";

import {
  getAccountCustomInstructions,
  putAccountCustomInstructions,
} from "@/components/api-client";
import {
  customInstructionsDraftIsDirty,
  customInstructionsInitialState,
  customInstructionsMaxLength,
  customInstructionsPutRequest,
  restoreCustomInstructionsReloadFocus,
  customInstructionsSettingsReducer,
  customInstructionsValidationMessage,
  CustomInstructionsRequestCoordinator,
  executeCustomInstructionsLoad,
  executeCustomInstructionsSave,
  type CustomInstructionsDraft,
} from "@/components/custom-instructions-settings-state";
import {
  AlertIcon,
  CheckIcon,
  RefreshIcon,
  SparklesIcon,
} from "@/components/icons";

export type CustomInstructionsSettingsReadyContentProps = Readonly<{
  conflict: boolean;
  draft: CustomInstructionsDraft;
  isDirty: boolean;
  isReloading: boolean;
  isSaving: boolean;
  loadError: string | null;
  notice: string | null;
  onContentChange: (content: string) => void;
  onEnabledChange: (enabled: boolean) => void;
  onReload: () => void;
  onSave: () => void;
  reloadButtonRef: RefObject<HTMLButtonElement | null>;
  saveError: string | null;
}>;

export function CustomInstructionsSettingsReadyContent({
  conflict,
  draft,
  isDirty,
  isReloading,
  isSaving,
  loadError,
  notice,
  onContentChange,
  onEnabledChange,
  onReload,
  onSave,
  reloadButtonRef,
  saveError,
}: CustomInstructionsSettingsReadyContentProps) {
  const validationMessage = customInstructionsValidationMessage(draft);
  const validationMessageId = "custom-instructions-validation-error";
  const controlsAreLocked = isSaving || isReloading || conflict;
  const saveIsDisabled =
    controlsAreLocked || !isDirty || validationMessage !== null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saveIsDisabled) {
      onSave();
    }
  }

  return (
    <form
      aria-busy={isSaving || isReloading}
      className="custom-instructions-settings"
      onSubmit={handleSubmit}
    >
      <header className="custom-instructions-settings__intro">
        <span className="custom-instructions-settings__intro-icon">
          <SparklesIcon />
        </span>
        <span>
          <strong id="custom-instructions-settings-heading">
            自定义 Agent 的回答方式
          </strong>
          <small>
            填写你的业务背景、产品信息、目标市场和希望采用的回答风格。
          </small>
        </span>
      </header>

      <label className="custom-instructions-settings__toggle">
        <span>
          <strong>在新对话中启用</strong>
          <small>保存后只会应用到以后新建的对话。</small>
        </span>
        <input
          aria-describedby="custom-instructions-enabled-description"
          checked={draft.enabled}
          disabled={controlsAreLocked}
          onChange={(event) => onEnabledChange(event.currentTarget.checked)}
          role="switch"
          type="checkbox"
        />
        <span
          aria-hidden="true"
          className="custom-instructions-settings__switch"
        />
        <span
          className="custom-instructions-settings__sr-only"
          id="custom-instructions-enabled-description"
        >
          禁用不会删除已经填写的文字。
        </span>
      </label>

      <div className="custom-instructions-settings__field">
        <label htmlFor="custom-instructions-content">自定义指令</label>
        <textarea
          aria-describedby={`custom-instructions-content-help custom-instructions-character-count${
            validationMessage === null ? "" : ` ${validationMessageId}`
          }`}
          aria-invalid={validationMessage !== null}
          disabled={controlsAreLocked}
          id="custom-instructions-content"
          maxLength={customInstructionsMaxLength}
          onChange={(event) => onContentChange(event.currentTarget.value)}
          placeholder="例如：我们是一家生产工业水泵的工厂。优先寻找德国和荷兰的进口商；结论必须区分已核实信息与推测，并提供来源。"
          rows={9}
          value={draft.content}
        />
        <div className="custom-instructions-settings__field-meta">
          <small id="custom-instructions-content-help">
            禁用时会保留这里的文字，重新开启后仍可继续使用。
          </small>
          <output id="custom-instructions-character-count">
            {draft.content.length.toLocaleString("zh-CN")} /{" "}
            {customInstructionsMaxLength.toLocaleString("zh-CN")}
          </output>
        </div>
      </div>

      <div className="custom-instructions-settings__privacy-note">
        <AlertIcon />
        <span>
          <strong>请勿填写密码或其他敏感信息</strong>
          <small>
            启用后，自定义指令原文会随新对话发送给模型供应商。
          </small>
        </span>
      </div>

      {validationMessage === null ? null : (
        <p
          className="custom-instructions-settings__error"
          id={validationMessageId}
          role="alert"
        >
          <AlertIcon />
          {validationMessage}
        </p>
      )}

      {saveError === null ? null : (
        <p className="custom-instructions-settings__error" role="alert">
          <AlertIcon />
          保存失败：{saveError}
        </p>
      )}

      {loadError === null ? null : (
        <p className="custom-instructions-settings__error" role="alert">
          <AlertIcon />
          重新加载失败：{loadError}
        </p>
      )}

      {conflict ? (
        <div className="custom-instructions-settings__conflict" role="alert">
          <AlertIcon />
          <span>
            <strong>设置已在其他页面更新</strong>
            <small>请重新加载最新版本，再继续修改。</small>
          </span>
          <button disabled={isReloading} onClick={onReload} type="button">
            <RefreshIcon />
            {isReloading ? "正在重新加载…" : "重新加载"}
          </button>
        </div>
      ) : null}

      {notice === null ? null : (
        <p className="custom-instructions-settings__notice" role="status">
          <CheckIcon />
          {notice}
        </p>
      )}

      <footer className="custom-instructions-settings__actions">
        <button
          disabled={isSaving || isReloading}
          onClick={onReload}
          ref={reloadButtonRef}
          type="button"
        >
          <RefreshIcon />
          {isReloading ? "正在重新加载…" : "重新加载"}
        </button>
        <button
          className="custom-instructions-settings__save"
          disabled={saveIsDisabled}
          type="submit"
        >
          {isSaving ? "正在保存…" : "保存自定义指令"}
        </button>
      </footer>
    </form>
  );
}

export function CustomInstructionsSettings() {
  const [state, dispatch] = useReducer(
    customInstructionsSettingsReducer,
    customInstructionsInitialState,
  );
  const [loadRevision, setLoadRevision] = useState(0);
  const [requestCoordinator] = useState(
    () => new CustomInstructionsRequestCoordinator(),
  );
  const handledReloadFocusRevisionRef = useRef(0);
  const reloadButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const signal = requestCoordinator.startLoad();
    void executeCustomInstructionsLoad({
      coordinator: requestCoordinator,
      dispatch,
      request: getAccountCustomInstructions,
      signal,
    });

    return () => requestCoordinator.abortLoad(signal);
  }, [loadRevision, requestCoordinator]);

  useEffect(
    () => () => requestCoordinator.abortAll(),
    [requestCoordinator],
  );

  useEffect(() => {
    handledReloadFocusRevisionRef.current =
      restoreCustomInstructionsReloadFocus(
        state.reloadFocusRevision,
        handledReloadFocusRevisionRef.current,
        reloadButtonRef.current,
      );
  }, [state.reloadFocusRevision]);

  function handleReload() {
    if (state.isSaving || state.isReloading) {
      return;
    }
    dispatch({ type: "reload_started" });
    setLoadRevision((current) => current + 1);
  }

  function updateDraft(nextDraft: CustomInstructionsDraft) {
    dispatch({ type: "draft_changed", draft: nextDraft });
  }

  async function handleSave() {
    const { conflict, draft, isReloading, isSaving, setting } = state;
    if (
      setting === null ||
      draft === null ||
      isSaving ||
      isReloading ||
      conflict ||
      !customInstructionsDraftIsDirty(setting, draft) ||
      customInstructionsValidationMessage(draft) !== null
    ) {
      return;
    }

    await executeCustomInstructionsSave({
      coordinator: requestCoordinator,
      dispatch,
      request: customInstructionsPutRequest(setting, draft),
      send: putAccountCustomInstructions,
    });
  }

  const setting = state.setting;
  const draft = state.draft;
  if (setting === null || draft === null) {
    if (state.loadError !== null) {
      return (
        <div
          aria-busy={state.isReloading}
          className="custom-instructions-settings__load-failure"
          role="alert"
        >
          <AlertIcon />
          <strong>无法加载自定义指令</strong>
          <p>{state.loadError}</p>
          <button
            disabled={state.isReloading}
            onClick={handleReload}
            ref={reloadButtonRef}
            type="button"
          >
            <RefreshIcon />
            {state.isReloading ? "正在重新加载…" : "重新加载"}
          </button>
        </div>
      );
    }
    return (
      <div
        aria-busy="true"
        className="custom-instructions-settings__loading"
        role="status"
      >
        <span aria-hidden="true" />
        <strong>正在加载自定义指令…</strong>
      </div>
    );
  }

  return (
    <CustomInstructionsSettingsReadyContent
      conflict={state.conflict}
      draft={draft}
      isDirty={customInstructionsDraftIsDirty(setting, draft)}
      isReloading={state.isReloading}
      isSaving={state.isSaving}
      loadError={state.loadError}
      notice={state.notice}
      onContentChange={(content) => updateDraft({ ...draft, content })}
      onEnabledChange={(enabled) => updateDraft({ ...draft, enabled })}
      onReload={handleReload}
      onSave={() => void handleSave()}
      reloadButtonRef={reloadButtonRef}
      saveError={state.saveError}
    />
  );
}
