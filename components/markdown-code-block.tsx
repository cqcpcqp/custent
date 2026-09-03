"use client";

import {
  useEffect,
  useMemo,
  useState,
  type HTMLAttributes,
} from "react";

import { AlertIcon, CheckIcon, CopyIcon } from "@/components/icons";
import {
  codeBlockCopyOperationIsCurrent,
  codeBlockCopyPresentation,
  copyMarkdownCode,
  highlightMarkdownCode,
  markdownCodeText,
  nextCodeBlockCopyOperation,
  parseMarkdownCodeLanguage,
  type CodeBlockCopyResult,
} from "@/components/markdown-code-block-state";

export function MarkdownCodeBlock({
  children,
  className,
  codeProperties,
  highlight,
  preProperties,
}: {
  children: string;
  className: string | undefined;
  codeProperties: HTMLAttributes<HTMLElement>;
  highlight: boolean;
  preProperties: HTMLAttributes<HTMLPreElement>;
}) {
  const code = markdownCodeText(children);
  const language = parseMarkdownCodeLanguage(className);
  const [copyState, setCopyState] = useState<{
    code: string;
    feedback: CodeBlockCopyResult | null;
    isCopying: boolean;
    operation: number;
    revision: number;
  }>(() => ({
    code,
    feedback: null,
    isCopying: false,
    operation: 0,
    revision: 0,
  }));
  const highlighted = useMemo(
    () => (highlight ? highlightMarkdownCode(code, language) : null),
    [code, highlight, language],
  );
  if (copyState.code !== code) {
    const nextRevision = nextCodeBlockCopyOperation(
      copyState.revision + 1,
      copyState.operation,
    );
    setCopyState({
      code,
      feedback: null,
      isCopying: false,
      operation: nextRevision.sequence,
      revision: nextRevision.identity,
    });
  }
  const copyStateIsCurrent = copyState.code === code;
  const feedback = copyStateIsCurrent ? copyState.feedback : null;
  const isCopying = copyStateIsCurrent && copyState.isCopying;
  const copyPresentation = codeBlockCopyPresentation(feedback, isCopying);
  const renderedClassName = `${className ?? ""}${
    highlighted?.highlighted === true ? " hljs" : ""
  }`.trim() || undefined;

  useEffect(() => {
    if (!copyStateIsCurrent || copyState.feedback === null) {
      return;
    }
    const operationCode = copyState.code;
    const operation = {
      identity: copyState.revision,
      sequence: copyState.operation,
    };
    const timer = window.setTimeout(() => {
      setCopyState((current) =>
        current.code === operationCode &&
        codeBlockCopyOperationIsCurrent(operation, {
          identity: current.revision,
          sequence: current.operation,
        })
          ? { ...current, feedback: null }
          : current,
      );
    }, copyState.feedback.status === "copied" ? 2_000 : 3_500);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    copyState.code,
    copyState.feedback,
    copyState.operation,
    copyState.revision,
    copyStateIsCurrent,
  ]);

  async function handleCopy() {
    const operation = nextCodeBlockCopyOperation(
      copyState.revision,
      copyState.operation,
    );
    const operationCode = code;
    setCopyState((current) =>
      current.code === operationCode &&
      current.revision === operation.identity
        ? {
            ...current,
            feedback: null,
            isCopying: true,
            operation: operation.sequence,
          }
        : current,
    );

    const clipboard =
      typeof navigator === "undefined" ||
      typeof navigator.clipboard === "undefined"
        ? null
        : navigator.clipboard;
    const result = await copyMarkdownCode(operationCode, clipboard);
    setCopyState((current) =>
      current.code === operationCode &&
      codeBlockCopyOperationIsCurrent(operation, {
        identity: current.revision,
        sequence: current.operation,
      })
        ? { ...current, feedback: result, isCopying: false }
        : current,
    );
  }

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-block__header">
        <span className="markdown-code-block__language">
          {language ?? "代码"}
        </span>
        <button
          aria-label={copyPresentation.ariaLabel}
          className={`markdown-code-block__copy markdown-code-block__copy--${copyPresentation.status}`}
          disabled={isCopying}
          onClick={() => void handleCopy()}
          type="button"
        >
          {copyPresentation.status === "copied" ? (
            <CheckIcon />
          ) : copyPresentation.status === "error" ? (
            <AlertIcon />
          ) : (
            <CopyIcon />
          )}
          <span>{copyPresentation.text}</span>
        </button>
      </div>
      <pre {...preProperties}>
        {highlighted?.highlighted === true ? (
          <code
            {...codeProperties}
            className={renderedClassName}
            // highlight.js escapes source text before adding its own span markup.
            dangerouslySetInnerHTML={{ __html: highlighted.html }}
          />
        ) : (
          <code {...codeProperties} className={renderedClassName}>
            {code}
          </code>
        )}
      </pre>
      <span
        aria-live="polite"
        className={`visually-hidden${
          feedback?.status === "error"
            ? " markdown-code-block__feedback--error"
            : ""
        }`}
        role={feedback?.status === "error" ? "alert" : "status"}
      >
        {feedback?.message ?? ""}
      </span>
    </div>
  );
}
