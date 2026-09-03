"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { CopyIcon } from "@/components/icons";
import {
  copyMessageContent,
  type MessageCopyResult,
} from "@/components/message-copy";

export function MessageCopyAction({
  children,
  content,
  persistent = false,
}: {
  children?: ReactNode;
  content: string | null;
  persistent?: boolean;
}) {
  const [feedback, setFeedback] = useState<MessageCopyResult | null>(null);
  const [isCopying, setIsCopying] = useState(false);
  const feedbackTimerRef = useRef<number | null>(null);
  const operationRef = useRef(0);

  useEffect(() => {
    return () => {
      operationRef.current += 1;
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  async function handleCopy() {
    if (content === null) {
      throw new Error("缺少待复制的消息内容");
    }
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    setIsCopying(true);

    const clipboard =
      typeof navigator.clipboard === "undefined" ? null : navigator.clipboard;
    const result = await copyMessageContent(content, clipboard);
    if (operationRef.current !== operation) {
      return;
    }

    setFeedback(result);
    setIsCopying(false);
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = window.setTimeout(() => {
      setFeedback(null);
      feedbackTimerRef.current = null;
    }, result.status === "copied" ? 2_000 : 3_500);
  }

  return (
    <div
      className={`message-actions${
        feedback === null && !persistent ? "" : " message-actions--persistent"
      }`}
    >
      {content === null ? null : (
        <button
          aria-label={isCopying ? "正在复制消息" : "复制消息"}
          className="message-action-button"
          disabled={isCopying}
          onClick={() => void handleCopy()}
          title="复制"
          type="button"
        >
          <CopyIcon />
        </button>
      )}
      {children}
      <span
        aria-live="polite"
        className={`message-copy-feedback${
          feedback?.status === "error" ? " message-copy-feedback--error" : ""
        }`}
        role={feedback?.status === "error" ? "alert" : "status"}
      >
        {feedback?.message ?? ""}
      </span>
    </div>
  );
}
