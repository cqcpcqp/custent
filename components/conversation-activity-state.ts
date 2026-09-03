export type ConversationActivityView = {
  isOpen: boolean;
  runId: string | null;
};

export type ConversationActivityViewMap = Record<
  string,
  ConversationActivityView
>;

export const closedConversationActivityView: ConversationActivityView = {
  isOpen: false,
  runId: null,
};

export function conversationActivityView(
  views: ConversationActivityViewMap,
  conversationKey: string,
): ConversationActivityView {
  return views[conversationKey] ?? closedConversationActivityView;
}

export function updateConversationActivityView(
  views: ConversationActivityViewMap,
  conversationKey: string,
  update: Partial<ConversationActivityView>,
): ConversationActivityViewMap {
  return {
    ...views,
    [conversationKey]: {
      ...conversationActivityView(views, conversationKey),
      ...update,
    },
  };
}

export function removeConversationActivityView(
  views: ConversationActivityViewMap,
  conversationKey: string,
): ConversationActivityViewMap {
  if (!Object.hasOwn(views, conversationKey)) {
    return views;
  }
  const next = { ...views };
  delete next[conversationKey];
  return next;
}
