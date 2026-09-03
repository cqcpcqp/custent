import { randomUUID } from "node:crypto";

import type { Page, Request, Route } from "@playwright/test";

import {
  AccountCustomInstructionsResponseSchema,
  AccountUsageResponseSchema,
  BootstrapResponseSchema,
  BranchConversationRequestSchema,
  BranchConversationResponseSchema,
  BulkConversationMutationResponseSchema,
  CancelRunResponseSchema,
  ChatStartResponseSchema,
  ConversationResponseSchema,
  DeleteInputAttachmentResponseSchema,
  GetLibraryResearchResponseSchema,
  GetConversationShareResponseSchema,
  ListLibraryArtifactsResponseSchema,
  ListLibraryResearchResponseSchema,
  ListConversationsResponseSchema,
  ListConversationSharesResponseSchema,
  PutConversationShareResponseSchema,
  RevokeConversationShareResponseSchema,
  RetryRunResponseSchema,
  UploadInputAttachmentResponseSchema,
  type ChatRequest,
  type ConversationListItem,
  type ConversationListView,
} from "../../lib/contracts";
import {
  abandonE2eRunAfterSimulatedModelStart,
  assertE2eCustomInstructionsPersistence,
  assertE2eRetryQueueGraph,
  claimE2eRunAndAppendCommittedEvent,
  completeE2eRunWithoutProvider,
  completeE2eRunsWithoutProvider,
  E2E_LIBRARY_ARTIFACT_NAME,
  E2E_LIBRARY_COMPANY_EVIDENCE,
  E2E_LIBRARY_COMPANY_NAME,
  E2E_LIBRARY_COMPANY_RELEVANCE,
  E2E_LIBRARY_CONTACT_EVIDENCE,
  E2E_LIBRARY_CONTACT_NAME,
  E2E_LIBRARY_CONTACT_TITLE,
  E2E_LIBRARY_LIMITATIONS,
  E2E_LIBRARY_QUERY_SUMMARY,
  E2E_LIBRARY_RESEARCH_TITLE,
  E2E_PRE_SWITCH_REASONING_TEXT,
  E2E_RECONCILIATION_PARTIAL_TEXT,
  E2E_RECONCILIATION_REASONING_TEXT,
  E2E_RETRYABLE_FAILURE_MESSAGE,
  failE2eRunBeforeProvider,
  type E2eLibraryFixture,
} from "../fixtures/database";
import {
  E2E_BACKGROUND_CONVERSATION_ID,
  E2E_BACKGROUND_CONVERSATION_TITLE,
  E2E_CONTROL_CONVERSATION_ID,
  E2E_CONTROL_CONVERSATION_TITLE,
  E2E_DEMO_USER_ID,
} from "../fixtures/ids";
import {
  createE2eXlsxFixture,
  E2E_XLSX_ATTACHMENT_NAME,
  E2E_XLSX_ATTACHMENT_MIME_TYPE,
  E2E_XLSX_FIRST_SHEET_NAME,
  E2E_XLSX_SECOND_SHEET_NAME,
} from "../fixtures/xlsx";
import { expect, test } from "../fixtures/test";

test.describe.configure({ mode: "serial" });

let libraryFixture: E2eLibraryFixture | null = null;

function requireLibraryFixture(): E2eLibraryFixture {
  if (libraryFixture === null) {
    throw new Error("The provider-free Library fixture was not created");
  }
  return libraryFixture;
}

async function expectNoHorizontalPageOverflow(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
}

async function enqueueChatFromBrowser(page: Page, request: ChatRequest) {
  const response = await page.evaluate(async (body) => {
    const result = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      body: await result.json(),
      status: result.status,
    };
  }, request);
  expect(response.status).toBe(202);
  return ChatStartResponseSchema.parse(response.body);
}

