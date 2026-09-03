import { AlertIcon, RefreshIcon } from "@/components/icons";

export function ConversationLoadFailure({
  error,
  isRetrying,
  onRetry,
}: {
  error: string;
  isRetrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      aria-busy={isRetrying}
      className="conversation-load-failure"
      role="alert"
    >
      <span className="conversation-load-failure__icon">
        <AlertIcon />
      </span>
      <strong>暂时无法载入这个会话</strong>
      <p>{error}</p>
      <button disabled={isRetrying} onClick={onRetry} type="button">
        <RefreshIcon />
        {isRetrying ? "正在重新载入…" : "重新载入"}
      </button>
    </div>
  );
}
