import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ExecutionProfilePicker,
  executionProfilePickerTargetIndex,
} from "@/components/execution-profile-picker";
import type { ExecutionProfileOption } from "@/lib/contracts";

const options: ExecutionProfileOption[] = [
  {
    id: "standard_research",
    label: "标准研究",
    description: "适合快速查找和整理潜在买家。",
  },
  {
    id: "pro_research",
    label: "专业研究",
    description: "投入更多推理与检索，适合复杂市场研究。",
  },
];

function renderPicker(input: {
  options?: ExecutionProfileOption[];
  selectedId?: "standard_research" | "pro_research";
} = {}): string {
  return renderToStaticMarkup(
    <ExecutionProfilePicker
      disabled={false}
      onChange={() => undefined}
      options={input.options ?? options}
      scopeKey="test-draft"
      selectedId={input.selectedId ?? "standard_research"}
    />,
  );
}

describe("execution profile picker", () => {
  it("wraps arrow navigation at both ends", () => {
    expect(
      executionProfilePickerTargetIndex({
        activeIndex: 1,
        itemCount: 2,
        key: "ArrowDown",
      }),
    ).toBe(0);
    expect(
      executionProfilePickerTargetIndex({
        activeIndex: 0,
        itemCount: 2,
        key: "ArrowUp",
      }),
    ).toBe(1);
  });

  it("opens collapsed ArrowDown from the first item and ArrowUp from the last", () => {
    expect(
      executionProfilePickerTargetIndex({
        activeIndex: -1,
        itemCount: 2,
        key: "ArrowDown",
      }),
    ).toBe(0);
    expect(
      executionProfilePickerTargetIndex({
        activeIndex: -1,
        itemCount: 2,
        key: "ArrowUp",
      }),
    ).toBe(1);
  });

  it("supports Home and End navigation", () => {
    expect(
      executionProfilePickerTargetIndex({
        activeIndex: 1,
        itemCount: 2,
        key: "Home",
      }),
    ).toBe(0);
    expect(
      executionProfilePickerTargetIndex({
        activeIndex: 0,
        itemCount: 2,
        key: "End",
      }),
    ).toBe(1);
  });

  it("fails explicitly when the catalog is empty", () => {
    expect(() => renderPicker({ options: [] })).toThrow(
      "执行模式目录不能为空",
    );
  });

  it("fails explicitly when IDs are duplicated", () => {
    expect(() =>
      renderPicker({ options: [options[0], options[0]] }),
    ).toThrow("执行模式目录包含重复 ID：standard_research");
  });

  it("fails explicitly when the selected ID is not in the catalog", () => {
    expect(() =>
      renderPicker({
        options: [options[0]],
        selectedId: "pro_research",
      }),
    ).toThrow("执行模式目录不包含当前选择：pro_research");
  });

  it("server-renders an accessible collapsed trigger for the selected mode", () => {
    const markup = renderPicker({ selectedId: "pro_research" });

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain('aria-label="执行模式：专业研究"');
    expect(markup).toContain("专业研究");
    expect(markup).not.toContain('role="listbox"');
  });

  it("closes a prior scope before paint while preserving its picker focus target", async () => {
    const source = await readFile(
      path.join(process.cwd(), "components/execution-profile-picker.tsx"),
      "utf8",
    );

    expect(source).toMatch(
      /useLayoutEffect\(\(\) => \{[\s\S]*?listboxRef\.current\?\.contains\(activeElement\)[\s\S]*?triggerRef\.current\?\.focus\(\{ preventScroll: true \}\);[\s\S]*?setIsOpen\(false\);[\s\S]*?\}, \[scopeKey\]\);/u,
    );
  });

  it("keeps the 390px active-run menu inside the clipped workspace", async () => {
    const styles = await readFile(
      path.join(process.cwd(), "app/globals.css"),
      "utf8",
    );

    expect(styles).toMatch(
      /\.execution-profile-picker__listbox \{[\s\S]*?right: -48px;[\s\S]*?\.composer__actions:has\(\.composer__send--stop\)\s*\.execution-profile-picker__listbox \{\s*right: -96px;/u,
    );

    const viewportWidth = 390;
    const menuWidth = Math.min(320, viewportWidth - 24);
    const composerContentRight = viewportWidth - 10 - 1 - 7;
    const menuLeft = composerContentRight - menuWidth;

    expect(menuLeft).toBeGreaterThanOrEqual(0);
    expect(composerContentRight).toBeLessThanOrEqual(viewportWidth);
  });
});