async function retryVisibleRunFromBrowser(page: Page, sourceRunId: string) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/runs/${sourceRunId}/retry`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "重试这轮研究" }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(202);
  return RetryRunResponseSchema.parse(await response.json());
}

async function listAllConversationsFromBrowser(
  page: Page,
  view: ConversationListView,
): Promise<ConversationListItem[]> {
  const items: ConversationListItem[] = [];
  let cursor: string | null = null;
  do {
    const response = await page.evaluate(
      async ({ currentCursor, currentView }) => {
        const search = new URLSearchParams({
          limit: "50",
          query: "",
          view: currentView,
        });
        if (currentCursor !== null) {
          search.set("cursor", currentCursor);
        }
        const result = await fetch(`/api/conversations?${search.toString()}`);
        return {
          body: await result.json(),
          status: result.status,
        };
      },
      { currentCursor: cursor, currentView: view },
    );
    expect(response.status).toBe(200);
    const parsed = ListConversationsResponseSchema.parse(response.body);
    items.push(...parsed.items);
    cursor = parsed.nextCursor;
  } while (cursor !== null);
  return items;
}

test("loads the production workspace with compact desktop geometry", async ({
  page,
}) => {
  await page.goto(`/c/${E2E_BACKGROUND_CONVERSATION_ID}`);

  await expect(
    page.getByRole("button", {
      name: E2E_BACKGROUND_CONVERSATION_TITLE,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "输入研究问题" })).toBeVisible();

  await expect(page.locator(".research-header")).toHaveCSS("height", "56px");
  await expect(page.locator(".research-header .header-credit")).toBeHidden();
  await expect(
    page.locator(".research-header .header-new-button"),
  ).toBeHidden();
  const composerWidth = await page
    .locator(".composer")
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(composerWidth).toBeLessThanOrEqual(800);

  await page
    .getByRole("button", { name: "演示用户，打开用户菜单" })
    .click();
  await page.getByRole("menuitem", { name: "设置" }).click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
  await page.getByRole("button", { name: "关闭设置" }).click();
  await expect(
    page.getByRole("button", { name: "演示用户，打开用户菜单" }),
  ).toBeFocused();
});

test("supports ChatGPT-style new-conversation and composer-focus shortcuts", async ({
  page,
}) => {
  await page.goto(`/c/${E2E_CONTROL_CONVERSATION_ID}`);
  const composer = page.getByRole("textbox", { name: "输入研究问题" });
  const userMenuTrigger = page.getByRole("button", {
    name: "演示用户，打开用户菜单",
  });

  await expect(composer).toHaveAttribute(
    "aria-keyshortcuts",
    "Shift+Escape",
  );
  await composer.fill("快捷键切换后仍应保留的会话草稿");
  await userMenuTrigger.focus();
  await page.keyboard.press("Shift+Escape");
  await expect(composer).toBeFocused();

  await userMenuTrigger.click();
  await page.getByRole("menuitem", { name: "设置" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await expect(settingsDialog).toBeVisible();
  await page.keyboard.press("Control+Shift+O");
  await expect(settingsDialog).toBeVisible();
  await expect(page).toHaveURL(`/c/${E2E_CONTROL_CONVERSATION_ID}`);
  await page.getByRole("button", { name: "关闭设置" }).click();

  const newConversationTrigger = page.getByRole("button", {
    name: "新建研究",
  });
  await expect(newConversationTrigger).toHaveAttribute(
    "aria-keyshortcuts",
    "Meta+Shift+O Control+Shift+O",
  );
  await page.keyboard.press("Control+Shift+O");
  await expect(page).toHaveURL("/");
  const newConversationComposer = page.getByRole("textbox", {
    name: "输入研究问题",
  });
  await expect(newConversationComposer).toHaveValue("");
  await expect(newConversationComposer).toBeEnabled();
  await page.keyboard.press("Shift+Escape");
  await expect(newConversationComposer).toBeFocused();

  await page
    .getByRole("button", {
      name: E2E_CONTROL_CONVERSATION_TITLE,
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(`/c/${E2E_CONTROL_CONVERSATION_ID}`);
  await expect(
    page.getByRole("textbox", { name: "输入研究问题" }),
  ).toHaveValue("快捷键切换后仍应保留的会话草稿");
});

test("continues eight Runs after switching conversations with one observer and finite replay", async ({
  page,
}) => {
  const eventRequestCounts = new Map<string, number>();
  const eventRequestsByRunId = new Map<string, Request[]>();
  const activeEventRequests = new Set<Request>();
  const activeBootstrapRequests = new Set<Request>();
  const backgroundRunIds = new Set<string>();
  const backgroundEventRequests: string[] = [];
  let observeBackgroundRequests = false;
  let bootstrapRequestCount = 0;
  let maximumConcurrentEventRequests = 0;
  let maximumConcurrentBootstrapRequests = 0;

  const eventRunId = (request: Request): string | null => {
    const match = new URL(request.url()).pathname.match(
      /^\/api\/runs\/([0-9a-f-]+)\/events$/u,
    );
    return match?.[1] ?? null;
  };
  const finishObservedRequest = (request: Request) => {
    activeEventRequests.delete(request);
    activeBootstrapRequests.delete(request);
  };

  page.on("request", (request) => {
    const runId = eventRunId(request);
    if (runId !== null) {
      activeEventRequests.add(request);
      maximumConcurrentEventRequests = Math.max(
        maximumConcurrentEventRequests,
        activeEventRequests.size,
      );
      eventRequestCounts.set(
        runId,
        (eventRequestCounts.get(runId) ?? 0) + 1,
      );
      eventRequestsByRunId.set(runId, [
        ...(eventRequestsByRunId.get(runId) ?? []),
        request,
      ]);
      if (observeBackgroundRequests && backgroundRunIds.has(runId)) {
        backgroundEventRequests.push(runId);
      }
    }
    if (new URL(request.url()).pathname === "/api/bootstrap") {
      bootstrapRequestCount += 1;
      activeBootstrapRequests.add(request);
      maximumConcurrentBootstrapRequests = Math.max(
        maximumConcurrentBootstrapRequests,
        activeBootstrapRequests.size,
      );
    }
  });
  page.on("requestfailed", finishObservedRequest);
  page.on("requestfinished", finishObservedRequest);

  await page.goto(`/c/${E2E_BACKGROUND_CONVERSATION_ID}`);
  const composer = page.getByRole("textbox", { name: "输入研究问题" });
  await composer.fill("验证切换会话后后台任务仍继续执行");

  const chatResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/chat") &&
      response.request().method() === "POST",
  );
  await composer.press("Enter");
  const chatResponse = await chatResponsePromise;
  expect(chatResponse.status()).toBe(202);
  const started = ChatStartResponseSchema.parse(await chatResponse.json());
  await expect(page.locator('.message--assistant[aria-busy="true"]')).toBeVisible();
  await expect
    .poll(() => eventRequestCounts.get(started.run.id) ?? 0)
    .toBe(1);
  const claimedRun = await claimE2eRunAndAppendCommittedEvent(started.run.id);
  await expect(
    page.locator("summary.run-process-card__toggle"),
  ).toContainText("1 条分析摘要");
  await expect(page.locator(".run-process-card__content")).toContainText(
    E2E_PRE_SWITCH_REASONING_TEXT,
  );

  await page
    .getByRole("button", {
      name: E2E_CONTROL_CONVERSATION_TITLE,
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(`/c/${E2E_CONTROL_CONVERSATION_ID}`);
  await expect.poll(() => activeEventRequests.size).toBe(0);
  expect(eventRequestCounts.get(started.run.id)).toBe(1);

  const additionalChatRequests = Array.from({ length: 7 }, (_, index) => ({
    kind: "append" as const,
    conversationId: null,
    parentRunId: null,
    message: `E2E 后台并行研究 ${index + 2}`,
    attachmentIds: [],
    requestId: randomUUID(),
    executionProfileId: "standard_research" as const,
  }));
  const additionalChatPayloads = await page.evaluate(
    async (requests) => {
      const payloads: unknown[] = [];
      for (const request of requests) {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        if (response.status !== 202) {
          throw new Error(
            `Provider-free background enqueue returned ${response.status}`,
          );
        }
        payloads.push(await response.json());
      }
      return payloads;
    },
    additionalChatRequests,
  );
  const additionalRuns = additionalChatPayloads.map((payload) =>
    ChatStartResponseSchema.parse(payload),
  );
  const backgroundRuns = [started, ...additionalRuns];
  for (const backgroundRun of backgroundRuns) {
    backgroundRunIds.add(backgroundRun.run.id);
  }

  await expect.poll(() => activeBootstrapRequests.size).toBe(0);
  bootstrapRequestCount = 0;
  maximumConcurrentBootstrapRequests = 0;
  await page.route("**/api/bootstrap", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    await route.fallback();
  });
  observeBackgroundRequests = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("button", { name: "后台任务，8 项待处理" }),
  ).toBeVisible();
  await expect.poll(() => activeEventRequests.size).toBe(0);
  await expect.poll(() => bootstrapRequestCount).toBeGreaterThanOrEqual(2);
  await expect.poll(() => activeBootstrapRequests.size).toBe(0);
  expect(eventRequestCounts.get(started.run.id)).toBe(1);
  expect(backgroundEventRequests).toEqual([]);
  expect(maximumConcurrentEventRequests).toBeLessThanOrEqual(1);

  libraryFixture = await completeE2eRunsWithoutProvider({
    claimedRun,
    detailedRunId: started.run.id,
    expectedRunIds: backgroundRuns.map(({ run }) => run.id),
    includeLibraryFixture: true,
  });
  expect(libraryFixture).not.toBeNull();

  const latestCompletionNotification = page.locator(
    ".run-completion-notification",
  );
  await expect(latestCompletionNotification).toHaveCount(1);
  await expect(latestCompletionNotification).toContainText("另有 7 项");
  await latestCompletionNotification
    .getByRole("button", { name: /^关闭“/u })
    .click();
  await expect(latestCompletionNotification).toHaveCount(1);
  await expect(latestCompletionNotification).toContainText("另有 6 项");
  await expect(
    latestCompletionNotification.getByRole("button", { name: /^关闭“/u }),
  ).toBeFocused();
  expect(backgroundEventRequests).toEqual([]);
  expect(bootstrapRequestCount).toBeGreaterThanOrEqual(3);
  expect(maximumConcurrentBootstrapRequests).toBe(1);

  const backgroundTasksTrigger = page.getByRole("button", {
    name: "后台任务，8 项待处理",
  });
  await backgroundTasksTrigger.click();
  const backgroundTasksDialog = page.getByRole("dialog", { name: "后台任务" });
  await expect(
    backgroundTasksDialog.locator(
      ".background-run-center__group--attention .background-run-center__item",
    ),
  ).toHaveCount(8);
  await backgroundTasksDialog
    .getByRole("button", { name: "关闭后台任务" })
    .click();

  expect(backgroundEventRequests).toEqual([]);
  observeBackgroundRequests = false;
  const replayRequestCountBefore = eventRequestCounts.get(started.run.id) ?? 0;
  expect(replayRequestCountBefore).toBe(1);

  await page
    .getByRole("button", {
      name: new RegExp(`^${E2E_BACKGROUND_CONVERSATION_TITLE}`, "u"),
    })
    .click();

  await expect(page).toHaveURL(`/c/${E2E_BACKGROUND_CONVERSATION_ID}`);
  await expect(page.getByText("E2E 后台任务已完成，切换会话没有中断执行。"))
    .toBeVisible();
  await expect
    .poll(() => eventRequestCounts.get(started.run.id) ?? 0)
    .toBe(replayRequestCountBefore + 1);
  const replayRequest = eventRequestsByRunId.get(started.run.id)?.at(-1);
  expect(replayRequest).toBeDefined();
  expect(await replayRequest?.headerValue("last-event-id")).toBe(
    claimedRun.committedEventId,
  );

  const inlineActivityToggle = page.locator(
    "summary.run-process-card__toggle",
  );
  await expect(inlineActivityToggle).toHaveAttribute("aria-expanded", "false");
  await inlineActivityToggle.click();
  await expect(inlineActivityToggle).toHaveAttribute("aria-expanded", "true");
  const inlineActivity = page.locator(".run-process-card__content");
  await expect(inlineActivity).toContainText(
    "已在不调用模型供应商的 E2E 驱动中继续执行。",
  );
  await expect(inlineActivity).toContainText("生成 E2E CSV 文件");
  await expect(inlineActivity).toContainText("Python 执行完成");
  await expect(inlineActivity).toContainText("verified_buyers = 2");
  const fullActivityButton = inlineActivity.getByRole("button", {
    name: "查看完整活动",
  });
  await expect(fullActivityButton).toBeVisible();
  await fullActivityButton.click();

  const activityPanel = page.locator("#run-activity-panel");
  await expect(activityPanel).toBeVisible();
  await expect(
    activityPanel.getByText("已在不调用模型供应商的 E2E 驱动中继续执行。"),
  ).toBeVisible();
  await expect(activityPanel.getByText("生成 E2E CSV 文件")).toBeVisible();
  await expect(
    activityPanel.getByText("Python 执行完成"),
  ).toBeVisible();
  await expect(activityPanel).toContainText("verified_buyers = 2");
  await expect(activityPanel).toContainText("执行输出");
  await expect(
    activityPanel.getByRole("link", { name: "example.com", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "关闭活动面板" }).click();
  await expect(fullActivityButton).toBeFocused();
  await expect.poll(() => activeEventRequests.size).toBe(0);
  await page.waitForTimeout(1_250);
  expect(eventRequestCounts.get(started.run.id)).toBe(
    replayRequestCountBefore + 1,
  );

  const startedAssistantMessageId = started.run.assistantMessageId;
  const completedAssistantMessage = page.locator(
    `.message--assistant[data-message-id="${startedAssistantMessageId}"]`,
  );
  const moreActionsTrigger = completedAssistantMessage.getByRole("button", {
    name: "更多回答操作",
    exact: true,
  });
  const moreActionsMenu = page.getByRole("menu", {
    name: "更多回答操作",
    exact: true,
  });

  await moreActionsTrigger.click();
  await expect(moreActionsTrigger).toHaveAttribute("aria-expanded", "true");
  const branchMenuItem = moreActionsMenu.getByRole("menuitem", {
    name: "在新对话中分支",
    exact: true,
  });
  await expect(branchMenuItem).toBeVisible();
  await expect(branchMenuItem).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(moreActionsMenu).toHaveCount(0);
  await expect(moreActionsTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(moreActionsTrigger).toBeFocused();

  await moreActionsTrigger.click();
  await expect(branchMenuItem).toBeFocused();
  await composer.click();
  await expect(moreActionsMenu).toHaveCount(0);
  await expect(moreActionsTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(composer).toBeFocused();

  await moreActionsTrigger.click();
  const branchResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(
        `/api/conversations/${started.conversation.id}/branches`,
      ) && response.request().method() === "POST",
  );
  await branchMenuItem.click();
  const branchResponse = await branchResponsePromise;
  expect(branchResponse.status()).toBe(201);
  const branchRequest = BranchConversationRequestSchema.parse(
    branchResponse.request().postDataJSON(),
  );
  expect(branchRequest.sourceMessageId).toBe(startedAssistantMessageId);
  const branched = BranchConversationResponseSchema.parse(
    await branchResponse.json(),
  );
  expect(branched.conversation.id).not.toBe(started.conversation.id);
  expect(branched.conversation).toMatchObject({
    selectedRunId: null,
    activeRun: null,
    waitingRunCount: 0,
  });
  await expect(page).toHaveURL(`/c/${branched.conversation.id}`);
  await expect(
    page.getByText(
      "E2E 后台任务已完成，切换会话没有中断执行。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "输入研究问题" })).toBeFocused();
});

test("browses one finalized research snapshot and CSV through canonical Library routes", async ({
  page,
}) => {
  const fixture = requireLibraryFixture();
  await page.setViewportSize({ width: 390, height: 844 });

  const researchListResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/library/research" &&
      response.request().method() === "GET"
    );
  });
  await page.goto("/library/research");
  await expect(page).toHaveURL("/library/research");
  const researchListResponse = await researchListResponsePromise;
  expect(researchListResponse.status()).toBe(200);
  const researchPage = ListLibraryResearchResponseSchema.parse(
    await researchListResponse.json(),
  );
  expect(researchPage.items).toHaveLength(1);
  expect(researchPage.nextCursor).toBeNull();
  expect(researchPage.items[0]).toMatchObject({
    id: fixture.snapshot.id,
    title: E2E_LIBRARY_RESEARCH_TITLE,
    querySummary: E2E_LIBRARY_QUERY_SUMMARY,
    companyCount: 1,
    conversation: {
      id: fixture.conversationId,
      archivedAt: null,
    },
    runId: fixture.runId,
    assistantMessageId: fixture.assistantMessageId,
  });

  const researchTab = page.getByRole("tab", { name: "研究快照" });
  await expect(researchTab).toHaveAttribute("aria-selected", "true");
  const snapshotTrigger = page.getByRole("button", {
    name: `查看研究快照：${E2E_LIBRARY_RESEARCH_TITLE}`,
  });
  await expect(snapshotTrigger).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: new RegExp("^打开来源对话：", "u"),
    }),
  ).toBeVisible();
  await expectNoHorizontalPageOverflow(page);

  const detailResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/library/research/${fixture.snapshot.id}` &&
      response.request().method() === "GET",
  );
  await snapshotTrigger.click();
  await expect(page).toHaveURL(
    `/library/research/${fixture.snapshot.id}`,
  );
  const libraryBackButton = page.getByRole("button", { name: "返回资料库" });
  await expect(libraryBackButton).toBeFocused();
  const detailResponse = await detailResponsePromise;
  expect(detailResponse.status()).toBe(200);
  const detail = GetLibraryResearchResponseSchema.parse(
    await detailResponse.json(),
  ).research;
  expect(detail).toMatchObject({
    id: fixture.snapshot.id,
    title: E2E_LIBRARY_RESEARCH_TITLE,
    querySummary: E2E_LIBRARY_QUERY_SUMMARY,
    limitations: E2E_LIBRARY_LIMITATIONS,
    companyCount: 1,
  });
  await expect(
    page.getByRole("heading", {
      name: E2E_LIBRARY_RESEARCH_TITLE,
      level: 2,
    }),
  ).toBeVisible();
  await expect(page.getByText(E2E_LIBRARY_QUERY_SUMMARY, { exact: true }))
    .toBeVisible();
  await expect(page.getByText(E2E_LIBRARY_LIMITATIONS, { exact: true }))
    .toBeVisible();
  await expect(
    page.getByRole("heading", { name: E2E_LIBRARY_COMPANY_NAME, level: 3 }),
  ).toBeVisible();
  await expect(page.getByText(E2E_LIBRARY_COMPANY_RELEVANCE, { exact: true }))
    .toBeVisible();
  await expect(page.getByText(E2E_LIBRARY_COMPANY_EVIDENCE, { exact: true }))
    .toBeVisible();
  await expect(page.getByText(E2E_LIBRARY_CONTACT_NAME, { exact: true }))
    .toBeVisible();
  await expect(page.getByText(E2E_LIBRARY_CONTACT_TITLE, { exact: true }))
    .toBeVisible();
  await expect(page.getByText(E2E_LIBRARY_CONTACT_EVIDENCE, { exact: true }))
    .toBeVisible();
  await expect(page.getByText("置信度 A", { exact: true })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);

  await libraryBackButton.click();
  await expect(page).toHaveURL("/library/research");
  await expect(snapshotTrigger).toBeFocused();
  await expect(researchTab).toHaveAttribute("aria-selected", "true");

  const artifactListResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/library/artifacts" &&
      response.request().method() === "GET"
    );
  });
  await page.getByRole("tab", { name: "生成文件" }).click();
  await expect(page).toHaveURL("/library/artifacts");
  const artifactListResponse = await artifactListResponsePromise;
  expect(artifactListResponse.status()).toBe(200);
  const artifactPage = ListLibraryArtifactsResponseSchema.parse(
    await artifactListResponse.json(),
  );
  expect(artifactPage.items).toHaveLength(1);
  expect(artifactPage.nextCursor).toBeNull();
  expect(artifactPage.items[0]).toMatchObject({
    id: fixture.artifact.id,
    name: E2E_LIBRARY_ARTIFACT_NAME,
    mimeType: "text/csv",
    downloadUrl: fixture.artifact.downloadUrl,
    conversation: {
      id: fixture.conversationId,
      archivedAt: null,
    },
    runId: fixture.runId,
    assistantMessageId: fixture.assistantMessageId,
    researchSnapshotId: fixture.snapshot.id,
  });

  const previewTrigger = page.getByRole("button", {
    name: `预览文件：${E2E_LIBRARY_ARTIFACT_NAME}`,
  });
  await expect(previewTrigger).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: `查看关联研究快照：${E2E_LIBRARY_ARTIFACT_NAME}`,
    }),
  ).toBeVisible();
  await expectNoHorizontalPageOverflow(page);

  const previewResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === fixture.artifact.downloadUrl &&
      response.request().method() === "GET",
  );
  await previewTrigger.click();
  const previewDialog = page.getByRole("dialog", {
    name: new RegExp(E2E_LIBRARY_ARTIFACT_NAME, "u"),
  });
  await expect(previewDialog).toBeVisible();
  const closePreviewButton = previewDialog.getByRole("button", {
    name: `关闭文件预览：${E2E_LIBRARY_ARTIFACT_NAME}`,
  });
  await expect(closePreviewButton).toBeFocused();
  expect((await previewResponsePromise).status()).toBe(200);
  const csvPreview = previewDialog.getByRole("region", {
    name: `${E2E_LIBRARY_ARTIFACT_NAME} CSV 表格预览`,
  });
  await expect(csvPreview).toBeVisible();
  await expect(
    csvPreview.getByRole("columnheader", { name: "company_name" }),
  ).toBeVisible();
  await expect(
    csvPreview.getByRole("cell", { name: E2E_LIBRARY_COMPANY_NAME }),
  ).toBeVisible();
  await expect(
    csvPreview.getByRole("cell", {
      name: E2E_LIBRARY_CONTACT_NAME,
      exact: true,
    }),
  ).toBeVisible();
  await expectNoHorizontalPageOverflow(page);

  const downloadLink = previewDialog.getByRole("link", {
    name: `下载文件：${E2E_LIBRARY_ARTIFACT_NAME}`,
  });
  await expect(downloadLink).toHaveAttribute(
    "href",
    fixture.artifact.downloadUrl,
  );
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(E2E_LIBRARY_ARTIFACT_NAME);
  expect(await download.failure()).toBeNull();

  await closePreviewButton.click();
  await expect(previewDialog).toBeHidden();
  await expect(previewTrigger).toBeFocused();
  await expectNoHorizontalPageOverflow(page);
});

