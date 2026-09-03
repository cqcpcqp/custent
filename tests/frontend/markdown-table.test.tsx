import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  copyMarkdownTable,
  MarkdownTable,
  markdownTableToTsv,
} from "@/components/markdown-table";

function table(rows: readonly (readonly string[])[]): HTMLTableElement {
  return {
    rows: rows.map((cells) => ({
      cells: cells.map((innerText) => ({ innerText })),
    })),
  } as unknown as HTMLTableElement;
}

describe("MarkdownTable", () => {
  it("preserves the scroll region and table properties", () => {
    const markup = renderToStaticMarkup(
      <MarkdownTable
        regionProperties={{
          "aria-describedby": "table-help",
          className: "custom-scroll",
        }}
        tableProperties={{ className: "buyer-table", id: "buyers" }}
      >
        <tbody>
          <tr>
            <th>公司</th>
            <td>Acme</td>
          </tr>
        </tbody>
      </MarkdownTable>,
    );

    expect(markup).toContain('class="markdown-table"');
    expect(markup).toContain('aria-label="复制表格"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-describedby="table-help"');
    expect(markup).toContain(
      'class="research-markdown__table-scroll markdown-table__scroll custom-scroll"',
    );
    expect(markup).toContain('role="region"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain(
      '<table class="buyer-table" id="buyers"><tbody>',
    );
  });

  it("serializes rendered th and td text as one TSV row per DOM row", () => {
    expect(
      markdownTableToTsv(
        table([
          [" 公司 ", "采购\n负责人"],
          ["Acme\tLtd.", " Jane Doe "],
        ]),
      ),
    ).toBe("公司\t采购 负责人\nAcme Ltd.\tJane Doe");
  });

  it("writes the TSV through Clipboard API only after the write resolves", async () => {
    const writeText = vi.fn(async () => undefined);

    await expect(
      copyMarkdownTable(table([["公司", "Acme"]]), { writeText }),
    ).resolves.toEqual({ status: "copied", message: "已复制表格" });
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("公司\tAcme");
  });

  it("returns explicit failures when clipboard access is absent or rejected", async () => {
    await expect(
      copyMarkdownTable(table([["公司"]]), null),
    ).resolves.toEqual({
      status: "error",
      message: "当前环境无法访问剪贴板。",
    });

    const writeText = vi.fn(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });
    await expect(
      copyMarkdownTable(table([["公司"]]), { writeText }),
    ).resolves.toEqual({
      status: "error",
      message: "复制失败，请检查剪贴板权限后重试。",
    });
  });
});
