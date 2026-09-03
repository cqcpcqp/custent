"use client";

import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";

import { AlertIcon, CheckIcon, CopyIcon } from "@/components/icons";

export type MarkdownTableClipboard = {
  writeText: (content: string) => Promise<void>;
};

export type MarkdownTableCopyResult =
  | { status: "copied"; message: "已复制表格" }
  | { status: "error"; message: string };

function tsvCellText(cell: HTMLTableCellElement): string {
  return cell.innerText.replace(/[\t\r\n]+/gu, " ").trim();
}

export function markdownTableToTsv(table: HTMLTableElement): string {
  return Array.from(table.rows)
    .map((row) => Array.from(row.cells, tsvCellText).join("\t"))
    .join("\n");
}

export async function copyMarkdownTable(
  table: HTMLTableElement,
  clipboard: MarkdownTableClipboard | null,
): Promise<MarkdownTableCopyResult> {
  if (clipboard === null) {
    return {
      status: "error",
      message: "当前环境无法访问剪贴板。",
    };
  }

  try {
    await clipboard.writeText(markdownTableToTsv(table));
    return { status: "copied", message: "已复制表格" };
  } catch {
    return {
      status: "error",
      message: "复制失败，请检查剪贴板权限后重试。",
    };
  }
}

type MarkdownTableProps = {
  children: ReactNode;
  regionProperties?: Omit<
    ComponentPropsWithoutRef<"div">,
    "children"
  >;
  tableProperties: Omit<
    ComponentPropsWithoutRef<"table">,
    "children" | "ref"
  >;
};

export function MarkdownTable({
  children,
  regionProperties = {},
  tableProperties,
}: MarkdownTableProps) {
  const tableRef = useRef<HTMLTableElement>(null);
  const operationRef = useRef(0);
  const feedbackTimerRef = useRef<number | null>(null);
  const [feedback, setFeedback] = useState<MarkdownTableCopyResult | null>(null);
  const [isCopying, setIsCopying] = useState(false);
  const {
    "aria-label": regionAriaLabel = "表格，可横向滚动",
    className: regionClassName,
    role: regionRole = "region",
    tabIndex: regionTabIndex = 0,
    ...remainingRegionProperties
  } = regionProperties;
  const regionClasses = [
    "research-markdown__table-scroll",
    "markdown-table__scroll",
    regionClassName,
  ]
    .filter((className) => className !== undefined && className.length > 0)
    .join(" ");
  const status = isCopying ? "copying" : (feedback?.status ?? "idle");

  useEffect(() => {
    return () => {
      operationRef.current += 1;
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  async function handleCopy() {
    const table = tableRef.current;
    if (table === null) {
      throw new Error("复制表格时缺少 table 元素");
    }

    const operation = operationRef.current + 1;
    operationRef.current = operation;
    setFeedback(null);
    setIsCopying(true);

    const clipboard =
      typeof navigator === "undefined" ||
      typeof navigator.clipboard === "undefined"
        ? null
        : navigator.clipboard;
    const result = await copyMarkdownTable(table, clipboard);
    if (operationRef.current !== operation) {
      return;
    }

    setFeedback(result);
    setIsCopying(false);
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = window.setTimeout(() => {
      if (operationRef.current === operation) {
        setFeedback(null);
      }
      feedbackTimerRef.current = null;
    }, result.status === "copied" ? 2_000 : 3_500);
  }

  return (
    <div className="markdown-table">
      <div className="markdown-table__toolbar">
        <button
          aria-label={
            isCopying
              ? "正在复制表格"
              : feedback?.status === "error"
                ? feedback.message
                : feedback?.status === "copied"
                  ? "已复制表格"
                  : "复制表格"
          }
          className={`markdown-table__copy markdown-table__copy--${status}`}
          disabled={isCopying}
          onClick={() => void handleCopy()}
          type="button"
        >
          {feedback?.status === "copied" ? (
            <CheckIcon />
          ) : feedback?.status === "error" ? (
            <AlertIcon />
          ) : (
            <CopyIcon />
          )}
          <span>
            {isCopying
              ? "复制中"
              : feedback?.status === "copied"
                ? "已复制"
                : feedback?.status === "error"
                  ? "复制失败"
                  : "复制表格"}
          </span>
        </button>
      </div>
      <div
        {...remainingRegionProperties}
        aria-label={regionAriaLabel}
        className={regionClasses}
        role={regionRole}
        tabIndex={regionTabIndex}
      >
        <table {...tableProperties} ref={tableRef}>
          {children}
        </table>
      </div>
      <span
        aria-atomic="true"
        aria-live="polite"
        className={`markdown-table__feedback visually-hidden${
          feedback?.status === "error"
            ? " markdown-table__feedback--error"
            : ""
        }`}
        role={feedback?.status === "error" ? "alert" : "status"}
      >
        {feedback?.message ?? ""}
      </span>
    </div>
  );
}