test("uploads and previews private TXT and XLSX attachments without a provider", async ({
  page,
}) => {
  await page.goto(`/c/${E2E_CONTROL_CONVERSATION_ID}`);
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "添加附件" }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: "verified-buyers.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Verified buyer A\nVerified buyer B\n", "utf8"),
  });
  await expect(page.getByText(/上传完成 · TXT/)).toBeVisible();

  const xlsxFileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "添加附件" }).click();
  const xlsxFileChooser = await xlsxFileChooserPromise;
  await xlsxFileChooser.setFiles({
    name: E2E_XLSX_ATTACHMENT_NAME,
    mimeType: E2E_XLSX_ATTACHMENT_MIME_TYPE,
    buffer: createE2eXlsxFixture(),
  });
  await expect(page.getByText(/上传完成 · XLSX/)).toBeVisible();

  const composer = page.getByRole("textbox", { name: "输入研究问题" });
  await composer.fill("读取这个 TXT 附件");
  const chatResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/chat") &&
      response.request().method() === "POST",
  );
  await composer.press("Enter");
  expect((await chatResponsePromise).status()).toBe(202);

  const previewTrigger = page.getByRole("button", {
    name: "预览源码：verified-buyers.txt",
  });
  await expect(previewTrigger).toBeVisible();
  await previewTrigger.click();
  const previewDialog = page.getByRole("dialog", {
    name: /verified-buyers\.txt/u,
  });
  await expect(previewDialog).toBeVisible();
  await expect(
    previewDialog.getByRole("region", {
      name: "verified-buyers.txt TXT 源码预览",
    }),
  ).toContainText("Verified buyer A");
  await page.keyboard.press("Escape");
  await expect(previewTrigger).toBeFocused();

  const cancelResponsePromise = page.waitForResponse(
    (response) =>
      /\/api\/runs\/[0-9a-f-]+\/cancel$/u.test(response.url()) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "停止生成" }).click();
  expect((await cancelResponsePromise).status()).toBe(200);
  await expect(page.getByText("这次研究已停止")).toBeVisible();

  // Reload before opening the spreadsheet so this assertion exercises the
  // persisted historical user message, not only the just-submitted draft.
  await page.reload();
  const historicalUserMessage = page
    .locator(".message--user")
    .filter({ hasText: "读取这个 TXT 附件" });
  await expect(historicalUserMessage).toContainText(E2E_XLSX_ATTACHMENT_NAME);

  const xlsxPreviewTrigger = page.getByRole("button", {
    name: `预览表格：${E2E_XLSX_ATTACHMENT_NAME}`,
    exact: true,
  });
  await expect(xlsxPreviewTrigger).toBeVisible();
  await expect(xlsxPreviewTrigger).toHaveAttribute("aria-haspopup", "dialog");

  const xlsxPreviewResponsePromise = page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname;
    return (
      response.request().method() === "GET" &&
      /^\/api\/input-attachments\/[0-9a-f-]+\/content$/u.test(pathname)
    );
  });
  await xlsxPreviewTrigger.click();
  const xlsxPreviewDialog = page.getByRole("dialog", {
    name: new RegExp(E2E_XLSX_ATTACHMENT_NAME, "u"),
  });
  await expect(xlsxPreviewDialog).toBeVisible();
  await expect(
    xlsxPreviewDialog.getByRole("button", {
      name: `关闭表格预览：${E2E_XLSX_ATTACHMENT_NAME}`,
    }),
  ).toBeFocused();
  expect((await xlsxPreviewResponsePromise).status()).toBe(200);

  const sheetTabs = xlsxPreviewDialog.getByRole("tablist", {
    name: `${E2E_XLSX_ATTACHMENT_NAME} 工作表`,
  });
  await expect(sheetTabs).toBeVisible();
  const firstSheetTab = sheetTabs.getByRole("tab", {
    name: E2E_XLSX_FIRST_SHEET_NAME,
    exact: true,
  });
  const secondSheetTab = sheetTabs.getByRole("tab", {
    name: E2E_XLSX_SECOND_SHEET_NAME,
    exact: true,
  });
  await expect(firstSheetTab).toHaveAttribute("aria-selected", "true");
  await expect(secondSheetTab).toHaveAttribute("aria-selected", "false");

  const sheetPanel = xlsxPreviewDialog.getByRole("tabpanel");
  await expect(sheetPanel).toContainText("只读预览");
  await expect(
    sheetPanel.locator('input, textarea, [contenteditable="true"]'),
  ).toHaveCount(0);
  await expect(sheetPanel).toContainText("Company");
  await expect(sheetPanel).toContainText("Acme GmbH");
  await expect(sheetPanel).toContainText("Germany");
  await expect(sheetPanel).toContainText("42");
  await expect(sheetPanel).not.toContainText("Follow up");

  await secondSheetTab.click();
  await expect(secondSheetTab).toHaveAttribute("aria-selected", "true");
  await expect(firstSheetTab).toHaveAttribute("aria-selected", "false");
  await expect(sheetPanel).toContainText("Status");
  await expect(sheetPanel).toContainText("Contacted");
  await expect(sheetPanel).toContainText("Follow up");
  await expect(sheetPanel).toContainText("TRUE");
  await expect(sheetPanel).not.toContainText("Acme GmbH");

  const xlsxDownloadLink = xlsxPreviewDialog.getByRole("link", {
    name: `下载原文件：${E2E_XLSX_ATTACHMENT_NAME}`,
  });
  const xlsxDownloadHref = await xlsxDownloadLink.getAttribute("href");
  expect(xlsxDownloadHref).toMatch(
    /^\/api\/input-attachments\/[0-9a-f-]+\/content$/u,
  );
  const xlsxDownloadPromise = page.waitForEvent("download");
  await xlsxDownloadLink.click();
  const xlsxDownload = await xlsxDownloadPromise;
  expect(xlsxDownload.suggestedFilename()).toBe(E2E_XLSX_ATTACHMENT_NAME);
  expect(await xlsxDownload.failure()).toBeNull();

  await page.keyboard.press("Escape");
  await expect(xlsxPreviewDialog).toBeHidden();
  await expect(xlsxPreviewTrigger).toBeFocused();
});

