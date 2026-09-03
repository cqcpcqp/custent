export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export type ConversationScrollSnapshot = {
  scrollTop: number;
  stickToBottom: boolean;
};

export const conversationBottomThresholdPx = 48;

export function maximumScrollTop(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

export function captureConversationScroll(
  metrics: ScrollMetrics,
): ConversationScrollSnapshot {
  const maximum = maximumScrollTop(metrics);
  const scrollTop = Math.min(maximum, Math.max(0, metrics.scrollTop));
  return {
    scrollTop,
    stickToBottom:
      maximum - scrollTop <= conversationBottomThresholdPx,
  };
}

export function shouldShowScrollToLatest(
  metrics: ScrollMetrics,
): boolean {
  return !captureConversationScroll(metrics).stickToBottom;
}

export function restoredConversationScrollTop(
  snapshot: ConversationScrollSnapshot | undefined,
  metrics: ScrollMetrics,
): number {
  const maximum = maximumScrollTop(metrics);
  if (snapshot === undefined || snapshot.stickToBottom) {
    return maximum;
  }
  return Math.min(maximum, Math.max(0, snapshot.scrollTop));
}
