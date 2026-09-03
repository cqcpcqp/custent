import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiClientError,
  getAccountCustomInstructions,
  putAccountCustomInstructions,
} from "@/components/api-client";
import {
  customInstructionsDraftFromSetting,
  customInstructionsDraftIsDirty,
  customInstructionsInitialState,
  customInstructionsIsRevisionConflict,
  customInstructionsMaxLength,
  customInstructionsPutRequest,
  customInstructionsSettingsReducer,
  customInstructionsValidationMessage,
  CustomInstructionsRequestCoordinator,
  executeCustomInstructionsLoad,
  executeCustomInstructionsSave,
  restoreCustomInstructionsReloadFocus,
} from "@/components/custom-instructions-settings-state";
import type { AccountCustomInstructions } from "@/lib/contracts";

const setting: AccountCustomInstructions = {
  enabled: true,
  content: "优先寻找德国工业泵进口商，并为结论提供来源。",
  revision: 7,
  updatedAt: "2026-09-01T03:20:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("custom instructions fixed API client", () => {
  it("loads the exact account setting without cache", async () => {
    const response = { customInstructions: setting };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAccountCustomInstructions()).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/custom-instructions",
      {
        method: "GET",
        cache: "no-store",
        signal: undefined,
      },
    );
  });

  it("saves the exact expected-revision request with PUT", async () => {
    const response = {
      customInstructions: {
        ...setting,
        content: "只输出已核实的买家信息。",
        revision: 8,
      },
    };
    const request = {
      enabled: true,
      content: "只输出已核实的买家信息。",
      expectedRevision: 7,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(putAccountCustomInstructions(request)).resolves.toEqual(
      response,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/custom-instructions",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: undefined,
      },
    );
  });

  it("rejects fields outside the fixed response contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          customInstructions: { ...setting, inventedField: true },
        }),
      ),
    );

    await expect(getAccountCustomInstructions()).rejects.toThrow();
  });
});

