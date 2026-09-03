import {
  ApiClientError,
  isApiAbortError,
  userFacingRequestErrorMessage,
} from "@/components/api-client";
import type {
  AccountCustomInstructions,
  AccountCustomInstructionsResponse,
  PutAccountCustomInstructionsRequest,
} from "@/lib/contracts";

export const customInstructionsMaxLength = 4_000;

export type CustomInstructionsDraft = Readonly<{
  enabled: boolean;
  content: string;
}>;

export type CustomInstructionsSettingsState = Readonly<{
  conflict: boolean;
  draft: CustomInstructionsDraft | null;
  isReloading: boolean;
  isSaving: boolean;
  loadError: string | null;
  notice: string | null;
  reloadFocusRevision: number;
  saveError: string | null;
  setting: AccountCustomInstructions | null;
}>;

export type CustomInstructionsSettingsAction =
  | Readonly<{ type: "reload_started" }>
  | Readonly<{
      type: "load_succeeded";
      setting: AccountCustomInstructions;
    }>
  | Readonly<{ type: "load_failed"; message: string }>
  | Readonly<{ type: "draft_changed"; draft: CustomInstructionsDraft }>
  | Readonly<{ type: "save_started" }>
  | Readonly<{
      type: "save_succeeded";
      setting: AccountCustomInstructions;
    }>
  | Readonly<{ type: "save_failed"; message: string }>
  | Readonly<{ type: "save_conflicted" }>;

export const customInstructionsInitialState: CustomInstructionsSettingsState = {
  conflict: false,
  draft: null,
  isReloading: false,
  isSaving: false,
  loadError: null,
  notice: null,
  reloadFocusRevision: 0,
  saveError: null,
  setting: null,
};

export function customInstructionsSettingsReducer(
  state: CustomInstructionsSettingsState,
  action: CustomInstructionsSettingsAction,
): CustomInstructionsSettingsState {
  switch (action.type) {
    case "reload_started":
      return {
        ...state,
        isReloading: true,
        loadError: null,
        notice: null,
        saveError: null,
      };
    case "load_succeeded":
      return {
        ...state,
        conflict: false,
        draft: customInstructionsDraftFromSetting(action.setting),
        isReloading: false,
        loadError: null,
        reloadFocusRevision:
          state.reloadFocusRevision + (state.isReloading ? 1 : 0),
        setting: action.setting,
      };
    case "load_failed":
      return {
        ...state,
        isReloading: false,
        loadError: action.message,
        reloadFocusRevision:
          state.reloadFocusRevision + (state.isReloading ? 1 : 0),
      };
    case "draft_changed":
      return {
        ...state,
        draft: action.draft,
        notice: null,
        saveError: null,
      };
    case "save_started":
      return {
        ...state,
        isSaving: true,
        notice: null,
        saveError: null,
      };
    case "save_succeeded":
      return {
        ...state,
        conflict: false,
        draft: customInstructionsDraftFromSetting(action.setting),
        isSaving: false,
        notice: "自定义指令已保存，将应用到以后新建的对话。",
        saveError: null,
        setting: action.setting,
      };
    case "save_failed":
      return {
        ...state,
        isSaving: false,
        saveError: action.message,
      };
    case "save_conflicted":
      return {
        ...state,
        conflict: true,
        isSaving: false,
        saveError: null,
      };
  }
}

type RequestKind = "load" | "save";

export class CustomInstructionsRequestCoordinator {
  private loadController: AbortController | null = null;
  private saveController: AbortController | null = null;

  private currentController(kind: RequestKind): AbortController | null {
    return kind === "load" ? this.loadController : this.saveController;
  }

  private setController(
    kind: RequestKind,
    controller: AbortController | null,
  ): void {
    if (kind === "load") {
      this.loadController = controller;
    } else {
      this.saveController = controller;
    }
  }

  startLoad(): AbortSignal {
    this.loadController?.abort();
    const controller = new AbortController();
    this.loadController = controller;
    return controller.signal;
  }

  startSave(): AbortSignal | null {
    if (this.saveController !== null) {
      return null;
    }
    const controller = new AbortController();
    this.saveController = controller;
    return controller.signal;
  }

  isCurrent(kind: RequestKind, signal: AbortSignal): boolean {
    return (
      !signal.aborted && this.currentController(kind)?.signal === signal
    );
  }

  finish(kind: RequestKind, signal: AbortSignal): void {
    if (this.currentController(kind)?.signal === signal) {
      this.setController(kind, null);
    }
  }

