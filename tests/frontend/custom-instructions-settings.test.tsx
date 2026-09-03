import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CustomInstructionsSettings,
  CustomInstructionsSettingsReadyContent,
} from "@/components/custom-instructions-settings";

function renderReady(
  overrides: Partial<
    Parameters<typeof CustomInstructionsSettingsReadyContent>[0]
  > = {},
): string {
  return renderToStaticMarkup(
    <CustomInstructionsSettingsReadyContent
      conflict={false}
      draft={{
        enabled: true,
        content: "优先寻找德国工业泵进口商，并为结论提供来源。",
      }}
      isDirty
      isReloading={false}
      isSaving={false}
      loadError={null}
      notice={null}
      onContentChange={() => undefined}
      onEnabledChange={() => undefined}
      onReload={() => undefined}
      onSave={() => undefined}
      reloadButtonRef={createRef<HTMLButtonElement>()}
      saveError={null}
      {...overrides}
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

describe("custom instructions settings", () => {
  it("starts with a truthful loading surface before the first GET resolves", () => {
    const markup = renderToStaticMarkup(<CustomInstructionsSettings />);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("正在加载自定义指令…");
  });

  it("renders a semantic switch, 4000-character editor, and privacy copy", () => {
    const markup = renderReady();
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('checked=""');
    expect(markup).toContain('id="custom-instructions-content"');
    expect(markup).toContain('maxLength="4000"');
    expect(markup).toContain('aria-invalid="false"');
    expect(markup).not.toContain('aria-live="polite"');
    expect(markup).toContain("22 / 4,000");
    expect(markup).toContain("保存后只会应用到以后新建的对话");
    expect(markup).toContain("禁用时会保留这里的文字");
    expect(markup).toContain("自定义指令原文会随新对话发送给模型供应商");
  });

  it("blocks an enabled blank draft with an explicit validation error", () => {
    const markup = renderReady({
      draft: { enabled: true, content: " \n" },
    });
    expect(markup).toContain("开启自定义指令前，请先填写内容。");
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain(
      'aria-describedby="custom-instructions-content-help custom-instructions-character-count custom-instructions-validation-error"',
    );
    expect(markup).toContain('id="custom-instructions-validation-error"');
    expect(openingTag(markup, "保存自定义指令")).toContain("disabled");
  });

  it("keeps disabled content editable and only disables save when unchanged", () => {
    const editableMarkup = renderReady({
      draft: { enabled: false, content: "保留这段文字" },
    });
    expect(openingTag(editableMarkup, 'role="switch"')).not.toContain(
      "disabled",
    );
    expect(openingTag(editableMarkup, "保留这段文字")).not.toContain(
      "disabled",
    );

    const unchangedMarkup = renderReady({ isDirty: false });
    expect(openingTag(unchangedMarkup, "保存自定义指令")).toContain(
      "disabled",
    );
  });

  it("makes save progress and revision conflicts explicit", () => {
    const savingMarkup = renderReady({ isSaving: true });
    expect(savingMarkup).toContain('aria-busy="true"');
    expect(savingMarkup).toContain("正在保存…");
    expect(openingTag(savingMarkup, 'role="switch"')).toContain("disabled");
    expect(openingTag(savingMarkup, 'id="custom-instructions-content"')).toContain(
      "disabled",
    );

    const conflictMarkup = renderReady({ conflict: true });
    expect(conflictMarkup).toContain("设置已在其他页面更新");
    expect(conflictMarkup).toContain("请重新加载最新版本，再继续修改");
    expect(conflictMarkup).toContain("重新加载");
    expect(openingTag(conflictMarkup, 'role="switch"')).toContain("disabled");
  });

  it("preserves the form and stable reload control while refreshing", () => {
    const markup = renderReady({ isReloading: true });
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('id="custom-instructions-content"');
    expect(markup).toContain("正在重新加载…");
    expect(openingTag(markup, 'role="switch"')).toContain("disabled");
  });

  it("announces save errors and successful future-conversation updates", () => {
    const markup = renderReady({
      notice: "自定义指令已保存，将应用到以后新建的对话。",
      saveError: "网络不可用",
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("保存失败：网络不可用");
    expect(markup).toContain('role="status"');
    expect(markup).toContain("将应用到以后新建的对话");
  });
});
