import { describe, expect, it } from "vitest";

import {
  captureConversationScroll,
  conversationBottomThresholdPx,
  restoredConversationScrollTop,
  shouldShowScrollToLatest,
} from "@/components/conversation-scroll-state";

describe("conversation scroll state", () => {
  const metrics = {
    scrollTop: 0,
    scrollHeight: 2_000,
    clientHeight: 500,
  };

  it("新会话默认定位到内容底部", () => {
    expect(restoredConversationScrollTop(undefined, metrics)).toBe(1_500);
  });

  it("分别保留两个会话的绝对阅读位置", () => {
    const conversationA = captureConversationScroll({
      ...metrics,
      scrollTop: 620,
    });
    const conversationB = captureConversationScroll({
      ...metrics,
      scrollTop: 1_100,
    });

    expect(restoredConversationScrollTop(conversationA, metrics)).toBe(620);
    expect(restoredConversationScrollTop(conversationB, metrics)).toBe(1_100);
  });

  it("贴近底部时跟随新增的流式内容", () => {
    const snapshot = captureConversationScroll({
      ...metrics,
      scrollTop: 1_500 - conversationBottomThresholdPx,
    });

    expect(snapshot.stickToBottom).toBe(true);
    expect(
      restoredConversationScrollTop(snapshot, {
        ...metrics,
        scrollHeight: 2_400,
      }),
    ).toBe(1_900);
  });

  it("离开底部阅读历史时不被流式内容拉走", () => {
    const snapshot = captureConversationScroll({
      ...metrics,
      scrollTop: 700,
    });

    expect(snapshot.stickToBottom).toBe(false);
    expect(
      restoredConversationScrollTop(snapshot, {
        ...metrics,
        scrollHeight: 2_400,
      }),
    ).toBe(700);
  });

  it("内容缩短后把旧位置约束到新的可滚动范围", () => {
    expect(
      restoredConversationScrollTop(
        { scrollTop: 1_200, stickToBottom: false },
        { scrollTop: 0, scrollHeight: 800, clientHeight: 500 },
      ),
    ).toBe(300);
  });

  it("只有离开底部阈值后才显示回到最新消息入口", () => {
    expect(
      shouldShowScrollToLatest({
        ...metrics,
        scrollTop: 1_500 - conversationBottomThresholdPx,
      }),
    ).toBe(false);
    expect(
      shouldShowScrollToLatest({
        ...metrics,
        scrollTop: 1_500 - conversationBottomThresholdPx - 1,
      }),
    ).toBe(true);
    expect(
      shouldShowScrollToLatest({
        scrollTop: 0,
        scrollHeight: 300,
        clientHeight: 500,
      }),
    ).toBe(false);
  });
});