  abortLoad(signal: AbortSignal): void {
    if (this.currentController("load")?.signal === signal) {
      this.loadController?.abort();
      this.loadController = null;
    }
  }

  abortAll(): void {
    this.loadController?.abort();
    this.saveController?.abort();
    this.loadController = null;
    this.saveController = null;
  }
}

export function restoreCustomInstructionsReloadFocus(
  reloadFocusRevision: number,
  handledRevision: number,
  button: Pick<HTMLButtonElement, "focus"> | null,
): number {
  if (reloadFocusRevision <= handledRevision) {
    return handledRevision;
  }
  button?.focus();
  return reloadFocusRevision;
}

type CustomInstructionsDispatch = (
  action: CustomInstructionsSettingsAction,
) => void;

export async function executeCustomInstructionsLoad({
  coordinator,
  dispatch,
  request,
  signal,
}: Readonly<{
  coordinator: CustomInstructionsRequestCoordinator;
  dispatch: CustomInstructionsDispatch;
  request: (
    signal: AbortSignal,
  ) => Promise<AccountCustomInstructionsResponse>;
  signal: AbortSignal;
}>): Promise<void> {
  try {
    const { customInstructions } = await request(signal);
    if (!coordinator.isCurrent("load", signal)) {
      return;
    }
    dispatch({ type: "load_succeeded", setting: customInstructions });
  } catch (error) {
    if (
      coordinator.isCurrent("load", signal) &&
      !customInstructionsIsAbortError(error)
    ) {
      dispatch({
        type: "load_failed",
        message: customInstructionsErrorMessage(error),
      });
    }
  } finally {
    coordinator.finish("load", signal);
  }
}

export async function executeCustomInstructionsSave({
  coordinator,
  dispatch,
  request,
  send,
}: Readonly<{
  coordinator: CustomInstructionsRequestCoordinator;
  dispatch: CustomInstructionsDispatch;
  request: PutAccountCustomInstructionsRequest;
  send: (
    request: PutAccountCustomInstructionsRequest,
    signal: AbortSignal,
  ) => Promise<AccountCustomInstructionsResponse>;
}>): Promise<boolean> {
  const signal = coordinator.startSave();
  if (signal === null) {
    return false;
  }
  dispatch({ type: "save_started" });
  try {
    const { customInstructions } = await send(request, signal);
    if (!coordinator.isCurrent("save", signal)) {
      return true;
    }
    dispatch({ type: "save_succeeded", setting: customInstructions });
  } catch (error) {
    if (
      !coordinator.isCurrent("save", signal) ||
      customInstructionsIsAbortError(error)
    ) {
      return true;
    }
    if (customInstructionsIsRevisionConflict(error)) {
      dispatch({ type: "save_conflicted" });
    } else {
      dispatch({
        type: "save_failed",
        message: customInstructionsErrorMessage(error),
      });
    }
  } finally {
    coordinator.finish("save", signal);
  }
  return true;
}

export function customInstructionsDraftFromSetting(
  setting: AccountCustomInstructions,
): CustomInstructionsDraft {
  return {
    enabled: setting.enabled,
    content: setting.content,
  };
}

export function customInstructionsDraftIsDirty(
  setting: AccountCustomInstructions,
  draft: CustomInstructionsDraft,
): boolean {
  return (
    setting.enabled !== draft.enabled || setting.content !== draft.content
  );
}

export function customInstructionsValidationMessage(
  draft: CustomInstructionsDraft,
): string | null {
  if (draft.content.length > customInstructionsMaxLength) {
    return `自定义指令不能超过 ${customInstructionsMaxLength} 个字符。`;
  }
  if (draft.enabled && draft.content.trim().length === 0) {
    return "开启自定义指令前，请先填写内容。";
  }
  return null;
}

export function customInstructionsPutRequest(
  setting: AccountCustomInstructions,
  draft: CustomInstructionsDraft,
): PutAccountCustomInstructionsRequest {
  return {
    enabled: draft.enabled,
    content: draft.content,
    expectedRevision: setting.revision,
  };
}

export function customInstructionsIsRevisionConflict(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    error.status === 409 &&
    error.code === "CUSTOM_INSTRUCTIONS_REVISION_CONFLICT"
  );
}

export function customInstructionsErrorMessage(error: unknown): string {
  return userFacingRequestErrorMessage(
    error,
    "自定义指令请求暂时失败，请重试。",
  );
}

export function customInstructionsIsAbortError(error: unknown): boolean {
  return isApiAbortError(error);
}
