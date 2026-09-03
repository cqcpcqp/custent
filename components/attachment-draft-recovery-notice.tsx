type AttachmentDraftRecoveryNoticeProps =
  | {
      phase: "restoring";
      message: string;
    }
  | {
      phase: "failed";
      message: string;
      onDiscard: () => void;
      onRetry: () => void;
    };

export function AttachmentDraftRecoveryNotice(
  props: AttachmentDraftRecoveryNoticeProps,
) {
  if (props.phase === "restoring") {
    return (
      <div
        aria-live="polite"
        className="composer-attachment-recovery composer-attachment-recovery--restoring"
        role="status"
      >
        <span aria-hidden="true" className="composer-attachment-recovery__spinner" />
        <span>{props.message}</span>
      </div>
    );
  }

  return (
    <div
      aria-live="assertive"
      className="composer-attachment-recovery composer-attachment-recovery--failed"
      role="alert"
    >
      <span>{props.message}</span>
      <span className="composer-attachment-recovery__actions">
        <button onClick={props.onRetry} type="button">
          重新恢复
        </button>
        <button onClick={props.onDiscard} type="button">
          放弃这些附件
        </button>
      </span>
    </div>
  );
}
