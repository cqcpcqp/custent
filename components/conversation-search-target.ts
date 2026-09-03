import type { ConversationBrowserSelection } from "@/components/conversation-browser-dialog";

export type ConversationSearchTarget = Readonly<{
  conversationId: string;
  messageId: string;
  requestId: number;
}>;

type SearchTargetContainer = Pick<HTMLElement, "querySelector">;

export function conversationSearchTargetFromSelection(
  selection: ConversationBrowserSelection,
  requestId: number,
): ConversationSearchTarget | null {
  if (selection.searchMatch?.kind !== "message") {
    return null;
  }
  return {
    conversationId: selection.conversation.id,
    messageId: selection.searchMatch.messageId,
    requestId,
  };
}

export function conversationMessageIsSearchTarget(
  target: ConversationSearchTarget | null,
  conversationId: string,
  messageId: string,
): boolean {
  return (
    target?.conversationId === conversationId && target.messageId === messageId
  );
}

export function revealConversationSearchTarget(
  container: SearchTargetContainer,
  target: ConversationSearchTarget,
  behavior: ScrollBehavior,
): boolean {
  const message = container.querySelector<HTMLElement>(
    `[data-message-id="${target.messageId}"]`,
  );
  if (message === null) {
    return false;
  }
  message.scrollIntoView({ behavior, block: "start" });
  return true;
}