test("keeps mobile navigation, activity, attachment preview, and tasks usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/c/${E2E_BACKGROUND_CONVERSATION_ID}`);

  const menuTrigger = page.getByRole("button", {
    name: "打开会话侧边栏",
  });
  await menuTrigger.click();
  await expect(page.getByRole("dialog", { name: "会话侧边栏" }))
    .toBeVisible();
  await page.getByRole("button", { name: "关闭会话侧边栏" }).click();
  await expect(menuTrigger).toBeFocused();
  await expect(page.getByRole("textbox", { name: "输入研究问题" })).toBeVisible();
  await expect(page.locator(".research-header .header-new-button")).toBeVisible();

  const inlineActivityToggle = page.locator(
    "summary.run-process-card__toggle",
  );
  await expect(inlineActivityToggle).toHaveAttribute("aria-expanded", "false");
  await inlineActivityToggle.click();
  await expect(inlineActivityToggle).toHaveAttribute("aria-expanded", "true");
  const inlineActivity = page.locator(".run-process-card__content");
  await expect(inlineActivity).toContainText(
    "已在不调用模型供应商的 E2E 驱动中继续执行。",
  );
  const fullActivityButton = inlineActivity.getByRole("button", {
    name: "查看完整活动",
  });
  await expect(fullActivityButton).toHaveCSS("min-height", "44px");
  await fullActivityButton.click();
  const activityDialog = page.getByRole("dialog", { name: "运行活动" });
  await expect(activityDialog).toBeVisible();
  await expect(activityDialog).toHaveAttribute("aria-modal", "true");
  await expect(
    activityDialog.getByRole("button", { name: "关闭活动面板" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "运行活动" })).toHaveCount(0);
  await expect(page.locator("#run-activity-panel")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await expect(page.locator("#run-activity-panel")).toHaveAttribute(
    "inert",
    "",
  );
  await expect(fullActivityButton).toBeFocused();

  await menuTrigger.click();
  await page
    .getByRole("dialog", { name: "会话侧边栏" })
    .getByRole("button", {
      name: new RegExp(`^${E2E_CONTROL_CONVERSATION_TITLE}`, "u"),
    })
    .click();
  await expect(page).toHaveURL(`/c/${E2E_CONTROL_CONVERSATION_ID}`);

  const previewTrigger = page.getByRole("button", {
    name: "预览源码：verified-buyers.txt",
  });
  await previewTrigger.click();
  const previewDialog = page.getByRole("dialog", {
    name: /verified-buyers\.txt/u,
  });
  await expect(previewDialog).toBeVisible();
  await expect(
    previewDialog.getByRole("region", {
      name: "verified-buyers.txt TXT 源码预览",
    }),
  ).toContainText("Verified buyer B");
  await expect(
    previewDialog.getByRole("button", {
      name: "关闭源码预览：verified-buyers.txt",
    }),
  ).toBeFocused();
  const pageWidth = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.clientWidth);
  await page.keyboard.press("Escape");
  await expect(previewDialog).toBeHidden();
  await expect(previewTrigger).toBeFocused();

  const backgroundTasksTrigger = page.getByRole("button", {
    name: /^后台任务，/u,
  });
  await backgroundTasksTrigger.click();
  const backgroundTasksDialog = page.getByRole("dialog", { name: "后台任务" });
  await expect(backgroundTasksDialog).toBeVisible();
  await expect(backgroundTasksDialog).toHaveAttribute("aria-modal", "true");
  await expect(
    backgroundTasksDialog.getByRole("button", { name: "关闭后台任务" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(backgroundTasksDialog).toBeHidden();
  await expect(backgroundTasksTrigger).toBeFocused();
});

test("keeps nested mobile modals ordered with top-only close and focus recovery", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/c/${E2E_CONTROL_CONVERSATION_ID}`);

  const disabledExpandedControls = page.locator(
    '[disabled][aria-expanded="true"], [aria-disabled="true"][aria-expanded="true"]',
  );
  const interactiveModalLayers = page.locator(
    '[data-modal-layer]:not([inert])',
  );
  const interactiveModalDialogs = page.locator(
    '[aria-modal="true"]:not([inert])',
  );
  const mobileMenuTrigger = page.getByRole("button", {
    name: "打开会话侧边栏",
  });

  await mobileMenuTrigger.click();
  const sidebarDialog = page.getByRole("dialog", { name: "会话侧边栏" });
  await expect(sidebarDialog).toBeVisible();
  await expect(page.locator("[data-modal-layer]")).toHaveCount(1);
  await expect(interactiveModalLayers).toHaveCount(1);
  await expect(interactiveModalDialogs).toHaveCount(1);
  await expect(disabledExpandedControls).toHaveCount(0);

  const userMenuTrigger = sidebarDialog.getByRole("button", {
    name: "演示用户，打开用户菜单",
  });
  await userMenuTrigger.click();
  await sidebarDialog.getByRole("menuitem", { name: "设置" }).click();

  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  const settingsClose = settingsDialog.getByRole("button", {
    name: "关闭设置",
  });
  await expect(settingsDialog).toBeVisible();
  await expect(settingsClose).toBeFocused();
  await expect(page.locator("[data-modal-layer]")).toHaveCount(2);
  await expect(interactiveModalLayers).toHaveCount(1);
  await expect(interactiveModalDialogs).toHaveCount(1);
  await expect(interactiveModalDialogs).toHaveAccessibleName("设置");
  await expect(sidebarDialog).toHaveAttribute("inert", "");
  await expect(disabledExpandedControls).toHaveCount(0);

  await settingsClose.press("Shift+Tab");
  const settingsLastControl = settingsDialog.getByRole("button", {
    name: /^删除所有对话/u,
  });
  await expect(settingsLastControl).toBeFocused();
  await settingsLastControl.press("Tab");
  await expect(settingsClose).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(settingsDialog).toHaveCount(0);
  await expect(sidebarDialog).toBeVisible();
  await expect(sidebarDialog).not.toHaveAttribute("inert", "");
  await expect(userMenuTrigger).toBeFocused();
  await expect(page.locator("[data-modal-layer]")).toHaveCount(1);
  await expect(interactiveModalLayers).toHaveCount(1);
  await expect(interactiveModalDialogs).toHaveCount(1);
  await expect(interactiveModalDialogs).toHaveAccessibleName("会话侧边栏");
  await expect(disabledExpandedControls).toHaveCount(0);

  const accountUsageTrigger = sidebarDialog.getByRole("button", {
    name: "积分余额",
  });
  await accountUsageTrigger.click();
  const accountUsageDialog = page.getByRole("dialog", { name: "积分与用量" });
  const accountUsageClose = accountUsageDialog.getByRole("button", {
    name: "关闭积分与用量",
  });
  await expect(accountUsageDialog).toBeVisible();
  await expect(accountUsageClose).toBeFocused();
  await expect(page.locator("[data-modal-layer]")).toHaveCount(2);
  await expect(interactiveModalLayers).toHaveCount(1);
  await expect(interactiveModalDialogs).toHaveCount(1);
  await expect(interactiveModalDialogs).toHaveAccessibleName("积分与用量");
  await expect(sidebarDialog).toHaveAttribute("inert", "");
  await expect(accountUsageTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(accountUsageTrigger).toBeEnabled();
  await expect(disabledExpandedControls).toHaveCount(0);

  await accountUsageClose.click();
  await expect(accountUsageDialog).toHaveCount(0);
  await expect(sidebarDialog).toBeVisible();
  await expect(sidebarDialog).not.toHaveAttribute("inert", "");
  await expect(accountUsageTrigger).toBeFocused();
  await expect(accountUsageTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[data-modal-layer]")).toHaveCount(1);
  await expect(interactiveModalLayers).toHaveCount(1);
  await expect(interactiveModalDialogs).toHaveCount(1);
  await expect(disabledExpandedControls).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(sidebarDialog).toHaveCount(0);
  await expect(mobileMenuTrigger).toBeFocused();
  await expect(mobileMenuTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[data-modal-layer]")).toHaveCount(0);
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(0);
  await expect(disabledExpandedControls).toHaveCount(0);
});

test("freezes custom instructions per conversation without leaking them", async ({
  page,
}) => {
  const instructionA = `E2E_PRIVATE_CUSTOM_INSTRUCTIONS_A_${randomUUID()}`;
  const instructionB = `E2E_PRIVATE_CUSTOM_INSTRUCTIONS_B_${randomUUID()}`;
  await page.goto("/");

  const initialSettingsResponse = await page.evaluate(async () => {
    const response = await fetch("/api/account/custom-instructions");
    return {
      body: await response.json(),
      status: response.status,
    };
  });
  expect(initialSettingsResponse.status).toBe(200);
  const initialSettings = AccountCustomInstructionsResponseSchema.parse(
    initialSettingsResponse.body,
  );

  const settingAResponse = await page.evaluate(
    async ({ content, expectedRevision }) => {
      const response = await fetch("/api/account/custom-instructions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          content,
          expectedRevision,
        }),
      });
      return {
        body: await response.json(),
        status: response.status,
      };
    },
    {
      content: instructionA,
      expectedRevision: initialSettings.customInstructions.revision,
    },
  );
  expect(settingAResponse.status).toBe(200);
  const settingA = AccountCustomInstructionsResponseSchema.parse(
    settingAResponse.body,
  ).customInstructions;
  expect(settingA).toMatchObject({
    enabled: true,
    content: instructionA,
    revision: initialSettings.customInstructions.revision + 1,
  });

  const startAResponse = await page.evaluate(
    async ({ message, requestId }) => {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "append",
          conversationId: null,
          parentRunId: null,
          message,
          attachmentIds: [],
          requestId,
          executionProfileId: "standard_research",
        }),
      });
      return {
        body: await response.json(),
        status: response.status,
      };
    },
    {
      message: "验证会话创建时捕获第一版偏好",
      requestId: randomUUID(),
    },
  );
  expect(startAResponse.status).toBe(202);
  const startA = ChatStartResponseSchema.parse(startAResponse.body);

  const settingBResponse = await page.evaluate(
    async ({ content, expectedRevision }) => {
      const response = await fetch("/api/account/custom-instructions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          content,
          expectedRevision,
        }),
      });
      return {
        body: await response.json(),
        status: response.status,
      };
    },
    {
      content: instructionB,
      expectedRevision: settingA.revision,
    },
  );
  expect(settingBResponse.status).toBe(200);
  const settingB = AccountCustomInstructionsResponseSchema.parse(
    settingBResponse.body,
  ).customInstructions;
  expect(settingB).toMatchObject({
    enabled: true,
    content: instructionB,
    revision: settingA.revision + 1,
  });

  const startBResponse = await page.evaluate(
    async ({ message, requestId }) => {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "append",
          conversationId: null,
          parentRunId: null,
          message,
          attachmentIds: [],
          requestId,
          executionProfileId: "standard_research",
        }),
      });
      return {
        body: await response.json(),
        status: response.status,
      };
    },
    {
      message: "验证后续会话捕获第二版偏好",
      requestId: randomUUID(),
    },
  );
  expect(startBResponse.status).toBe(202);
  const startB = ChatStartResponseSchema.parse(startBResponse.body);

  const expectedCustomInstructionsByRunId = {
    [startA.run.id]: {
      content: instructionA,
      revision: settingA.revision,
    },
    [startB.run.id]: {
      content: instructionB,
      revision: settingB.revision,
    },
  };
  await completeE2eRunsWithoutProvider({
    detailedRunId: startA.run.id,
    expectedCustomInstructionsByRunId,
    expectedRunIds: [startA.run.id, startB.run.id],
  });

  await page.goto(`/c/${startA.conversation.id}`);
  await expect(
    page.getByText("E2E 后台任务已完成，切换会话没有中断执行。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "分享对话", exact: true }).click();
  const shareDialog = page.getByRole("dialog", { name: "分享对话" });
  await expect(shareDialog).toBeVisible();
  const publishResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(
        `/api/conversations/${startA.conversation.id}/share`,
      ) && response.request().method() === "PUT",
  );
  await shareDialog
    .getByRole("button", { name: "创建分享链接" })
    .click();
  const publishResponse = await publishResponsePromise;
  expect(publishResponse.status()).toBe(200);
  const published = PutConversationShareResponseSchema.parse(
    await publishResponse.json(),
  ).share;
  await expect(shareDialog.getByText("分享链接已创建", { exact: true }))
    .toBeVisible();
  await expect(shareDialog.getByRole("textbox", { name: "分享链接" }))
    .toHaveValue(new RegExp(`${published.publicPath}$`, "u"));

  const surfaces = await page.evaluate(
    async ({ conversationAId, conversationBId, publicPath, runAId, runBId }) => {
      async function read(path: string) {
        const response = await fetch(path);
        return {
          contentType: response.headers.get("content-type"),
          status: response.status,
          text: await response.text(),
        };
      }

      const [
        bootstrap,
        conversationA,
        conversationB,
        ownerShare,
        shareList,
        publicShare,
        runAEvents,
        runBEvents,
      ] = await Promise.all([
        read("/api/bootstrap"),
        read(`/api/conversations/${conversationAId}`),
        read(`/api/conversations/${conversationBId}`),
        read(`/api/conversations/${conversationAId}/share`),
        read("/api/conversation-shares?limit=30"),
        read(publicPath),
        read(`/api/runs/${runAId}/events`),
        read(`/api/runs/${runBId}/events`),
      ]);
      return {
        bootstrap,
        conversationA,
        conversationB,
        ownerShare,
        shareList,
        publicShare,
        runAEvents,
        runBEvents,
      };
    },
    {
      conversationAId: startA.conversation.id,
      conversationBId: startB.conversation.id,
      publicPath: published.publicPath,
      runAId: startA.run.id,
      runBId: startB.run.id,
    },
  );

  expect(surfaces.bootstrap.status).toBe(200);
  BootstrapResponseSchema.parse(JSON.parse(surfaces.bootstrap.text));
  expect(surfaces.conversationA.status).toBe(200);
  ConversationResponseSchema.parse(JSON.parse(surfaces.conversationA.text));
  expect(surfaces.conversationB.status).toBe(200);
  ConversationResponseSchema.parse(JSON.parse(surfaces.conversationB.text));
  expect(surfaces.ownerShare.status).toBe(200);
  GetConversationShareResponseSchema.parse(
    JSON.parse(surfaces.ownerShare.text),
  );
  expect(surfaces.shareList.status).toBe(200);
  ListConversationSharesResponseSchema.parse(
    JSON.parse(surfaces.shareList.text),
  );
  expect(surfaces.publicShare.status).toBe(200);
  expect(surfaces.publicShare.contentType).toContain("text/html");
  for (const events of [surfaces.runAEvents, surfaces.runBEvents]) {
    expect(events.status).toBe(200);
    expect(events.contentType).toContain("text/event-stream");
  }

  const privateSurfaces = Object.values(surfaces).map(
    (surface) => surface.text,
  );
  for (const privateContent of [instructionA, instructionB]) {
    for (const surface of privateSurfaces) {
      expect(surface).not.toContain(privateContent);
    }
  }

  await assertE2eCustomInstructionsPersistence({
    expectedConversationSnapshots: {
      [startA.conversation.id]: expectedCustomInstructionsByRunId[startA.run.id],
      [startB.conversation.id]: expectedCustomInstructionsByRunId[startB.run.id],
    },
    forbiddenMarkers: [instructionA, instructionB],
    runIds: [startA.run.id, startB.run.id],
    sharedConversationId: startA.conversation.id,
  });

  await page.goto(`/c/${startA.conversation.id}`);
  await expect(
    page.getByText("E2E 后台任务已完成，切换会话没有中断执行。"),
  ).toBeVisible();
  const inlineActivityToggle = page.locator(
    "summary.run-process-card__toggle",
  );
  await inlineActivityToggle.click();
  const inlineActivity = page.locator(".run-process-card__content");
  await expect(inlineActivity).not.toContainText(instructionA);
  await expect(inlineActivity).not.toContainText(instructionB);
  await inlineActivity
    .getByRole("button", { name: "查看完整活动" })
    .click();
  const activityPanel = page.locator("#run-activity-panel");
  await expect(activityPanel).toBeVisible();
  await expect(activityPanel).not.toContainText(instructionA);
  await expect(activityPanel).not.toContainText(instructionB);

  const publicPage = await page.context().newPage();
  const publicResponse = await publicPage.goto(published.publicPath);
  expect(publicResponse?.status()).toBe(200);
  await expect(
    publicPage.getByRole("heading", { name: startA.conversation.title }),
  ).toBeVisible();
  await expect(publicPage.getByText("只读分享", { exact: true })).toBeVisible();
  await expect(
    publicPage
      .getByLabel("用户消息")
      .getByText("验证会话创建时捕获第一版偏好", { exact: true }),
  ).toBeVisible();
  await expect(
    publicPage.getByText(
      "E2E 后台任务已完成，切换会话没有中断执行。",
      { exact: true },
    ),
  ).toBeVisible();
  for (const privateContent of [
    instructionA,
    instructionB,
    startA.run.id,
    startA.run.requestId,
    "/api/runs/",
    "/api/artifacts/",
    "/api/input-attachments/",
  ]) {
    await expect(publicPage.locator("body")).not.toContainText(privateContent);
  }

  await page.getByRole("button", { name: "关闭活动面板" }).click();
  await page.getByRole("button", { name: "分享对话", exact: true }).click();
  const updateDialog = page.getByRole("dialog", { name: "分享对话" });
  await expect(updateDialog.getByRole("button", { name: "更新快照" }))
    .toBeVisible();
  const updateResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(
        `/api/conversations/${startA.conversation.id}/share`,
      ) && response.request().method() === "PUT",
  );
  await updateDialog.getByRole("button", { name: "更新快照" }).click();
  const updateResponse = await updateResponsePromise;
  expect(updateResponse.status()).toBe(200);
  const updated = PutConversationShareResponseSchema.parse(
    await updateResponse.json(),
  ).share;
  expect(updated.publicId).toBe(published.publicId);
  expect(updated.publicPath).toBe(published.publicPath);
  expect(updated.createdAt).toBe(published.createdAt);
  expect(Date.parse(updated.updatedAt)).toBeGreaterThan(
    Date.parse(published.updatedAt),
  );
  await expect(updateDialog.getByText("分享快照已更新", { exact: true }))
    .toBeVisible();
  expect((await publicPage.reload())?.status()).toBe(200);

  await updateDialog.getByRole("button", { name: "撤销链接" }).click();
  await expect(updateDialog.getByText("撤销这个公开链接？", { exact: true }))
    .toBeVisible();
  const cancelRevokeButton = updateDialog.getByRole("button", {
    name: "取消",
  });
  await expect(cancelRevokeButton).toBeFocused();
  await cancelRevokeButton.click();
  const revokeLinkButton = updateDialog.getByRole("button", {
    name: "撤销链接",
  });
  await expect(revokeLinkButton).toBeFocused();
  await revokeLinkButton.click();
  await expect(cancelRevokeButton).toBeFocused();
  const revokeResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(
        `/api/conversations/${startA.conversation.id}/share?`,
      ) && response.request().method() === "DELETE",
  );
  await updateDialog.getByRole("button", { name: "确认撤销" }).click();
  const revokeResponse = await revokeResponsePromise;
  expect(revokeResponse.status()).toBe(200);
  const revoked = RevokeConversationShareResponseSchema.parse(
    await revokeResponse.json(),
  ).revocation;
  expect(revoked).toMatchObject({
    conversationId: startA.conversation.id,
    publicId: published.publicId,
  });
  await expect(updateDialog.getByText("分享链接已撤销", { exact: true }))
    .toBeVisible();
  await expect(
    updateDialog.getByRole("button", { name: "创建分享链接" }),
  ).toBeFocused();

  await publicPage.close();
  const revokedPublicResponse = await page.request.get(published.publicPath);
  expect(revokedPublicResponse.status()).toBe(404);
  expect(revokedPublicResponse.headers()["content-type"]).toContain(
    "text/html",
  );
  expect(await revokedPublicResponse.text()).toContain("这个分享链接不可用");
});

test("preserves cancelled and failed attempts across waiting retry, direct promotion, and reconciliation", async ({
  page,
}) => {
  const conversationTitle = "E2E 队列重试与待对账边界";
  const secondMessage = "E2E 第二轮先等待、取消并重试";
  const thirdMessage = "E2E 第三轮不能被跨级提升";

  await page.goto("/");
  const head = await enqueueChatFromBrowser(page, {
    kind: "append",
    conversationId: null,
    parentRunId: null,
    message: conversationTitle,
    attachmentIds: [],
    requestId: randomUUID(),
    executionProfileId: "standard_research",
  });
  const cancelledAttempt = await enqueueChatFromBrowser(page, {
    kind: "append",
    conversationId: head.conversation.id,
    parentRunId: head.run.id,
    message: secondMessage,
    attachmentIds: [],
    requestId: randomUUID(),
    executionProfileId: "standard_research",
  });
  const successor = await enqueueChatFromBrowser(page, {
    kind: "append",
    conversationId: head.conversation.id,
    parentRunId: cancelledAttempt.run.id,
    message: thirdMessage,
    attachmentIds: [],
    requestId: randomUUID(),
    executionProfileId: "standard_research",
  });

  expect(head.conversation.title).toBe(conversationTitle);
  expect(head.run).toMatchObject({
    status: "queued",
    conversationTurn: "1",
    attemptIndex: 1,
    predecessorRunId: null,
  });
  expect(cancelledAttempt.run).toMatchObject({
    status: "waiting",
    conversationTurn: "2",
    attemptIndex: 1,
    predecessorRunId: head.run.id,
  });
  expect(successor.run).toMatchObject({
    status: "waiting",
    conversationTurn: "3",
    attemptIndex: 1,
    predecessorRunId: cancelledAttempt.run.id,
  });

  await page.goto(`/c/${head.conversation.id}`);
  await expect(
    page.locator(".message--user").getByText(conversationTitle, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(secondMessage, { exact: true })).toBeVisible();
  await expect(page.getByText(thirdMessage, { exact: true })).toBeVisible();
  await expect(page.locator(".run-process-card--queued")).toHaveCount(1);
  await expect(page.locator(".waiting-run-notice")).toHaveCount(2);
  await expect(page.getByText("已加入队列", { exact: true })).toHaveCount(2);

  const cancellationResponse = await page.evaluate(async (runId) => {
    const response = await fetch(`/api/runs/${runId}/cancel`, {
      method: "POST",
    });
    return {
      body: await response.json(),
      status: response.status,
    };
  }, cancelledAttempt.run.id);
  expect(cancellationResponse.status).toBe(200);
  const cancelled = CancelRunResponseSchema.parse(cancellationResponse.body);
  expect(cancelled.run).toMatchObject({
    id: cancelledAttempt.run.id,
    status: "cancelled",
    attemptIndex: 1,
    predecessorRunId: head.run.id,
  });
  await page.reload();
  await expect(page.getByText("这次研究已停止", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重试这轮研究" })).toBeVisible();
  await expect(page.locator(".waiting-run-notice--blocked")).toHaveCount(1);

  const waitingRetry = await retryVisibleRunFromBrowser(
    page,
    cancelledAttempt.run.id,
  );
  expect(waitingRetry.run).toMatchObject({
    status: "waiting",
    conversationId: head.conversation.id,
    inputMessageId: cancelledAttempt.run.inputMessageId,
    conversationTurn: "2",
    attemptIndex: 2,
    predecessorRunId: head.run.id,
    retryOfRunId: cancelledAttempt.run.id,
  });
  expect(waitingRetry.run.id).not.toBe(cancelledAttempt.run.id);
  expect(waitingRetry.run.assistantMessageId).not.toBe(
    cancelledAttempt.run.assistantMessageId,
  );
  expect(waitingRetry.run.executionConfig).toEqual(
    cancelledAttempt.run.executionConfig,
  );

  await assertE2eRetryQueueGraph({
    headRunId: head.run.id,
    expectedHeadStatus: "queued",
    attempts: [
      { runId: cancelledAttempt.run.id, status: "cancelled" },
      { runId: waitingRetry.run.id, status: "waiting" },
    ],
    successorRunId: successor.run.id,
    expectedSuccessorStatus: "waiting",
  });
  await expect(
    page
      .getByRole("group", { name: "回答版本" })
      .filter({ hasText: "2 / 2" }),
  ).toBeVisible();
  await expect(page.locator(".waiting-run-notice--blocked")).toHaveCount(0);
  await expect(page.locator(".waiting-run-notice")).toHaveCount(2);

  await completeE2eRunWithoutProvider(head.run.id);
  await assertE2eRetryQueueGraph({
    headRunId: head.run.id,
    expectedHeadStatus: "completed",
    attempts: [
      { runId: cancelledAttempt.run.id, status: "cancelled" },
      { runId: waitingRetry.run.id, status: "queued" },
    ],
    successorRunId: successor.run.id,
    expectedSuccessorStatus: "waiting",
  });
  await expect(
    page.getByText(
      "E2E 后台任务已完成，切换会话没有中断执行。",
      { exact: true },
    ),
  ).toHaveCount(1);
  await expect(page.locator(".run-process-card--queued")).toHaveCount(1);
  await expect(page.locator(".waiting-run-notice")).toHaveCount(1);

  await failE2eRunBeforeProvider(waitingRetry.run.id);
  const failedRunNotice = page.locator(".terminal-run-notice--failed");
  await expect(
    failedRunNotice.getByText("运行未能完成，请稍后重试。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(failedRunNotice).not.toContainText(
    E2E_RETRYABLE_FAILURE_MESSAGE,
  );
  await expect(page.getByText("队列已暂停", { exact: true })).toHaveCount(1);

  const queuedRetry = await retryVisibleRunFromBrowser(
    page,
    waitingRetry.run.id,
  );
  expect(queuedRetry.run).toMatchObject({
    status: "queued",
    conversationId: head.conversation.id,
    inputMessageId: cancelledAttempt.run.inputMessageId,
    conversationTurn: "2",
    attemptIndex: 3,
    predecessorRunId: head.run.id,
    retryOfRunId: waitingRetry.run.id,
  });
  expect(queuedRetry.run.id).not.toBe(waitingRetry.run.id);
  expect(queuedRetry.run.assistantMessageId).not.toBe(
    waitingRetry.run.assistantMessageId,
  );
  expect(queuedRetry.run.executionConfig).toEqual(
    cancelledAttempt.run.executionConfig,
  );

  await assertE2eRetryQueueGraph({
    headRunId: head.run.id,
    expectedHeadStatus: "completed",
    attempts: [
      { runId: cancelledAttempt.run.id, status: "cancelled" },
      { runId: waitingRetry.run.id, status: "failed" },
      { runId: queuedRetry.run.id, status: "queued" },
    ],
    successorRunId: successor.run.id,
    expectedSuccessorStatus: "waiting",
  });
  const latestAttemptControls = page
    .getByRole("group", { name: "回答版本" })
    .filter({ hasText: "3 / 3" });
  await expect(latestAttemptControls).toBeVisible();
  await expect(page.locator(".run-process-card--queued")).toHaveCount(1);
  await expect(page.locator(".waiting-run-notice--blocked")).toHaveCount(0);
  await expect(page.locator(".waiting-run-notice")).toHaveCount(1);

  await completeE2eRunWithoutProvider(queuedRetry.run.id);
  await assertE2eRetryQueueGraph({
    headRunId: head.run.id,
    expectedHeadStatus: "completed",
    attempts: [
      { runId: cancelledAttempt.run.id, status: "cancelled" },
      { runId: waitingRetry.run.id, status: "failed" },
      { runId: queuedRetry.run.id, status: "completed" },
    ],
    successorRunId: successor.run.id,
    expectedSuccessorStatus: "queued",
  });
  await expect(
    page.getByText(
      "E2E 后台任务已完成，切换会话没有中断执行。",
      { exact: true },
    ),
  ).toHaveCount(2);
  await expect(page.locator(".run-process-card--queued")).toHaveCount(1);
  await expect(page.locator(".waiting-run-notice")).toHaveCount(0);

  await page
    .getByRole("button", {
      name: E2E_CONTROL_CONVERSATION_TITLE,
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(`/c/${E2E_CONTROL_CONVERSATION_ID}`);
  await abandonE2eRunAfterSimulatedModelStart(successor.run.id);
  const reconciliationResponse = await page.evaluate(async (runId) => {
    const response = await fetch(`/api/runs/${runId}/cancel`, {
      method: "POST",
    });
    return {
      body: await response.json(),
      status: response.status,
    };
  }, successor.run.id);
  expect(reconciliationResponse.status).toBe(200);
  expect(
    CancelRunResponseSchema.parse(reconciliationResponse.body).run,
  ).toMatchObject({
    id: successor.run.id,
    status: "reconciliation_required",
    cancelRequestedAt: expect.any(String),
    failure: {
      code: "RUN_REQUIRES_RECONCILIATION",
      message: "这次运行需要积分对账。",
    },
  });
  await assertE2eRetryQueueGraph({
    headRunId: head.run.id,
    expectedHeadStatus: "completed",
    attempts: [
      { runId: cancelledAttempt.run.id, status: "cancelled" },
      { runId: waitingRetry.run.id, status: "failed" },
      { runId: queuedRetry.run.id, status: "completed" },
    ],
    successorRunId: successor.run.id,
    expectedSuccessorStatus: "reconciliation_required",
  });

  const backgroundTasksTrigger = page.getByRole("button", {
    name: /^后台任务，/u,
  });
  await expect(backgroundTasksTrigger).toBeVisible();
  await backgroundTasksTrigger.click();
  const backgroundTasksDialog = page.getByRole("dialog", { name: "后台任务" });
  const reconciliationRow = backgroundTasksDialog
    .locator(".background-run-center__group--attention")
    .getByRole("button")
    .filter({ hasText: conversationTitle })
    .filter({ hasText: "待对账" });
  await expect(reconciliationRow).toHaveCount(1);
  await reconciliationRow.click();

  await expect(page).toHaveURL(`/c/${head.conversation.id}`);
  const activityPanel = page.locator("#run-activity-panel");
  await expect(activityPanel).toBeVisible();
  await expect(activityPanel.locator(".activity-panel__title small")).toContainText(
    "待对账",
  );
  await expect(
    activityPanel.getByText(E2E_RECONCILIATION_REASONING_TEXT, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    activityPanel.getByText("运行需要核对积分", { exact: true }),
  ).toBeVisible();
  await expect(
    activityPanel.getByText("运行待对账", { exact: true }),
  ).toBeVisible();
  await expect(activityPanel).not.toContainText("这次运行需要积分对账。");
  await expect(activityPanel).not.toContainText(
    "RUN_REQUIRES_RECONCILIATION",
  );
  await expect(
    page.getByText(E2E_RECONCILIATION_PARTIAL_TEXT, { exact: true }),
  ).toBeVisible();
  const reconciliationNotice = page.locator(
    ".terminal-run-notice--reconciliation_required",
  );
  await expect(reconciliationNotice).toContainText(
    "生成内容已保留；这次运行的积分需要核对。",
  );
  await expect(reconciliationNotice).not.toContainText(
    "RUN_REQUIRES_RECONCILIATION",
  );
  await page.getByRole("button", { name: "关闭活动面板" }).click();

  const persistedAttemptControls = page
    .getByRole("group", { name: "回答版本" })
    .filter({ hasText: "3 / 3" });
  await expect(persistedAttemptControls).toBeVisible();
  const selectOldAttemptResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/conversations/${head.conversation.id}`) &&
      response.request().method() === "PATCH",
  );
  await persistedAttemptControls
    .getByRole("button", { name: "查看上一个回答" })
    .click();
  expect((await selectOldAttemptResponse).status()).toBe(200);
  await expect(
    page
      .getByRole("group", { name: "回答版本" })
      .filter({ hasText: "2 / 3" }),
  ).toBeVisible();
  const persistedFailedRunNotice = page.locator(
    ".terminal-run-notice--failed",
  );
  await expect(
    persistedFailedRunNotice.getByText("运行未能完成，请稍后重试。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(persistedFailedRunNotice).not.toContainText(
    E2E_RETRYABLE_FAILURE_MESSAGE,
  );
  await expect(page.getByText(thirdMessage, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "重试这轮研究" }),
  ).toHaveCount(0);

  const failedAttemptControls = page
    .getByRole("group", { name: "回答版本" })
    .filter({ hasText: "2 / 3" });
  const selectCancelledAttemptResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/conversations/${head.conversation.id}`) &&
      response.request().method() === "PATCH",
  );
  await failedAttemptControls
    .getByRole("button", { name: "查看上一个回答" })
    .click();
  expect((await selectCancelledAttemptResponse).status()).toBe(200);
  await expect(
    page
      .getByRole("group", { name: "回答版本" })
      .filter({ hasText: "1 / 3" }),
  ).toBeVisible();
  const persistedCancelledRunNotice = page.locator(
    ".terminal-run-notice--cancelled",
  );
  await expect(
    persistedCancelledRunNotice.getByText("运行已停止。", { exact: true }),
  ).toBeVisible();
  await expect(persistedCancelledRunNotice).not.toContainText(
    "预扣积分已退回",
  );
});

test("shows exact account balances and one usage row per provider-free Run", async ({
  page,
}) => {
  await page.goto(`/c/${E2E_CONTROL_CONVERSATION_ID}`);

  const firstPageResponse = await page.evaluate(async () => {
    const response = await fetch("/api/account/usage?limit=1");
    return { body: await response.json(), status: response.status };
  });
  expect(firstPageResponse.status).toBe(200);
  const firstPage = AccountUsageResponseSchema.parse(firstPageResponse.body);
  expect(firstPage.balance).toEqual({
    available: 9_500,
    reserved: 0,
    frozen: 500,
  });
  expect(firstPage.items).toHaveLength(1);
  expect(firstPage.items[0]).toMatchObject({
    conversationTitle: "E2E 队列重试与待对账边界",
    status: "completed",
    reservationCredits: 500,
    chargedCredits: 0,
    inputTokens: 0,
    outputTokens: 0,
    webSearches: 0,
  });
  expect(firstPage.nextCursor).not.toBeNull();

  const secondPageResponse = await page.evaluate(async (cursor) => {
    const search = new URLSearchParams({ cursor, limit: "1" });
    const response = await fetch(`/api/account/usage?${search.toString()}`);
    return { body: await response.json(), status: response.status };
  }, firstPage.nextCursor!);
  expect(secondPageResponse.status).toBe(200);
  const secondPage = AccountUsageResponseSchema.parse(secondPageResponse.body);
  expect(secondPage.balance).toEqual(firstPage.balance);
  expect(secondPage.items).toHaveLength(1);
  expect(secondPage.items[0].runId).not.toBe(firstPage.items[0].runId);
  expect(secondPage.items[0]).toMatchObject({
    conversationTitle: "E2E 队列重试与待对账边界",
    status: "failed",
    reservationCredits: 500,
    chargedCredits: null,
    inputTokens: null,
    outputTokens: null,
    webSearches: null,
  });

  const usageResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/account/usage" &&
      new URL(response.url()).searchParams.get("limit") === "30",
  );
  const usageTrigger = page.getByRole("button", { name: "积分余额" });
  await usageTrigger.click();
  const usageResponse = await usageResponsePromise;
  expect(usageResponse.status()).toBe(200);
  const usage = AccountUsageResponseSchema.parse(await usageResponse.json());
  expect(usage.balance).toEqual(firstPage.balance);
  expect(usage.items).toHaveLength(16);
  expect(new Set(usage.items.map((item) => item.runId)).size).toBe(16);
  expect(usage.nextCursor).toBeNull();

  const dialog = page.getByRole("dialog", { name: "积分与用量" });
  await expect(dialog).toBeVisible();
  const balance = dialog.locator(".account-usage-balance");
  await expect(balance).toContainText("可用积分9,500");
  await expect(balance).toContainText("运行中预留积分0");
  await expect(balance).toContainText("待对账冻结积分500");
  const usageRows = dialog.locator(".account-usage-run");
  await expect(usageRows).toHaveCount(16);
  await expect(dialog.locator(".account-usage-dialog__status")).toHaveText(
    "已显示 16 条 Run 用量记录",
  );
  const latestRunRow = usageRows.first();
  await expect(latestRunRow).toContainText("E2E 队列重试与待对账边界");
  await expect(latestRunRow.getByLabel("运行状态：已完成")).toBeVisible();
  await expect(latestRunRow).toContainText("本次预留积分500");
  await expect(latestRunRow).toContainText("本次实扣积分0");
  await expect(dialog.getByRole("button", { name: "加载更多用量记录" }))
    .toHaveCount(0);

  await dialog.getByRole("button", { name: "关闭积分与用量" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(usageTrigger).toBeFocused();
});

test("archives and permanently deletes all account conversations without starting a Run", async ({
  page,
}) => {
  const chatRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/chat") {
      chatRequests.push(request.url());
    }
  });

  await page.goto(`/c/${E2E_CONTROL_CONVERSATION_ID}`);
  await expect(page.getByRole("textbox", { name: "输入研究问题" }))
    .toBeVisible();

  async function readAccountUsage() {
    const response = await page.evaluate(async () => {
      const result = await fetch("/api/account/usage?limit=30");
      return {
        body: await result.json(),
        status: result.status,
      };
    });
    expect(response.status).toBe(200);
    return AccountUsageResponseSchema.parse(response.body);
  }

  async function openSettings() {
    await page
      .getByRole("button", { name: "演示用户，打开用户菜单" })
      .click();
    await page.getByRole("menuitem", { name: "设置" }).click();
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  async function uploadComposerAttachment(
    name: string,
    content: string,
  ) {
    const uploadResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/input-attachments" &&
        response.request().method() === "POST",
    );
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "添加附件" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from(content, "utf8"),
    });
    const response = await uploadResponsePromise;
    expect(response.status()).toBe(201);
    const uploaded = UploadInputAttachmentResponseSchema.parse(
      await response.json(),
    );
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    return uploaded;
  }

  const usageBeforeDataControl = await readAccountUsage();
  expect(usageBeforeDataControl.items).toHaveLength(16);
  expect(usageBeforeDataControl.nextCursor).toBeNull();

  const activeBeforeArchive = await listAllConversationsFromBrowser(
    page,
    "active",
  );
  const archivedBeforeArchive = await listAllConversationsFromBrowser(
    page,
    "archived",
  );
  expect(activeBeforeArchive.length).toBeGreaterThan(0);
  expect(
    new Set(activeBeforeArchive.map((conversation) => conversation.id)).size,
  ).toBe(activeBeforeArchive.length);

  const shareConversation = requireLibraryFixture();
  expect(
    activeBeforeArchive.map((conversation) => conversation.id),
  ).toContain(shareConversation.conversationId);
  const publishShareResponse = await page.evaluate(async (conversationId) => {
    const result = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/share`,
      { method: "PUT" },
    );
    return {
      body: await result.json(),
      status: result.status,
    };
  }, shareConversation.conversationId);
  expect(publishShareResponse.status).toBe(200);
  const publishedShare = PutConversationShareResponseSchema.parse(
    publishShareResponse.body,
  ).share;
  expect((await page.request.get(publishedShare.publicPath)).status()).toBe(
    200,
  );

  const newConversationDraftText =
    "E2E 删除全部后仍应保留的新对话本地草稿";
  const conversationDraftText =
    "E2E 删除全部后必须清理的会话本地草稿";
  const newConversationComposerKey =
    "custent:composer-draft:new-conversation";
  const conversationComposerKey =
    `custent:composer-draft:conversation:${encodeURIComponent(
      E2E_CONTROL_CONVERSATION_ID,
    )}`;
  const newConversationExecutionProfileKey =
    `custent:execution-profile:${newConversationComposerKey}`;
  const conversationExecutionProfileKey =
    `custent:execution-profile:${conversationComposerKey}`;

  const composer = page.getByRole("textbox", { name: "输入研究问题" });
  await composer.fill(conversationDraftText);
  const conversationAttachment = await uploadComposerAttachment(
    "delete-all-conversation-draft.txt",
    "conversation-scoped staged attachment",
  );

  const workspaceSidebar = page.getByRole("complementary", {
    name: "会话侧边栏",
  });
  await workspaceSidebar
    .getByRole("button", { name: "新建研究", exact: true })
    .click();
  await expect(page).toHaveURL("/");
  await composer.fill(newConversationDraftText);
  const newConversationAttachment = await uploadComposerAttachment(
    "delete-all-new-conversation-draft.txt",
    "new-conversation staged attachment",
  );
  await workspaceSidebar
    .getByRole("button", {
      name: E2E_CONTROL_CONVERSATION_TITLE,
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(`/c/${E2E_CONTROL_CONVERSATION_ID}`);
  await expect(composer).toHaveValue(conversationDraftText);

  const conversationAttachmentId = conversationAttachment.attachment.id;
  const conversationAttachmentKey =
    `custent:composer-attachment-draft:v1:user:${encodeURIComponent(
      E2E_DEMO_USER_ID,
    )}:conversation:${encodeURIComponent(
      E2E_CONTROL_CONVERSATION_ID,
    )}:attachment:${encodeURIComponent(conversationAttachmentId)}`;
  const newConversationAttachmentId =
    newConversationAttachment.attachment.id;
  const newConversationAttachmentKey =
    `custent:composer-attachment-draft:v1:user:${encodeURIComponent(
      E2E_DEMO_USER_ID,
    )}:new-conversation:attachment:${encodeURIComponent(
      newConversationAttachmentId,
    )}`;
  const newConversationComposerValue = JSON.stringify({
    version: 1,
    scope: { kind: "new_conversation" },
    text: newConversationDraftText,
  });
  const conversationComposerValue = JSON.stringify({
    version: 1,
    scope: {
      kind: "conversation",
      conversationId: E2E_CONTROL_CONVERSATION_ID,
    },
    text: conversationDraftText,
  });
  const executionProfileValue = JSON.stringify({
    version: 1,
    executionProfileId: "standard_research",
  });
  await page.evaluate((entries) => {
    for (const [key, value] of entries) {
      window.localStorage.setItem(key, value);
    }
  }, [
    [newConversationExecutionProfileKey, executionProfileValue],
    [conversationExecutionProfileKey, executionProfileValue],
  ]);

  const storageKeys = [
    newConversationComposerKey,
    conversationComposerKey,
    newConversationExecutionProfileKey,
    conversationExecutionProfileKey,
    conversationAttachmentKey,
    newConversationAttachmentKey,
  ];
  await expect
    .poll(async () =>
      page.evaluate(
        (keys) =>
          keys.every((key) => window.localStorage.getItem(key) !== null),
        storageKeys,
      ),
    )
    .toBe(true);
  const storageBeforeArchive = await page.evaluate(
    (keys) =>
      Object.fromEntries(
        keys.map((key) => [key, window.localStorage.getItem(key)]),
      ),
    storageKeys,
  );
  expect(storageBeforeArchive).toMatchObject({
    [newConversationComposerKey]: newConversationComposerValue,
    [conversationComposerKey]: conversationComposerValue,
    [newConversationExecutionProfileKey]: executionProfileValue,
    [conversationExecutionProfileKey]: executionProfileValue,
  });
  const conversationAttachmentValue =
    storageBeforeArchive[conversationAttachmentKey];
  const newConversationAttachmentValue =
    storageBeforeArchive[newConversationAttachmentKey];
  if (
    conversationAttachmentValue === null ||
    newConversationAttachmentValue === null
  ) {
    throw new Error("Composer attachment drafts were not persisted");
  }

  let settingsDialog = await openSettings();
  const archiveAllTrigger = settingsDialog.getByRole("button", {
    name: /^归档所有对话/u,
  });
  await archiveAllTrigger.click();
  let archiveDialog = page.getByRole("dialog", {
    name: "归档所有对话？",
    exact: true,
  });
  await expect(archiveDialog).toBeVisible();
  await expect(archiveDialog).toHaveAttribute("aria-busy", "false");
  await expect(
    archiveDialog.getByRole("button", { name: "取消", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(archiveDialog).toHaveCount(0);
  await expect(archiveAllTrigger).toBeFocused();

  await archiveAllTrigger.click();
  archiveDialog = page.getByRole("dialog", {
    name: "归档所有对话？",
    exact: true,
  });
  await expect(
    archiveDialog.getByRole("button", { name: "取消", exact: true }),
  ).toBeFocused();

  const archiveRequestPaused = Promise.withResolvers<void>();
  const archiveRequestRelease = Promise.withResolvers<void>();
  const archiveRoute = async (route: Route): Promise<void> => {
    const request = route.request();
    if (
      new URL(request.url()).pathname === "/api/conversations" &&
      request.method() === "PATCH"
    ) {
      archiveRequestPaused.resolve();
      await archiveRequestRelease.promise;
    }
    await route.continue();
  };
  await page.route("**/api/conversations", archiveRoute);
  const archiveResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/conversations" &&
      response.request().method() === "PATCH",
  );
  const archiveConfirm = archiveDialog.getByRole("button", {
    name: /^(?:归档所有对话|正在归档…)$/u,
  });
  await archiveConfirm.click();
  await archiveRequestPaused.promise;
  await expect(archiveDialog).toHaveAttribute("aria-busy", "true");
  await expect(archiveConfirm).toBeDisabled();
  await expect(archiveConfirm).toHaveText("正在归档…");
  await expect(
    archiveDialog.getByRole("button", { name: "取消", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(archiveDialog).toBeVisible();

  archiveRequestRelease.resolve();
  const archiveResponse = await archiveResponsePromise;
  expect(archiveResponse.status()).toBe(200);
  expect(archiveResponse.request().postDataJSON()).toEqual({
    action: "archive_all",
  });
  const archiveMutation = BulkConversationMutationResponseSchema.parse(
    await archiveResponse.json(),
  );
  expect(archiveMutation.mutation).toMatchObject({
    action: "archive_all",
    conversationCount: activeBeforeArchive.length,
  });
  await page.unroute("**/api/conversations", archiveRoute);
  await expect(archiveDialog).toHaveCount(0);
  await expect(archiveAllTrigger).toBeFocused();
  await expect(page).toHaveURL("/");
  await expect(
    settingsDialog.getByRole("status"),
  ).toContainText(
    `已归档 ${activeBeforeArchive.length.toLocaleString("zh-CN")} 个对话。`,
  );
  const activeConversationNav = page.locator("#conversation-nav");
  await expect(activeConversationNav.locator(".conversation-row"))
    .toHaveCount(0);
  await expect(
    activeConversationNav.getByText("研究记录会出现在这里", {
      exact: true,
    }),
  ).toBeVisible();

  const activeAfterArchive = await listAllConversationsFromBrowser(
    page,
    "active",
  );
  const archivedAfterArchive = await listAllConversationsFromBrowser(
    page,
    "archived",
  );
  expect(activeAfterArchive).toEqual([]);
  expect(archivedAfterArchive.length).toBe(
    archivedBeforeArchive.length + activeBeforeArchive.length,
  );
  expect(
    archivedAfterArchive.map((conversation) => conversation.id).sort(),
  ).toEqual(
    [
      ...archivedBeforeArchive.map((conversation) => conversation.id),
      ...activeBeforeArchive.map((conversation) => conversation.id),
    ].sort(),
  );
  for (const conversation of archivedAfterArchive) {
    expect(conversation.archivedAt).not.toBeNull();
  }

  const shareAfterArchiveResponse = await page.evaluate(
    async (conversationId) => {
      const result = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/share`,
      );
      return {
        body: await result.json(),
        status: result.status,
      };
    },
    shareConversation.conversationId,
  );
  expect(shareAfterArchiveResponse.status).toBe(200);
  expect(
    GetConversationShareResponseSchema.parse(shareAfterArchiveResponse.body)
      .share,
  ).toMatchObject({
    conversationId: shareConversation.conversationId,
    publicId: publishedShare.publicId,
    publicPath: publishedShare.publicPath,
  });
  expect((await page.request.get(publishedShare.publicPath)).status()).toBe(
    200,
  );

  const storageAfterArchive = await page.evaluate(
    (keys) =>
      Object.fromEntries(
        keys.map((key) => [key, window.localStorage.getItem(key)]),
      ),
    Object.keys(storageBeforeArchive),
  );
  expect(storageAfterArchive).toEqual(storageBeforeArchive);

  await settingsDialog.getByRole("button", { name: "关闭设置" }).click();
  await expect(
    page.getByRole("button", { name: "演示用户，打开用户菜单" }),
  ).toBeFocused();
  const archivedTrigger = page.getByRole("button", {
    name: "已归档",
    exact: true,
  });
  const archivedBrowserResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/conversations" &&
      url.searchParams.get("view") === "archived" &&
      response.request().method() === "GET"
    );
  });
  await archivedTrigger.click();
  const archivedBrowserResponse = await archivedBrowserResponsePromise;
  expect(archivedBrowserResponse.status()).toBe(200);
  const archivedBrowserPage = ListConversationsResponseSchema.parse(
    await archivedBrowserResponse.json(),
  );
  expect(archivedBrowserPage.items.length).toBeGreaterThan(0);
  expect(
    archivedBrowserPage.items.map((conversation) => conversation.id),
  ).toEqual(
    archivedAfterArchive
      .slice(0, archivedBrowserPage.items.length)
      .map((conversation) => conversation.id),
  );
  const conversationBrowser = page.getByRole("dialog", {
    name: "搜索对话",
    exact: true,
  });
  await expect(
    conversationBrowser.getByRole("tab", { name: "已归档", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    conversationBrowser.locator(".conversation-search-result"),
  ).toHaveCount(archivedBrowserPage.items.length);
  await expect(
    conversationBrowser.locator(".conversation-browser-dialog__status"),
  ).toContainText(
    `已归档对话，已显示 ${archivedBrowserPage.items.length} 项`,
  );
  await conversationBrowser
    .getByRole("button", { name: "关闭搜索对话" })
    .click();
  await expect(archivedTrigger).toBeFocused();

  const activeBeforeDelete = await listAllConversationsFromBrowser(
    page,
    "active",
  );
  const archivedBeforeDelete = await listAllConversationsFromBrowser(
    page,
    "archived",
  );
  expect(activeBeforeDelete).toEqual([]);
  expect(
    archivedBeforeDelete.map((conversation) => conversation.id),
  ).toEqual(archivedAfterArchive.map((conversation) => conversation.id));

  settingsDialog = await openSettings();
  const deleteAllTrigger = settingsDialog.getByRole("button", {
    name: /^删除所有对话/u,
  });
  await deleteAllTrigger.click();
  const deleteDialog = page.getByRole("alertdialog", {
    name: "永久删除所有对话？",
    exact: true,
  });
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog).toHaveAttribute("aria-busy", "false");
  await expect(
    deleteDialog.getByRole("button", { name: "取消", exact: true }),
  ).toBeFocused();
  await expect(deleteDialog).toContainText("此操作不可撤销。");

  const deleteRequestPaused = Promise.withResolvers<void>();
  const deleteRequestRelease = Promise.withResolvers<void>();
  const deleteRoute = async (route: Route): Promise<void> => {
    const request = route.request();
    if (
      new URL(request.url()).pathname === "/api/conversations" &&
      request.method() === "DELETE"
    ) {
      deleteRequestPaused.resolve();
      await deleteRequestRelease.promise;
    }
    await route.continue();
  };
  await page.route("**/api/conversations", deleteRoute);
  const deleteResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/conversations" &&
      response.request().method() === "DELETE",
  );
  const attachmentCleanupResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/input-attachments/${conversationAttachmentId}` &&
      response.request().method() === "DELETE",
  );
  const deleteConfirm = deleteDialog.getByRole("button", {
    name: /^(?:永久删除所有对话|正在删除…)$/u,
  });
  await deleteConfirm.click();
  await deleteRequestPaused.promise;
  await expect(deleteDialog).toHaveAttribute("aria-busy", "true");
  await expect(deleteConfirm).toBeDisabled();
  await expect(deleteConfirm).toHaveText("正在删除…");
  await page.keyboard.press("Escape");
  await expect(deleteDialog).toBeVisible();

  deleteRequestRelease.resolve();
  const deleteResponse = await deleteResponsePromise;
  expect(deleteResponse.status()).toBe(200);
  expect(deleteResponse.request().postData()).toBeNull();
  const deleteMutation = BulkConversationMutationResponseSchema.parse(
    await deleteResponse.json(),
  );
  expect(deleteMutation.mutation).toMatchObject({
    action: "delete_all",
    conversationCount:
      activeBeforeDelete.length + archivedBeforeDelete.length,
  });
  await page.unroute("**/api/conversations", deleteRoute);
  await expect(deleteDialog).toHaveCount(0);
  await expect(deleteAllTrigger).toBeFocused();
  await expect(page).toHaveURL("/");
  await expect(settingsDialog.getByRole("status")).toContainText(
    `已永久删除 ${(
      activeBeforeDelete.length + archivedBeforeDelete.length
    ).toLocaleString("zh-CN")} 个对话。`,
  );

  const attachmentCleanupResponse =
    await attachmentCleanupResponsePromise;
  expect(attachmentCleanupResponse.status()).toBe(200);
  expect(
    DeleteInputAttachmentResponseSchema.parse(
      await attachmentCleanupResponse.json(),
    ).deletion.attachmentId,
  ).toBe(conversationAttachmentId);

  const retainedStorage = {
    [newConversationComposerKey]: newConversationComposerValue,
    [newConversationExecutionProfileKey]: executionProfileValue,
    [newConversationAttachmentKey]: newConversationAttachmentValue,
  };
  const removedStorageKeys = [
    conversationComposerKey,
    conversationExecutionProfileKey,
    conversationAttachmentKey,
  ];
  const storageAfterDelete = await page.evaluate(
    ({ removedKeys, retainedKeys }) => ({
      removed: Object.fromEntries(
        removedKeys.map((key) => [key, window.localStorage.getItem(key)]),
      ),
      retained: Object.fromEntries(
        retainedKeys.map((key) => [key, window.localStorage.getItem(key)]),
      ),
    }),
    {
      removedKeys: removedStorageKeys,
      retainedKeys: Object.keys(retainedStorage),
    },
  );
  expect(storageAfterDelete.removed).toEqual(
    Object.fromEntries(removedStorageKeys.map((key) => [key, null])),
  );
  expect(storageAfterDelete.retained).toEqual(retainedStorage);
  await expect(
    page.locator('textarea[aria-label="输入研究问题"]'),
  ).toHaveValue(newConversationDraftText);

  const activeAfterDelete = await listAllConversationsFromBrowser(
    page,
    "active",
  );
  const archivedAfterDelete = await listAllConversationsFromBrowser(
    page,
    "archived",
  );
  expect(activeAfterDelete).toEqual([]);
  expect(archivedAfterDelete).toEqual([]);
  await expect(activeConversationNav.locator(".conversation-row"))
    .toHaveCount(0);

  const shareListAfterDeleteResponse = await page.evaluate(async () => {
    const result = await fetch("/api/conversation-shares?limit=50");
    return {
      body: await result.json(),
      status: result.status,
    };
  });
  expect(shareListAfterDeleteResponse.status).toBe(200);
  expect(
    ListConversationSharesResponseSchema.parse(
      shareListAfterDeleteResponse.body,
    ),
  ).toMatchObject({ items: [], nextCursor: null });
  const deletedPublicShareResponse = await page.request.get(
    publishedShare.publicPath,
  );
  expect(deletedPublicShareResponse.status()).toBe(404);
  expect(deletedPublicShareResponse.headers()["content-type"]).toContain(
    "text/html",
  );
  expect(await deletedPublicShareResponse.text()).toContain(
    "这个分享链接不可用",
  );

  const usageAfterDataControl = await readAccountUsage();
  expect(usageAfterDataControl).toEqual(usageBeforeDataControl);
  expect(chatRequests).toEqual([]);

  await settingsDialog.getByRole("button", { name: "关闭设置" }).click();
  const emptyArchivedResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/conversations" &&
      url.searchParams.get("view") === "archived" &&
      response.request().method() === "GET"
    );
  });
  await archivedTrigger.click();
  const emptyArchivedResponse = await emptyArchivedResponsePromise;
  expect(emptyArchivedResponse.status()).toBe(200);
  expect(
    ListConversationsResponseSchema.parse(await emptyArchivedResponse.json()),
  ).toEqual({ items: [], nextCursor: null });
  await expect(
    page
      .getByRole("dialog", { name: "搜索对话", exact: true })
      .getByText("还没有已归档对话", { exact: true }),
  ).toBeVisible();
});