describe("custom instructions presentation state", () => {
  it("copies the setting exactly and detects only real draft changes", () => {
    const draft = customInstructionsDraftFromSetting(setting);
    expect(draft).toEqual({ enabled: true, content: setting.content });
    expect(customInstructionsDraftIsDirty(setting, draft)).toBe(false);
    expect(
      customInstructionsDraftIsDirty(setting, {
        ...draft,
        enabled: false,
      }),
    ).toBe(true);
    expect(
      customInstructionsDraftIsDirty(setting, {
        ...draft,
        content: `${draft.content}\n请用中文回答。`,
      }),
    ).toBe(true);
  });

  it("preserves disabled content and sends the saved revision", () => {
    const draft = { enabled: false, content: setting.content };
    expect(customInstructionsPutRequest(setting, draft)).toEqual({
      enabled: false,
      content: setting.content,
      expectedRevision: 7,
    });
    expect(customInstructionsValidationMessage(draft)).toBeNull();
  });

  it("requires nonblank content only when enabled and enforces 4000 chars", () => {
    expect(
      customInstructionsValidationMessage({ enabled: true, content: "  \n" }),
    ).toBe("开启自定义指令前，请先填写内容。");
    expect(
      customInstructionsValidationMessage({ enabled: false, content: "" }),
    ).toBeNull();
    expect(
      customInstructionsValidationMessage({
        enabled: true,
        content: "a".repeat(customInstructionsMaxLength),
      }),
    ).toBeNull();
    expect(
      customInstructionsValidationMessage({
        enabled: true,
        content: "a".repeat(customInstructionsMaxLength + 1),
      }),
    ).toBe("自定义指令不能超过 4000 个字符。");
  });

  it("recognizes conflicts only from the exact fixed code and status", () => {
    expect(
      customInstructionsIsRevisionConflict(
        new ApiClientError(
          "CUSTOM_INSTRUCTIONS_REVISION_CONFLICT",
          "conflict",
          409,
        ),
      ),
    ).toBe(true);
    expect(
      customInstructionsIsRevisionConflict(
        new ApiClientError(
          "CUSTOM_INSTRUCTIONS_REVISION_CONFLICT",
          "wrong status",
          500,
        ),
      ),
    ).toBe(false);
    expect(
      customInstructionsIsRevisionConflict(
        new ApiClientError("OTHER_CONFLICT", "wrong code", 409),
      ),
    ).toBe(false);
  });

  it("keeps the current form during reload and requests focus restoration", () => {
    const ready = customInstructionsSettingsReducer(
      customInstructionsInitialState,
      { type: "load_succeeded", setting },
    );
    const reloading = customInstructionsSettingsReducer(ready, {
      type: "reload_started",
    });

    expect(reloading.setting).toBe(setting);
    expect(reloading.draft).toEqual({
      enabled: true,
      content: setting.content,
    });
    expect(reloading.isReloading).toBe(true);

    const refreshed = customInstructionsSettingsReducer(reloading, {
      type: "load_succeeded",
      setting: { ...setting, revision: 8 },
    });
    expect(refreshed.isReloading).toBe(false);
    expect(refreshed.setting?.revision).toBe(8);
    expect(refreshed.reloadFocusRevision).toBe(1);

    const focus = vi.fn();
    expect(
      restoreCustomInstructionsReloadFocus(
        refreshed.reloadFocusRevision,
        0,
        { focus },
      ),
    ).toBe(1);
    expect(focus).toHaveBeenCalledOnce();
    expect(
      restoreCustomInstructionsReloadFocus(
        refreshed.reloadFocusRevision,
        1,
        { focus },
      ),
    ).toBe(1);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("transitions from the exact async 409 through reload to the fresh revision", async () => {
    const ready = customInstructionsSettingsReducer(
      customInstructionsInitialState,
      { type: "load_succeeded", setting },
    );
    const coordinator = new CustomInstructionsRequestCoordinator();
    const actions: Parameters<typeof customInstructionsSettingsReducer>[1][] = [];
    const request = customInstructionsPutRequest(setting, {
      enabled: false,
      content: setting.content,
    });
    await executeCustomInstructionsSave({
      coordinator,
      dispatch: (action) => actions.push(action),
      request,
      send: async () =>
        Promise.reject(
          new ApiClientError(
            "CUSTOM_INSTRUCTIONS_REVISION_CONFLICT",
            "revision changed",
            409,
          ),
        ),
    });

    expect(actions).toEqual([
      { type: "save_started" },
      { type: "save_conflicted" },
    ]);
    const conflicted = actions.reduce(
      customInstructionsSettingsReducer,
      ready,
    );
    expect(conflicted).toMatchObject({ conflict: true, isSaving: false });

    const reloading = customInstructionsSettingsReducer(conflicted, {
      type: "reload_started",
    });
    expect(reloading).toMatchObject({ conflict: true, isReloading: true });

    const refreshedSetting = { ...setting, revision: 9 };
    const refreshed = customInstructionsSettingsReducer(reloading, {
      type: "load_succeeded",
      setting: refreshedSetting,
    });
    expect(refreshed).toMatchObject({
      conflict: false,
      isReloading: false,
      setting: refreshedSetting,
    });
  });

  it("deduplicates a double save and aborts active work on unmount", async () => {
    const coordinator = new CustomInstructionsRequestCoordinator();
    const actions: Parameters<typeof customInstructionsSettingsReducer>[1][] = [];
    const request = customInstructionsPutRequest(setting, {
      enabled: false,
      content: setting.content,
    });
    const send = vi.fn(
      (_request: typeof request, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const dispatch = (action: (typeof actions)[number]) => actions.push(action);

    const firstSave = executeCustomInstructionsSave({
      coordinator,
      dispatch,
      request,
      send,
    });
    const duplicateSave = executeCustomInstructionsSave({
      coordinator,
      dispatch,
      request,
      send,
    });
    await expect(duplicateSave).resolves.toBe(false);
    expect(send).toHaveBeenCalledOnce();
    expect(actions).toEqual([{ type: "save_started" }]);

    coordinator.abortAll();
    await expect(firstSave).resolves.toBe(true);
    expect(actions).toEqual([{ type: "save_started" }]);
  });

  it("retires a stale async reload before its response can mutate state", async () => {
    const coordinator = new CustomInstructionsRequestCoordinator();
    const staleLoad = coordinator.startLoad();
    let resolveStale: (
      response: { customInstructions: AccountCustomInstructions },
    ) => void = () => undefined;
    const staleRequest = new Promise<{
      customInstructions: AccountCustomInstructions;
    }>((resolve) => {
      resolveStale = resolve;
    });
    const actions: Parameters<typeof customInstructionsSettingsReducer>[1][] = [];
    const staleTask = executeCustomInstructionsLoad({
      coordinator,
      dispatch: (action) => actions.push(action),
      request: () => staleRequest,
      signal: staleLoad,
    });

    const currentLoad = coordinator.startLoad();
    expect(staleLoad.aborted).toBe(true);
    resolveStale({ customInstructions: setting });
    await staleTask;

    expect(actions).toEqual([]);
    expect(coordinator.isCurrent("load", staleLoad)).toBe(false);
    expect(coordinator.isCurrent("load", currentLoad)).toBe(true);
  });
});
