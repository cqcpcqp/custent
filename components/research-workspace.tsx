"use client";

import { useRouter } from "next/navigation";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import {
  ApiClientError,
  archiveAllConversations,
  branchConversation,
  cancelRun,
  deleteConversation,
  deleteAllConversations,
  deleteInputAttachment,
  getBootstrap,
  getConversation,
  getStagedInputAttachment,
  isApiAbortError,
  listConversations,
  openRunEventStream,
  patchConversation,
  patchMessageFeedback,
  regenerateRun,
  retryRun,
  startChat,
  uploadInputAttachment,
  userFacingRequestErrorMessage,
} from "@/components/api-client";
import { AttachmentDraftRecoveryNotice } from "@/components/attachment-draft-recovery-notice";
import {
  BackgroundRunCenterDialog,
  BackgroundRunCenterTrigger,
} from "@/components/background-run-center";
import {
  backgroundRunCenterItems,
  backgroundRunCenterSelection,
  backgroundRunHistorySelection,
  type BackgroundRunCenterItem,
} from "@/components/background-run-center-state";
import {
  conversationRoute,
  libraryResearchRoute,
  libraryRoute,
  type WorkspaceSurfaceRoute,
} from "@/components/conversation-route";
import {
  ChatComposer,
  nextChatComposerFocusRequestToken,
} from "@/components/chat-composer";
import {
  chatSubmissionFailureRecovery,
  chatRequestsHaveSamePayload,
  executeChatSubmissionFailureRecovery,
  reconcilePendingChatRequestStoreAfterConfirmedAttachmentDeletion,
  shouldActivateCreatedConversation,
  shouldRetainPendingChatRequest,
  staleParentRecoveryFailedMessage,
  staleParentRecoveryMessage,
} from "@/components/chat-submission-state";
import {
  conversationActivityView,
  removeConversationActivityView,
  updateConversationActivityView,
  type ConversationActivityViewMap,
} from "@/components/conversation-activity-state";
import {
  readRunEventStreamWithReconnect,
  RunEventProtocolError,
} from "@/components/chat-stream";
import {
  ConversationBrowserDialog,
  type ConversationBrowserSelection,
} from "@/components/conversation-browser-dialog";
import { createClientId } from "@/components/client-id";
import { CitationSourcesPanel } from "@/components/citation-sources-panel";
import { ConversationLoadFailure } from "@/components/conversation-load-failure";
import {
  reconcileRecoveredComposerAttachmentDrafts,
  recoverComposerAttachmentDrafts,
} from "@/components/composer-attachment-draft-recovery";
import {
  clearComposerAttachmentDraftScope,
  clearComposerAttachmentDraftConversationScopes,
  composerAttachmentDraftStorageEventAffectsScope,
  readComposerAttachmentDraftScope,
  removeComposerAttachmentDraft,
  writeComposerAttachmentDraft,
} from "@/components/composer-attachment-draft-storage";
import {
  clearConversationComposerDrafts,
  conversationComposerDraftScope,
  newConversationComposerDraftScope,
  readComposerDraft,
  removeComposerDraft,
  writeComposerDraft,
  type ComposerDraftScope,
} from "@/components/composer-draft-storage";
import {
  clearConversationExecutionProfileDrafts,
  executionProfileDraftIdForCatalog,
  readExecutionProfileDraft,
  removeExecutionProfileDraft,
  writeExecutionProfileDraft,
} from "@/components/execution-profile-draft-storage";
import {
  nextCreditsRevision,
  shouldCommitCreditOperationResponse,
  shouldCommitCreditMutationResponse,
  shouldCommitTerminalCreditsAtRevision,
} from "@/components/credit-refresh-state";
import {
  captureConversationScroll,
  maximumScrollTop,
  restoredConversationScrollTop,
  type ConversationScrollSnapshot,
} from "@/components/conversation-scroll-state";
import {
  conversationMessageIsSearchTarget,
  conversationSearchTargetFromSelection,
  revealConversationSearchTarget,
  type ConversationSearchTarget,
} from "@/components/conversation-search-target";
import {
  advanceConversationLoadedDepth,
  conversationHasOutstandingRuns,
  conversationSidebarRunStatus,
  conversationPageLimitToRestoreDepth,
  mergeBootstrapConversationSummaries,
  mergeConversationPage,
  mergeConversationPageAtRevision,
  mergeConversationSummarySources,
  removeConversationAndSelectNext,
  removeConversationFromSummarySources,
  removeConversationSummary,
  upsertConversationSummary,
} from "@/components/conversation-list-state";
import type { MessageBranchToNewConversationTarget } from "@/components/message-branch-action";
import {
  DeleteConversationDialog,
  RenameConversationDialog,
} from "@/components/conversation-mutation-dialogs";
import { ConversationHeaderMenu } from "@/components/conversation-header-menu";
import { ConversationShareDialog } from "@/components/conversation-share-dialog";
import { ConversationSidebar } from "@/components/conversation-sidebar";
import type { DataControlMutationResult } from "@/components/settings-dialog";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import {
  attachmentIdsForSubmission,
  canSubmitDraft,
  createInputAttachmentPreviewUrl,
  failedDraftInputAttachment,
  inputAttachmentMimeTypeForCandidate,
  releaseDraftInputAttachmentResources,
  removeDraftInputAttachment,
  replaceDraftInputAttachment,
  retryDraftInputAttachment,
  validateDraftInputAttachmentLimits,
  validateInputAttachmentCandidate,
  type DraftInputAttachment,
} from "@/components/input-attachment-state";
import { LibraryView } from "@/components/library-view";
import type { LibraryTab } from "@/components/library-state";
import {
  ActivityIcon,
  AlertIcon,
  ArchiveIcon,
  BrandMark,
  ChevronDownIcon,
  CoinsIcon,
  MenuIcon,
  PlusIcon,
  RefreshIcon,
  ShareIcon,
} from "@/components/icons";
import {
  archiveMutationRefreshesConversationBrowser,
  closeDesktopPanelAndRestoreFocus,
  documentHasOpenModal,
  workspaceKeyboardShortcutAriaKeyShortcuts,
  workspaceShortcutAction,
  type ConversationArchiveMutationOrigin,
} from "@/components/workspace-ux-state";
import { ResearchEmptyState } from "@/components/research-empty-state";
import {
  MessageView,
  StreamingMessage,
  TerminalRunMessage,
  TurnAttemptControls,
  TurnBranchControls,
  WaitingRunMessage,
  type OpenCitationSources,
} from "@/components/research-message";
import {
  activityRunForSelection,
  advanceConversationRefreshFence,
  artifactsForRun,
  canRetryRun,
  claimConversationMutationOwner,
  conversationLoadFenceStatus,
  conversationSummaryAtReadWatermark,
  conversationRefreshIsCurrent,
  conversationStateHasOutstandingRuns,
  conversationStateReducer,
  conversationStateShowsTerminalResult,
  editChatRequestForTurn,
  effectiveRunStatus,
  eventsForRun,
  followSupersededConversationLoad,
  isActiveRunStatus,
  loadedRunSubscriptionRequests,
  projectLoadedConversationTimeline,
  refreshIncompatibleBootstrapConversationDetails,
  resolveLatestReachableLeafRunId,
  releaseConversationMutationOwner,
  runCancellationIsPending,
  runEventSubscriptionMode,
  shouldCommitCancelRunResponse,
  shouldMarkConversationRead,
  shouldCommitTerminalCredits,
  shouldRetryConversationLoad,
  shouldSubscribeToRun,
  statusEventAdvancesConversationObservation,
  textForRun,
  visibleConversationDetailRefreshIsCurrent,
  waitingRunIsBlocked,
  type ConversationLoadResult,
  type ConversationMutationOwnerToken,
  type ConversationStateMap,
  type ConversationTurnProjection,
  type ConversationViewState,
  type RunEventReplayState,
} from "@/components/research-workspace-state";
import {
  idleRunEventConnectionState,
  reconnectingRunEventConnectionState,
  sameRunEventConnectionState,
  type RunEventConnectionState,
} from "@/components/run-event-connection-state";
import {
  dismissRunCompletionNotification,
  dismissRunCompletionNotificationsForConversation,
  emptyRunCompletionNotificationQueue,
  enqueueRunCompletionNotification,
  reconcileRunCompletionNotifications,
  runCompletionOutcomeForEvent,
  type RunCompletionNotificationQueue,
  type RunCompletionOutcome,
} from "@/components/run-completion-notification-state";
import { RunCompletionNotifications } from "@/components/run-completion-notifications";
import { RunCompletionSystemNotifications } from "@/components/run-completion-system-notifications";
import {
  abortableDelay,
  isRetryableRunEventError,
  isTransientApiError,
  runEventRetryDelayMs,
} from "@/components/run-event-retry";
import { RunEventFrameBuffer } from "@/components/run-event-buffer";
import {
  activeRunSubscriptionRole,
  backgroundRunBootstrapObservationRequired,
  connectionModeForRunSubscriptionRole,
  markCurrentRunSubscriptionTerminalEvent,
  releaseCurrentTerminalRunSubscription,
  runSubscriptionCommitsEvents,
  runSubscriptionPresentsConnectionState,
  runSubscriptionRole,
  runSubscriptionRoleTransition,
  runSubscriptionUsesEventStream,
  type RunEventStreamSubscriptionRole,
  type RunSubscriptionIntent,
} from "@/components/run-subscription-policy";
import {
  resolveRunActivityDetailState,
  RunActivityPanel,
} from "@/components/run-activity";
import {
  userMessageEditAttachmentIds,
  userMessageEditHasPendingAttachments,
  updateUserMessageEditState,
  type UserMessageEditState,
  type UserMessageEditStateMap,
} from "@/components/user-message-edit-state";
import {
  nextWorkspaceGeneration,
  workspaceGenerationIsCurrent,
} from "@/components/workspace-lifetime-state";
import {
  workspaceDocumentTitleContext,
  workspaceDocumentStatusCounts,
  workspaceDocumentTitle,
} from "@/components/workspace-document-title";
import {
  beginBootstrapRevalidation,
  initialBootstrapRevalidationQueueState,
  isWorkspaceCrossTabMessage,
  planBootstrapRevalidationRequest,
  settleBootstrapRevalidation,
  workspaceBootstrapChangedMessage,
  workspaceCrossTabChannelName,
  type BootstrapRevalidationRequestKind,
} from "@/components/workspace-cross-tab-sync";
import {
  mergeTerminalConversationSummary,
  refreshTerminalSources,
} from "@/components/terminal-refresh";
import {
  conversationSummaryFromListItem,
  type AgentRun,
  type AgentRunStatus,
  type BackgroundRunHistoryItem,
  type BootstrapResponse,
  type ChatMessage,
  type ChatRequest,
  type ConversationListView,
  type PatchConversationRequest,
  type ConversationSummary,
  type ExecutionProfileId,
  type MessageFeedback,
  type RunEvent,
} from "@/lib/contracts";

const EMPTY_RUN_EVENTS: RunEvent[] = [];
const backgroundRunBootstrapObservationIntervalMs = 1_000;

type RunSubscription = {
  conversationId: string;
  controller: AbortController;
  role: RunEventStreamSubscriptionRole;
  terminalEventReceived: boolean;
};

type RunTerminalFollowUp = {
  conversationId: string;
  controller: AbortController;
  terminalEventId: string;
};

type CitationSourcesView = Readonly<{
  conversationId: string;
  messageId: string;
  citations: Parameters<OpenCitationSources>[1];
  activeNumber: number;
}>;

type RunSubscriptionSeed = {
  knownRun?: AgentRun;
  existingEvents?: RunEvent[];
  knownConversation?: ConversationSummary;
};

type ConversationPatchResult =
  | { conversation: ConversationSummary; error: null }
  | { conversation: null; error: string };

type ChatSubmissionFailureResult =
  | { handled: false }
  | {
      handled: true;
      message: string;
      reloadFailed: boolean;
    };

type ConversationLoadOperation = {
  controller: AbortController;
  promise: Promise<ConversationLoadResult> | null;
  status: "pending" | "settled";
};

type UnsuccessfulConversationLoadResult = Exclude<
  ConversationLoadResult,
  { status: "loaded" }
>;

type ConversationPageLoadOperation = {
  controller: AbortController;
  cursor: string;
  generation: number;
};

type AttachmentDraftRecoveryState =
  | Readonly<{ phase: "restoring" }>
  | Readonly<{ phase: "ready" }>
  | Readonly<{ phase: "failed"; message: string }>;

const newConversationDraftKey = "__new_conversation__";
const conversationSidebarPageSize = 30;
const conversationSearchHighlightMilliseconds = 2_600;

function retainNewConversationRecord<Value>(
  record: Record<string, Value>,
): Record<string, Value> {
  const value = record[newConversationDraftKey];
  return value === undefined
    ? {}
    : { [newConversationDraftKey]: value };
}

function composerDraftScopeForKey(key: string): ComposerDraftScope {
  return key === newConversationDraftKey
    ? newConversationComposerDraftScope
    : conversationComposerDraftScope(key);
}

function nextAttachmentDraftOrderToken(
  currentSequence: number,
  clientId: string,
  now = Date.now(),
): { sequence: number; token: string } {
  const sequence = currentSequence + 1;
  if (
    !Number.isSafeInteger(sequence) ||
    sequence <= 0 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    clientId.length === 0
  ) {
    throw new Error("附件草稿顺序 token 输入不符合固定契约");
  }
  return {
    sequence,
    token: `${String(now).padStart(13, "0")}:${String(sequence).padStart(
      12,
      "0",
    )}:${clientId}`,
  };
}

function messageBranchRequestKey(
  conversationId: string,
  messageId: string,
): string {
  return `${conversationId}:${messageId}`;
}

function userMessageEditPendingRequestKey(
  conversationId: string,
  messageId: string,
): string {
  return `edit:${conversationId}:${messageId}`;
}
const activeRunMutationMessage =
  "该对话仍有正在运行或等待中的研究，请先停止或取消后再归档或删除。";
const activeRunSelectionMessage =
  "研究正在运行或等待中，完成或停止后才能切换回答版本或消息分支。";
const activeRunRegenerateMessage =
  "研究正在运行或等待中，完成或停止后才能重新生成回答。";
const archivedConversationRegenerateMessage =
  "恢复已归档对话后才能重新生成回答。";

function isAbortError(error: unknown): boolean {
  return isApiAbortError(error);
}

function errorMessage(error: unknown): string {
  return userFacingRequestErrorMessage(
    error,
    "操作暂时无法完成，请重试。",
  );
}

function conversationMutationErrorMessage(error: unknown): string {
  if (
    error instanceof ApiClientError &&
    error.code === "ACTIVE_RUN" &&
    error.status === 409
  ) {
    return activeRunMutationMessage;
  }
  return errorMessage(error);
}

function bulkConversationMutationErrorMessage(error: unknown): string {
  if (
    error instanceof ApiClientError &&
    error.code === "ACTIVE_RUN" &&
    error.status === 409
  ) {
    return "仍有对话包含正在运行或等待中的研究，请先停止或取消后再试。";
  }
  return errorMessage(error);
}

function branchedConversationLoadErrorMessage(
  status: UnsuccessfulConversationLoadResult["status"],
): string {
  switch (status) {
    case "failed":
      return "新对话分支已创建，但详情加载失败，未自动打开";
    case "not_found":
      return "新对话分支已创建，但详情不存在，未自动打开";
    case "revision_changed":
      return "新对话分支加载期间已发生变更，未自动打开";
    case "superseded":
      return "新对话分支详情加载已被更新请求取代，未自动打开";
  }
}

function runForId(
  state: ConversationViewState | undefined,
  runId: string | null,
): AgentRun | null {
  if (runId === null) {
    return null;
  }
  return state?.runs.find((run) => run.id === runId) ?? null;
}

function activeRunForConversation(
  conversation: ConversationSummary | undefined,
  state: ConversationViewState | undefined,
): AgentRun | null {
  const summarizedRun = runForId(state, conversation?.activeRun?.id ?? null);
  if (summarizedRun !== null) {
    const status = effectiveRunStatus(
      summarizedRun,
      eventsForRun(state, summarizedRun.id),
    );
    if (isActiveRunStatus(status)) {
      return summarizedRun;
    }
  }

  if (state === undefined) {
    return null;
  }
  for (let index = state.runs.length - 1; index >= 0; index -= 1) {
    const run = state.runs[index];
    if (isActiveRunStatus(effectiveRunStatus(run, eventsForRun(state, run.id)))) {
      return run;
    }
  }
  return null;
}

function requiredConversationSummary(
  bootstrap: BootstrapResponse | null,
  detachedConversation: ConversationSummary | null,
  conversationId: string,
): ConversationSummary {
  const conversation =
    findBootstrapConversation(bootstrap, conversationId) ??
    (detachedConversation?.id === conversationId
      ? detachedConversation
      : null);
  if (conversation === null) {
    throw new Error(`当前工作区缺少会话摘要 ${conversationId}`);
  }
  return conversation;
}

function bootstrapConversationSummaries(
  bootstrap: BootstrapResponse | null,
): ConversationSummary[] {
  return bootstrap === null
    ? []
    : mergeConversationSummarySources(
        bootstrap.conversations,
        bootstrap.trackedConversations,
      );
}

function findBootstrapConversation(
  bootstrap: BootstrapResponse | null,
  conversationId: string,
): ConversationSummary | undefined {
  return bootstrapConversationSummaries(bootstrap).find(
    (conversation) => conversation.id === conversationId,
  );
}

function requiredInputAttachmentLimits(
  bootstrap: BootstrapResponse | null,
): BootstrapResponse["inputAttachmentLimits"] {
  if (bootstrap === null) {
    throw new Error("工作区尚未加载附件限制契约");
  }
  return bootstrap.inputAttachmentLimits;
}

function retainedUserMessageAttachments(
  message: ChatMessage,
  retainedAttachmentIds: readonly string[],
): ChatMessage["attachments"] {
  const attachmentsById = new Map(
    message.attachments.map((attachment) => [attachment.id, attachment]),
  );
  return retainedAttachmentIds.map((attachmentId) => {
    const attachment = attachmentsById.get(attachmentId);
    if (attachment === undefined) {
      throw new Error(
        `用户消息 ${message.id} 不包含待保留附件 ${attachmentId}`,
      );
    }
    return attachment;
  });
}

export function ResearchWorkspace({
  route,
}: {
  route: WorkspaceSurfaceRoute;
}) {
  const router = useRouter();
  const routeConversationId =
    route.kind === "conversation" ? route.conversationId : null;
  const routeSnapshotId = route.kind === "library" ? route.snapshotId : null;
  const isLibraryRoute = route.kind === "library";
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversationStates, dispatchConversation] = useReducer(
    conversationStateReducer,
    {} as ConversationStateMap,
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [executionProfileDrafts, setExecutionProfileDrafts] = useState<
    Record<string, ExecutionProfileId>
  >({});
  const [isLoadingMoreConversations, setIsLoadingMoreConversations] =
    useState(false);
  const [conversationLoadMoreError, setConversationLoadMoreError] =
    useState<string | null>(null);
  const [attachmentDrafts, setAttachmentDrafts] = useState<
    Record<string, DraftInputAttachment[]>
  >({});
  const [attachmentDraftErrors, setAttachmentDraftErrors] = useState<
    Record<string, string>
  >({});
  const [attachmentDraftRecoveryStates, setAttachmentDraftRecoveryStates] =
    useState<Record<string, AttachmentDraftRecoveryState>>({});
  const [isCreating, setIsCreating] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [activityViews, setActivityViews] =
    useState<ConversationActivityViewMap>({});
  const [citationSourcesView, setCitationSourcesView] =
    useState<CitationSourcesView | null>(null);
  const [conversationBrowserView, setConversationBrowserView] =
    useState<ConversationListView | null>(null);
  const [conversationBrowserVersion, setConversationBrowserVersion] =
    useState(0);
  const [conversationSearchTarget, setConversationSearchTarget] =
    useState<ConversationSearchTarget | null>(null);
  const [renameTarget, setRenameTarget] =
    useState<ConversationSummary | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<ConversationSummary | null>(null);
  const [shareTargetConversationId, setShareTargetConversationId] =
    useState<string | null>(null);
  const [isKeyboardShortcutsOpen, setIsKeyboardShortcutsOpen] =
    useState(false);
  const [isBackgroundRunCenterOpen, setIsBackgroundRunCenterOpen] =
    useState(false);
  const [detachedConversation, setDetachedConversation] =
    useState<ConversationSummary | null>(null);
  const [mutatingConversationIds, setMutatingConversationIds] = useState<
    Set<string>
  >(() => new Set());
  const [runReplayStates, setRunReplayStates] = useState<
    Record<string, RunEventReplayState>
  >({});
  const [runEventConnectionStates, setRunEventConnectionStates] = useState<
    Record<string, RunEventConnectionState>
  >({});
  const [cancellingRunIds, setCancellingRunIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [retryingRunIds, setRetryingRunIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [regeneratingRunIds, setRegeneratingRunIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectingRunConversationIds, setSelectingRunConversationIds] =
    useState<Set<string>>(() => new Set());
  const [userMessageEdits, setUserMessageEdits] =
    useState<UserMessageEditStateMap>({});
  const [feedbackPendingMessageIds, setFeedbackPendingMessageIds] = useState<
    Set<string>
  >(() => new Set());
  const [branchingMessageKeys, setBranchingMessageKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const [composerFocusRequestToken, setComposerFocusRequestToken] =
    useState(0);
  const [runCompletionNotifications, setRunCompletionNotifications] =
    useState<RunCompletionNotificationQueue>(
      emptyRunCompletionNotificationQueue,
    );
  const [runSubscriptionContextRevision, setRunSubscriptionContextRevision] =
    useState(0);
  const activeConversationUiKey =
    activeConversationId ?? newConversationDraftKey;
  const activeActivityView = conversationActivityView(
    activityViews,
    activeConversationUiKey,
  );
  const isActivityOpen = !isLibraryRoute && activeActivityView.isOpen;
  const activityRunId = activeActivityView.runId;
  const activeCitationSourcesView =
    citationSourcesView?.conversationId === activeConversationId
      ? citationSourcesView
      : null;
  const isCitationSourcesOpen =
    !isLibraryRoute && activeCitationSourcesView !== null;
  const userMessageEdit =
    activeConversationId === null
      ? null
      : userMessageEdits[activeConversationId] ?? null;
  const observedConversationSummaries = useMemo(
    () => bootstrapConversationSummaries(bootstrap),
    [bootstrap],
  );
  const backgroundRunItems = useMemo(
    () => backgroundRunCenterItems(observedConversationSummaries),
    [observedConversationSummaries],
  );
  const backgroundRunStatusCounts = useMemo(
    () => workspaceDocumentStatusCounts(observedConversationSummaries),
    [observedConversationSummaries],
  );
  const backgroundRunBadgeCount =
    backgroundRunStatusCounts.activeRunCount +
    backgroundRunStatusCounts.unreadCount;

  const bootstrapAbortRef = useRef<AbortController | null>(null);
  const bootstrapRevalidationAbortRef = useRef<AbortController | null>(null);
  const bootstrapRevalidationTimerRef = useRef<number | null>(null);
  const bootstrapRevalidationTimerRequestRef =
    useRef<BootstrapRevalidationRequestKind | null>(null);
  const bootstrapRevalidationRunningRequestRef =
    useRef<BootstrapRevalidationRequestKind | null>(null);
  const bootstrapRevalidationQueueStateRef = useRef(
    initialBootstrapRevalidationQueueState,
  );
  const conversationPageLoadOperationRef =
    useRef<ConversationPageLoadOperation | null>(null);
  const conversationListGenerationRef = useRef(0);
  const conversationLoadedDepthRef = useRef(0);
  const workspaceCrossTabChannelRef = useRef<BroadcastChannel | null>(null);
  const conversationLoadOperationsRef = useRef(
    new Map<string, ConversationLoadOperation>(),
  );
  const runSubscriptionsRef = useRef(new Map<string, RunSubscription>());
  const runTerminalFollowUpsRef = useRef(
    new Map<string, RunTerminalFollowUp>(),
  );
  const runEventBuffersRef = useRef(new Map<string, RunEventFrameBuffer>());
  const runReplayStatesRef = useRef(new Map<string, RunEventReplayState>());
  const runEventConnectionStatesRef = useRef(
    new Map<string, RunEventConnectionState>(),
  );
  const runsWithObservedRunningStatusRef = useRef(new Set<string>());
  const restoredDraftKeysRef = useRef(new Set<string>());
  const attachmentDraftsRef = useRef<
    Record<string, DraftInputAttachment[]>
  >({});
  const attachmentUploadControllersRef = useRef(
    new Map<string, AbortController>(),
  );
  const attachmentDraftRecoveryControllersRef = useRef(
    new Map<string, AbortController>(),
  );
  const attachmentDraftOrderTokensRef = useRef(new Map<string, string>());
  const attachmentDraftOrderSequenceRef = useRef(0);
  const unpersistedAttachmentIdsRef = useRef(new Set<string>());
  const attachmentPreviewUrlsRef = useRef(new Set<string>());
  const userMessageEditsRef = useRef<UserMessageEditStateMap>({});
  const pendingChatRequestsRef = useRef(new Map<string, ChatRequest>());
  const pendingRetryRequestIdsRef = useRef(new Map<string, string>());
  const pendingRegenerateRequestIdsRef = useRef(new Map<string, string>());
  const pendingMessageBranchRequestIdsRef = useRef(new Map<string, string>());
  const pendingMessageBranchFocusRestoresRef = useRef(
    new Map<string, HTMLButtonElement>(),
  );
  const selectingRunConversationIdsRef = useRef(new Set<string>());
  const feedbackPendingMessageIdsRef = useRef(new Set<string>());
  const feedbackDataRevisionRef = useRef(0);
  const conversationMutationOwnersRef = useRef(
    new Map<string, ConversationMutationOwnerToken>(),
  );
  const bulkConversationMutationPendingRef = useRef(false);
  const markReadRequestsRef = useRef(new Map<string, string>());
  const conversationReadWatermarksRef = useRef(new Map<string, string>());
  const conversationRefreshFencesRef = useRef(new Map<string, string>());
  const conversationObservationRevisionsRef = useRef(
    new Map<string, number>(),
  );
  const latestCreditTerminalEventIdRef = useRef("0");
  const latestStartedCreditTerminalEventIdRef = useRef("0");
  const creditMutationRevisionRef = useRef(0);
  const pendingCreditMutationRevisionsRef = useRef(new Set<number>());
  const creditMutationOperationRevisionsRef = useRef(new Map<number, number>());
  const creditOperationRevisionRef = useRef(0);
  const nonTerminalCreditSnapshotRevisionRef = useRef(0);
  const creditSnapshotRevisionRef = useRef(0);
  const workspaceGenerationRef = useRef(0);
  const navigationIntentRevisionRef = useRef(0);
  const bootstrapRef = useRef<BootstrapResponse | null>(null);
  const detachedConversationRef = useRef<ConversationSummary | null>(null);
  const conversationStatesRef = useRef(conversationStates);
  const runCompletionNotificationsRef = useRef(runCompletionNotifications);
  const dismissedRunCompletionRunIdsRef = useRef(new Set<string>());
  const activeConversationIdRef = useRef<string | null>(null);
  const routeRef = useRef<WorkspaceSurfaceRoute>(route);
  routeRef.current = route;
  const mobileSidebarMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const headerActivityButtonRef = useRef<HTMLButtonElement>(null);
  const headerBackgroundRunButtonRef = useRef<HTMLButtonElement>(null);
  const activityReturnFocusRef = useRef<HTMLButtonElement>(null);
  const citationSourcesReturnFocusRef = useRef<HTMLElement>(null);
  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const conversationScrollMemoryRef = useRef(
    new Map<string, ConversationScrollSnapshot>(),
  );
  const conversationSearchRequestIdRef = useRef(0);
  const revealedConversationSearchRequestIdRef = useRef<number | null>(null);
  const conversationSearchClearTimerRef = useRef<number | null>(null);

  useEffect(() => {
    conversationStatesRef.current = conversationStates;
  }, [conversationStates]);

  useEffect(() => {
    bootstrapRef.current = bootstrap;
  }, [bootstrap]);

  useEffect(() => {
    detachedConversationRef.current = detachedConversation;
  }, [detachedConversation]);

  useEffect(() => {
    runCompletionNotificationsRef.current = runCompletionNotifications;
  }, [runCompletionNotifications]);

  useLayoutEffect(() => {
    for (const [requestKey, trigger] of
      pendingMessageBranchFocusRestoresRef.current) {
      if (branchingMessageKeys.has(requestKey)) {
        continue;
      }
      pendingMessageBranchFocusRestoresRef.current.delete(requestKey);
      if (trigger.isConnected) {
        trigger.focus();
      }
    }
  }, [branchingMessageKeys]);

  useEffect(() => {
    setCitationSourcesView((current) =>
      current !== null && current.conversationId !== activeConversationId
        ? null
        : current,
    );
  }, [activeConversationId]);

  useEffect(
    () => () => {
      if (conversationSearchClearTimerRef.current !== null) {
        window.clearTimeout(conversationSearchClearTimerRef.current);
        conversationSearchClearTimerRef.current = null;
      }
    },
    [],
  );

  const beginConversationMutation = useCallback(
    (
      conversationId: string,
      owner: ConversationMutationOwnerToken,
    ) => {
      if (
        !claimConversationMutationOwner(
          conversationMutationOwnersRef.current,
          conversationId,
          owner,
        )
      ) {
        return false;
      }
      setMutatingConversationIds(
        new Set(conversationMutationOwnersRef.current.keys()),
      );
      return true;
    },
    [],
  );

  const finishConversationMutation = useCallback(
    (
      conversationId: string,
      owner: ConversationMutationOwnerToken,
    ) => {
      if (
        !releaseConversationMutationOwner(
          conversationMutationOwnersRef.current,
          conversationId,
          owner,
        )
      ) {
        return false;
      }
      setMutatingConversationIds(
        new Set(conversationMutationOwnersRef.current.keys()),
      );
      return true;
    },
    [],
  );

  const beginRunSelection = useCallback((conversationId: string) => {
    if (selectingRunConversationIdsRef.current.has(conversationId)) {
      return false;
    }
    selectingRunConversationIdsRef.current.add(conversationId);
    setSelectingRunConversationIds(
      new Set(selectingRunConversationIdsRef.current),
    );
    return true;
  }, []);

  const finishRunSelection = useCallback((conversationId: string) => {
    selectingRunConversationIdsRef.current.delete(conversationId);
    setSelectingRunConversationIds(
      new Set(selectingRunConversationIdsRef.current),
    );
  }, []);

  const mutateUserMessageEdit = useCallback(
    (
      conversationId: string,
      update: (
        current: UserMessageEditState | null,
      ) => UserMessageEditState | null,
    ) => {
      const next = updateUserMessageEditState(
        userMessageEditsRef.current,
        conversationId,
        update,
      );
      userMessageEditsRef.current = next;
      setUserMessageEdits(next);
    },
    [],
  );

  const updateAttachmentDraft = useCallback(
    (
      key: string,
      update: (current: DraftInputAttachment[]) => DraftInputAttachment[],
    ) => {
      const nextItems = update(attachmentDraftsRef.current[key] ?? []);
      const nextDrafts = { ...attachmentDraftsRef.current };
      if (nextItems.length === 0) {
        delete nextDrafts[key];
      } else {
        nextDrafts[key] = nextItems;
      }
      attachmentDraftsRef.current = nextDrafts;
      setAttachmentDrafts(nextDrafts);
    },
    [],
  );

  const setAttachmentDraftError = useCallback(
    (key: string, message: string | null) => {
      setAttachmentDraftErrors((current) => {
        const next = { ...current };
        if (message === null) {
          delete next[key];
        } else {
          next[key] = message;
        }
        return next;
      });
    },
    [],
  );

  const setAttachmentDraftRecoveryState = useCallback(
    (key: string, state: AttachmentDraftRecoveryState) => {
      setAttachmentDraftRecoveryStates((current) => ({
        ...current,
        [key]: state,
      }));
    },
    [],
  );

  const revokeAttachmentPreview = useCallback((previewUrl: string | null) => {
    if (previewUrl === null) {
      return;
    }
    URL.revokeObjectURL(previewUrl);
    attachmentPreviewUrlsRef.current.delete(previewUrl);
  }, []);

  const abortAttachmentUpload = useCallback((clientId: string) => {
    attachmentUploadControllersRef.current.get(clientId)?.abort();
    attachmentUploadControllersRef.current.delete(clientId);
  }, []);

  const clearLocalAttachmentDraft = useCallback(
    (key: string) => {
      const attachments = attachmentDraftsRef.current[key] ?? [];
      for (const attachment of attachments) {
        releaseDraftInputAttachmentResources(
          attachment,
          abortAttachmentUpload,
          revokeAttachmentPreview,
        );
        attachmentDraftOrderTokensRef.current.delete(attachment.clientId);
        if (
          attachment.status === "uploaded" ||
          attachment.status === "deleting"
        ) {
          unpersistedAttachmentIdsRef.current.delete(
            attachment.attachment.id,
          );
        }
      }
      updateAttachmentDraft(key, () => []);
      setAttachmentDraftError(key, null);
    },
    [
      abortAttachmentUpload,
      revokeAttachmentPreview,
      setAttachmentDraftError,
      updateAttachmentDraft,
    ],
  );

  const restoreAttachmentDraftScope = useCallback(
    async (key: string, scope: ComposerDraftScope, userId: string) => {
      attachmentDraftRecoveryControllersRef.current.get(key)?.abort();
      const controller = new AbortController();
      attachmentDraftRecoveryControllersRef.current.set(key, controller);
      setAttachmentDraftRecoveryState(key, { phase: "restoring" });

      try {
        const stored = readComposerAttachmentDraftScope(
          window.localStorage,
          userId,
          scope,
        );
        if (stored.status === "invalid") {
          throw new Error("附件草稿恢复作用域不符合固定契约");
        }
        if (stored.status === "unavailable") {
          setAttachmentDraftError(
            key,
            "浏览器存储当前不可用，已上传附件无法跨刷新恢复。你仍可在本页继续使用新附件。",
          );
          setAttachmentDraftRecoveryState(key, { phase: "ready" });
          return;
        }

        const warningMessages: string[] = [];
        let hasUnreadStoredRecord = false;
        for (const issue of stored.issues) {
          if (
            issue.reason === "enumeration_failed" ||
            issue.reason === "read_failed"
          ) {
            hasUnreadStoredRecord = true;
            continue;
          }
          if (issue.key !== null) {
            try {
              window.localStorage.removeItem(issue.key);
            } catch {
              hasUnreadStoredRecord = true;
            }
          }
        }
        if (stored.issues.length > 0) {
          warningMessages.push("已忽略损坏或暂时不可读的附件草稿记录。");
        }

        for (const expired of stored.expired) {
          const removal = removeComposerAttachmentDraft(
            window.localStorage,
            userId,
            scope,
            expired.attachment.id,
          );
          if (removal.status !== "removed") {
            warningMessages.push(
              `无法清理已过期附件记录：${expired.attachment.name}`,
            );
          }
          unpersistedAttachmentIdsRef.current.delete(expired.attachment.id);
        }

        const recovery = await recoverComposerAttachmentDrafts(
          stored.active,
          getStagedInputAttachment,
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          attachmentDraftRecoveryControllersRef.current.get(key) !== controller
        ) {
          return;
        }

        const invalidatedIds = new Set(
          recovery.invalidated.map((draft) => draft.attachment.id),
        );
        for (const invalidated of recovery.invalidated) {
          const removal = removeComposerAttachmentDraft(
            window.localStorage,
            userId,
            scope,
            invalidated.attachment.id,
          );
          if (removal.status !== "removed") {
            warningMessages.push(
              `无法清理失效附件记录：${invalidated.attachment.name}`,
            );
          }
          unpersistedAttachmentIdsRef.current.delete(
            invalidated.attachment.id,
          );
        }

        const liveStored = stored.active.filter(
          (draft) => !invalidatedIds.has(draft.attachment.id),
        );
        for (const draft of liveStored) {
          unpersistedAttachmentIdsRef.current.delete(draft.attachment.id);
        }
        const reconciliation = reconcileRecoveredComposerAttachmentDrafts({
          current: attachmentDraftsRef.current[key] ?? [],
          stored: liveStored,
          recovery,
          unpersistedAttachmentIds: unpersistedAttachmentIdsRef.current,
        });
        for (const removed of reconciliation.removed) {
          releaseDraftInputAttachmentResources(
            removed,
            abortAttachmentUpload,
            revokeAttachmentPreview,
          );
          attachmentDraftOrderTokensRef.current.delete(removed.clientId);
        }
        updateAttachmentDraft(key, () => [...reconciliation.attachments]);

        if (stored.expired.length > 0) {
          warningMessages.push(
            `${stored.expired.length} 个附件草稿已过期，已从输入框移除。`,
          );
        }
        if (recovery.invalidated.length > 0) {
          warningMessages.push(
            `${recovery.invalidated.length} 个附件已过期、删除或在其他页面发送，已从输入框移除。`,
          );
        }
        if (warningMessages.length > 0) {
          setAttachmentDraftError(key, Array.from(new Set(warningMessages)).join("\n"));
        }

        if (recovery.failures.length > 0 || hasUnreadStoredRecord) {
          const unresolvedCount =
            recovery.failures.length + (hasUnreadStoredRecord ? 1 : 0);
          setAttachmentDraftRecoveryState(key, {
            phase: "failed",
            message: `有 ${unresolvedCount} 项附件草稿暂时无法确认。为避免漏发附件，发送已暂停。`,
          });
        } else {
          setAttachmentDraftRecoveryState(key, { phase: "ready" });
        }
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          return;
        }
        setAttachmentDraftRecoveryState(key, {
          phase: "failed",
          message: `附件草稿恢复失败：${errorMessage(error)}`,
        });
      } finally {
        if (
          attachmentDraftRecoveryControllersRef.current.get(key) === controller
        ) {
          attachmentDraftRecoveryControllersRef.current.delete(key);
        }
      }
    },
    [
      abortAttachmentUpload,
      revokeAttachmentPreview,
      setAttachmentDraftError,
      setAttachmentDraftRecoveryState,
      updateAttachmentDraft,
    ],
  );

  const discardAttachmentDraftScope = useCallback(
    (key: string, scope: ComposerDraftScope, userId: string) => {
      attachmentDraftRecoveryControllersRef.current.get(key)?.abort();
      attachmentDraftRecoveryControllersRef.current.delete(key);

      const attachmentIds = new Set<string>();
      for (const attachment of attachmentDraftsRef.current[key] ?? []) {
        if (
          attachment.status === "uploaded" ||
          attachment.status === "deleting"
        ) {
          attachmentIds.add(attachment.attachment.id);
        }
      }
      const stored = readComposerAttachmentDraftScope(
        window.localStorage,
        userId,
        scope,
      );
      if (stored.status === "ok" || stored.status === "warning") {
        for (const draft of [...stored.active, ...stored.expired]) {
          attachmentIds.add(draft.attachment.id);
        }
      }

      const cleared = clearComposerAttachmentDraftScope(
        window.localStorage,
        userId,
        scope,
      );
      if (cleared.status !== "cleared") {
        setAttachmentDraftError(
          key,
          "未能完整清理浏览器中的附件草稿记录；服务器仍会按过期策略回收未发送文件。",
        );
      }
      clearLocalAttachmentDraft(key);
      for (const attachmentId of attachmentIds) {
        unpersistedAttachmentIdsRef.current.delete(attachmentId);
        void (async () => {
          try {
            const response = await deleteInputAttachment(attachmentId);
            if (response.deletion.attachmentId !== attachmentId) {
              throw new Error("删除附件返回了不一致的 attachmentId");
            }
          } catch (error) {
            if (
              error instanceof ApiClientError &&
              ((error.code === "NOT_FOUND" && error.status === 404) ||
                (error.code === "INVALID_REQUEST" && error.status === 409))
            ) {
              return;
            }
            setAttachmentDraftError(
              key,
              `附件草稿已从本地放弃，但服务器清理暂时失败：${errorMessage(error)}`,
            );
          }
        })();
      }
      setAttachmentDraftRecoveryState(key, { phase: "ready" });
    },
    [
      clearLocalAttachmentDraft,
      setAttachmentDraftError,
      setAttachmentDraftRecoveryState,
    ],
  );

  const uploadDraftInputAttachment = useCallback(
    async (
      key: string,
      draftAttachment: Extract<
        DraftInputAttachment,
        { status: "uploading" }
      >,
    ) => {
      const controller = new AbortController();
      attachmentUploadControllersRef.current.set(
        draftAttachment.clientId,
        controller,
      );
      try {
        const response = await uploadInputAttachment(
          draftAttachment.file,
          controller.signal,
        );
        if (
          attachmentUploadControllersRef.current.get(
            draftAttachment.clientId,
          ) !== controller
        ) {
          return;
        }
        updateAttachmentDraft(key, (current) =>
          replaceDraftInputAttachment(
            current,
            draftAttachment.clientId,
            {
              clientId: draftAttachment.clientId,
              name: response.attachment.name,
              mimeType: response.attachment.mimeType,
              sizeBytes: response.attachment.sizeBytes,
              previewUrl: draftAttachment.previewUrl,
              status: "uploaded",
              attachment: response.attachment,
            },
          ),
        );
        const userId = bootstrapRef.current?.user.id;
        const orderToken = attachmentDraftOrderTokensRef.current.get(
          draftAttachment.clientId,
        );
        const persistence =
          userId === undefined || orderToken === undefined
            ? { status: "invalid" as const }
            : writeComposerAttachmentDraft(window.localStorage, {
                userId,
                scope: composerDraftScopeForKey(key),
                attachment: response.attachment,
                expiresAt: response.expiresAt,
                orderToken,
              });
        if (persistence.status === "written") {
          unpersistedAttachmentIdsRef.current.delete(response.attachment.id);
        } else {
          unpersistedAttachmentIdsRef.current.add(response.attachment.id);
          setAttachmentDraftError(
            key,
            "附件已上传并可在本页发送，但浏览器未能保存附件草稿；刷新后它可能丢失。",
          );
        }
      } catch (error) {
        if (
          attachmentUploadControllersRef.current.get(
            draftAttachment.clientId,
          ) !== controller
        ) {
          return;
        }
        const failedAttachment = failedDraftInputAttachment(
          draftAttachment,
          isAbortError(error)
            ? "上传已中断，可以重试。"
            : errorMessage(error),
        );
        updateAttachmentDraft(key, (current) =>
          replaceDraftInputAttachment(
            current,
            draftAttachment.clientId,
            failedAttachment,
          ),
        );
      } finally {
        if (
          attachmentUploadControllersRef.current.get(
            draftAttachment.clientId,
          ) === controller
        ) {
          attachmentUploadControllersRef.current.delete(
            draftAttachment.clientId,
          );
        }
      }
    },
    [setAttachmentDraftError, updateAttachmentDraft],
  );

  const uploadUserMessageEditAttachment = useCallback(
    async (
      conversationId: string,
      messageId: string,
      draftAttachment: Extract<
        DraftInputAttachment,
        { status: "uploading" }
      >,
    ) => {
      const controller = new AbortController();
      attachmentUploadControllersRef.current.set(
        draftAttachment.clientId,
        controller,
      );
      try {
        const response = await uploadInputAttachment(
          draftAttachment.file,
          controller.signal,
        );
        if (
          attachmentUploadControllersRef.current.get(
            draftAttachment.clientId,
          ) !== controller
        ) {
          return;
        }
        mutateUserMessageEdit(conversationId, (current) => {
          if (current === null || current.messageId !== messageId) {
            return current;
          }
          return {
            ...current,
            newAttachments: replaceDraftInputAttachment(
              current.newAttachments,
              draftAttachment.clientId,
              {
                clientId: draftAttachment.clientId,
                name: response.attachment.name,
                mimeType: response.attachment.mimeType,
                sizeBytes: response.attachment.sizeBytes,
                previewUrl: draftAttachment.previewUrl,
                status: "uploaded",
                attachment: response.attachment,
              },
            ),
          };
        });
      } catch (error) {
        if (
          attachmentUploadControllersRef.current.get(
            draftAttachment.clientId,
          ) !== controller
        ) {
          return;
        }
        const failedAttachment = failedDraftInputAttachment(
          draftAttachment,
          isAbortError(error)
            ? "上传已中断，可以重试。"
            : errorMessage(error),
        );
        mutateUserMessageEdit(conversationId, (current) => {
          if (current === null || current.messageId !== messageId) {
            return current;
          }
          return {
            ...current,
            newAttachments: replaceDraftInputAttachment(
              current.newAttachments,
              draftAttachment.clientId,
              failedAttachment,
            ),
          };
        });
      } finally {
        if (
          attachmentUploadControllersRef.current.get(
            draftAttachment.clientId,
          ) === controller
        ) {
          attachmentUploadControllersRef.current.delete(
            draftAttachment.clientId,
          );
        }
      }
    },
    [mutateUserMessageEdit],
  );

  const releaseUserMessageEditLocalResources = useCallback(
    (edit: UserMessageEditState) => {
      for (const attachment of edit.newAttachments) {
        releaseDraftInputAttachmentResources(
          attachment,
          abortAttachmentUpload,
          revokeAttachmentPreview,
        );
      }
    },
    [abortAttachmentUpload, revokeAttachmentPreview],
  );

  const discardUserMessageEdit = useCallback(
    (conversationId: string) => {
      const edit = userMessageEditsRef.current[conversationId];
      if (edit === undefined) {
        return;
      }
      releaseUserMessageEditLocalResources(edit);
      mutateUserMessageEdit(conversationId, () => null);

      for (const attachment of edit.newAttachments) {
        if (attachment.status !== "uploaded") {
          continue;
        }
        void (async () => {
          try {
            const response = await deleteInputAttachment(
              attachment.attachment.id,
            );
            if (
              response.deletion.attachmentId !== attachment.attachment.id
            ) {
              throw new Error("删除附件返回了不一致的 attachmentId");
            }
          } catch (error) {
            setWorkspaceError(
              `未能清理编辑草稿附件 ${attachment.name}：${errorMessage(error)}`,
            );
          }
        })();
      }
    },
    [mutateUserMessageEdit, releaseUserMessageEditLocalResources],
  );

  const setActiveConversation = useCallback((conversationId: string | null) => {
    activeConversationIdRef.current = conversationId;
    setActiveConversationId(conversationId);
  }, []);

  const clearConversationSearchTarget = useCallback(() => {
    if (conversationSearchClearTimerRef.current !== null) {
      window.clearTimeout(conversationSearchClearTimerRef.current);
      conversationSearchClearTimerRef.current = null;
    }
    revealedConversationSearchRequestIdRef.current = null;
    setConversationSearchTarget(null);
  }, []);

  const requestComposerFocus = useCallback(() => {
    setComposerFocusRequestToken(nextChatComposerFocusRequestToken);
  }, []);

  const updateActivityView = useCallback(
    (
      conversationId: string | null,
      update: Partial<{ isOpen: boolean; runId: string | null }>,
    ) => {
      const conversationKey = conversationId ?? newConversationDraftKey;
      setActivityViews((current) =>
        updateConversationActivityView(current, conversationKey, update),
      );
    },
    [],
  );

  const closeActiveActivity = useCallback(() => {
    updateActivityView(activeConversationIdRef.current, { isOpen: false });
  }, [updateActivityView]);

  const handleOpenBackgroundRunCenter = useCallback(() => {
    setCitationSourcesView(null);
    closeActiveActivity();
    setIsBackgroundRunCenterOpen(true);
  }, [closeActiveActivity]);

  const closeCitationSources = useCallback(() => {
    setCitationSourcesView(null);
  }, []);

  const handleOpenCitationSources = useCallback<OpenCitationSources>(
    (messageId, citations, activeNumber, trigger) => {
      const conversationId = activeConversationIdRef.current;
      if (conversationId === null) {
        throw new Error("空会话不能打开回答来源");
      }
      const message = conversationStatesRef.current[
        conversationId
      ]?.messages.find((candidate) => candidate.id === messageId);
      if (message === undefined) {
        throw new Error(`当前会话缺少来源消息 ${messageId}`);
      }
      if (message.role !== "assistant") {
        throw new Error(`用户消息 ${messageId} 不能打开回答来源`);
      }

      citationSourcesReturnFocusRef.current = trigger;
      updateActivityView(conversationId, { isOpen: false });
      setCitationSourcesView({
        conversationId,
        messageId,
        citations,
        activeNumber,
      });
    },
    [updateActivityView],
  );

  const rememberActiveActivityTrigger = useCallback(() => {
    const activeElement = document.activeElement;
    activityReturnFocusRef.current =
      activeElement instanceof HTMLButtonElement && !activeElement.disabled
        ? activeElement
        : headerActivityButtonRef.current;
  }, []);

  const beginCreditMutation = useCallback(() => {
    const revision = nextCreditsRevision(creditMutationRevisionRef.current);
    creditMutationRevisionRef.current = revision;
    const operationRevision = nextCreditsRevision(
      creditOperationRevisionRef.current,
    );
    creditOperationRevisionRef.current = operationRevision;
    creditMutationOperationRevisionsRef.current.set(
      revision,
      operationRevision,
    );
    pendingCreditMutationRevisionsRef.current.add(revision);
    return revision;
  }, []);

  const beginCreditSnapshotOperation = useCallback(() => {
    if (pendingCreditMutationRevisionsRef.current.size > 0) {
      return null;
    }
    const revision = nextCreditsRevision(creditOperationRevisionRef.current);
    creditOperationRevisionRef.current = revision;
    return revision;
  }, []);

  const beginTerminalCreditSnapshotOperation = useCallback(
    (terminalEventId: string) => {
      if (
        pendingCreditMutationRevisionsRef.current.size > 0 ||
        !shouldCommitTerminalCredits(
          latestStartedCreditTerminalEventIdRef.current,
          terminalEventId,
        )
      ) {
        return null;
      }
      const revision = nextCreditsRevision(
        creditOperationRevisionRef.current,
      );
      creditOperationRevisionRef.current = revision;
      latestStartedCreditTerminalEventIdRef.current = terminalEventId;
      return revision;
    },
    [],
  );

  const commitMutationCredits = useCallback(
    (credits: BootstrapResponse["credits"], mutationRevision: number) => {
      const operationRevision =
        creditMutationOperationRevisionsRef.current.get(mutationRevision);
      if (operationRevision === undefined) {
        throw new Error(
          `积分 mutation ${mutationRevision} 缺少 operation revision`,
        );
      }
      if (
        !shouldCommitCreditMutationResponse({
          responseMutationRevision: mutationRevision,
          currentMutationRevision: creditMutationRevisionRef.current,
        }) ||
        !shouldCommitCreditOperationResponse({
          responseOperationRevision: operationRevision,
          currentOperationRevision: creditOperationRevisionRef.current,
          source: "local_mutation",
          hasPendingLocalMutation:
            pendingCreditMutationRevisionsRef.current.size > 0,
        })
      ) {
        return false;
      }
      nonTerminalCreditSnapshotRevisionRef.current = nextCreditsRevision(
        nonTerminalCreditSnapshotRevisionRef.current,
      );
      creditSnapshotRevisionRef.current = nextCreditsRevision(
        creditSnapshotRevisionRef.current,
      );
      setBootstrap((current) =>
        current === null ? current : { ...current, credits },
      );
      return true;
    },
    [],
  );

  const commitTerminalCredits = useCallback(
    (credits: BootstrapResponse["credits"]) => {
      creditSnapshotRevisionRef.current = nextCreditsRevision(
        creditSnapshotRevisionRef.current,
      );
      setBootstrap((current) =>
        current === null ? current : { ...current, credits },
      );
    },
    [],
  );

  const workspaceOperationIsCurrent = useCallback(
    (operationGeneration: number) =>
      workspaceGenerationIsCurrent(
        workspaceGenerationRef.current,
        operationGeneration,
      ),
    [],
  );

  const advanceFeedbackDataRevision = useCallback(() => {
    const nextRevision = feedbackDataRevisionRef.current + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      throw new Error("回答反馈数据 revision 已超出安全整数范围");
    }
    feedbackDataRevisionRef.current = nextRevision;
    return nextRevision;
  }, []);

  const conversationObservationRevision = useCallback(
    (conversationId: string) =>
      conversationObservationRevisionsRef.current.get(conversationId) ?? 0,
    [],
  );

  const advanceConversationObservationRevision = useCallback(
    (conversationId: string) => {
      const nextRevision =
        conversationObservationRevision(conversationId) + 1;
      if (!Number.isSafeInteger(nextRevision)) {
        throw new Error("会话观察 revision 已超出安全整数范围");
      }
      conversationObservationRevisionsRef.current.set(
        conversationId,
        nextRevision,
      );
      return nextRevision;
    },
    [conversationObservationRevision],
  );

  const advanceNavigationIntentRevision = useCallback(() => {
    const nextRevision = navigationIntentRevisionRef.current + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      throw new Error("导航意图 revision 已超出安全整数范围");
    }
    navigationIntentRevisionRef.current = nextRevision;
    return nextRevision;
  }, []);

  const navigateWithinWorkspace = useCallback(
    (href: string, method: "push" | "replace" = "push") => {
      advanceNavigationIntentRevision();
      router[method](href, { scroll: false });
    },
    [advanceNavigationIntentRevision, router],
  );

  useEffect(() => {
    const handlePopState = () => {
      advanceNavigationIntentRevision();
    };
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [advanceNavigationIntentRevision]);

  const navigateToConversation = useCallback(
    (
      conversationId: string | null,
      method: "push" | "replace" = "push",
    ) => {
      const href =
        conversationId === null ? "/" : conversationRoute(conversationId);
      navigateWithinWorkspace(href, method);
    },
    [navigateWithinWorkspace],
  );

  const setRunReplayState = useCallback(
    (runId: string, replayState: RunEventReplayState) => {
      if (replayState === "not_loaded") {
        runReplayStatesRef.current.delete(runId);
      } else {
        runReplayStatesRef.current.set(runId, replayState);
      }
      setRunReplayStates((current) => {
        const currentState = current[runId] ?? "not_loaded";
        if (currentState === replayState) {
          return current;
        }
        if (replayState === "not_loaded") {
          const next = { ...current };
          delete next[runId];
          return next;
        }
        return { ...current, [runId]: replayState };
      });
    },
    [],
  );

  const setRunEventConnectionState = useCallback(
    (runId: string, connectionState: RunEventConnectionState) => {
      if (connectionState.phase === "idle") {
        runEventConnectionStatesRef.current.delete(runId);
      } else {
        runEventConnectionStatesRef.current.set(runId, connectionState);
      }
      setRunEventConnectionStates((current) => {
        const currentState =
          current[runId] ?? idleRunEventConnectionState;
        if (sameRunEventConnectionState(currentState, connectionState)) {
          return current;
        }
        if (connectionState.phase === "idle") {
          const next = { ...current };
          delete next[runId];
          return next;
        }
        return { ...current, [runId]: connectionState };
      });
    },
    [],
  );

  const summaryAtAcknowledgedReadWatermark = useCallback(
    (conversation: ConversationSummary) =>
      conversationSummaryAtReadWatermark(
        conversation,
        conversationReadWatermarksRef.current.get(conversation.id) ?? null,
      ),
    [],
  );

  const commitConversationSummary = useCallback(
    (
      conversation: ConversationSummary,
      terminalRunId?: string,
      refreshConversationBrowser = true,
    ) => {
      const visibleConversation =
        summaryAtAcknowledgedReadWatermark(conversation);
      setBootstrap((current) => {
        if (current === null) {
          return current;
        }
        const currentConversation = current.conversations.find(
          (candidate) => candidate.id === visibleConversation.id,
        );
        const mergedConversation =
          terminalRunId === undefined
            ? visibleConversation
            : mergeTerminalConversationSummary(
                currentConversation,
                visibleConversation,
                terminalRunId,
              );
        return {
          ...current,
          conversations:
            visibleConversation.archivedAt === null
              ? upsertConversationSummary(
                  current.conversations,
                  mergedConversation,
                )
              : removeConversationSummary(
                  current.conversations,
                  visibleConversation.id,
                ),
        };
      });
      setDetachedConversation((current) =>
        current?.id === visibleConversation.id
          ? visibleConversation.archivedAt === null
            ? null
            : visibleConversation
          : current,
      );
      if (refreshConversationBrowser) {
        setConversationBrowserVersion((current) => current + 1);
      }
    },
    [summaryAtAcknowledgedReadWatermark],
  );

  const markConversationRead = useCallback(
    async (
      conversationId: string,
      terminalRunId: string,
      terminalEventId: string,
      signal?: AbortSignal,
    ) => {
      if (signal?.aborted) {
        return;
      }
      const workspaceGeneration = workspaceGenerationRef.current;
      const operationIsCurrent = () =>
        !signal?.aborted && workspaceOperationIsCurrent(workspaceGeneration);
      const requestedEventId = markReadRequestsRef.current.get(conversationId);
      if (
        requestedEventId !== undefined &&
        BigInt(requestedEventId) >= BigInt(terminalEventId)
      ) {
        return;
      }
      markReadRequestsRef.current.set(conversationId, terminalEventId);
      const observationRevision =
        conversationObservationRevision(conversationId);

      try {
        const response = await patchConversation(
          conversationId,
          {
            action: "mark_read",
            throughEventId: terminalEventId,
          },
          signal,
        );
        if (!operationIsCurrent()) {
          return;
        }
        if (response.conversation.id !== conversationId) {
          throw new Error("标记已读返回了不一致的 conversationId");
        }
        workspaceCrossTabChannelRef.current?.postMessage(
          workspaceBootstrapChangedMessage,
        );
        setRunCompletionNotifications((current) =>
          dismissRunCompletionNotification(current, {
            conversationId,
            runId: terminalRunId,
          }),
        );
        const acknowledgedEventId = advanceConversationRefreshFence(
          conversationReadWatermarksRef.current.get(conversationId) ?? null,
          terminalEventId,
        );
        conversationReadWatermarksRef.current.set(
          conversationId,
          acknowledgedEventId,
        );
        if (
          markReadRequestsRef.current.get(conversationId) === terminalEventId
        ) {
          if (
            conversationObservationRevision(conversationId) ===
              observationRevision
          ) {
            commitConversationSummary(response.conversation, terminalRunId);
          } else {
            setBootstrap((current) =>
              current === null
                ? current
                : {
                    ...current,
                    conversations: current.conversations.map((conversation) =>
                      conversation.id === conversationId
                        ? summaryAtAcknowledgedReadWatermark(conversation)
                        : conversation,
                    ),
                  },
            );
            setDetachedConversation((current) =>
              current?.id === conversationId
                ? summaryAtAcknowledgedReadWatermark(current)
                : current,
            );
          }
        }
      } catch (error) {
        if (!operationIsCurrent() || isAbortError(error)) {
          return;
        }
        if (
          markReadRequestsRef.current.get(conversationId) === terminalEventId
        ) {
          dispatchConversation({
            type: "set_error",
            conversationId,
            message: errorMessage(error),
          });
        }
      } finally {
        if (
          markReadRequestsRef.current.get(conversationId) === terminalEventId
        ) {
          markReadRequestsRef.current.delete(conversationId);
        }
      }
    },
    [
      commitConversationSummary,
      conversationObservationRevision,
      summaryAtAcknowledgedReadWatermark,
      workspaceOperationIsCurrent,
    ],
  );

  const refreshAfterRun = useCallback(async (
    conversationId: string,
    terminalRunId: string,
    terminalEventId: string,
    signal: AbortSignal,
  ) => {
    const observationRevision =
      conversationObservationRevision(conversationId);
    const creditMutationRevisionAtRefreshStart =
      creditMutationRevisionRef.current;
    const nonTerminalCreditSnapshotRevisionAtRefreshStart =
      nonTerminalCreditSnapshotRevisionRef.current;
    let conversationFeedbackDataRevision: number | null = null;
    const refreshFence = advanceConversationRefreshFence(
      conversationRefreshFencesRef.current.get(conversationId) ?? null,
      terminalEventId,
    );
    conversationRefreshFencesRef.current.set(conversationId, refreshFence);
    if (
      signal.aborted ||
      !conversationRefreshIsCurrent(refreshFence, terminalEventId)
    ) {
      return;
    }
    const creditOperationRevisionAtRefreshStart =
      beginTerminalCreditSnapshotOperation(terminalEventId);

    const refreshIsCurrent = () => {
      const currentFence = conversationRefreshFencesRef.current.get(
        conversationId,
      );
      return (
        !signal.aborted &&
        currentFence !== undefined &&
        conversationRefreshIsCurrent(currentFence, terminalEventId)
      );
    };

    await refreshTerminalSources({
      signal,
      isCurrent: refreshIsCurrent,
      shouldRefreshBootstrap: () =>
        creditOperationRevisionAtRefreshStart !== null &&
        shouldCommitCreditOperationResponse({
          responseOperationRevision: creditOperationRevisionAtRefreshStart,
          currentOperationRevision: creditOperationRevisionRef.current,
          source: "snapshot",
          hasPendingLocalMutation:
            pendingCreditMutationRevisionsRef.current.size > 0,
        }) &&
        shouldCommitTerminalCreditsAtRevision({
          latestCommittedTerminalEventId:
            latestCreditTerminalEventIdRef.current,
          terminalEventId,
          creditMutationRevisionAtRefreshStart,
          currentCreditMutationRevision: creditMutationRevisionRef.current,
          nonTerminalCreditSnapshotRevisionAtRefreshStart,
          currentNonTerminalCreditSnapshotRevision:
            nonTerminalCreditSnapshotRevisionRef.current,
        }),
      loadConversation: (refreshSignal) => {
        conversationFeedbackDataRevision = advanceFeedbackDataRevision();
        return getConversation(conversationId, refreshSignal);
      },
      loadBootstrap: getBootstrap,
      commitConversation: (detail) => {
        if (conversationFeedbackDataRevision === null) {
          throw new Error("会话刷新结果缺少回答反馈数据 revision");
        }
        if (
          conversationObservationRevision(conversationId) !==
          observationRevision
        ) {
          return;
        }
        advanceConversationObservationRevision(conversationId);
        dispatchConversation({
          type: "load_succeeded",
          conversationId,
          detail,
          feedbackDataRevision: conversationFeedbackDataRevision,
        });
        const visibleConversation = summaryAtAcknowledgedReadWatermark(
          detail.conversation,
        );
        setBootstrap((current) =>
          current === null
            ? current
            : {
                ...current,
                conversations: upsertConversationSummary(
                  current.conversations,
                  mergeTerminalConversationSummary(
                    current.conversations.find(
                      (conversation) =>
                        conversation.id === visibleConversation.id,
                    ),
                    visibleConversation,
                    terminalRunId,
                  ),
                ),
              },
        );
        setConversationBrowserVersion((current) => current + 1);
      },
      commitBootstrap: (nextBootstrap) => {
        latestCreditTerminalEventIdRef.current = terminalEventId;
        commitTerminalCredits(nextBootstrap.credits);
      },
      isRetryable: isTransientApiError,
      waitBeforeRetry: (_source, consecutiveFailures, refreshSignal) =>
        abortableDelay(
          runEventRetryDelayMs(consecutiveFailures),
          refreshSignal,
        ),
      onPermanentFailure: (_source, error) => {
        dispatchConversation({
          type: "set_error",
          conversationId,
          message: errorMessage(error),
        });
      },
    });
  }, [
    advanceConversationObservationRevision,
    advanceFeedbackDataRevision,
    beginTerminalCreditSnapshotOperation,
    commitTerminalCredits,
    conversationObservationRevision,
    summaryAtAcknowledgedReadWatermark,
  ]);

  const scheduleRunTerminalFollowUp = useCallback(
    (input: {
      conversationId: string;
      runId: string;
      terminalEventId: string;
      outcome: RunCompletionOutcome;
    }) => {
      const existing = runTerminalFollowUpsRef.current.get(input.runId);
      if (existing !== undefined) {
        if (
          existing.conversationId === input.conversationId &&
          existing.terminalEventId === input.terminalEventId
        ) {
          return;
        }
        throw new Error(`Run ${input.runId} 存在冲突的终态后续操作`);
      }

      const controller = new AbortController();
      const followUp: RunTerminalFollowUp = {
        conversationId: input.conversationId,
        controller,
        terminalEventId: input.terminalEventId,
      };
      const workspaceGeneration = workspaceGenerationRef.current;
      const operationIsCurrent = () =>
        !controller.signal.aborted &&
        workspaceOperationIsCurrent(workspaceGeneration);
      runTerminalFollowUpsRef.current.set(input.runId, followUp);

      void (async () => {
        const resultIsVisible = shouldMarkConversationRead({
          activeConversationId: activeConversationIdRef.current,
          conversationId: input.conversationId,
          visibilityState: document.visibilityState,
        });
        if (resultIsVisible) {
          await markConversationRead(
            input.conversationId,
            input.runId,
            input.terminalEventId,
            controller.signal,
          );
        } else if (
          operationIsCurrent() &&
          !dismissedRunCompletionRunIdsRef.current.has(input.runId)
        ) {
          const conversation = requiredConversationSummary(
            bootstrapRef.current,
            detachedConversationRef.current,
            input.conversationId,
          );
          setRunCompletionNotifications((current) =>
            enqueueRunCompletionNotification(current, {
              conversationId: input.conversationId,
              runId: input.runId,
              title: conversation.title,
              outcome: input.outcome,
            }),
          );
        }

        if (!operationIsCurrent()) {
          return;
        }
        await refreshAfterRun(
          input.conversationId,
          input.runId,
          input.terminalEventId,
          controller.signal,
        );
      })()
        .catch((error: unknown) => {
          if (!operationIsCurrent() || isAbortError(error)) {
            return;
          }
          dispatchConversation({
            type: "set_error",
            conversationId: input.conversationId,
            message: errorMessage(error),
          });
        })
        .finally(() => {
          if (
            runTerminalFollowUpsRef.current.get(input.runId) === followUp
          ) {
            runTerminalFollowUpsRef.current.delete(input.runId);
          }
        });
    },
    [markConversationRead, refreshAfterRun, workspaceOperationIsCurrent],
  );

  const stopRunSubscriptionForRoleChange = useCallback(
    (
      runId: string,
      subscription: RunSubscription,
      requestResubscribe: boolean,
    ): boolean => {
      if (
        runSubscriptionsRef.current.get(runId)?.controller !==
        subscription.controller
      ) {
        return false;
      }

      runSubscriptionsRef.current.delete(runId);
      runEventBuffersRef.current.get(runId)?.discardPending();
      subscription.controller.abort();
      if (runSubscriptionPresentsConnectionState(subscription.role)) {
        setRunReplayState(runId, "not_loaded");
        setRunEventConnectionState(runId, idleRunEventConnectionState);
      }
      if (requestResubscribe) {
        setRunSubscriptionContextRevision((current) => current + 1);
      }
      return true;
    },
    [setRunEventConnectionState, setRunReplayState],
  );

  const ensureRunSubscription = useCallback(
    (
      conversationId: string,
      runId: string,
      intent: RunSubscriptionIntent,
      seed?: RunSubscriptionSeed,
    ) => {
      const conversationState = conversationStatesRef.current[conversationId];
      const existingEvents =
        seed?.existingEvents ?? eventsForRun(conversationState, runId);
      const knownRun =
        seed?.knownRun ?? conversationState?.runs.find((run) => run.id === runId);
      const knownConversation =
        seed?.knownConversation ??
        findBootstrapConversation(bootstrapRef.current, conversationId);
      if (
        (knownRun?.status === "running" && knownRun.startedAt !== null) ||
        (knownConversation?.activeRun?.id === runId &&
          knownConversation.activeRun.status === "running" &&
          knownConversation.activeRun.startedAt !== null)
      ) {
        runsWithObservedRunningStatusRef.current.add(runId);
      }
      const existingSubscription = runSubscriptionsRef.current.get(runId);
      let subscriptionMode =
        existingSubscription === undefined
          ? runEventSubscriptionMode(
              knownRun,
              existingEvents,
              intent === "active"
                ? "not_loaded"
                : runReplayStatesRef.current.get(runId) ?? "not_loaded",
            )
          : connectionModeForRunSubscriptionRole(existingSubscription.role);

      if (intent === "active" && subscriptionMode !== "follow") {
        return;
      }
      if (
        existingSubscription === undefined &&
        intent === "activity" &&
        !shouldSubscribeToRun(
          knownRun,
          existingEvents,
          runReplayStatesRef.current.get(runId) ?? "not_loaded",
        )
      ) {
        return;
      }
      if (subscriptionMode === "none") {
        throw new Error(`Run ${runId} 订阅模式与订阅请求不一致`);
      }

      const role = runSubscriptionRole({
        mode: subscriptionMode,
        conversationId,
        activeConversationId: activeConversationIdRef.current,
        visibilityState: document.visibilityState,
      });
      const replayState =
        runReplayStatesRef.current.get(runId) ?? "not_loaded";
      if (!runSubscriptionUsesEventStream(role)) {
        if (intent === "active" && replayState === "failed") {
          setRunReplayState(runId, "not_loaded");
          setRunEventConnectionState(runId, idleRunEventConnectionState);
        }
        if (existingSubscription !== undefined) {
          stopRunSubscriptionForRoleChange(
            runId,
            existingSubscription,
            false,
          );
        }
        return;
      }
      if (existingSubscription === undefined && intent === "active") {
        if (replayState !== "not_loaded") {
          return;
        }
      }

      if (existingSubscription !== undefined) {
        const transition = runSubscriptionRoleTransition({
          currentRole: existingSubscription.role,
          nextRole: role,
          terminalEventReceived:
            existingSubscription.terminalEventReceived,
        });
        if (transition !== "restart") {
          return;
        }
        if (
          !stopRunSubscriptionForRoleChange(
            runId,
            existingSubscription,
            false,
          )
        ) {
          return;
        }
      }

      let eventBuffer = runEventBuffersRef.current.get(runId);
      if (eventBuffer === undefined) {
        eventBuffer = new RunEventFrameBuffer({
          runId,
          initialCommittedEventId: existingEvents.at(-1)?.id ?? null,
          requestFrame: (callback) =>
            window.requestAnimationFrame(() => callback()),
          cancelFrame: (handle) => window.cancelAnimationFrame(handle),
          onFlush: (observations) => {
            const currentSubscription =
              runSubscriptionsRef.current.get(runId);
            if (currentSubscription === undefined) {
              return false;
            }
            const realtimeRole = runSubscriptionRole({
              mode: connectionModeForRunSubscriptionRole(
                currentSubscription.role,
              ),
              conversationId,
              activeConversationId: activeConversationIdRef.current,
              visibilityState: document.visibilityState,
            });
            const transition = runSubscriptionRoleTransition({
              currentRole: currentSubscription.role,
              nextRole: realtimeRole,
              terminalEventReceived:
                currentSubscription.terminalEventReceived,
            });
            if (transition !== "retain") {
              if (transition === "restart") {
                stopRunSubscriptionForRoleChange(
                  runId,
                  currentSubscription,
                  true,
                );
              }
              return false;
            }
            dispatchConversation({
              type: "run_events_received",
              conversationId,
              observations,
            });
            return true;
          },
        });
        runEventBuffersRef.current.set(runId, eventBuffer);
      }

      const lastCommittedOrObservedEventId = eventBuffer.beginSubscription();
      subscriptionMode = connectionModeForRunSubscriptionRole(role);

      const controller = new AbortController();
      runSubscriptionsRef.current.set(runId, {
        conversationId,
        controller,
        role,
        terminalEventReceived: false,
      });
      const presentsConnectionState =
        runSubscriptionPresentsConnectionState(role);
      const commitsEvents = runSubscriptionCommitsEvents(role);
      if (presentsConnectionState) {
        setRunReplayState(runId, "replaying");
        setRunEventConnectionState(runId, {
          phase: "connecting",
          mode: subscriptionMode,
        });
      }
      let replayLoaded = false;
      let replayFailed = false;
      let replayFailureMessage: string | null = null;
      let streamFeedbackDataRevision: number | null = null;

      const updateConnectionState = (
        connectionState: RunEventConnectionState,
      ) => {
        if (
          presentsConnectionState &&
          !controller.signal.aborted &&
          runSubscriptionsRef.current.get(runId)?.controller === controller
        ) {
          setRunEventConnectionState(runId, connectionState);
        }
      };

      void (async () => {
        let lastEventId = lastCommittedOrObservedEventId;
        let terminalReceived = false;
        let consecutiveFailures = 0;

        while (!controller.signal.aborted && !terminalReceived) {
          try {
            for await (const event of readRunEventStreamWithReconnect({
              initialLastEventId: lastEventId,
              openStream: async (resumeAfterEventId) => {
                streamFeedbackDataRevision = advanceFeedbackDataRevision();
                const stream = await openRunEventStream(
                  runId,
                  controller.signal,
                  resumeAfterEventId,
                );
                updateConnectionState({
                  phase: "connected",
                  mode: subscriptionMode,
                });
                return stream;
              },
              beforeReconnect: async () => {
                if (commitsEvents) {
                  eventBuffer.flush();
                }
                consecutiveFailures += 1;
                const retryDelayMs = runEventRetryDelayMs(
                  consecutiveFailures,
                );
                updateConnectionState(
                  reconnectingRunEventConnectionState({
                    mode: subscriptionMode,
                    attempt: consecutiveFailures,
                    retryDelayMs,
                  }),
                );
                await abortableDelay(
                  retryDelayMs,
                  controller.signal,
                );
              },
            })) {
              const currentSubscription =
                runSubscriptionsRef.current.get(runId);
              if (
                controller.signal.aborted ||
                currentSubscription?.controller !== controller
              ) {
                return;
              }
              const realtimeRole = runSubscriptionRole({
                mode: subscriptionMode,
                conversationId,
                activeConversationId: activeConversationIdRef.current,
                visibilityState: document.visibilityState,
              });
              const realtimeTransition = runSubscriptionRoleTransition({
                currentRole: role,
                nextRole: realtimeRole,
                terminalEventReceived:
                  currentSubscription.terminalEventReceived,
              });
              if (realtimeTransition !== "retain") {
                if (realtimeTransition === "restart") {
                  stopRunSubscriptionForRoleChange(
                    runId,
                    currentSubscription,
                    true,
                  );
                }
                return;
              }
              consecutiveFailures = 0;
              if (streamFeedbackDataRevision === null) {
                throw new Error(
                  `Run ${runId} 事件缺少回答反馈数据 revision`,
                );
              }
              try {
                const cursor = eventBuffer.observe(
                  {
                    event,
                    feedbackDataRevision: streamFeedbackDataRevision,
                  },
                  commitsEvents,
                );
                lastEventId = cursor.observedEventId;
              } catch (error) {
                throw new RunEventProtocolError(errorMessage(error), {
                  cause: error,
                });
              }

              if (event.payload.type === "status") {
                const summary =
                  findBootstrapConversation(
                    bootstrapRef.current,
                    conversationId,
                  ) ?? knownConversation;
                if (
                  role !== "replay_once" &&
                  !runsWithObservedRunningStatusRef.current.has(runId) &&
                  statusEventAdvancesConversationObservation({
                    runId,
                    backgroundRunStatus: null,
                    conversation: summary,
                  })
                ) {
                  runsWithObservedRunningStatusRef.current.add(runId);
                  advanceConversationObservationRevision(conversationId);
                }
                setBootstrap((current) => {
                  if (current === null) {
                    return current;
                  }
                  let changed = false;
                  const conversations = current.conversations.map(
                    (conversation) => {
                      if (
                        conversation.id !== conversationId ||
                        conversation.activeRun?.id !== runId ||
                        (conversation.activeRun.status === "running" &&
                          conversation.activeRun.startedAt !== null)
                      ) {
                        return conversation;
                      }
                      changed = true;
                      return {
                        ...conversation,
                        activeRun: {
                          id: runId,
                          status: "running" as const,
                          startedAt:
                            conversation.activeRun.startedAt ?? event.createdAt,
                        },
                      };
                    },
                  );
                  if (!changed) {
                    return current;
                  }
                  return {
                    ...current,
                    conversations,
                  };
                });
              }

              if (
                event.payload.type === "done" ||
                event.payload.type === "error"
              ) {
                if (role !== "replay_once") {
                  advanceConversationObservationRevision(conversationId);
                }
                if (
                  !markCurrentRunSubscriptionTerminalEvent({
                    current: runSubscriptionsRef.current.get(runId),
                    controller,
                  })
                ) {
                  return;
                }
                terminalReceived = true;
                setBootstrap((current) =>
                  current === null
                    ? current
                    : {
                        ...current,
                        conversations: current.conversations.map(
                          (conversation) =>
                            conversation.id === conversationId &&
                            conversation.activeRun?.id === runId
                              ? { ...conversation, activeRun: null }
                              : conversation,
                        ),
                      },
                );
                if (role !== "replay_once") {
                  setCancellingRunIds((current) => {
                    if (!current.has(runId)) {
                      return current;
                    }
                    const next = new Set(current);
                    next.delete(runId);
                    return next;
                  });
                }
                if (commitsEvents) {
                  eventBuffer.flush();
                }
                if (
                  !releaseCurrentTerminalRunSubscription({
                    subscriptions: runSubscriptionsRef.current,
                    runId,
                    controller,
                  })
                ) {
                  return;
                }
                if (presentsConnectionState) {
                  setRunReplayState(runId, "loaded");
                  setRunEventConnectionState(
                    runId,
                    idleRunEventConnectionState,
                  );
                }
                setRunSubscriptionContextRevision((current) => current + 1);
                if (role !== "replay_once") {
                  scheduleRunTerminalFollowUp({
                    conversationId,
                    runId,
                    terminalEventId: event.id,
                    outcome: runCompletionOutcomeForEvent(event),
                  });
                }
                return;
              }
            }

            if (commitsEvents) {
              eventBuffer.flush();
            }
            if (terminalReceived) {
              replayLoaded = commitsEvents;
            } else if (
              role === "replay_once" &&
              !controller.signal.aborted
            ) {
              replayLoaded = true;
              break;
            } else if (!controller.signal.aborted) {
              consecutiveFailures += 1;
              const retryDelayMs = runEventRetryDelayMs(
                consecutiveFailures,
              );
              updateConnectionState(
                reconnectingRunEventConnectionState({
                  mode: subscriptionMode,
                  attempt: consecutiveFailures,
                  retryDelayMs,
                }),
              );
              await abortableDelay(retryDelayMs, controller.signal);
            }
          } catch (error) {
            if (isAbortError(error)) {
              return;
            }
            if (
              controller.signal.aborted ||
              runSubscriptionsRef.current.get(runId)?.controller !== controller
            ) {
              return;
            }
            if (
              commitsEvents &&
              runSubscriptionsRef.current.get(runId)?.controller === controller
            ) {
              eventBuffer.flush();
            }
            if (isRetryableRunEventError(error)) {
              consecutiveFailures += 1;
              const retryDelayMs = runEventRetryDelayMs(
                consecutiveFailures,
              );
              updateConnectionState(
                reconnectingRunEventConnectionState({
                  mode: subscriptionMode,
                  attempt: consecutiveFailures,
                  retryDelayMs,
                }),
              );
              try {
                await abortableDelay(
                  retryDelayMs,
                  controller.signal,
                );
              } catch (retryDelayError) {
                if (isAbortError(retryDelayError)) {
                  return;
                }
                throw retryDelayError;
              }
              continue;
            }
            replayFailed = true;
            replayFailureMessage = errorMessage(error);
            if (presentsConnectionState) {
              dispatchConversation({
                type: "set_error",
                conversationId,
                message: replayFailureMessage,
              });
            }
            return;
          }
        }
      })().finally(() => {
        const active = runSubscriptionsRef.current.get(runId);
        if (active?.controller !== controller) {
          return;
        }
        const terminalEventReceived = active.terminalEventReceived;
        runSubscriptionsRef.current.delete(runId);
        if (commitsEvents && !controller.signal.aborted) {
          eventBuffer.flush();
        }
        const finalReplayState = runReplayStatesRef.current.get(runId);
        if (
          presentsConnectionState &&
          !controller.signal.aborted &&
          finalReplayState === "replaying"
        ) {
          setRunReplayState(
            runId,
            replayFailed ? "failed" : replayLoaded ? "loaded" : "not_loaded",
          );
        }
        if (presentsConnectionState && !controller.signal.aborted) {
          setRunEventConnectionState(
            runId,
            replayFailureMessage === null
              ? idleRunEventConnectionState
              : {
                  phase: "failed",
                  mode: subscriptionMode,
                  message: replayFailureMessage,
                },
          );
        }
        if (terminalEventReceived && !controller.signal.aborted) {
          setRunSubscriptionContextRevision((current) => current + 1);
        }
      });
    },
    [
      advanceConversationObservationRevision,
      advanceFeedbackDataRevision,
      scheduleRunTerminalFollowUp,
      setRunEventConnectionState,
      setRunReplayState,
      stopRunSubscriptionForRoleChange,
    ],
  );

  const loadConversation = useCallback(
    (
      conversationId: string,
      commitGuard?: () => boolean,
    ): Promise<ConversationLoadResult> => {
      if (commitGuard !== undefined && !commitGuard()) {
        return Promise.resolve({ status: "superseded" });
      }
      const requestedObservationRevision =
        conversationObservationRevision(conversationId);
      const previousOperation =
        conversationLoadOperationsRef.current.get(conversationId);
      if (previousOperation?.status === "pending") {
        previousOperation.controller.abort();
      }
      const controller = new AbortController();
      const operation: ConversationLoadOperation = {
        controller,
        promise: null,
        status: "pending",
      };
      conversationLoadOperationsRef.current.set(conversationId, operation);
      const feedbackDataRevision = advanceFeedbackDataRevision();
      dispatchConversation({ type: "load_started", conversationId });
      const loadFenceStatus = () => {
        const operationFenceStatus = conversationLoadFenceStatus({
          candidateRequest: operation,
          currentRequest:
            conversationLoadOperationsRef.current.get(conversationId),
          currentObservationRevision:
            conversationObservationRevision(conversationId),
          requestedObservationRevision,
        });
        return operationFenceStatus === "current" &&
          commitGuard !== undefined &&
          !commitGuard()
          ? "superseded"
          : operationFenceStatus;
      };
      const finishNonCurrentLoad = (
        status: "superseded" | "revision_changed",
      ): ConversationLoadResult => {
        if (status === "revision_changed") {
          dispatchConversation({
            type: "load_invalidated",
            conversationId,
          });
        } else if (
          commitGuard !== undefined &&
          conversationLoadOperationsRef.current.get(conversationId) ===
            operation &&
          !commitGuard()
        ) {
          dispatchConversation({
            type: "load_invalidated",
            conversationId,
          });
        }
        return { status };
      };

      const promise = (async (): Promise<ConversationLoadResult> => {
        try {
          const detail = await getConversation(
            conversationId,
            controller.signal,
          );
          const detailFenceStatus = loadFenceStatus();
          if (detailFenceStatus !== "current") {
            return finishNonCurrentLoad(detailFenceStatus);
          }
          if (
            detail.conversation.attention !== null &&
            shouldMarkConversationRead({
              activeConversationId: activeConversationIdRef.current,
              conversationId,
              visibilityState: document.visibilityState,
            })
          ) {
            await markConversationRead(
              conversationId,
              detail.conversation.attention.runId,
              detail.conversation.attention.terminalEventId,
            );
            const readFenceStatus = loadFenceStatus();
            if (readFenceStatus !== "current") {
              return finishNonCurrentLoad(readFenceStatus);
            }
          }
          const subscriptionRequests = loadedRunSubscriptionRequests(
            conversationStatesRef.current[conversationId],
            detail.runs,
            detail.conversation.selectedRunId,
            runReplayStatesRef.current,
          );
          const executionProfileScope =
            conversationComposerDraftScope(conversationId);
          const executionProfileCatalog =
            bootstrapRef.current?.executionProfiles;
          if (executionProfileCatalog === undefined) {
            throw new Error("加载会话时工作区缺少执行模式目录");
          }
          const storedExecutionProfile = readExecutionProfileDraft(
            window.localStorage,
            executionProfileScope,
            executionProfileCatalog,
          );
          const selectedRun = detail.runs.find(
            (run) => run.id === detail.conversation.selectedRunId,
          );
          const selectedRunExecutionProfile =
            selectedRun?.executionConfig.provenance === "captured"
              ? executionProfileDraftIdForCatalog(
                  selectedRun.executionConfig.executionProfileId,
                  executionProfileCatalog,
                )
              : null;
          const initialExecutionProfile =
            storedExecutionProfile ?? selectedRunExecutionProfile;
          if (initialExecutionProfile !== null) {
            setExecutionProfileDrafts((current) =>
              Object.hasOwn(current, conversationId)
                ? current
                : {
                    ...current,
                    [conversationId]: initialExecutionProfile,
                  },
            );
            if (storedExecutionProfile === null) {
              writeExecutionProfileDraft(
                window.localStorage,
                executionProfileScope,
                initialExecutionProfile,
              );
            }
          }
          dispatchConversation({
            type: "load_succeeded",
            conversationId,
            detail,
            feedbackDataRevision,
          });
          const visibleConversation = summaryAtAcknowledgedReadWatermark(
            detail.conversation,
          );
          if (visibleConversation.archivedAt === null) {
            setBootstrap((current) => {
              if (current === null) {
                return current;
              }
              return {
                ...current,
                conversations: upsertConversationSummary(
                  current.conversations,
                  visibleConversation,
                ),
              };
            });
            if (activeConversationIdRef.current === conversationId) {
              setDetachedConversation(null);
            }
          } else {
            setBootstrap((current) => {
              if (current === null) {
                return current;
              }
              return {
                ...current,
                conversations: removeConversationSummary(
                  current.conversations,
                  conversationId,
                ),
              };
            });
            if (activeConversationIdRef.current === conversationId) {
              setDetachedConversation(visibleConversation);
            }
          }
          for (const subscription of subscriptionRequests) {
            ensureRunSubscription(
              conversationId,
              subscription.run.id,
              subscription.intent,
              {
                knownRun: subscription.run,
                existingEvents: subscription.existingEvents,
              },
            );
          }
          return { status: "loaded", detail };
        } catch (error) {
          const errorFenceStatus = loadFenceStatus();
          if (errorFenceStatus !== "current") {
            return finishNonCurrentLoad(errorFenceStatus);
          }
          if (!isAbortError(error)) {
            dispatchConversation({
              type: "load_failed",
              conversationId,
              message: errorMessage(error),
            });
          }
          return {
            status:
              error instanceof ApiClientError &&
              error.code === "NOT_FOUND" &&
              error.status === 404
                ? "not_found"
                : "failed",
          };
        } finally {
          operation.status = "settled";
        }
      })();
      operation.promise = promise;
      return promise;
    },
    [
      ensureRunSubscription,
      markConversationRead,
      advanceFeedbackDataRevision,
      conversationObservationRevision,
      summaryAtAcknowledgedReadWatermark,
    ],
  );

  const retryConversationLoad = useCallback(
    (
      conversationId: string,
      state: ConversationViewState | undefined =
        conversationStatesRef.current[conversationId],
    ) => {
      if (
        !shouldRetryConversationLoad({
          activeConversationId: activeConversationIdRef.current,
          requestedConversationId: conversationId,
          state,
          hasInFlightRequest:
            conversationLoadOperationsRef.current.get(conversationId)
              ?.status === "pending",
        })
      ) {
        return false;
      }

      void loadConversation(conversationId);
      return true;
    },
    [loadConversation],
  );

  const loadConversationForStaleParent = useCallback(
    (conversationId: string): Promise<ConversationLoadResult> =>
      followSupersededConversationLoad(
        loadConversation(conversationId),
        () => {
          const latestOperation =
            conversationLoadOperationsRef.current.get(conversationId);
          return latestOperation?.promise ?? null;
        },
      ),
    [loadConversation],
  );

  const recoverChatSubmissionFailure = useCallback(
    async (input: {
      conversationId: string | null;
      error: unknown;
      pendingRequestKey: string;
      submittedRequest: ChatRequest;
    }): Promise<ChatSubmissionFailureResult> => {
      const currentPendingRequest = pendingChatRequestsRef.current.get(
        input.pendingRequestKey,
      );
      const recovery = chatSubmissionFailureRecovery({
        conversationId: input.conversationId,
        error: input.error,
        pendingRequest: currentPendingRequest,
        submittedRequestId: input.submittedRequest.requestId,
      });
      if (!recovery.shouldHandle) {
        return { handled: false };
      }
      if (
        currentPendingRequest !== undefined &&
        recovery.pendingRequest === undefined
      ) {
        pendingChatRequestsRef.current.delete(input.pendingRequestKey);
      }

      const execution = await executeChatSubmissionFailureRecovery(
        recovery,
        loadConversationForStaleParent,
      );
      if (execution === "reloaded") {
        return {
          handled: true,
          message: staleParentRecoveryMessage,
          reloadFailed: false,
        };
      }
      if (execution !== "not_requested") {
        return {
          handled: true,
          message: staleParentRecoveryFailedMessage,
          reloadFailed: true,
        };
      }
      return {
        handled: true,
        message: errorMessage(input.error),
        reloadFailed: false,
      };
    },
    [loadConversationForStaleParent],
  );

  const invalidateConversationPageLoad = useCallback(() => {
    conversationListGenerationRef.current += 1;
    conversationPageLoadOperationRef.current?.controller.abort();
    conversationPageLoadOperationRef.current = null;
    setIsLoadingMoreConversations(false);
    setConversationLoadMoreError(null);
  }, []);

  const loadMoreConversations = useCallback(async () => {
    const bootstrapAtRequestStart = bootstrapRef.current;
    const cursor = bootstrapAtRequestStart?.nextCursor ?? null;
    if (
      bootstrapAtRequestStart === null ||
      cursor === null ||
      conversationPageLoadOperationRef.current !== null
    ) {
      return;
    }

    const generation = conversationListGenerationRef.current;
    const loadedDepthAtRequestStart = conversationLoadedDepthRef.current;
    const controller = new AbortController();
    const operation: ConversationPageLoadOperation = {
      controller,
      cursor,
      generation,
    };
    const observationRevisionsAtRequestStart = new Map(
      conversationObservationRevisionsRef.current,
    );
    conversationPageLoadOperationRef.current = operation;
    setIsLoadingMoreConversations(true);
    setConversationLoadMoreError(null);

    try {
      const response = await listConversations(
        {
          view: "active",
          query: "",
          cursor,
          limit: conversationSidebarPageSize,
        },
        controller.signal,
      );
      if (
        conversationPageLoadOperationRef.current !== operation ||
        generation !== conversationListGenerationRef.current
      ) {
        return;
      }

      conversationLoadedDepthRef.current =
        advanceConversationLoadedDepth(
          loadedDepthAtRequestStart,
          response.items.length,
        );
      const incomingConversations = response.items.map((item) =>
        summaryAtAcknowledgedReadWatermark(
          conversationSummaryFromListItem(item),
        ),
      );
      setBootstrap((current) => {
        if (
          current === null ||
          generation !== conversationListGenerationRef.current ||
          current.nextCursor !== cursor
        ) {
          return current;
        }
        return {
          ...current,
          conversations: mergeConversationPageAtRevision({
            current: current.conversations,
            incoming: incomingConversations,
            atRequestStart: bootstrapAtRequestStart.conversations,
            revisionsAtRequestStart: observationRevisionsAtRequestStart,
            currentRevisions: conversationObservationRevisionsRef.current,
          }),
          nextCursor: response.nextCursor,
        };
      });

      for (const conversation of incomingConversations) {
        if (conversation.activeRun !== null) {
          ensureRunSubscription(
            conversation.id,
            conversation.activeRun.id,
            "active",
            { knownConversation: conversation },
          );
        }
      }
    } catch (error) {
      if (
        !isAbortError(error) &&
        conversationPageLoadOperationRef.current === operation &&
        generation === conversationListGenerationRef.current
      ) {
        setConversationLoadMoreError(errorMessage(error));
      }
    } finally {
      if (conversationPageLoadOperationRef.current === operation) {
        conversationPageLoadOperationRef.current = null;
        setIsLoadingMoreConversations(false);
      }
    }
  }, [ensureRunSubscription, summaryAtAcknowledgedReadWatermark]);

  const handleConfirmedRemoteConversationRemoval = useCallback(
    (conversationId: string) => {
      const currentConversations =
        bootstrapRef.current?.conversations ?? [];
      const removal = removeConversationAndSelectNext(
        currentConversations,
        conversationId,
      );
      const nextConversationId =
        removal.nextConversationId ??
        (currentConversations.some(
          (conversation) => conversation.id === conversationId,
        )
          ? null
          : currentConversations[0]?.id ?? null);

      setBootstrap((current) =>
        current === null
          ? current
          : {
              ...current,
              ...removeConversationFromSummarySources(
                current,
                conversationId,
              ),
            },
      );
      setDrafts((current) => {
        if (!Object.hasOwn(current, conversationId)) {
          return current;
        }
        const next = { ...current };
        delete next[conversationId];
        return next;
      });
      removeComposerDraft(
        window.localStorage,
        conversationComposerDraftScope(conversationId),
      );
      removeExecutionProfileDraft(
        window.localStorage,
        conversationComposerDraftScope(conversationId),
      );
      setExecutionProfileDrafts((current) => {
        if (!Object.hasOwn(current, conversationId)) {
          return current;
        }
        const next = { ...current };
        delete next[conversationId];
        return next;
      });
      const userId = bootstrapRef.current?.user.id;
      if (userId === undefined) {
        clearLocalAttachmentDraft(conversationId);
      } else {
        discardAttachmentDraftScope(
          conversationId,
          conversationComposerDraftScope(conversationId),
          userId,
        );
      }
      setDetachedConversation((current) =>
        current?.id === conversationId ? null : current,
      );
      setConversationBrowserVersion((current) => current + 1);

      if (activeConversationIdRef.current !== conversationId) {
        return;
      }
      setActiveConversation(nextConversationId);
      navigateToConversation(nextConversationId, "replace");
      if (nextConversationId !== null) {
        void loadConversation(nextConversationId);
      }
    },
    [
      clearLocalAttachmentDraft,
      discardAttachmentDraftScope,
      loadConversation,
      navigateToConversation,
      setActiveConversation,
    ],
  );

  const initialize = useCallback(async () => {
    invalidateConversationPageLoad();
    bootstrapAbortRef.current?.abort();
    const controller = new AbortController();
    bootstrapAbortRef.current = controller;
    const bootstrapAtRequestStart = bootstrapRef.current;
    const loadedDepthAtRequestStart = conversationLoadedDepthRef.current;
    const observationRevisionsAtRequestStart = new Map(
      conversationObservationRevisionsRef.current,
    );
    setIsBootstrapping(true);
    setFatalError(null);
    setWorkspaceError(null);
    setActivityViews({});
    for (const conversationId of Object.keys(userMessageEditsRef.current)) {
      discardUserMessageEdit(conversationId);
    }

    try {
      const data = await getBootstrap(controller.signal);
      if (bootstrapAbortRef.current !== controller) {
        return;
      }
      let incomingConversations = data.conversations.map(
        summaryAtAcknowledgedReadWatermark,
      );
      let incomingNextCursor = data.nextCursor;
      while (incomingNextCursor !== null) {
        const pageLimit = conversationPageLimitToRestoreDepth({
          targetDepth: loadedDepthAtRequestStart,
          loadedCount: incomingConversations.length,
          pageSize: conversationSidebarPageSize,
        });
        if (pageLimit === null) {
          break;
        }
        const page = await listConversations(
          {
            view: "active",
            query: "",
            cursor: incomingNextCursor,
            limit: pageLimit,
          },
          controller.signal,
        );
        if (bootstrapAbortRef.current !== controller) {
          return;
        }
        incomingConversations = mergeConversationPage(
          incomingConversations,
          page.items.map((item) =>
            summaryAtAcknowledgedReadWatermark(
              conversationSummaryFromListItem(item),
            ),
          ),
        );
        incomingNextCursor = page.nextCursor;
      }
      const incomingTrackedConversations = data.trackedConversations.map(
        summaryAtAcknowledgedReadWatermark,
      );
      const normalizedData: BootstrapResponse = {
        ...data,
        conversations: incomingConversations,
        nextCursor: incomingNextCursor,
        trackedConversations: incomingTrackedConversations,
      };
      conversationLoadedDepthRef.current = incomingConversations.length;
      const activeConversationIdAtCommit = activeConversationIdRef.current;
      const currentActiveConversation =
        activeConversationIdAtCommit === null
          ? undefined
          : findBootstrapConversation(
              bootstrapAtRequestStart,
              activeConversationIdAtCommit,
            ) ??
            (detachedConversationRef.current?.id ===
            activeConversationIdAtCommit
              ? detachedConversationRef.current
              : undefined);
      const incomingActiveConversation =
        activeConversationIdAtCommit === null
          ? undefined
          : findBootstrapConversation(
              normalizedData,
              activeConversationIdAtCommit,
            );
      if (
        currentActiveConversation !== undefined &&
        incomingActiveConversation === undefined
      ) {
        setDetachedConversation(currentActiveConversation);
      } else if (
        incomingActiveConversation !== undefined &&
        incomingActiveConversation.archivedAt === null
      ) {
        setDetachedConversation(null);
      }
      setBootstrap((current) =>
        current === null || current === bootstrapAtRequestStart
          ? normalizedData
          : {
              ...normalizedData,
              credits: current.credits,
              conversations: mergeBootstrapConversationSummaries({
                current: current.conversations,
                incoming: incomingConversations,
                atRequestStart:
                  bootstrapAtRequestStart?.conversations ?? [],
                revisionsAtRequestStart:
                  observationRevisionsAtRequestStart,
                currentRevisions:
                  conversationObservationRevisionsRef.current,
                preserveIncomingConversationIds: new Set(),
              }),
              trackedConversations: mergeBootstrapConversationSummaries({
                current: current.trackedConversations,
                incoming: incomingTrackedConversations,
                atRequestStart:
                  bootstrapAtRequestStart?.trackedConversations ?? [],
                revisionsAtRequestStart:
                  observationRevisionsAtRequestStart,
                currentRevisions:
                  conversationObservationRevisionsRef.current,
                preserveIncomingConversationIds: new Set(),
              }),
            },
      );
      setIsBootstrapping(false);

      for (const conversation of bootstrapConversationSummaries(normalizedData)) {
        if (conversation.activeRun !== null) {
          ensureRunSubscription(
            conversation.id,
            conversation.activeRun.id,
            "active",
            { knownConversation: conversation },
          );
        }
      }
    } catch (error) {
      if (!isAbortError(error)) {
        setFatalError(errorMessage(error));
        setIsBootstrapping(false);
      }
    }
  }, [
    discardUserMessageEdit,
    ensureRunSubscription,
    invalidateConversationPageLoad,
    summaryAtAcknowledgedReadWatermark,
  ]);

  const revalidateBootstrap = useCallback(async (
    requestKind: BootstrapRevalidationRequestKind,
  ) => {
    const bootstrapAtRequestStart = bootstrapRef.current;
    if (bootstrapAtRequestStart === null) {
      return "ignored" as const;
    }
    const loadedDepthAtRequestStart = conversationLoadedDepthRef.current;

    if (requestKind === "full") {
      invalidateConversationPageLoad();
    }
    if (bootstrapRevalidationAbortRef.current !== null) {
      throw new Error("bootstrap revalidation 请求发生重叠");
    }
    const controller = new AbortController();
    bootstrapRevalidationAbortRef.current = controller;
    const observationRevisionsAtRequestStart = new Map(
      conversationObservationRevisionsRef.current,
    );
    const creditMutationRevisionAtRequestStart =
      creditMutationRevisionRef.current;
    const creditSnapshotRevisionAtRequestStart =
      creditSnapshotRevisionRef.current;
    const creditOperationRevisionAtRequestStart =
      beginCreditSnapshotOperation();
    const notificationsAtRequestStart =
      runCompletionNotificationsRef.current;

    try {
      const data = await getBootstrap(controller.signal);
      if (bootstrapRevalidationAbortRef.current !== controller) {
        return "ignored" as const;
      }

      let incomingConversations = data.conversations.map(
        summaryAtAcknowledgedReadWatermark,
      );
      let incomingNextCursor = data.nextCursor;
      while (requestKind === "full" && incomingNextCursor !== null) {
        const pageLimit = conversationPageLimitToRestoreDepth({
          targetDepth: loadedDepthAtRequestStart,
          loadedCount: incomingConversations.length,
          pageSize: conversationSidebarPageSize,
        });
        if (pageLimit === null) {
          break;
        }
        const page = await listConversations(
          {
            view: "active",
            query: "",
            cursor: incomingNextCursor,
            limit: pageLimit,
          },
          controller.signal,
        );
        if (bootstrapRevalidationAbortRef.current !== controller) {
          return "ignored" as const;
        }
        incomingConversations = mergeConversationPage(
          incomingConversations,
          page.items.map((item) =>
            summaryAtAcknowledgedReadWatermark(
              conversationSummaryFromListItem(item),
            ),
          ),
        );
        incomingNextCursor = page.nextCursor;
      }
      const incomingTrackedConversations = data.trackedConversations.map(
        summaryAtAcknowledgedReadWatermark,
      );
      const normalizedData: BootstrapResponse = {
        ...data,
        conversations: incomingConversations,
        nextCursor: incomingNextCursor,
        trackedConversations: incomingTrackedConversations,
      };
      const incomingObservedConversations =
        bootstrapConversationSummaries(normalizedData);
      const activeConversationIdAtCommit = activeConversationIdRef.current;
      const visibleIncomingConversations =
        document.visibilityState === "visible" &&
        activeConversationIdAtCommit !== null
          ? incomingObservedConversations.filter(
              (conversation) =>
                conversation.id === activeConversationIdAtCommit,
            )
          : [];
      const preserveIncomingConversationIds =
        await refreshIncompatibleBootstrapConversationDetails({
          conversations: visibleIncomingConversations,
          states: conversationStatesRef.current,
          loadConversation: (conversationId) =>
            loadConversation(
              conversationId,
              () =>
                visibleConversationDetailRefreshIsCurrent({
                  requestedConversationId: conversationId,
                  activeConversationId: activeConversationIdRef.current,
                  visibilityState: document.visibilityState,
                }),
            ),
        });
      if (bootstrapRevalidationAbortRef.current !== controller) {
        return "ignored" as const;
      }
      setRunCompletionNotifications((current) =>
        current === notificationsAtRequestStart
          ? reconcileRunCompletionNotifications(
              current,
              incomingObservedConversations,
              {
                baselineConversations: bootstrapConversationSummaries(
                  bootstrapAtRequestStart,
                ),
                dismissedRunIds: dismissedRunCompletionRunIdsRef.current,
                omitNewForConversationId:
                  document.visibilityState === "visible"
                    ? activeConversationIdRef.current
                    : null,
              },
            )
          : current,
      );
      const currentActiveConversation =
        activeConversationIdAtCommit === null
          ? undefined
          : findBootstrapConversation(
              bootstrapAtRequestStart,
              activeConversationIdAtCommit,
            ) ??
            (detachedConversationRef.current?.id ===
            activeConversationIdAtCommit
              ? detachedConversationRef.current
              : undefined);
      const incomingActiveConversation =
        activeConversationIdAtCommit === null
          ? undefined
          : findBootstrapConversation(
              normalizedData,
              activeConversationIdAtCommit,
            );
      if (requestKind === "full") {
        if (
          currentActiveConversation !== undefined &&
          incomingActiveConversation === undefined
        ) {
          setDetachedConversation(currentActiveConversation);
        } else if (
          incomingActiveConversation !== undefined &&
          incomingActiveConversation.archivedAt === null
        ) {
          setDetachedConversation(null);
        }
      }
      const commitIncomingCredits =
        creditOperationRevisionAtRequestStart !== null &&
        shouldCommitCreditOperationResponse({
          responseOperationRevision: creditOperationRevisionAtRequestStart,
          currentOperationRevision: creditOperationRevisionRef.current,
          source: "snapshot",
          hasPendingLocalMutation:
            pendingCreditMutationRevisionsRef.current.size > 0,
        }) &&
        creditMutationRevisionRef.current ===
          creditMutationRevisionAtRequestStart &&
        creditSnapshotRevisionRef.current ===
          creditSnapshotRevisionAtRequestStart;
      if (commitIncomingCredits) {
        nonTerminalCreditSnapshotRevisionRef.current = nextCreditsRevision(
          nonTerminalCreditSnapshotRevisionRef.current,
        );
        creditSnapshotRevisionRef.current = nextCreditsRevision(
          creditSnapshotRevisionRef.current,
        );
      }
      if (requestKind === "full") {
        conversationLoadedDepthRef.current = incomingConversations.length;
      }
      setBootstrap((current) => {
        if (current === null) {
          return current;
        }
        const conversations =
          requestKind === "full"
            ? mergeBootstrapConversationSummaries({
                current: current.conversations,
                incoming: incomingConversations,
                atRequestStart: bootstrapAtRequestStart.conversations,
                revisionsAtRequestStart:
                  observationRevisionsAtRequestStart,
                currentRevisions:
                  conversationObservationRevisionsRef.current,
                preserveIncomingConversationIds,
              })
            : mergeConversationPageAtRevision({
                current: current.conversations,
                incoming: incomingConversations,
                atRequestStart: bootstrapAtRequestStart.conversations,
                revisionsAtRequestStart:
                  observationRevisionsAtRequestStart,
                currentRevisions:
                  conversationObservationRevisionsRef.current,
              });
        const trackedConversations =
          mergeBootstrapConversationSummaries({
            current: current.trackedConversations,
            incoming: incomingTrackedConversations,
            atRequestStart: bootstrapAtRequestStart.trackedConversations,
            revisionsAtRequestStart: observationRevisionsAtRequestStart,
            currentRevisions:
              conversationObservationRevisionsRef.current,
            preserveIncomingConversationIds,
          });
        return requestKind === "full"
          ? {
              ...normalizedData,
              credits: commitIncomingCredits
                ? data.credits
                : current.credits,
              conversations,
              trackedConversations,
            }
          : {
              ...current,
              credits: commitIncomingCredits
                ? data.credits
                : current.credits,
              conversations,
              trackedConversations,
            };
      });
      if (requestKind === "full") {
        setConversationBrowserVersion((current) => current + 1);
      }
      if (
        requestKind === "full" &&
        activeConversationIdAtCommit !== null &&
        currentActiveConversation !== undefined &&
        incomingActiveConversation === undefined
      ) {
        const confirmation = await loadConversation(
          activeConversationIdAtCommit,
        );
        if (bootstrapRevalidationAbortRef.current !== controller) {
          return "ignored" as const;
        }
        if (confirmation.status === "not_found") {
          handleConfirmedRemoteConversationRemoval(
            activeConversationIdAtCommit,
          );
        }
      }
      return "success" as const;
    } catch (error) {
      return !isAbortError(error) && isTransientApiError(error)
        ? ("retryable_failure" as const)
        : ("ignored" as const);
    } finally {
      if (bootstrapRevalidationAbortRef.current === controller) {
        bootstrapRevalidationAbortRef.current = null;
      }
    }
  }, [
    beginCreditSnapshotOperation,
    handleConfirmedRemoteConversationRemoval,
    invalidateConversationPageLoad,
    loadConversation,
    summaryAtAcknowledgedReadWatermark,
  ]);

  const workspaceNeedsBackgroundRunObservation = useCallback(
    () =>
      backgroundRunBootstrapObservationRequired({
        conversations: bootstrapConversationSummaries(bootstrapRef.current),
        activeConversationId: activeConversationIdRef.current,
        visibilityState: document.visibilityState,
      }),
    [],
  );

  const scheduleBootstrapRevalidation = useCallback(
    (
      requestKind: BootstrapRevalidationRequestKind = "full",
      requestedDelayMs =
        requestKind === "background_poll"
          ? backgroundRunBootstrapObservationIntervalMs
          : 0,
    ) => {
      const plan = planBootstrapRevalidationRequest({
        state: bootstrapRevalidationQueueStateRef.current,
        requestKind,
        bootstrapIsReady: bootstrapRef.current !== null,
        hasScheduledOrRunningRequest:
          bootstrapRevalidationTimerRef.current !== null ||
          bootstrapRevalidationAbortRef.current !== null,
      });
      bootstrapRevalidationQueueStateRef.current = plan.state;
      if (bootstrapRef.current === null) {
        return;
      }

      const armScheduledRevalidation = (
        scheduledRequestKind: BootstrapRevalidationRequestKind,
        delayMs: number,
      ) => {
        bootstrapRevalidationTimerRequestRef.current = scheduledRequestKind;
        bootstrapRevalidationTimerRef.current = window.setTimeout(() => {
          bootstrapRevalidationTimerRef.current = null;
          bootstrapRevalidationTimerRequestRef.current = null;
          void runScheduledRevalidation();
        }, delayMs);
      };

      const runScheduledRevalidation = async () => {
        const runningRequestKind =
          bootstrapRevalidationQueueStateRef.current.requested;
        if (
          bootstrapRef.current === null ||
          runningRequestKind === null ||
          bootstrapRevalidationAbortRef.current !== null
        ) {
          return;
        }
        bootstrapRevalidationQueueStateRef.current =
          beginBootstrapRevalidation(
            bootstrapRevalidationQueueStateRef.current,
          );
        bootstrapRevalidationRunningRequestRef.current = runningRequestKind;
        const outcome = await revalidateBootstrap(runningRequestKind);
        bootstrapRevalidationRunningRequestRef.current = null;
        const hadNewerRequest =
          bootstrapRevalidationQueueStateRef.current.requested !== null;
        bootstrapRevalidationQueueStateRef.current =
          settleBootstrapRevalidation(
            bootstrapRevalidationQueueStateRef.current,
            runningRequestKind,
            outcome,
          );
        const nextRequestKind =
          bootstrapRevalidationQueueStateRef.current.requested;
        if (bootstrapRef.current === null) {
          return;
        }
        if (nextRequestKind !== null) {
          const delayMs =
            outcome === "retryable_failure" && !hadNewerRequest
              ? runEventRetryDelayMs(
                  bootstrapRevalidationQueueStateRef.current
                    .consecutiveFailures,
                )
              : 0;
          armScheduledRevalidation(nextRequestKind, delayMs);
          return;
        }
        if (workspaceNeedsBackgroundRunObservation()) {
          const backgroundPlan = planBootstrapRevalidationRequest({
            state: bootstrapRevalidationQueueStateRef.current,
            requestKind: "background_poll",
            bootstrapIsReady: true,
            hasScheduledOrRunningRequest: false,
          });
          bootstrapRevalidationQueueStateRef.current = backgroundPlan.state;
          armScheduledRevalidation(
            "background_poll",
            backgroundRunBootstrapObservationIntervalMs,
          );
        }
      };

      if (bootstrapRevalidationAbortRef.current !== null) {
        return;
      }
      if (bootstrapRevalidationTimerRef.current !== null) {
        if (
          requestKind === "full" &&
          bootstrapRevalidationTimerRequestRef.current === "background_poll"
        ) {
          window.clearTimeout(bootstrapRevalidationTimerRef.current);
          bootstrapRevalidationTimerRef.current = null;
          bootstrapRevalidationTimerRequestRef.current = null;
          armScheduledRevalidation("full", 0);
        }
        return;
      }
      if (!plan.shouldSchedule) {
        return;
      }
      const scheduledRequestKind =
        bootstrapRevalidationQueueStateRef.current.requested;
      if (scheduledRequestKind === null) {
        throw new Error("已计划 bootstrap revalidation 但队列为空");
      }
      armScheduledRevalidation(
        scheduledRequestKind,
        scheduledRequestKind === "full" ? 0 : requestedDelayMs,
      );
    },
    [revalidateBootstrap, workspaceNeedsBackgroundRunObservation],
  );

  const finishCreditMutation = useCallback(
    (mutationRevision: number, shouldRevalidate: boolean) => {
      if (
        !pendingCreditMutationRevisionsRef.current.delete(mutationRevision)
      ) {
        return;
      }
      if (
        !creditMutationOperationRevisionsRef.current.delete(mutationRevision)
      ) {
        throw new Error(
          `积分 mutation ${mutationRevision} 完成时缺少 operation revision`,
        );
      }
      if (
        shouldRevalidate &&
        pendingCreditMutationRevisionsRef.current.size === 0
      ) {
        scheduleBootstrapRevalidation();
      }
    },
    [scheduleBootstrapRevalidation],
  );

  const signalWorkspaceBootstrapChanged = useCallback(() => {
    scheduleBootstrapRevalidation();
    workspaceCrossTabChannelRef.current?.postMessage(
      workspaceBootstrapChangedMessage,
    );
  }, [scheduleBootstrapRevalidation]);

  useEffect(() => {
    const workspaceGeneration = nextWorkspaceGeneration(
      workspaceGenerationRef.current,
    );
    workspaceGenerationRef.current = workspaceGeneration;
    const loadOperations = conversationLoadOperationsRef.current;
    const runSubscriptions = runSubscriptionsRef.current;
    const runTerminalFollowUps = runTerminalFollowUpsRef.current;
    const runEventBuffers = runEventBuffersRef.current;
    const replayStates = runReplayStatesRef.current;
    const connectionStates = runEventConnectionStatesRef.current;
    const runsWithObservedRunningStatus =
      runsWithObservedRunningStatusRef.current;
    const attachmentUploadControllers =
      attachmentUploadControllersRef.current;
    const attachmentDraftRecoveryControllers =
      attachmentDraftRecoveryControllersRef.current;
    const attachmentDraftOrderTokens = attachmentDraftOrderTokensRef.current;
    const unpersistedAttachmentIds = unpersistedAttachmentIdsRef.current;
    const attachmentPreviewUrls = attachmentPreviewUrlsRef.current;
    return () => {
      if (
        workspaceGenerationIsCurrent(
          workspaceGenerationRef.current,
          workspaceGeneration,
        )
      ) {
        workspaceGenerationRef.current = nextWorkspaceGeneration(
          workspaceGeneration,
        );
      }
      bootstrapAbortRef.current?.abort();
      bootstrapRevalidationAbortRef.current?.abort();
      conversationListGenerationRef.current += 1;
      conversationPageLoadOperationRef.current?.controller.abort();
      conversationPageLoadOperationRef.current = null;
      if (bootstrapRevalidationTimerRef.current !== null) {
        window.clearTimeout(bootstrapRevalidationTimerRef.current);
        bootstrapRevalidationTimerRef.current = null;
      }
      bootstrapRevalidationTimerRequestRef.current = null;
      bootstrapRevalidationRunningRequestRef.current = null;
      bootstrapRevalidationQueueStateRef.current =
        initialBootstrapRevalidationQueueState;
      for (const operation of loadOperations.values()) {
        if (operation.status === "pending") {
          operation.controller.abort();
        }
      }
      for (const buffer of runEventBuffers.values()) {
        buffer.destroy();
      }
      for (const subscription of runSubscriptions.values()) {
        subscription.controller.abort();
      }
      for (const followUp of runTerminalFollowUps.values()) {
        followUp.controller.abort();
      }
      for (const controller of attachmentUploadControllers.values()) {
        controller.abort();
      }
      for (const controller of attachmentDraftRecoveryControllers.values()) {
        controller.abort();
      }
      for (const previewUrl of attachmentPreviewUrls) {
        URL.revokeObjectURL(previewUrl);
      }
      bootstrapAbortRef.current = null;
      bootstrapRevalidationAbortRef.current = null;
      loadOperations.clear();
      runSubscriptions.clear();
      runTerminalFollowUps.clear();
      runEventBuffers.clear();
      replayStates.clear();
      connectionStates.clear();
      runsWithObservedRunningStatus.clear();
      attachmentUploadControllers.clear();
      attachmentDraftRecoveryControllers.clear();
      attachmentDraftOrderTokens.clear();
      unpersistedAttachmentIds.clear();
      attachmentPreviewUrls.clear();
    };
  }, []);

  useEffect(() => {
    const initializeTimer = window.setTimeout(() => void initialize(), 0);
    return () => {
      window.clearTimeout(initializeTimer);
    };
  }, [initialize]);

  useEffect(() => {
    const handleWindowFocus = () => scheduleBootstrapRevalidation();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleBootstrapRevalidation();
      }
    };
    const channel = new BroadcastChannel(workspaceCrossTabChannelName);
    workspaceCrossTabChannelRef.current = channel;
    const handleCrossTabMessage = (event: MessageEvent<unknown>) => {
      if (isWorkspaceCrossTabMessage(event.data)) {
        scheduleBootstrapRevalidation();
      }
    };

    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    channel.addEventListener("message", handleCrossTabMessage);
    return () => {
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      channel.removeEventListener("message", handleCrossTabMessage);
      channel.close();
      if (workspaceCrossTabChannelRef.current === channel) {
        workspaceCrossTabChannelRef.current = null;
      }
    };
  }, [scheduleBootstrapRevalidation]);

  const bootstrapIsReady = bootstrap !== null;
  useEffect(() => {
    if (!bootstrapIsReady) {
      return;
    }
    if (workspaceNeedsBackgroundRunObservation()) {
      if (
        bootstrapRevalidationAbortRef.current !== null ||
        bootstrapRevalidationTimerRef.current !== null
      ) {
        return;
      }
      scheduleBootstrapRevalidation("background_poll");
      return;
    }

    if (
      bootstrapRevalidationQueueStateRef.current.requested ===
      "background_poll"
    ) {
      bootstrapRevalidationQueueStateRef.current = {
        requested: null,
        consecutiveFailures: 0,
      };
    }
    if (
      bootstrapRevalidationTimerRequestRef.current === "background_poll" &&
      bootstrapRevalidationTimerRef.current !== null
    ) {
      window.clearTimeout(bootstrapRevalidationTimerRef.current);
      bootstrapRevalidationTimerRef.current = null;
      bootstrapRevalidationTimerRequestRef.current = null;
    }
    if (
      bootstrapRevalidationRunningRequestRef.current === "background_poll"
    ) {
      bootstrapRevalidationAbortRef.current?.abort();
    }
  }, [
    activeConversationId,
    bootstrap,
    bootstrapIsReady,
    runSubscriptionContextRevision,
    scheduleBootstrapRevalidation,
    workspaceNeedsBackgroundRunObservation,
  ]);

  useEffect(() => {
    const requested = bootstrapRevalidationQueueStateRef.current.requested;
    if (bootstrapIsReady && requested !== null) {
      scheduleBootstrapRevalidation(requested);
    }
  }, [bootstrapIsReady, scheduleBootstrapRevalidation]);

  useLayoutEffect(() => {
    if (!bootstrapIsReady) {
      return;
    }
    setIsSidebarOpen(false);
    setIsBackgroundRunCenterOpen(false);

    if (route.kind === "library") {
      const previousConversationId = activeConversationIdRef.current;
      setCitationSourcesView(null);
      setShareTargetConversationId(null);
      updateActivityView(previousConversationId, { isOpen: false });
      if (previousConversationId !== null) {
        setActiveConversation(null);
      }
      return;
    }

    if (activeConversationIdRef.current === routeConversationId) {
      return;
    }
    setActiveConversation(routeConversationId);
    setDetachedConversation(null);
    if (routeConversationId !== null) {
      void loadConversation(routeConversationId);
    }
  }, [
    bootstrapIsReady,
    route.kind,
    routeConversationId,
    routeSnapshotId,
    loadConversation,
    setActiveConversation,
    updateActivityView,
  ]);

  useEffect(() => {
    if (bootstrap === null) {
      return;
    }
    const observedConversations = bootstrapConversationSummaries(bootstrap);
    const activeRunIds = new Set(
      observedConversations.flatMap((conversation) =>
        conversation.activeRun === null ? [] : [conversation.activeRun.id],
      ),
    );
    for (const [runId, subscription] of runSubscriptionsRef.current) {
      if (
        subscription.role === "foreground_follow" &&
        (!activeRunIds.has(runId) ||
          activeRunSubscriptionRole({
            conversationId: subscription.conversationId,
            activeConversationId,
            visibilityState: document.visibilityState,
          }) === null)
      ) {
        stopRunSubscriptionForRoleChange(runId, subscription, false);
      }
    }
    for (const conversation of observedConversations) {
      if (conversation.activeRun === null) {
        continue;
      }
      const state = conversationStates[conversation.id];
      const knownRun = state?.runs.find(
        (run) => run.id === conversation.activeRun?.id,
      );
      ensureRunSubscription(
        conversation.id,
        conversation.activeRun.id,
        "active",
        knownRun === undefined
          ? undefined
          : {
              knownRun,
              existingEvents: eventsForRun(state, knownRun.id),
            },
      );
    }
  }, [
    activeConversationId,
    bootstrap,
    conversationStates,
    ensureRunSubscription,
    runSubscriptionContextRevision,
    stopRunSubscriptionForRoleChange,
  ]);

  useEffect(() => {
    const markVisibleConversationRead = () => {
      setRunSubscriptionContextRevision((current) => current + 1);
      if (document.visibilityState !== "visible") {
        return;
      }
      const conversationId = activeConversationIdRef.current;
      if (conversationId === null) {
        return;
      }
      const conversation =
        findBootstrapConversation(
          bootstrapRef.current,
          conversationId,
        ) ??
        (detachedConversationRef.current?.id === conversationId
          ? detachedConversationRef.current
          : null);
      if (
        conversation !== null &&
        conversation.attention !== null &&
        conversationStateShowsTerminalResult(
          conversationStatesRef.current[conversationId],
          conversation.attention.runId,
          conversation.attention.terminalEventId,
        )
      ) {
        void markConversationRead(
          conversationId,
          conversation.attention.runId,
          conversation.attention.terminalEventId,
        );
      }
    };

    document.addEventListener("visibilitychange", markVisibleConversationRead);
    return () => {
      document.removeEventListener(
        "visibilitychange",
        markVisibleConversationRead,
      );
    };
  }, [markConversationRead]);

  const listedActiveConversation =
    activeConversationId === null
      ? undefined
      : findBootstrapConversation(bootstrap, activeConversationId);
  const activeConversation =
    listedActiveConversation ??
    (detachedConversation?.id === activeConversationId
      ? detachedConversation
      : undefined);
  const shareTargetConversation =
    shareTargetConversationId === null
      ? null
      : (findBootstrapConversation(bootstrap, shareTargetConversationId) ??
        (detachedConversation?.id === shareTargetConversationId
          ? detachedConversation
          : null));
  const isHeaderShareDialogOpen =
    activeConversation !== undefined &&
    shareTargetConversationId === activeConversation.id;
  const activeConversationSelectedRunId =
    activeConversation?.selectedRunId ?? null;

  useEffect(() => {
    setCitationSourcesView((current) =>
      current?.conversationId === activeConversationId ? null : current,
    );
  }, [activeConversationId, activeConversationSelectedRunId]);

  const activeAttentionTerminalEventId =
    activeConversation?.attention?.terminalEventId ?? null;
  const activeAttentionRunId = activeConversation?.attention?.runId ?? null;
  const activeAttentionResultIsVisible =
    activeAttentionTerminalEventId !== null &&
    activeAttentionRunId !== null &&
    conversationStateShowsTerminalResult(
      activeConversationId === null
        ? undefined
        : conversationStates[activeConversationId],
      activeAttentionRunId,
      activeAttentionTerminalEventId,
    );

  useEffect(() => {
    if (
      activeConversationId === null ||
      activeAttentionTerminalEventId === null ||
      !activeAttentionResultIsVisible ||
      !shouldMarkConversationRead({
        activeConversationId,
        conversationId: activeConversationId,
        visibilityState: document.visibilityState,
      })
    ) {
      return;
    }
    // This synchronizes an external read receipt; its React updates happen
    // only after the awaited PATCH response resolves.
    void markConversationRead(
      activeConversationId,
      activeAttentionRunId,
      activeAttentionTerminalEventId,
    );
  }, [
    activeAttentionTerminalEventId,
    activeAttentionRunId,
    activeAttentionResultIsVisible,
    activeConversationId,
    markConversationRead,
  ]);

  const activeState =
    activeConversationId === null
      ? undefined
      : conversationStates[activeConversationId];
  const activeRun = activeRunForConversation(activeConversation, activeState);
  const activeRunEvents = useMemo(
    () => (activeRun === null ? [] : eventsForRun(activeState, activeRun.id)),
    [activeRun, activeState],
  );

  useLayoutEffect(() => {
    if (conversationSearchTarget?.conversationId === activeConversationId) {
      return;
    }
    const scrollContainer = conversationScrollRef.current;
    if (scrollContainer === null) {
      return;
    }
    const snapshot = conversationScrollMemoryRef.current.get(
      activeConversationUiKey,
    );
    const scrollTop = restoredConversationScrollTop(snapshot, scrollContainer);
    scrollContainer.scrollTop = scrollTop;
    const nextSnapshot = captureConversationScroll(scrollContainer);
    conversationScrollMemoryRef.current.set(
      activeConversationUiKey,
      nextSnapshot,
    );
    // The visible conversation can change without a scroll event (route switch,
    // streamed content, activity panel resize), so update the affordance here.
    setShowScrollToLatest(!nextSnapshot.stickToBottom);
  }, [
    activeConversationUiKey,
    activeRun,
    activeRunEvents,
    activeState?.isLoading,
    activeState?.messages,
    activeState?.runs,
    activeConversationId,
    conversationSearchTarget,
    isActivityOpen,
  ]);

  useLayoutEffect(() => {
    if (
      conversationSearchTarget === null ||
      conversationSearchTarget.conversationId !== activeConversationId ||
      activeState?.isLoaded !== true ||
      revealedConversationSearchRequestIdRef.current ===
        conversationSearchTarget.requestId
    ) {
      return;
    }
    const scrollContainer = conversationScrollRef.current;
    if (
      scrollContainer === null ||
      !revealConversationSearchTarget(
        scrollContainer,
        conversationSearchTarget,
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      )
    ) {
      return;
    }

    revealedConversationSearchRequestIdRef.current =
      conversationSearchTarget.requestId;
    if (conversationSearchClearTimerRef.current !== null) {
      window.clearTimeout(conversationSearchClearTimerRef.current);
    }
    conversationSearchClearTimerRef.current = window.setTimeout(() => {
      setConversationSearchTarget((current) =>
        current?.requestId === conversationSearchTarget.requestId
          ? null
          : current,
      );
      conversationSearchClearTimerRef.current = null;
    }, conversationSearchHighlightMilliseconds);
  }, [
    activeConversationId,
    activeState?.isLoaded,
    activeState?.messages,
    activeState?.runs,
    conversationSearchTarget,
  ]);

  const handleConversationScroll = useCallback(() => {
    const scrollContainer = conversationScrollRef.current;
    if (scrollContainer === null) {
      return;
    }
    const snapshot = captureConversationScroll(scrollContainer);
    conversationScrollMemoryRef.current.set(activeConversationUiKey, snapshot);
    setShowScrollToLatest(!snapshot.stickToBottom);
  }, [activeConversationUiKey]);

  const handleScrollToLatest = useCallback(() => {
    const scrollContainer = conversationScrollRef.current;
    if (scrollContainer === null) {
      return;
    }
    const scrollTop = maximumScrollTop(scrollContainer);
    scrollContainer.scrollTop = scrollTop;
    conversationScrollMemoryRef.current.set(activeConversationUiKey, {
      scrollTop,
      stickToBottom: true,
    });
    setShowScrollToLatest(false);
  }, [activeConversationUiKey]);

  const handleCreateConversation = useCallback(() => {
    if (isCreating) {
      return;
    }
    setWorkspaceError(null);
    clearConversationSearchTarget();
    setActiveConversation(null);
    setDetachedConversation(null);
    updateActivityView(null, { isOpen: false, runId: null });
    setIsSidebarOpen(false);
    navigateToConversation(null);
    requestComposerFocus();
  }, [
    clearConversationSearchTarget,
    isCreating,
    navigateToConversation,
    requestComposerFocus,
    setActiveConversation,
    updateActivityView,
  ]);

  const handleSelectConversation = useCallback(
    (conversationId: string) => {
      setIsSidebarOpen(false);
      clearConversationSearchTarget();
      if (conversationId === activeConversationIdRef.current) {
        retryConversationLoad(conversationId);
        return;
      }
      if (!isLibraryRoute) {
        setActiveConversation(conversationId);
      }
      setDetachedConversation(null);
      navigateToConversation(conversationId);
      void loadConversation(conversationId);
    },
    [
      clearConversationSearchTarget,
      isLibraryRoute,
      loadConversation,
      navigateToConversation,
      retryConversationLoad,
      setActiveConversation,
    ],
  );

  const handleBranchToNewConversation = useCallback(
    async (
      target: MessageBranchToNewConversationTarget,
      trigger: HTMLButtonElement,
    ) => {
      const workspaceGeneration = workspaceGenerationRef.current;
      const navigationIntentRevision = navigationIntentRevisionRef.current;
      const sourceConversationId = target.conversationId;
      const sourceState = conversationStatesRef.current[sourceConversationId];
      if (sourceState === undefined || !sourceState.isLoaded) {
        dispatchConversation({
          type: "set_error",
          conversationId: sourceConversationId,
          message: `源会话 ${sourceConversationId} 尚未完整加载`,
        });
        return;
      }
      const sourceMessage = sourceState.messages.find(
        (message) => message.id === target.messageId,
      );
      const sourceRun = sourceState.runs.find((run) => run.id === target.runId);
      if (
        target.role !== "assistant" ||
        sourceMessage?.role !== "assistant" ||
        sourceMessage.runId !== target.runId ||
        sourceRun === undefined ||
        sourceRun.conversationId !== sourceConversationId ||
        sourceRun.assistantMessageId !== target.messageId ||
        effectiveRunStatus(
          sourceRun,
          eventsForRun(sourceState, sourceRun.id),
        ) !== "completed"
      ) {
        dispatchConversation({
          type: "set_error",
          conversationId: sourceConversationId,
          message: "只能从当前会话中已完成的助手回答创建新对话",
        });
        return;
      }

      const mutationOwner = {};
      if (!beginConversationMutation(sourceConversationId, mutationOwner)) {
        return;
      }
      const requestKey = messageBranchRequestKey(
        sourceConversationId,
        target.messageId,
      );
      const requestId =
        pendingMessageBranchRequestIdsRef.current.get(requestKey) ??
        createClientId();
      pendingMessageBranchRequestIdsRef.current.set(requestKey, requestId);
      setBranchingMessageKeys((current) => new Set(current).add(requestKey));
      dispatchConversation({
        type: "clear_error",
        conversationId: sourceConversationId,
      });
      let branchRequestWasConfirmed = false;
      let shouldRestoreTriggerFocus = false;

      try {
        const response = await branchConversation(sourceConversationId, {
          requestId,
          sourceMessageId: target.messageId,
        });
        if (!workspaceOperationIsCurrent(workspaceGeneration)) {
          return;
        }
        if (response.conversation.id === sourceConversationId) {
          throw new Error("新对话分支返回了源会话 ID");
        }
        branchRequestWasConfirmed = true;

        const branchedConversationId = response.conversation.id;
        const loadResult = await loadConversationForStaleParent(
          branchedConversationId,
        );
        if (!workspaceOperationIsCurrent(workspaceGeneration)) {
          return;
        }
        if (loadResult.status !== "loaded") {
          throw new Error(
            branchedConversationLoadErrorMessage(loadResult.status),
          );
        }
        const branchedConversation = loadResult.detail.conversation;
        if (branchedConversation.id !== branchedConversationId) {
          throw new Error("新对话分支详情返回了不一致的会话 ID");
        }
        if (branchedConversation.archivedAt !== null) {
          throw new Error("新对话分支已被归档，未自动打开");
        }
        pendingMessageBranchRequestIdsRef.current.delete(requestKey);
        commitConversationSummary(branchedConversation);
        signalWorkspaceBootstrapChanged();

        const currentRoute = routeRef.current;
        if (
          navigationIntentRevisionRef.current === navigationIntentRevision &&
          activeConversationIdRef.current === sourceConversationId &&
          currentRoute.kind === "conversation" &&
          currentRoute.conversationId === sourceConversationId
        ) {
          clearConversationSearchTarget();
          setActiveConversation(branchedConversationId);
          setDetachedConversation(null);
          navigateToConversation(branchedConversationId);
          requestComposerFocus();
        }
      } catch (error) {
        if (!workspaceOperationIsCurrent(workspaceGeneration)) {
          return;
        }
        if (
          !branchRequestWasConfirmed &&
          !shouldRetainPendingChatRequest(error)
        ) {
          pendingMessageBranchRequestIdsRef.current.delete(requestKey);
        }
        dispatchConversation({
          type: "set_error",
          conversationId: sourceConversationId,
          message: errorMessage(error),
        });
        shouldRestoreTriggerFocus = true;
      } finally {
        if (workspaceOperationIsCurrent(workspaceGeneration)) {
          if (shouldRestoreTriggerFocus) {
            pendingMessageBranchFocusRestoresRef.current.set(
              requestKey,
              trigger,
            );
          }
          setBranchingMessageKeys((current) => {
            const next = new Set(current);
            next.delete(requestKey);
            return next;
          });
          finishConversationMutation(sourceConversationId, mutationOwner);
        }
      }
    },
    [
      beginConversationMutation,
      clearConversationSearchTarget,
      commitConversationSummary,
      finishConversationMutation,
      loadConversationForStaleParent,
      navigateToConversation,
      requestComposerFocus,
      setActiveConversation,
      signalWorkspaceBootstrapChanged,
      workspaceOperationIsCurrent,
    ],
  );

  const handleOpenLibrary = useCallback(() => {
    setIsSidebarOpen(false);
    clearConversationSearchTarget();
    setCitationSourcesView(null);
    updateActivityView(activeConversationIdRef.current, { isOpen: false });
    navigateWithinWorkspace(libraryRoute("research"));
  }, [
    clearConversationSearchTarget,
    navigateWithinWorkspace,
    updateActivityView,
  ]);

  const handleNavigateLibraryTab = useCallback(
    (tab: LibraryTab) => {
      navigateWithinWorkspace(libraryRoute(tab));
    },
    [navigateWithinWorkspace],
  );

  const handleNavigateLibrarySnapshot = useCallback(
    (snapshotId: string | null) => {
      navigateWithinWorkspace(
        snapshotId === null
          ? libraryRoute("research")
          : libraryResearchRoute(snapshotId),
      );
    },
    [navigateWithinWorkspace],
  );

  const dismissRunCompletion = useCallback(
    (conversationId: string, runId: string) => {
      dismissedRunCompletionRunIdsRef.current.add(runId);
      setRunCompletionNotifications((current) =>
        dismissRunCompletionNotification(current, {
          conversationId,
          runId,
        }),
      );
    },
    [],
  );

  const handleOpenRunCompletion = useCallback(
    (
      conversationId: string,
      runId: string,
      returnFocusTarget: HTMLButtonElement | null =
        headerBackgroundRunButtonRef.current,
    ) => {
      const wasActiveConversation =
        conversationId === activeConversationIdRef.current;
      const targetState = conversationStatesRef.current[conversationId];
      const targetRunIsLoaded =
        targetState?.runs.some((run) => run.id === runId) === true;
      activityReturnFocusRef.current = returnFocusTarget;
      dismissRunCompletion(conversationId, runId);
      updateActivityView(conversationId, { isOpen: true, runId });
      handleSelectConversation(conversationId);
      if (
        wasActiveConversation &&
        !targetRunIsLoaded &&
        conversationLoadOperationsRef.current.get(conversationId)?.status !==
          "pending"
      ) {
        void loadConversation(conversationId);
      }
    },
    [
      dismissRunCompletion,
      handleSelectConversation,
      loadConversation,
      updateActivityView,
    ],
  );

  const handleOpenBackgroundRunItem = useCallback(
    (item: BackgroundRunCenterItem) => {
      setIsBackgroundRunCenterOpen(false);
      setCitationSourcesView(null);
      const selection = backgroundRunCenterSelection(item);
      if (selection.activityRunId === null) {
        updateActivityView(selection.conversationId, { isOpen: false });
        handleSelectConversation(selection.conversationId);
        return;
      }
      handleOpenRunCompletion(
        selection.conversationId,
        selection.activityRunId,
        headerBackgroundRunButtonRef.current,
      );
    },
    [handleOpenRunCompletion, handleSelectConversation, updateActivityView],
  );

  const handleOpenBackgroundRunHistoryItem = useCallback(
    (item: BackgroundRunHistoryItem) => {
      setIsBackgroundRunCenterOpen(false);
      setCitationSourcesView(null);
      const selection = backgroundRunHistorySelection(item);
      handleOpenRunCompletion(
        selection.conversationId,
        selection.activityRunId,
        headerBackgroundRunButtonRef.current,
      );
    },
    [handleOpenRunCompletion],
  );

  const handleSelectRun = useCallback(
    async (conversationId: string, targetRunId: string) => {
      const state = conversationStatesRef.current[conversationId];
      if (state === undefined || !state.isLoaded) {
        throw new Error(`会话 ${conversationId} 尚未完整加载`);
      }
      const conversation = requiredConversationSummary(
        bootstrapRef.current,
        detachedConversationRef.current,
        conversationId,
      );
      if (
        conversationHasOutstandingRuns(conversation) ||
        conversationStateHasOutstandingRuns(state)
      ) {
        dispatchConversation({
          type: "set_error",
          conversationId,
          message: activeRunSelectionMessage,
        });
        return;
      }
      const leafRunId = resolveLatestReachableLeafRunId(state, targetRunId);
      if (conversation.selectedRunId === leafRunId) {
        return;
      }
      const mutationOwner = {};
      if (!beginConversationMutation(conversationId, mutationOwner)) {
        return;
      }
      if (!beginRunSelection(conversationId)) {
        finishConversationMutation(conversationId, mutationOwner);
        return;
      }
      discardUserMessageEdit(conversationId);
      dispatchConversation({ type: "clear_error", conversationId });

      try {
        const response = await patchConversation(conversationId, {
          action: "select_run",
          runId: leafRunId,
        });
        if (
          response.conversation.id !== conversationId ||
          response.conversation.selectedRunId !== leafRunId
        ) {
          throw new Error("切换分支返回了不一致的 selectedRunId");
        }
        advanceConversationObservationRevision(conversationId);
        commitConversationSummary(response.conversation);
        updateActivityView(conversationId, { runId: leafRunId });
        signalWorkspaceBootstrapChanged();
      } catch (error) {
        dispatchConversation({
          type: "set_error",
          conversationId,
          message:
            error instanceof ApiClientError &&
            error.code === "ACTIVE_RUN" &&
            error.status === 409
              ? activeRunSelectionMessage
              : errorMessage(error),
        });
      } finally {
        finishRunSelection(conversationId);
        finishConversationMutation(conversationId, mutationOwner);
      }
    },
    [
      advanceConversationObservationRevision,
      beginConversationMutation,
      beginRunSelection,
      commitConversationSummary,
      discardUserMessageEdit,
      finishConversationMutation,
      finishRunSelection,
      signalWorkspaceBootstrapChanged,
      updateActivityView,
    ],
  );

  const closeConversationBrowser = useCallback(() => {
    setConversationBrowserView(null);
  }, []);

  const openConversationBrowser = useCallback(
    (view: ConversationListView) => {
      setIsSidebarOpen(false);
      setConversationBrowserView(view);
    },
    [],
  );

  useEffect(() => {
    function handleWorkspaceShortcut(event: KeyboardEvent) {
      const targetElement =
        event.target instanceof Element
          ? event.target
          : event.target instanceof Node
            ? event.target.parentElement
            : null;
      const targetIsEditable =
        targetElement !== null &&
        (targetElement.closest("input, textarea, select") !== null ||
          (targetElement instanceof HTMLElement &&
            targetElement.isContentEditable));

      const action = workspaceShortcutAction({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        isComposing: event.isComposing,
        defaultPrevented: event.defaultPrevented,
        repeat: event.repeat,
        targetIsEditable,
      });
      if (action === null) {
        return;
      }

      event.preventDefault();
      if (documentHasOpenModal(document)) {
        return;
      }
      switch (action) {
        case "new_conversation":
          handleCreateConversation();
          return;
        case "focus_composer":
          requestComposerFocus();
          return;
        case "search_conversations":
          openConversationBrowser("active");
          return;
        case "show_shortcuts":
          setIsKeyboardShortcutsOpen(true);
          return;
      }
    }

    window.addEventListener("keydown", handleWorkspaceShortcut);
    return () => {
      window.removeEventListener("keydown", handleWorkspaceShortcut);
    };
  }, [handleCreateConversation, openConversationBrowser, requestComposerFocus]);

  const handleBrowserConversationSelect = useCallback(
    (selection: ConversationBrowserSelection) => {
      const { conversation } = selection;
      if (conversationSearchClearTimerRef.current !== null) {
        window.clearTimeout(conversationSearchClearTimerRef.current);
        conversationSearchClearTimerRef.current = null;
      }
      revealedConversationSearchRequestIdRef.current = null;
      conversationSearchRequestIdRef.current += 1;
      setConversationSearchTarget(
        conversationSearchTargetFromSelection(
          selection,
          conversationSearchRequestIdRef.current,
        ),
      );
      if (!isLibraryRoute) {
        setActiveConversation(conversation.id);
      }
      setDetachedConversation(
        conversation.archivedAt === null ? null : conversation,
      );
      navigateToConversation(conversation.id);
      void loadConversation(conversation.id);
    },
    [
      loadConversation,
      isLibraryRoute,
      navigateToConversation,
      setActiveConversation,
    ],
  );

  const performConversationPatch = useCallback(
    async (
      conversation: ConversationSummary,
      request: PatchConversationRequest,
    ): Promise<ConversationPatchResult> => {
      const mutationOwner = {};
      if (!beginConversationMutation(conversation.id, mutationOwner)) {
        return {
          conversation: null,
          error: "该对话正在处理其他操作，请稍候。",
        };
      }

      try {
        const response = await patchConversation(conversation.id, request);
        if (response.conversation.id !== conversation.id) {
          throw new Error("更新对话返回了不一致的 conversationId");
        }
        advanceConversationObservationRevision(conversation.id);
        signalWorkspaceBootstrapChanged();
        return { conversation: response.conversation, error: null };
      } catch (error) {
        return {
          conversation: null,
          error: conversationMutationErrorMessage(error),
        };
      } finally {
        finishConversationMutation(conversation.id, mutationOwner);
      }
    },
    [
      advanceConversationObservationRevision,
      beginConversationMutation,
      finishConversationMutation,
      signalWorkspaceBootstrapChanged,
    ],
  );

  const removeConversationAndAdvance = useCallback(
    (conversationId: string) => {
      const currentConversations =
        bootstrapRef.current?.conversations ?? [];
      const removal = removeConversationAndSelectNext(
        currentConversations,
        conversationId,
      );
      const nextConversationId =
        removal.nextConversationId ??
        (currentConversations.some(
          (conversation) => conversation.id === conversationId,
        )
          ? null
          : currentConversations[0]?.id ?? null);

      setBootstrap((current) =>
        current === null
          ? current
          : {
              ...current,
              ...removeConversationFromSummarySources(
                current,
                conversationId,
              ),
            },
      );
      setConversationBrowserVersion((current) => current + 1);
      conversationScrollMemoryRef.current.delete(conversationId);
      setActivityViews((current) =>
        removeConversationActivityView(current, conversationId),
      );
      discardUserMessageEdit(conversationId);

      if (activeConversationIdRef.current !== conversationId) {
        return;
      }

      setActiveConversation(nextConversationId);
      setDetachedConversation(null);
      navigateToConversation(nextConversationId, "replace");
      if (nextConversationId !== null) {
        void loadConversation(nextConversationId);
      }
    },
    [
      discardUserMessageEdit,
      loadConversation,
      navigateToConversation,
      setActiveConversation,
    ],
  );

  const handleRenameConversation = useCallback(
    async (
      conversation: ConversationSummary,
      title: string,
    ): Promise<string | null> => {
      const result = await performConversationPatch(conversation, {
        action: "rename",
        title,
      });
      if (result.error !== null) {
        return result.error;
      }
      commitConversationSummary(result.conversation);
      return null;
    },
    [commitConversationSummary, performConversationPatch],
  );

  const handleSetPinned = useCallback(
    async (conversation: ConversationSummary, pinned: boolean) => {
      setWorkspaceError(null);
      const result = await performConversationPatch(conversation, {
        action: "set_pinned",
        pinned,
      });
      if (result.error !== null) {
        setWorkspaceError(result.error);
        return;
      }
      commitConversationSummary(result.conversation);
    },
    [commitConversationSummary, performConversationPatch],
  );

  const mutateConversationArchiveState = useCallback(
    async (
      conversation: ConversationSummary,
      archived: boolean,
      origin: ConversationArchiveMutationOrigin,
    ): Promise<string | null> => {
      if (
        archived &&
        conversationHasOutstandingRuns(conversation)
      ) {
        return activeRunMutationMessage;
      }

      const result = await performConversationPatch(conversation, {
        action: "set_archived",
        archived,
      });
      if (result.error !== null) {
        return result.error;
      }

      if (archived) {
        removeConversationAndAdvance(conversation.id);
      } else {
        commitConversationSummary(
          result.conversation,
          undefined,
          archiveMutationRefreshesConversationBrowser(origin),
        );
      }
      return null;
    },
    [
      commitConversationSummary,
      performConversationPatch,
      removeConversationAndAdvance,
    ],
  );

  const handleSetArchived = useCallback(
    async (conversation: ConversationSummary, archived: boolean) => {
      setWorkspaceError(null);
      const mutationError = await mutateConversationArchiveState(
        conversation,
        archived,
        "workspace",
      );
      if (mutationError !== null) {
        setWorkspaceError(mutationError);
      }
    },
    [mutateConversationArchiveState],
  );

  const handleRestoreConversation = useCallback(
    (conversation: ConversationSummary) =>
      mutateConversationArchiveState(
        conversation,
        false,
        "conversation_browser",
      ),
    [mutateConversationArchiveState],
  );

  const handleDeleteConversation = useCallback(
    async (conversation: ConversationSummary): Promise<string | null> => {
      if (conversationHasOutstandingRuns(conversation)) {
        return activeRunMutationMessage;
      }
      const mutationOwner = {};
      if (!beginConversationMutation(conversation.id, mutationOwner)) {
        return "该对话正在处理其他操作，请稍候。";
      }

      try {
        const response = await deleteConversation(conversation.id);
        if (response.deletion.conversationId !== conversation.id) {
          throw new Error("删除对话返回了不一致的 conversationId");
        }

        removeComposerDraft(
          window.localStorage,
          conversationComposerDraftScope(conversation.id),
        );
        removeExecutionProfileDraft(
          window.localStorage,
          conversationComposerDraftScope(conversation.id),
        );
        setExecutionProfileDrafts((current) => {
          if (!Object.hasOwn(current, conversation.id)) {
            return current;
          }
          const next = { ...current };
          delete next[conversation.id];
          return next;
        });
        const userId = bootstrapRef.current?.user.id;
        if (userId === undefined) {
          throw new Error("删除会话时工作区缺少当前用户契约");
        }
        discardAttachmentDraftScope(
          conversation.id,
          conversationComposerDraftScope(conversation.id),
          userId,
        );
        advanceConversationObservationRevision(conversation.id);
        const loadOperation =
          conversationLoadOperationsRef.current.get(conversation.id);
        if (loadOperation?.status === "pending") {
          loadOperation.controller.abort();
        }
        conversationLoadOperationsRef.current.delete(conversation.id);
        for (const [runId, subscription] of runSubscriptionsRef.current) {
          if (subscription.conversationId === conversation.id) {
            runEventBuffersRef.current.get(runId)?.destroy();
            runEventBuffersRef.current.delete(runId);
            subscription.controller.abort();
            runSubscriptionsRef.current.delete(runId);
          }
        }
        for (const [runId, followUp] of runTerminalFollowUpsRef.current) {
          if (followUp.conversationId === conversation.id) {
            followUp.controller.abort();
            runTerminalFollowUpsRef.current.delete(runId);
          }
        }
        for (const run of conversationStatesRef.current[conversation.id]?.runs ?? []) {
          runEventBuffersRef.current.get(run.id)?.destroy();
          runEventBuffersRef.current.delete(run.id);
          runReplayStatesRef.current.delete(run.id);
          runEventConnectionStatesRef.current.delete(run.id);
        }
        setDrafts((current) => {
          const next = { ...current };
          delete next[conversation.id];
          return next;
        });
        conversationScrollMemoryRef.current.delete(conversation.id);
        pendingChatRequestsRef.current.delete(conversation.id);
        setRunCompletionNotifications((current) =>
          dismissRunCompletionNotificationsForConversation(
            current,
            conversation.id,
          ),
        );
        removeConversationAndAdvance(conversation.id);
        signalWorkspaceBootstrapChanged();
        return null;
      } catch (error) {
        return conversationMutationErrorMessage(error);
      } finally {
        finishConversationMutation(conversation.id, mutationOwner);
      }
    },
    [
      advanceConversationObservationRevision,
      beginConversationMutation,
      discardAttachmentDraftScope,
      finishConversationMutation,
      removeConversationAndAdvance,
      signalWorkspaceBootstrapChanged,
    ],
  );

  const resetWorkspaceAfterBulkConversationMutation = useCallback(
    (action: "archive_all" | "delete_all") => {
      const currentBootstrap = bootstrapRef.current;
      if (currentBootstrap === null) {
        throw new Error("批量管理对话时工作区缺少 bootstrap 契约");
      }

      workspaceGenerationRef.current = nextWorkspaceGeneration(
        workspaceGenerationRef.current,
      );
      invalidateConversationPageLoad();
      bootstrapRevalidationAbortRef.current?.abort();

      const knownConversationIds = new Set<string>();
      for (const conversation of [
        ...currentBootstrap.conversations,
        ...currentBootstrap.trackedConversations,
      ]) {
        knownConversationIds.add(conversation.id);
      }
      for (const conversationId of Object.keys(
        conversationStatesRef.current,
      )) {
        knownConversationIds.add(conversationId);
      }
      for (const key of [
        ...Object.keys(drafts),
        ...Object.keys(executionProfileDrafts),
        ...Object.keys(attachmentDraftsRef.current),
        ...Object.keys(userMessageEditsRef.current),
      ]) {
        if (key !== newConversationDraftKey) {
          knownConversationIds.add(key);
        }
      }
      if (detachedConversationRef.current !== null) {
        knownConversationIds.add(detachedConversationRef.current.id);
      }
      for (const conversationId of conversationLoadOperationsRef.current.keys()) {
        knownConversationIds.add(conversationId);
      }
      for (const subscription of runSubscriptionsRef.current.values()) {
        knownConversationIds.add(subscription.conversationId);
      }
      for (const followUp of runTerminalFollowUpsRef.current.values()) {
        knownConversationIds.add(followUp.conversationId);
      }

      const stagedAttachmentIdsToDelete = new Set<string>();
      for (const edit of Object.values(userMessageEditsRef.current)) {
        releaseUserMessageEditLocalResources(edit);
        for (const attachment of edit.newAttachments) {
          if (
            attachment.status === "uploaded" ||
            attachment.status === "deleting"
          ) {
            stagedAttachmentIdsToDelete.add(attachment.attachment.id);
          }
        }
      }
      userMessageEditsRef.current = {};
      setUserMessageEdits({});

      let localCleanupWarning = false;
      if (action === "delete_all") {
        const composerDraftClear = clearConversationComposerDrafts(
          window.localStorage,
        );
        const executionProfileClear =
          clearConversationExecutionProfileDrafts(window.localStorage);
        const attachmentDraftClear =
          clearComposerAttachmentDraftConversationScopes(
            window.localStorage,
            currentBootstrap.user.id,
          );
        localCleanupWarning =
          composerDraftClear.status !== "cleared" ||
          executionProfileClear.status !== "cleared" ||
          attachmentDraftClear.status !== "cleared";
        if (
          attachmentDraftClear.status === "cleared" ||
          attachmentDraftClear.status === "warning"
        ) {
          for (const conversationId of attachmentDraftClear.conversationIds) {
            knownConversationIds.add(conversationId);
          }
          for (const attachmentId of attachmentDraftClear.attachmentIds) {
            stagedAttachmentIdsToDelete.add(attachmentId);
          }
        }

        for (const [key, attachments] of Object.entries(
          attachmentDraftsRef.current,
        )) {
          if (key === newConversationDraftKey) {
            continue;
          }
          for (const attachment of attachments) {
            if (
              attachment.status === "uploaded" ||
              attachment.status === "deleting"
            ) {
              stagedAttachmentIdsToDelete.add(attachment.attachment.id);
            }
          }
          clearLocalAttachmentDraft(key);
        }
        for (const [key, controller] of
          attachmentDraftRecoveryControllersRef.current) {
          if (key === newConversationDraftKey) {
            continue;
          }
          controller.abort();
          attachmentDraftRecoveryControllersRef.current.delete(key);
        }
        for (const key of Array.from(restoredDraftKeysRef.current)) {
          if (key !== newConversationDraftKey) {
            restoredDraftKeysRef.current.delete(key);
          }
        }
        setDrafts(retainNewConversationRecord);
        setExecutionProfileDrafts(retainNewConversationRecord);
        setAttachmentDraftErrors(retainNewConversationRecord);
        setAttachmentDraftRecoveryStates(retainNewConversationRecord);
      }

      for (const conversationId of knownConversationIds) {
        advanceConversationObservationRevision(conversationId);
      }
      for (const operation of conversationLoadOperationsRef.current.values()) {
        operation.controller.abort();
      }
      conversationLoadOperationsRef.current.clear();
      for (const subscription of runSubscriptionsRef.current.values()) {
        subscription.controller.abort();
      }
      runSubscriptionsRef.current.clear();
      for (const followUp of runTerminalFollowUpsRef.current.values()) {
        followUp.controller.abort();
      }
      runTerminalFollowUpsRef.current.clear();
      for (const buffer of runEventBuffersRef.current.values()) {
        buffer.destroy();
      }
      runEventBuffersRef.current.clear();
      runReplayStatesRef.current.clear();
      runEventConnectionStatesRef.current.clear();
      runsWithObservedRunningStatusRef.current.clear();
      conversationScrollMemoryRef.current.clear();
      pendingRetryRequestIdsRef.current.clear();
      pendingRegenerateRequestIdsRef.current.clear();
      pendingMessageBranchRequestIdsRef.current.clear();
      pendingMessageBranchFocusRestoresRef.current.clear();
      selectingRunConversationIdsRef.current.clear();
      feedbackPendingMessageIdsRef.current.clear();
      markReadRequestsRef.current.clear();
      conversationReadWatermarksRef.current.clear();
      conversationRefreshFencesRef.current.clear();
      dismissedRunCompletionRunIdsRef.current.clear();
      for (const requestKey of Array.from(pendingChatRequestsRef.current.keys())) {
        if (requestKey !== newConversationDraftKey) {
          pendingChatRequestsRef.current.delete(requestKey);
        }
      }
      conversationMutationOwnersRef.current.clear();

      conversationStatesRef.current = {};
      dispatchConversation({ type: "reset_all" });
      setRunReplayStates({});
      setRunEventConnectionStates({});
      setRunSubscriptionContextRevision((current) => current + 1);
      setCancellingRunIds(new Set());
      setRetryingRunIds(new Set());
      setRegeneratingRunIds(new Set());
      setSelectingRunConversationIds(new Set());
      setFeedbackPendingMessageIds(new Set());
      setBranchingMessageKeys(new Set());
      setMutatingConversationIds(new Set());
      setActivityViews({});
      setCitationSourcesView(null);
      clearConversationSearchTarget();
      setConversationBrowserView(null);
      setRenameTarget(null);
      setDeleteTarget(null);
      setShareTargetConversationId(null);
      setIsBackgroundRunCenterOpen(false);
      setIsCreating(false);
      setRunCompletionNotifications(emptyRunCompletionNotificationQueue);
      runCompletionNotificationsRef.current =
        emptyRunCompletionNotificationQueue;
      conversationLoadedDepthRef.current = 0;

      const nextBootstrap: BootstrapResponse = {
        ...currentBootstrap,
        conversations: [],
        nextCursor: null,
        trackedConversations: [],
      };
      bootstrapRef.current = nextBootstrap;
      setBootstrap(nextBootstrap);
      detachedConversationRef.current = null;
      setDetachedConversation(null);
      setActiveConversation(null);
      navigateToConversation(null, "replace");
      setConversationBrowserVersion((current) => current + 1);

      if (localCleanupWarning) {
        setWorkspaceError(
          "对话已删除，但浏览器未能完整清理部分本地草稿；服务器仍会按过期策略回收未发送文件。",
        );
      }
      for (const attachmentId of stagedAttachmentIdsToDelete) {
        unpersistedAttachmentIdsRef.current.delete(attachmentId);
        void (async () => {
          try {
            const response = await deleteInputAttachment(attachmentId);
            if (response.deletion.attachmentId !== attachmentId) {
              throw new Error("批量清理附件返回了不一致的 attachmentId");
            }
          } catch (error) {
            if (
              error instanceof ApiClientError &&
              ((error.code === "NOT_FOUND" && error.status === 404) ||
                (error.code === "INVALID_REQUEST" && error.status === 409))
            ) {
              return;
            }
            setWorkspaceError(
              "对话操作已完成，但服务器暂时未能清理部分未发送附件；系统仍会按过期策略回收。",
            );
          }
        })();
      }
      signalWorkspaceBootstrapChanged();
    },
    [
      advanceConversationObservationRevision,
      clearConversationSearchTarget,
      clearLocalAttachmentDraft,
      drafts,
      executionProfileDrafts,
      invalidateConversationPageLoad,
      navigateToConversation,
      releaseUserMessageEditLocalResources,
      setActiveConversation,
      signalWorkspaceBootstrapChanged,
    ],
  );

  const performBulkConversationMutation = useCallback(
    async (
      action: "archive_all" | "delete_all",
    ): Promise<DataControlMutationResult> => {
      if (bulkConversationMutationPendingRef.current) {
        return {
          conversationCount: null,
          error: "另一项账户数据操作正在进行，请稍候。",
        };
      }
      if (
        isCreating ||
        pendingChatRequestsRef.current.has(newConversationDraftKey)
      ) {
        return {
          conversationCount: null,
          error: "新对话仍在提交或等待确认，请稍候再试。",
        };
      }
      if (conversationMutationOwnersRef.current.size > 0) {
        return {
          conversationCount: null,
          error: "仍有对话正在处理其他操作，请稍候再试。",
        };
      }

      bulkConversationMutationPendingRef.current = true;
      setWorkspaceError(null);
      try {
        const response =
          action === "archive_all"
            ? await archiveAllConversations()
            : await deleteAllConversations();
        if (response.mutation.action !== action) {
          throw new Error("批量管理对话返回了不一致的 action");
        }
        resetWorkspaceAfterBulkConversationMutation(action);
        return {
          conversationCount: response.mutation.conversationCount,
          error: null,
        };
      } catch (error) {
        return {
          conversationCount: null,
          error: bulkConversationMutationErrorMessage(error),
        };
      } finally {
        bulkConversationMutationPendingRef.current = false;
      }
    },
    [isCreating, resetWorkspaceAfterBulkConversationMutation],
  );

  const handleArchiveAllConversations = useCallback(
    () => performBulkConversationMutation("archive_all"),
    [performBulkConversationMutation],
  );

  const handleDeleteAllConversations = useCallback(
    () => performBulkConversationMutation("delete_all"),
    [performBulkConversationMutation],
  );

  const closeRenameDialog = useCallback(() => setRenameTarget(null), []);
  const closeDeleteDialog = useCallback(() => setDeleteTarget(null), []);
  const closeShareDialog = useCallback(
    () => setShareTargetConversationId(null),
    [],
  );

  const draftKey = activeConversationId ?? newConversationDraftKey;
  const draftScope = useMemo(
    () =>
      activeConversationId === null
        ? newConversationComposerDraftScope
        : conversationComposerDraftScope(activeConversationId),
    [activeConversationId],
  );
  const draft = drafts[draftKey] ?? "";
  const draftAttachments = useMemo(
    () => attachmentDrafts[draftKey] ?? [],
    [attachmentDrafts, draftKey],
  );
  const draftAttachmentError = attachmentDraftErrors[draftKey] ?? null;
  const draftAttachmentRecoveryState = attachmentDraftRecoveryStates[
    draftKey
  ] ?? { phase: "restoring" as const };
  const executionProfileCatalog = bootstrap?.executionProfiles ?? null;

  useLayoutEffect(() => {
    if (restoredDraftKeysRef.current.has(draftKey)) {
      return;
    }
    restoredDraftKeysRef.current.add(draftKey);
    const restoredDraft = readComposerDraft(window.localStorage, draftScope);
    if (restoredDraft === null) {
      return;
    }
    setDrafts((current) =>
      Object.hasOwn(current, draftKey)
        ? current
        : { ...current, [draftKey]: restoredDraft },
    );
  }, [draftKey, draftScope]);

  useLayoutEffect(() => {
    if (executionProfileCatalog === null) {
      return;
    }
    const restoredProfile = readExecutionProfileDraft(
      window.localStorage,
      draftScope,
      executionProfileCatalog,
    );
    if (restoredProfile === null) {
      return;
    }
    setExecutionProfileDrafts((current) =>
      current[draftKey] === restoredProfile
        ? current
        : { ...current, [draftKey]: restoredProfile },
    );
  }, [draftKey, draftScope, executionProfileCatalog]);

  useEffect(() => {
    const userId = bootstrap?.user.id;
    if (userId === undefined) {
      return;
    }

    const recoveryControllers = attachmentDraftRecoveryControllersRef.current;
    const restore = () => {
      void restoreAttachmentDraftScope(draftKey, draftScope, userId);
    };
    const handleStorage = (event: StorageEvent) => {
      if (
        event.storageArea === window.localStorage &&
        composerAttachmentDraftStorageEventAffectsScope(
          event.key,
          userId,
          draftScope,
        )
      ) {
        restore();
      }
    };

    restore();
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
      const controller = recoveryControllers.get(draftKey);
      controller?.abort();
      if (recoveryControllers.get(draftKey) === controller) {
        recoveryControllers.delete(draftKey);
      }
    };
  }, [
    bootstrap?.user.id,
    draftKey,
    draftScope,
    restoreAttachmentDraftScope,
  ]);

  const setDraft = useCallback(
    (value: string) => {
      writeComposerDraft(window.localStorage, draftScope, value);
      setDrafts((current) => ({ ...current, [draftKey]: value }));
    },
    [draftKey, draftScope],
  );
  const setExecutionProfileDraft = useCallback(
    (executionProfileId: ExecutionProfileId) => {
      writeExecutionProfileDraft(
        window.localStorage,
        draftScope,
        executionProfileId,
      );
      setExecutionProfileDrafts((current) => ({
        ...current,
        [draftKey]: executionProfileId,
      }));
    },
    [draftKey, draftScope],
  );
  const handleUsePrompt = useCallback(
    (prompt: string) => {
      setDraft(prompt);
      requestComposerFocus();
    },
    [requestComposerFocus, setDraft],
  );

  const handleFilesSelected = useCallback(
    (files: File[]) => {
      setAttachmentDraftError(draftKey, null);
      const current = attachmentDraftsRef.current[draftKey] ?? [];
      const limits = requiredInputAttachmentLimits(bootstrap);
      const acceptedFiles: Array<{
        draftAttachment: Extract<
          DraftInputAttachment,
          { status: "uploading" }
        >;
      }> = [];
      const selectionErrors: string[] = [];
      const reportedLimitErrors = new Set<string>();

      for (const file of files) {
        const validationError = validateInputAttachmentCandidate(file, limits);
        if (validationError !== null) {
          selectionErrors.push(`${file.name || "未命名附件"}：${validationError}`);
          continue;
        }
        const limitError = validateDraftInputAttachmentLimits(
          [
            ...current,
            ...acceptedFiles.map((item) => item.draftAttachment),
            { name: file.name, sizeBytes: file.size },
          ],
          limits,
        );
        if (limitError !== null) {
          if (!reportedLimitErrors.has(limitError)) {
            reportedLimitErrors.add(limitError);
            selectionErrors.push(limitError);
          }
          continue;
        }

        const mimeType = inputAttachmentMimeTypeForCandidate(file);
        const previewUrl = createInputAttachmentPreviewUrl(mimeType, () =>
          URL.createObjectURL(file),
        );
        if (previewUrl !== null) {
          attachmentPreviewUrlsRef.current.add(previewUrl);
        }
        const clientId = createClientId();
        const order = nextAttachmentDraftOrderToken(
          attachmentDraftOrderSequenceRef.current,
          clientId,
        );
        attachmentDraftOrderSequenceRef.current = order.sequence;
        attachmentDraftOrderTokensRef.current.set(clientId, order.token);
        const draftAttachment: Extract<
          DraftInputAttachment,
          { status: "uploading" }
        > = {
          clientId,
          file,
          name: file.name,
          mimeType,
          sizeBytes: file.size,
          previewUrl,
          status: "uploading",
        };
        acceptedFiles.push({ draftAttachment });
      }

      if (acceptedFiles.length > 0) {
        updateAttachmentDraft(draftKey, (attachments) => [
          ...attachments,
          ...acceptedFiles.map((item) => item.draftAttachment),
        ]);
        for (const item of acceptedFiles) {
          void uploadDraftInputAttachment(
            draftKey,
            item.draftAttachment,
          );
        }
      }
      if (selectionErrors.length > 0) {
        setAttachmentDraftError(draftKey, selectionErrors.join("\n"));
      }
    },
    [
      bootstrap,
      draftKey,
      setAttachmentDraftError,
      updateAttachmentDraft,
      uploadDraftInputAttachment,
    ],
  );

  const handleRetryDraftAttachment = useCallback(
    (clientId: string) => {
      const retry = retryDraftInputAttachment(
        attachmentDraftsRef.current[draftKey] ?? [],
        clientId,
      );
      if (retry.retryAttachment === null) {
        return;
      }

      updateAttachmentDraft(draftKey, () => retry.attachments);
      setAttachmentDraftError(draftKey, null);
      void uploadDraftInputAttachment(draftKey, retry.retryAttachment);
    },
    [
      draftKey,
      setAttachmentDraftError,
      updateAttachmentDraft,
      uploadDraftInputAttachment,
    ],
  );

  const handleRemoveDraftAttachment = useCallback(
    (clientId: string) => {
      const attachment = (attachmentDraftsRef.current[draftKey] ?? []).find(
        (item) => item.clientId === clientId,
      );
      if (attachment === undefined || attachment.status === "deleting") {
        return;
      }

      setAttachmentDraftError(draftKey, null);
      if (
        attachment.status === "uploading" ||
        attachment.status === "failed"
      ) {
        releaseDraftInputAttachmentResources(
          attachment,
          abortAttachmentUpload,
          revokeAttachmentPreview,
        );
        updateAttachmentDraft(draftKey, (current) =>
          removeDraftInputAttachment(current, clientId),
        );
        attachmentDraftOrderTokensRef.current.delete(clientId);
        return;
      }

      const uploadedAttachment = attachment;
      updateAttachmentDraft(draftKey, (current) =>
        replaceDraftInputAttachment(current, clientId, {
          ...uploadedAttachment,
          status: "deleting",
        }),
      );
      void (async () => {
        try {
          const response = await deleteInputAttachment(
            uploadedAttachment.attachment.id,
          );
          if (
            response.deletion.attachmentId !==
            uploadedAttachment.attachment.id
          ) {
            throw new Error("删除附件返回了不一致的 attachmentId");
          }
          // DELETE succeeds only for an attachment that is still staged. Its
          // fixed receipt therefore confirms that a retained chat request did
          // not bind this ID and can no longer succeed with its old payload.
          reconcilePendingChatRequestStoreAfterConfirmedAttachmentDeletion(
            pendingChatRequestsRef.current,
            draftKey,
            response.deletion.attachmentId,
          );
          updateAttachmentDraft(draftKey, (current) =>
            removeDraftInputAttachment(current, clientId),
          );
          const userId = bootstrapRef.current?.user.id;
          if (userId !== undefined) {
            const removal = removeComposerAttachmentDraft(
              window.localStorage,
              userId,
              draftScope,
              uploadedAttachment.attachment.id,
            );
            if (removal.status !== "removed") {
              setAttachmentDraftError(
                draftKey,
                "附件已从服务器移除，但浏览器未能清理对应草稿记录。",
              );
            }
          }
          unpersistedAttachmentIdsRef.current.delete(
            uploadedAttachment.attachment.id,
          );
          attachmentDraftOrderTokensRef.current.delete(clientId);
          revokeAttachmentPreview(uploadedAttachment.previewUrl);
        } catch (error) {
          if (
            error instanceof ApiClientError &&
            ((error.code === "NOT_FOUND" && error.status === 404) ||
              (error.code === "INVALID_REQUEST" && error.status === 409))
          ) {
            updateAttachmentDraft(draftKey, (current) =>
              removeDraftInputAttachment(current, clientId),
            );
            const userId = bootstrapRef.current?.user.id;
            if (userId !== undefined) {
              removeComposerAttachmentDraft(
                window.localStorage,
                userId,
                draftScope,
                uploadedAttachment.attachment.id,
              );
            }
            unpersistedAttachmentIdsRef.current.delete(
              uploadedAttachment.attachment.id,
            );
            attachmentDraftOrderTokensRef.current.delete(clientId);
            revokeAttachmentPreview(uploadedAttachment.previewUrl);
            setAttachmentDraftError(
              draftKey,
              "该附件已过期、删除或在其他页面发送，已从输入框移除。",
            );
            return;
          }
          updateAttachmentDraft(draftKey, (current) =>
            replaceDraftInputAttachment(current, clientId, uploadedAttachment),
          );
          setAttachmentDraftError(draftKey, errorMessage(error));
        }
      })();
    },
    [
      abortAttachmentUpload,
      draftKey,
      draftScope,
      revokeAttachmentPreview,
      setAttachmentDraftError,
      updateAttachmentDraft,
    ],
  );

  const handleSend = useCallback(async () => {
    const workspaceGeneration = workspaceGenerationRef.current;
    const message = draft.trim();
    if (draftAttachmentRecoveryState.phase !== "ready") {
      return;
    }
    if (bootstrap === null) {
      throw new Error("发送消息时工作区缺少 bootstrap 契约");
    }
    if (isCreating && activeConversationIdRef.current === null) {
      return;
    }
    const limits = requiredInputAttachmentLimits(bootstrap);
    const executionProfileId =
      executionProfileDrafts[draftKey] ??
      bootstrap.executionProfiles.defaultId;
    if (
      !bootstrap.executionProfiles.options.some(
        (profile) => profile.id === executionProfileId,
      )
    ) {
      setWorkspaceError(
        "草稿选择的执行模式已不可用，请重新选择后发送。",
      );
      return;
    }
    const attachmentLimitError = validateDraftInputAttachmentLimits(
      draftAttachments,
      limits,
    );
    if (attachmentLimitError !== null) {
      setAttachmentDraftError(draftKey, attachmentLimitError);
      return;
    }
    if (!canSubmitDraft(message, draftAttachments, limits)) {
      return;
    }
    const attachmentIds = attachmentIdsForSubmission(
      draftAttachments,
      limits,
    );
    const requestedConversationId = activeConversationIdRef.current;
    const pendingRequestKey =
      requestedConversationId ?? newConversationDraftKey;
    const currentState =
      requestedConversationId === null
        ? undefined
        : conversationStatesRef.current[requestedConversationId];
    if (
      requestedConversationId !== null &&
      (currentState === undefined || !currentState.isLoaded)
    ) {
      dispatchConversation({
        type: "set_error",
        conversationId: requestedConversationId,
        message: "会话尚未完整加载，暂时不能发送消息。",
      });
      return;
    }
    if (currentState?.isStarting === true) {
      return;
    }

    let parentRunId: string | null = null;
    if (requestedConversationId !== null) {
      if (currentState === undefined) {
        throw new Error(`会话 ${requestedConversationId} 缺少已加载状态`);
      }
      const conversation = requiredConversationSummary(
        bootstrapRef.current,
        detachedConversationRef.current,
        requestedConversationId,
      );
      if (
        (currentState.runs.length === 0 &&
          conversation.selectedRunId !== null) ||
        (currentState.runs.length > 0 && conversation.selectedRunId === null)
      ) {
        throw new Error("会话 selectedRunId 与 Run 图不一致");
      }
      if (
        conversation.selectedRunId !== null &&
        !currentState.runs.some(
          (run) => run.id === conversation.selectedRunId,
        )
      ) {
        throw new Error(
          `会话 selectedRunId ${conversation.selectedRunId} 不存在`,
        );
      }
      parentRunId = conversation.selectedRunId;
    }

    const requestCandidate: ChatRequest = {
      kind: "append",
      conversationId: requestedConversationId,
      parentRunId,
      message,
      attachmentIds,
      requestId: createClientId(),
      executionProfileId,
    };
    const pendingRequest =
      pendingChatRequestsRef.current.get(pendingRequestKey);
    if (
      pendingRequest !== undefined &&
      !chatRequestsHaveSamePayload(pendingRequest, requestCandidate)
    ) {
      const pendingRequestError =
        "上一条消息的发送结果尚未确认。请恢复原内容后重试；系统会复用同一个请求 ID，避免重复运行。";
      if (requestedConversationId === null) {
        setWorkspaceError(pendingRequestError);
      } else {
        dispatchConversation({
          type: "set_error",
          conversationId: requestedConversationId,
          message: pendingRequestError,
        });
      }
      return;
    }
    const mutationOwner = {};
    const ownsConversationMutation =
      requestedConversationId !== null &&
      beginConversationMutation(requestedConversationId, mutationOwner);
    if (
      requestedConversationId !== null &&
      !ownsConversationMutation
    ) {
      dispatchConversation({
        type: "set_error",
        conversationId: requestedConversationId,
        message: "该对话正在处理其他操作，请稍候。",
      });
      return;
    }
    const request = pendingRequest ?? requestCandidate;
    pendingChatRequestsRef.current.set(pendingRequestKey, request);
    if (requestedConversationId === null) {
      setIsCreating(true);
      setWorkspaceError(null);
    } else {
      dispatchConversation({
        type: "run_starting",
        conversationId: requestedConversationId,
      });
    }
    const creditMutationRevision = beginCreditMutation();

    try {
      const response = await startChat(request);
      if (!workspaceOperationIsCurrent(workspaceGeneration)) {
        return;
      }
      const conversationId = response.conversation.id;
      if (
        (requestedConversationId !== null &&
          conversationId !== requestedConversationId) ||
        response.run.conversationId !== conversationId ||
        response.run.predecessorRunId !== parentRunId ||
        response.run.executionConfig.provenance !== "captured" ||
        response.run.executionConfig.executionProfileId !==
          request.executionProfileId ||
        response.conversation.selectedRunId !== response.run.id
      ) {
        throw new Error("启动运行返回了不一致的会话分支");
      }
      advanceConversationObservationRevision(conversationId);
      dispatchConversation({
        type: "run_started",
        conversationId,
        response,
      });
      if (
        shouldActivateCreatedConversation({
          requestedConversationId,
          activeConversationId: activeConversationIdRef.current,
        })
      ) {
        setActiveConversation(conversationId);
        setDetachedConversation(null);
        navigateToConversation(conversationId, "replace");
      }
      updateActivityView(conversationId, { runId: response.run.id });
      commitMutationCredits(response.credits, creditMutationRevision);
      setBootstrap((current) => {
        if (current === null) {
          return current;
        }
        return {
          ...current,
          conversations: upsertConversationSummary(
            current.conversations,
            summaryAtAcknowledgedReadWatermark(response.conversation),
          ),
        };
      });
      removeComposerDraft(window.localStorage, draftScope);
      for (const attachmentId of attachmentIds) {
        const removal = removeComposerAttachmentDraft(
          window.localStorage,
          bootstrap.user.id,
          draftScope,
          attachmentId,
        );
        if (removal.status !== "removed") {
          setAttachmentDraftError(
            draftKey,
            "消息已发送，但浏览器未能清理对应附件草稿记录；下次恢复会再次向服务器确认。",
          );
        }
        unpersistedAttachmentIdsRef.current.delete(attachmentId);
      }
      setDrafts((current) => {
        const next = { ...current };
        delete next[draftKey];
        next[conversationId] = "";
        return next;
      });
      writeExecutionProfileDraft(
        window.localStorage,
        conversationComposerDraftScope(conversationId),
        request.executionProfileId,
      );
      setExecutionProfileDrafts((current) => ({
        ...current,
        [conversationId]: request.executionProfileId,
      }));
      clearLocalAttachmentDraft(draftKey);
      setAttachmentDraftRecoveryState(draftKey, { phase: "ready" });
      pendingChatRequestsRef.current.delete(pendingRequestKey);
      ensureRunSubscription(conversationId, response.run.id, "active", {
        knownRun: response.run,
        existingEvents: [],
      });
      signalWorkspaceBootstrapChanged();
    } catch (error) {
      if (!workspaceOperationIsCurrent(workspaceGeneration)) {
        return;
      }
      const failureResult = await recoverChatSubmissionFailure({
        conversationId: requestedConversationId,
        error,
        pendingRequestKey,
        submittedRequest: request,
      });
      if (!workspaceOperationIsCurrent(workspaceGeneration)) {
        return;
      }
      if (!failureResult.handled) {
        return;
      }
      if (requestedConversationId === null) {
        setWorkspaceError(failureResult.message);
      } else {
        dispatchConversation(
          failureResult.reloadFailed
            ? {
                type: "conversation_reload_required",
                conversationId: requestedConversationId,
                message: failureResult.message,
              }
            : {
                type: "run_start_failed",
                conversationId: requestedConversationId,
                message: failureResult.message,
              },
        );
      }
    } finally {
      const operationIsCurrent =
        workspaceOperationIsCurrent(workspaceGeneration);
      finishCreditMutation(creditMutationRevision, operationIsCurrent);
      if (operationIsCurrent) {
        if (requestedConversationId === null) {
          setIsCreating(false);
        } else if (ownsConversationMutation) {
          finishConversationMutation(
            requestedConversationId,
            mutationOwner,
          );
        }
      }
    }
  }, [
    advanceConversationObservationRevision,
    beginCreditMutation,
    beginConversationMutation,
    bootstrap,
    clearLocalAttachmentDraft,
    commitMutationCredits,
    draft,
    draftAttachmentRecoveryState.phase,
    draftAttachments,
    draftKey,
    draftScope,
    ensureRunSubscription,
    executionProfileDrafts,
    finishCreditMutation,
    finishConversationMutation,
    isCreating,
    navigateToConversation,
    recoverChatSubmissionFailure,
    setActiveConversation,
    setAttachmentDraftError,
    setAttachmentDraftRecoveryState,
    signalWorkspaceBootstrapChanged,
    summaryAtAcknowledgedReadWatermark,
    updateActivityView,
    workspaceOperationIsCurrent,
  ]);

  const beginUserMessageEdit = useCallback(
    (conversationId: string, message: ChatMessage) => {
      if (message.role !== "user") {
        throw new Error(`消息 ${message.id} 不是用户消息`);
      }
      mutateUserMessageEdit(conversationId, (current) => {
        if (
          current?.isSaving === true ||
          (current !== null && current.messageId !== message.id)
        ) {
          return current;
        }
        return {
          conversationId,
          messageId: message.id,
          value: message.content,
          retainedAttachmentIds: message.attachments.map(
            (attachment) => attachment.id,
          ),
          newAttachments: [],
          attachmentError: null,
          isSaving: false,
          error: null,
        };
      });
    },
    [mutateUserMessageEdit],
  );

  const selectUserMessageEditFiles = useCallback(
    (conversationId: string, message: ChatMessage, files: File[]) => {
      const current = userMessageEditsRef.current[conversationId];
      if (
        current === undefined ||
        current.messageId !== message.id ||
        current.isSaving
      ) {
        return;
      }
      const limits = requiredInputAttachmentLimits(bootstrapRef.current);
      const retainedAttachments = retainedUserMessageAttachments(
        message,
        current.retainedAttachmentIds,
      );
      const acceptedFiles: Array<{
        draftAttachment: Extract<
          DraftInputAttachment,
          { status: "uploading" }
        >;
      }> = [];
      const selectionErrors: string[] = [];
      const reportedLimitErrors = new Set<string>();

      for (const file of files) {
        const validationError = validateInputAttachmentCandidate(file, limits);
        if (validationError !== null) {
          selectionErrors.push(
            `${file.name || "未命名附件"}：${validationError}`,
          );
          continue;
        }
        const limitError = validateDraftInputAttachmentLimits(
          [
            ...retainedAttachments,
            ...current.newAttachments,
            ...acceptedFiles.map((item) => item.draftAttachment),
            { name: file.name, sizeBytes: file.size },
          ],
          limits,
        );
        if (limitError !== null) {
          if (!reportedLimitErrors.has(limitError)) {
            reportedLimitErrors.add(limitError);
            selectionErrors.push(limitError);
          }
          continue;
        }

        const mimeType = inputAttachmentMimeTypeForCandidate(file);
        const previewUrl = createInputAttachmentPreviewUrl(mimeType, () =>
          URL.createObjectURL(file),
        );
        if (previewUrl !== null) {
          attachmentPreviewUrlsRef.current.add(previewUrl);
        }
        acceptedFiles.push({
          draftAttachment: {
            clientId: createClientId(),
            file,
            name: file.name,
            mimeType,
            sizeBytes: file.size,
            previewUrl,
            status: "uploading",
          },
        });
      }

      mutateUserMessageEdit(conversationId, (latest) => {
        if (latest === null || latest.messageId !== message.id) {
          return latest;
        }
        return {
          ...latest,
          newAttachments: [
            ...latest.newAttachments,
            ...acceptedFiles.map((item) => item.draftAttachment),
          ],
          attachmentError:
            selectionErrors.length === 0
              ? null
              : selectionErrors.join("\n"),
          error: null,
        };
      });
      for (const item of acceptedFiles) {
        void uploadUserMessageEditAttachment(
          conversationId,
          message.id,
          item.draftAttachment,
        );
      }
    },
    [mutateUserMessageEdit, uploadUserMessageEditAttachment],
  );

  const removeRetainedUserMessageAttachment = useCallback(
    (conversationId: string, messageId: string, attachmentId: string) => {
      mutateUserMessageEdit(conversationId, (current) => {
        if (
          current === null ||
          current.messageId !== messageId ||
          current.isSaving
        ) {
          return current;
        }
        if (!current.retainedAttachmentIds.includes(attachmentId)) {
          throw new Error(
            `消息编辑状态不包含待移除附件 ${attachmentId}`,
          );
        }
        return {
          ...current,
          retainedAttachmentIds: current.retainedAttachmentIds.filter(
            (candidate) => candidate !== attachmentId,
          ),
          attachmentError: null,
          error: null,
        };
      });
    },
    [mutateUserMessageEdit],
  );

  const retryUserMessageEditAttachment = useCallback(
    (conversationId: string, messageId: string, clientId: string) => {
      const current = userMessageEditsRef.current[conversationId];
      if (
        current === undefined ||
        current.messageId !== messageId ||
        current.isSaving
      ) {
        return;
      }
      const retry = retryDraftInputAttachment(
        current.newAttachments,
        clientId,
      );
      if (retry.retryAttachment === null) {
        return;
      }
      mutateUserMessageEdit(conversationId, (latest) =>
        latest === null || latest.messageId !== messageId
          ? latest
          : {
              ...latest,
              newAttachments: retry.attachments,
              attachmentError: null,
              error: null,
            },
      );
      void uploadUserMessageEditAttachment(
        conversationId,
        messageId,
        retry.retryAttachment,
      );
    },
    [mutateUserMessageEdit, uploadUserMessageEditAttachment],
  );

  const removeNewUserMessageEditAttachment = useCallback(
    async (
      conversationId: string,
      messageId: string,
      clientId: string,
    ): Promise<boolean> => {
      const edit = userMessageEditsRef.current[conversationId];
      if (
        edit === undefined ||
        edit.messageId !== messageId ||
        edit.isSaving
      ) {
        return false;
      }
      const attachment = edit.newAttachments.find(
        (candidate) => candidate.clientId === clientId,
      );
      if (attachment === undefined || attachment.status === "deleting") {
        return false;
      }

      if (
        attachment.status === "uploading" ||
        attachment.status === "failed"
      ) {
        releaseDraftInputAttachmentResources(
          attachment,
          abortAttachmentUpload,
          revokeAttachmentPreview,
        );
        mutateUserMessageEdit(conversationId, (current) =>
          current === null || current.messageId !== messageId
            ? current
            : {
                ...current,
                newAttachments: removeDraftInputAttachment(
                  current.newAttachments,
                  clientId,
                ),
                attachmentError: null,
                error: null,
              },
        );
        return true;
      }

      const uploadedAttachment = attachment;
      mutateUserMessageEdit(conversationId, (current) =>
        current === null || current.messageId !== messageId
          ? current
          : {
              ...current,
              newAttachments: replaceDraftInputAttachment(
                current.newAttachments,
                clientId,
                { ...uploadedAttachment, status: "deleting" },
              ),
              attachmentError: null,
              error: null,
            },
      );
      try {
        const response = await deleteInputAttachment(
          uploadedAttachment.attachment.id,
        );
        if (
          response.deletion.attachmentId !== uploadedAttachment.attachment.id
        ) {
          throw new Error("删除附件返回了不一致的 attachmentId");
        }
        reconcilePendingChatRequestStoreAfterConfirmedAttachmentDeletion(
          pendingChatRequestsRef.current,
          userMessageEditPendingRequestKey(conversationId, messageId),
          response.deletion.attachmentId,
        );
        mutateUserMessageEdit(conversationId, (current) =>
          current === null || current.messageId !== messageId
            ? current
            : {
                ...current,
                newAttachments: removeDraftInputAttachment(
                  current.newAttachments,
                  clientId,
                ),
              },
        );
        revokeAttachmentPreview(uploadedAttachment.previewUrl);
        return true;
      } catch (error) {
        mutateUserMessageEdit(conversationId, (current) =>
          current === null || current.messageId !== messageId
            ? current
            : {
                ...current,
                newAttachments: replaceDraftInputAttachment(
                  current.newAttachments,
                  clientId,
                  uploadedAttachment,
                ),
                attachmentError: errorMessage(error),
              },
        );
        return false;
      }
    },
    [
      abortAttachmentUpload,
      mutateUserMessageEdit,
      revokeAttachmentPreview,
    ],
  );

  const dismissUserMessageEditAttachmentError = useCallback(
    (conversationId: string, messageId: string) => {
      mutateUserMessageEdit(conversationId, (current) =>
        current === null || current.messageId !== messageId
          ? current
          : { ...current, attachmentError: null },
      );
    },
    [mutateUserMessageEdit],
  );

  const changeUserMessageEdit = useCallback(
    (conversationId: string, messageId: string, value: string) => {
      mutateUserMessageEdit(conversationId, (current) => {
        if (
          current === null ||
          current.conversationId !== conversationId ||
          current.messageId !== messageId ||
          current.isSaving
        ) {
          return current;
        }
        return { ...current, value, error: null };
      });
    },
    [mutateUserMessageEdit],
  );

  const cancelUserMessageEdit = useCallback(
    async (conversationId: string, messageId: string) => {
      const edit = userMessageEditsRef.current[conversationId];
      if (
        edit === undefined ||
        edit.messageId !== messageId ||
        edit.isSaving
      ) {
        return;
      }
      if (
        edit.newAttachments.some(
          (attachment) => attachment.status === "deleting",
        )
      ) {
        mutateUserMessageEdit(conversationId, (current) =>
          current === null || current.messageId !== messageId
            ? current
            : {
                ...current,
                attachmentError: "附件正在移除，请稍候再取消编辑。",
              },
        );
        return;
      }

      const removalResults = await Promise.all(
        edit.newAttachments.map((attachment) =>
          removeNewUserMessageEditAttachment(
            conversationId,
            messageId,
            attachment.clientId,
          ),
        ),
      );
      if (removalResults.some((removed) => !removed)) {
        return;
      }
      mutateUserMessageEdit(conversationId, (current) =>
        current?.messageId === messageId &&
        !current.isSaving &&
        current.newAttachments.length === 0
          ? null
          : current,
      );
    },
    [mutateUserMessageEdit, removeNewUserMessageEditAttachment],
  );

  const handleEditUserMessage = useCallback(
    async (
      conversationId: string,
      turn: ConversationTurnProjection,
    ) => {
      const workspaceGeneration = workspaceGenerationRef.current;
      const sourceMessage = turn.inputMessage;
      if (sourceMessage.role !== "user") {
        throw new Error(`消息 ${sourceMessage.id} 不是用户消息`);
      }
      const firstAttempt = turn.attempts[0];
      if (
        firstAttempt === undefined ||
        sourceMessage.runId !== firstAttempt.run.id ||
        firstAttempt.run.inputMessageId !== sourceMessage.id ||
        firstAttempt.run.attemptIndex !== 1
      ) {
        throw new Error(`用户消息 ${sourceMessage.id} 缺少合法的首个 Run`);
      }
      const edit = userMessageEditsRef.current[conversationId];
      if (edit === undefined || edit.messageId !== sourceMessage.id) {
        throw new Error(`用户消息 ${sourceMessage.id} 缺少编辑状态`);
      }
      if (userMessageEditHasPendingAttachments(edit)) {
        mutateUserMessageEdit(conversationId, (current) =>
          current === null || current.messageId !== sourceMessage.id
            ? current
            : {
                ...current,
                attachmentError: "请等待所有新增附件处理完成后再保存。",
              },
        );
        return;
      }
      const retainedAttachments = retainedUserMessageAttachments(
        sourceMessage,
        edit.retainedAttachmentIds,
      );
      const attachmentLimitError = validateDraftInputAttachmentLimits(
        [...retainedAttachments, ...edit.newAttachments],
        requiredInputAttachmentLimits(bootstrapRef.current),
      );
      if (attachmentLimitError !== null) {
        mutateUserMessageEdit(conversationId, (current) =>
          current === null || current.messageId !== sourceMessage.id
            ? current
            : { ...current, attachmentError: attachmentLimitError },
        );
        return;
      }
      const message = edit.value.trim();
      const attachmentIds = userMessageEditAttachmentIds(edit);
      const originalAttachmentIds = sourceMessage.attachments.map(
        (attachment) => attachment.id,
      );
      const attachmentsChanged =
        attachmentIds.length !== originalAttachmentIds.length ||
        attachmentIds.some(
          (attachmentId, index) =>
            attachmentId !== originalAttachmentIds[index],
        );
      if (
        (message === sourceMessage.content && !attachmentsChanged) ||
        (message.length === 0 && attachmentIds.length === 0)
      ) {
        return;
      }
      const state = conversationStatesRef.current[conversationId];
      if (state === undefined || !state.isLoaded) {
        throw new Error(`会话 ${conversationId} 尚未完整加载`);
      }
      const conversation = requiredConversationSummary(
        bootstrapRef.current,
        detachedConversationRef.current,
        conversationId,
      );
      const locallyOutstanding = state.runs.some((run) => {
        const status = effectiveRunStatus(run, eventsForRun(state, run.id));
        return status === "waiting" || isActiveRunStatus(status);
      });
      if (
        conversationHasOutstandingRuns(conversation) ||
        locallyOutstanding
      ) {
        mutateUserMessageEdit(conversationId, (current) =>
          current?.conversationId === conversationId &&
          current.messageId === sourceMessage.id
            ? {
                ...current,
                error:
                  "研究正在运行或等待中，完成或停止后才能编辑消息。",
              }
            : current,
        );
        return;
      }
      if (state.isStarting) {
        mutateUserMessageEdit(conversationId, (current) =>
          current?.conversationId === conversationId &&
          current.messageId === sourceMessage.id
            ? { ...current, error: "该会话正在提交另一条消息，请稍候。" }
            : current,
        );
        return;
      }

      const requestCandidate = editChatRequestForTurn({
        attachmentIds,
        conversationId,
        message,
        requestId: createClientId(),
        turn,
      });
      const pendingRequestKey = userMessageEditPendingRequestKey(
        conversationId,
        sourceMessage.id,
      );
      const pendingRequest = pendingChatRequestsRef.current.get(
        pendingRequestKey,
      );
      if (
        pendingRequest !== undefined &&
        !chatRequestsHaveSamePayload(pendingRequest, requestCandidate)
      ) {
        mutateUserMessageEdit(conversationId, (current) =>
          current?.conversationId === conversationId &&
          current.messageId === sourceMessage.id
            ? {
                ...current,
                error:
                  "上一次编辑结果尚未确认。请恢复上次提交的内容后重试，以避免重复运行。",
              }
            : current,
        );
        return;
      }
      const mutationOwner = {};
      if (!beginConversationMutation(conversationId, mutationOwner)) {
        mutateUserMessageEdit(conversationId, (current) =>
          current?.conversationId === conversationId &&
          current.messageId === sourceMessage.id
            ? {
                ...current,
                error: "该对话正在处理其他操作，请稍候。",
              }
            : current,
        );
        return;
      }
      const request = pendingRequest ?? requestCandidate;
      pendingChatRequestsRef.current.set(pendingRequestKey, request);
      mutateUserMessageEdit(conversationId, (current) =>
        current?.conversationId === conversationId &&
        current.messageId === sourceMessage.id
          ? { ...current, isSaving: true, error: null }
          : current,
      );
      dispatchConversation({ type: "run_starting", conversationId });
      const creditMutationRevision = beginCreditMutation();

      try {
        const response = await startChat(request);
        if (!workspaceOperationIsCurrent(workspaceGeneration)) {
          return;
        }
        if (
          response.conversation.id !== conversationId ||
          response.conversation.selectedRunId !== response.run.id ||
          response.run.conversationId !== conversationId ||
          response.run.inputMessageId !== response.userMessage.id ||
          response.run.inputMessageId === sourceMessage.id ||
          response.run.conversationTurn !== turn.conversationTurn ||
          response.run.attemptIndex !== 1 ||
          response.run.predecessorRunId !== firstAttempt.run.predecessorRunId ||
          response.run.retryOfRunId !== null ||
          response.run.regenerateOfRunId !== null ||
          response.run.executionConfig.provenance !== "captured" ||
          response.run.executionConfig.executionProfileId !==
            request.executionProfileId ||
          response.userMessage.role !== "user"
        ) {
          throw new Error("编辑消息返回了不一致的新分支");
        }
        const returnedAttachmentIds = response.userMessage.attachments.map(
          (attachment) => attachment.id,
        );
        if (
          returnedAttachmentIds.length !== attachmentIds.length ||
          returnedAttachmentIds.some(
            (attachmentId, index) => attachmentId !== attachmentIds[index],
          )
        ) {
          throw new Error("编辑消息返回的附件顺序与提交内容不一致");
        }

        advanceConversationObservationRevision(conversationId);
        dispatchConversation({
          type: "run_started",
          conversationId,
          response,
        });
        commitMutationCredits(response.credits, creditMutationRevision);
        setBootstrap((current) =>
          current === null
            ? current
            : {
                ...current,
                conversations: upsertConversationSummary(
                  current.conversations,
                  summaryAtAcknowledgedReadWatermark(response.conversation),
                ),
              },
        );
        updateActivityView(conversationId, { runId: response.run.id });
        pendingChatRequestsRef.current.delete(pendingRequestKey);
        releaseUserMessageEditLocalResources(edit);
        mutateUserMessageEdit(conversationId, (current) =>
          current?.conversationId === conversationId &&
          current.messageId === sourceMessage.id
            ? null
            : current,
        );
        ensureRunSubscription(conversationId, response.run.id, "active", {
          knownRun: response.run,
          existingEvents: [],
        });
        signalWorkspaceBootstrapChanged();
      } catch (error) {
        if (!workspaceOperationIsCurrent(workspaceGeneration)) {
          return;
        }
        const failureResult = await recoverChatSubmissionFailure({
          conversationId,
          error,
          pendingRequestKey,
          submittedRequest: request,
        });
        if (!workspaceOperationIsCurrent(workspaceGeneration)) {
          return;
        }
        if (!failureResult.handled) {
          return;
        }
        dispatchConversation(
          failureResult.reloadFailed
            ? {
                type: "conversation_reload_required",
                conversationId,
                message: failureResult.message,
              }
            : {
                type: "run_start_failed",
                conversationId,
                message: failureResult.message,
              },
        );
        mutateUserMessageEdit(conversationId, (current) =>
          current?.conversationId === conversationId &&
          current.messageId === sourceMessage.id
            ? {
                ...current,
                isSaving: false,
                error: failureResult.message,
              }
            : current,
        );
      } finally {
        const operationIsCurrent =
          workspaceOperationIsCurrent(workspaceGeneration);
        finishCreditMutation(creditMutationRevision, operationIsCurrent);
        if (operationIsCurrent) {
          finishConversationMutation(conversationId, mutationOwner);
        }
      }
    },
    [
      advanceConversationObservationRevision,
      beginCreditMutation,
      beginConversationMutation,
      commitMutationCredits,
      ensureRunSubscription,
      finishCreditMutation,
      finishConversationMutation,
      mutateUserMessageEdit,
      recoverChatSubmissionFailure,
      releaseUserMessageEditLocalResources,
      signalWorkspaceBootstrapChanged,
      summaryAtAcknowledgedReadWatermark,
      updateActivityView,
      workspaceOperationIsCurrent,
    ],
  );

  const handleCancelRun = useCallback(async (runId: string) => {
    const workspaceGeneration = workspaceGenerationRef.current;
    const conversationId = activeConversationIdRef.current;
    if (conversationId === null || cancellingRunIds.has(runId)) {
      return;
    }
    const targetRun = conversationStatesRef.current[conversationId]?.runs.find(
      (run) => run.id === runId,
    );
    if (targetRun === undefined) {
      throw new Error(`当前会话缺少待取消的 Run ${runId}`);
    }
    const observationRevisionAtRequestStart =
      conversationObservationRevision(conversationId);

    setCancellingRunIds((current) => new Set(current).add(runId));
    let cancellationIsPending = false;
    try {
      const response = await cancelRun(runId);
      if (!workspaceOperationIsCurrent(workspaceGeneration)) {
        return;
      }
      if (
        response.run.id !== runId ||
        response.run.conversationId !== conversationId ||
        JSON.stringify(response.run.executionConfig) !==
          JSON.stringify(targetRun.executionConfig)
      ) {
        throw new Error("取消运行返回了不一致的 Run");
      }
      cancellationIsPending = isActiveRunStatus(response.run.status);
      signalWorkspaceBootstrapChanged();
      if (
        !shouldCommitCancelRunResponse({
          observationRevisionAtRequestStart,
          currentObservationRevision:
            conversationObservationRevision(conversationId),
        })
      ) {
        return;
      }
      advanceConversationObservationRevision(conversationId);
      dispatchConversation({
        type: "run_updated",
        conversationId,
        run: response.run,
      });
      if (!isActiveRunStatus(response.run.status)) {
        setBootstrap((current) => {
          if (current === null) {
            return current;
          }
          return {
            ...current,
            conversations: current.conversations.map((conversation) =>
              conversation.id === conversationId &&
              conversation.activeRun?.id === response.run.id
                ? { ...conversation, activeRun: null }
                : conversation,
              ),
            };
          });
        const loadResult = await loadConversation(conversationId);
        if (!workspaceOperationIsCurrent(workspaceGeneration)) {
          return;
        }
        const terminalEventId =
          loadResult.status === "loaded"
            ? loadResult.detail.conversation.attention?.terminalEventId
            : undefined;
        if (terminalEventId === undefined) {
          return;
        }
        const creditOperationRevisionAtRefreshStart =
          beginTerminalCreditSnapshotOperation(terminalEventId);
        if (creditOperationRevisionAtRefreshStart === null) {
          return;
        }
        const creditMutationRevisionAtRefreshStart =
          creditMutationRevisionRef.current;
        const nonTerminalCreditSnapshotRevisionAtRefreshStart =
          nonTerminalCreditSnapshotRevisionRef.current;
        const nextBootstrap = await getBootstrap();
        if (!workspaceOperationIsCurrent(workspaceGeneration)) {
          return;
        }
        const shouldCommitCredits =
          shouldCommitCreditOperationResponse({
            responseOperationRevision: creditOperationRevisionAtRefreshStart,
            currentOperationRevision: creditOperationRevisionRef.current,
            source: "snapshot",
            hasPendingLocalMutation:
              pendingCreditMutationRevisionsRef.current.size > 0,
          }) &&
          shouldCommitTerminalCreditsAtRevision({
            latestCommittedTerminalEventId:
              latestCreditTerminalEventIdRef.current,
            terminalEventId,
            creditMutationRevisionAtRefreshStart,
            currentCreditMutationRevision: creditMutationRevisionRef.current,
            nonTerminalCreditSnapshotRevisionAtRefreshStart,
            currentNonTerminalCreditSnapshotRevision:
              nonTerminalCreditSnapshotRevisionRef.current,
          });
        if (shouldCommitCredits) {
          latestCreditTerminalEventIdRef.current = terminalEventId;
          commitTerminalCredits(nextBootstrap.credits);
        }
      }
    } catch (error) {
      if (!workspaceOperationIsCurrent(workspaceGeneration)) {
        return;
      }
      dispatchConversation({
        type: "set_error",
        conversationId,
        message: errorMessage(error),
      });
    } finally {
      if (
        workspaceOperationIsCurrent(workspaceGeneration) &&
        !cancellationIsPending
      ) {
        setCancellingRunIds((current) => {
          const next = new Set(current);
          next.delete(runId);
          return next;
        });
      }
    }
  }, [
    advanceConversationObservationRevision,
    beginTerminalCreditSnapshotOperation,
    cancellingRunIds,
    commitTerminalCredits,
    conversationObservationRevision,
    loadConversation,
    signalWorkspaceBootstrapChanged,
    workspaceOperationIsCurrent,
  ]);

  const handleRetryRun = useCallback(async (sourceRunId: string) => {
    const workspaceGeneration = workspaceGenerationRef.current;
    const conversationId = activeConversationIdRef.current;
    if (conversationId === null || retryingRunIds.has(sourceRunId)) {
      return;
    }
    const sourceRun = conversationStatesRef.current[conversationId]?.runs.find(
      (run) => run.id === sourceRunId,
    );
    if (sourceRun === undefined) {
      throw new Error(`当前会话缺少待重试的 Run ${sourceRunId}`);
    }
    const mutationOwner = {};
    if (!beginConversationMutation(conversationId, mutationOwner)) {
      dispatchConversation({
        type: "set_error",
        conversationId,
        message: "该对话正在处理其他操作，请稍候。",
      });
      return;
    }

    const requestId =
      pendingRetryRequestIdsRef.current.get(sourceRunId) ?? createClientId();
    pendingRetryRequestIdsRef.current.set(sourceRunId, requestId);
    setRetryingRunIds((current) => new Set(current).add(sourceRunId));
    const creditMutationRevision = beginCreditMutation();

    try {
      const response = await retryRun(sourceRunId, { requestId });
      if (!workspaceOperationIsCurrent(workspaceGeneration)) {
        return;
      }
      if (
        response.run.retryOfRunId !== sourceRunId ||
        JSON.stringify(response.run.executionConfig) !==
          JSON.stringify(sourceRun.executionConfig) ||
        response.run.conversationId !== conversationId ||
        response.conversation.id !== conversationId ||
        response.conversation.selectedRunId === null
      ) {
        throw new Error("重试运行返回了不一致的 Run");
      }
      advanceConversationObservationRevision(conversationId);
      dispatchConversation({
        type: "run_updated",
        conversationId,
        run: response.run,
      });
      commitMutationCredits(response.credits, creditMutationRevision);
      commitConversationSummary(response.conversation);
      updateActivityView(conversationId, { runId: response.run.id });
      ensureRunSubscription(conversationId, response.run.id, "active", {
        knownRun: response.run,
        existingEvents: [],
      });
      signalWorkspaceBootstrapChanged();
      const loadResult = await loadConversation(conversationId);
      if (!workspaceOperationIsCurrent(workspaceGeneration)) {
        return;
      }
      if (loadResult.status === "loaded") {
        const detail = loadResult.detail;
        const reloadedRun = detail.runs.find(
          (run) => run.id === response.run.id,
        );
        if (reloadedRun === undefined) {
          throw new Error("重载会话后缺少新建的重试 Run");
        }
        if (
          detail.conversation.selectedRunId !==
          response.conversation.selectedRunId
        ) {
          throw new Error("重载会话后 selectedRunId 与重试响应不一致");
        }
        const expectedSelectedRunId = resolveLatestReachableLeafRunId(
          { messages: detail.messages, runs: detail.runs },
          response.run.id,
        );
        if (detail.conversation.selectedRunId !== expectedSelectedRunId) {
          throw new Error("重试后 selectedRunId 不是新 Run 的最深可达叶子");
        }
        pendingRetryRequestIdsRef.current.delete(sourceRunId);
      }
    } catch (error) {
      if (!workspaceOperationIsCurrent(workspaceGeneration)) {
        return;
      }
      if (!shouldRetainPendingChatRequest(error)) {
        pendingRetryRequestIdsRef.current.delete(sourceRunId);
      }
      dispatchConversation({
        type: "set_error",
        conversationId,
        message: errorMessage(error),
      });
    } finally {
      const operationIsCurrent =
        workspaceOperationIsCurrent(workspaceGeneration);
      finishCreditMutation(creditMutationRevision, operationIsCurrent);
      if (operationIsCurrent) {
        setRetryingRunIds((current) => {
          const next = new Set(current);
          next.delete(sourceRunId);
          return next;
        });
        finishConversationMutation(conversationId, mutationOwner);
      }
    }
  }, [
    advanceConversationObservationRevision,
    beginCreditMutation,
    beginConversationMutation,
    commitConversationSummary,
    commitMutationCredits,
    ensureRunSubscription,
    finishCreditMutation,
    finishConversationMutation,
    loadConversation,
    retryingRunIds,
    signalWorkspaceBootstrapChanged,
    updateActivityView,
    workspaceOperationIsCurrent,
  ]);

  const handleRegenerateRun = useCallback(async (sourceRunId: string) => {
    const workspaceGeneration = workspaceGenerationRef.current;
    const conversationId = activeConversationIdRef.current;
    if (conversationId === null || regeneratingRunIds.has(sourceRunId)) {
      return;
    }
    const sourceRun = conversationStatesRef.current[conversationId]?.runs.find(
      (run) => run.id === sourceRunId,
    );
    if (sourceRun === undefined) {
      throw new Error(`当前会话缺少待重新生成的 Run ${sourceRunId}`);
    }
    if (sourceRun.status !== "completed") {
      throw new Error(`Run ${sourceRunId} 不是已完成回答`);
    }
    const mutationOwner = {};
    if (!beginConversationMutation(conversationId, mutationOwner)) {
      dispatchConversation({
        type: "set_error",
        conversationId,
        message: "该对话正在处理其他操作，请稍候。",
      });
      return;
    }

    const requestId =
      pendingRegenerateRequestIdsRef.current.get(sourceRunId) ??
      createClientId();
    pendingRegenerateRequestIdsRef.current.set(sourceRunId, requestId);
    setRegeneratingRunIds((current) => new Set(current).add(sourceRunId));
    const creditMutationRevision = beginCreditMutation();

    try {
      const response = await regenerateRun(sourceRunId, { requestId });
      if (!workspaceOperationIsCurrent(workspaceGeneration)) {
        return;
      }
      if (
        response.run.regenerateOfRunId !== sourceRunId ||
        response.run.retryOfRunId !== null ||
        response.run.conversationId !== conversationId ||
        response.run.inputMessageId !== sourceRun.inputMessageId ||
        response.run.conversationTurn !== sourceRun.conversationTurn ||
        response.run.attemptIndex !== sourceRun.attemptIndex + 1 ||
        response.run.predecessorRunId !== sourceRun.predecessorRunId ||
        JSON.stringify(response.run.executionConfig) !==
          JSON.stringify(sourceRun.executionConfig) ||
        response.conversation.id !== conversationId ||
        response.conversation.selectedRunId !== response.run.id
      ) {
        throw new Error("重新生成返回了不一致的 Run");
      }
      advanceConversationObservationRevision(conversationId);
      dispatchConversation({
        type: "run_updated",
        conversationId,
        run: response.run,
      });
      commitMutationCredits(response.credits, creditMutationRevision);
      setBootstrap((current) => {
        if (current === null) {
          return current;
        }
        return {
          ...current,
          conversations: upsertConversationSummary(
            current.conversations,
            summaryAtAcknowledgedReadWatermark(response.conversation),
          ),
        };
      });
      updateActivityView(conversationId, { runId: response.run.id });
      ensureRunSubscription(conversationId, response.run.id, "active", {
        knownRun: response.run,
        existingEvents: [],
      });
      signalWorkspaceBootstrapChanged();
      const loadResult = await loadConversation(conversationId);
      if (!workspaceOperationIsCurrent(workspaceGeneration)) {
        return;
      }
      if (loadResult.status === "loaded") {
        const detail = loadResult.detail;
        if (!detail.runs.some((run) => run.id === response.run.id)) {
          throw new Error("重载会话后缺少新建的重新生成 Run");
        }
        pendingRegenerateRequestIdsRef.current.delete(sourceRunId);
      }
    } catch (error) {
      if (!workspaceOperationIsCurrent(workspaceGeneration)) {
        return;
      }
      if (!shouldRetainPendingChatRequest(error)) {
        pendingRegenerateRequestIdsRef.current.delete(sourceRunId);
      }
      dispatchConversation({
        type: "set_error",
        conversationId,
        message: errorMessage(error),
      });
    } finally {
      const operationIsCurrent =
        workspaceOperationIsCurrent(workspaceGeneration);
      finishCreditMutation(creditMutationRevision, operationIsCurrent);
      if (operationIsCurrent) {
        setRegeneratingRunIds((current) => {
          const next = new Set(current);
          next.delete(sourceRunId);
          return next;
        });
        finishConversationMutation(conversationId, mutationOwner);
      }
    }
  }, [
    advanceConversationObservationRevision,
    beginCreditMutation,
    beginConversationMutation,
    commitMutationCredits,
    ensureRunSubscription,
    finishCreditMutation,
    finishConversationMutation,
    loadConversation,
    regeneratingRunIds,
    signalWorkspaceBootstrapChanged,
    summaryAtAcknowledgedReadWatermark,
    updateActivityView,
    workspaceOperationIsCurrent,
  ]);

  const handleMessageFeedback = useCallback(
    async (messageId: string, feedback: MessageFeedback | null) => {
      const conversationId = activeConversationIdRef.current;
      if (
        conversationId === null ||
        feedbackPendingMessageIdsRef.current.has(messageId)
      ) {
        return;
      }
      const message = conversationStatesRef.current[
        conversationId
      ]?.messages.find((candidate) => candidate.id === messageId);
      if (message === undefined) {
        throw new Error(`当前会话缺少待反馈消息 ${messageId}`);
      }
      if (message.role !== "assistant") {
        throw new Error(`用户消息 ${messageId} 不能设置反馈`);
      }

      feedbackPendingMessageIdsRef.current.add(messageId);
      setFeedbackPendingMessageIds(
        new Set(feedbackPendingMessageIdsRef.current),
      );
      try {
        const response = await patchMessageFeedback(messageId, feedback);
        if (response.messageId !== messageId) {
          throw new Error("回答反馈接口返回了不一致的 messageId");
        }
        const feedbackDataRevision = advanceFeedbackDataRevision();
        dispatchConversation({
          type: "message_feedback_updated",
          conversationId,
          messageId,
          feedback: response.feedback,
          feedbackDataRevision,
        });
      } catch (error) {
        dispatchConversation({
          type: "set_error",
          conversationId,
          message: errorMessage(error),
        });
      } finally {
        feedbackPendingMessageIdsRef.current.delete(messageId);
        setFeedbackPendingMessageIds(
          new Set(feedbackPendingMessageIdsRef.current),
        );
      }
    },
    [advanceFeedbackDataRevision],
  );

  function handleStop() {
    if (activeRun !== null) {
      void handleCancelRun(activeRun.id);
    }
  }

  const handleOpenActivity = useCallback(
    (runId: string, surface: "inline" | "panel" = "panel") => {
      const conversationId = activeConversationIdRef.current;
      if (conversationId === null) {
        return;
      }
      const conversationState =
        conversationStatesRef.current[conversationId];
      if (
        conversationState === undefined ||
        !conversationState.runs.some((run) => run.id === runId)
      ) {
        return;
      }
      if (surface === "panel") {
        setCitationSourcesView(null);
        rememberActiveActivityTrigger();
        updateActivityView(conversationId, { isOpen: true, runId });
      }
      ensureRunSubscription(conversationId, runId, "activity");
    },
    [ensureRunSubscription, rememberActiveActivityTrigger, updateActivityView],
  );

  const handleRetryRunEventConnection = useCallback(
    (runId: string) => {
      const conversationId = activeConversationIdRef.current;
      if (conversationId === null) {
        throw new Error(`无法在空会话中重试 Run ${runId} 的活动连接`);
      }
      const state = conversationStatesRef.current[conversationId];
      const run = state?.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        throw new Error(`当前会话中找不到待重连的 Run ${runId}`);
      }
      const connectionState = runEventConnectionStatesRef.current.get(runId);
      if (connectionState?.phase !== "failed") {
        throw new Error(`Run ${runId} 的活动连接并未失败`);
      }

      dispatchConversation({ type: "clear_error", conversationId });
      setRunReplayState(runId, "not_loaded");
      setRunEventConnectionState(runId, idleRunEventConnectionState);
      ensureRunSubscription(conversationId, runId, "activity", {
        knownRun: run,
        existingEvents: eventsForRun(state, runId),
      });
    },
    [ensureRunSubscription, setRunEventConnectionState, setRunReplayState],
  );

  const selectedActivityRun =
    activityRunId === null
      ? activeRun ??
        activityRunForSelection(
          activeState,
          activeConversation?.selectedRunId ?? null,
          null,
        )
      : activityRunForSelection(activeState, activityRunId, null);
  const selectedActivityEvents =
    selectedActivityRun === null
      ? EMPTY_RUN_EVENTS
      : eventsForRun(activeState, selectedActivityRun.id);
  const selectedActivityReplayState =
    selectedActivityRun === null
      ? "not_loaded"
      : runReplayStates[selectedActivityRun.id] ?? "not_loaded";
  const selectedActivityConnectionState =
    selectedActivityRun === null
      ? idleRunEventConnectionState
      : runEventConnectionStates[selectedActivityRun.id] ??
        idleRunEventConnectionState;
  const selectedActivityDetailState = resolveRunActivityDetailState({
    requestedRunId: activityRunId,
    run: selectedActivityRun,
    conversationState: activeState,
  });

  const handleRetryActivityLoad = useCallback(() => {
    if (activeConversationId === null || activityRunId === null) {
      throw new Error("当前没有可重新载入的运行活动");
    }
    void loadConversation(activeConversationId);
  }, [activeConversationId, activityRunId, loadConversation]);

  useEffect(() => {
    if (!isActivityOpen || selectedActivityRun === null) {
      return;
    }
    if (selectedActivityRun.conversationId !== activeConversationId) {
      throw new Error(
        `活动 Run ${selectedActivityRun.id} 不属于当前会话 ${activeConversationId ?? "空"}`,
      );
    }
    ensureRunSubscription(
      selectedActivityRun.conversationId,
      selectedActivityRun.id,
      "activity",
      {
        knownRun: selectedActivityRun,
        existingEvents: selectedActivityEvents,
      },
    );
  }, [
    activeConversationId,
    ensureRunSubscription,
    isActivityOpen,
    runSubscriptionContextRevision,
    selectedActivityEvents,
    selectedActivityRun,
  ]);

  const runStatusByConversation = useMemo(() => {
    if (bootstrap === null) {
      return {};
    }
    const statuses: Record<string, AgentRunStatus | null> = {};
    for (const conversation of bootstrap.conversations) {
      const state = conversationStates[conversation.id];
      const summarizedRun = runForId(state, conversation.activeRun?.id ?? null);
      if (summarizedRun !== null) {
        statuses[conversation.id] = effectiveRunStatus(
          summarizedRun,
          eventsForRun(state, summarizedRun.id),
        );
        continue;
      }
      statuses[conversation.id] = conversationSidebarRunStatus(conversation);
    }
    return statuses;
  }, [bootstrap, conversationStates]);

  const documentTitleContext = workspaceDocumentTitleContext(
    route,
    activeConversation?.title ?? null,
  );

  useEffect(() => {
    document.title = workspaceDocumentTitle({
      currentTitle: documentTitleContext.currentTitle,
      ...backgroundRunStatusCounts,
    });
  }, [
    backgroundRunStatusCounts,
    documentTitleContext.currentTitle,
    documentTitleContext.routeKey,
  ]);

  if (isBootstrapping && bootstrap === null) {
    return (
      <main className="launch-screen" aria-busy="true">
        <span className="launch-screen__mark"><BrandMark /></span>
        <strong>正在打开研究工作区</strong>
        <span className="launch-screen__bar" />
      </main>
    );
  }

  if (bootstrap === null) {
    return (
      <main className="launch-screen launch-screen--error">
        <span className="launch-screen__mark launch-screen__mark--error"><AlertIcon /></span>
        <strong>暂时无法进入工作区</strong>
        <p>{fatalError}</p>
        <button onClick={() => void initialize()} type="button">
          <RefreshIcon />
          重试
        </button>
      </main>
    );
  }

  const activeConversationSummaryIsMissing =
    activeConversationId !== null && activeConversation === undefined;
  const isConversationLoading =
    activeConversationId !== null &&
    (activeState === undefined ||
      (activeState.isLoading === true && activeState.isLoaded === false) ||
      (activeConversationSummaryIsMissing && activeState.isLoaded === true));
  const isConversationUnavailable =
    activeConversationId !== null &&
    (activeState?.isLoaded !== true || activeConversationSummaryIsMissing);
  const activeConversationLoadError =
    activeConversationId !== null &&
    shouldRetryConversationLoad({
      activeConversationId,
      requestedConversationId: activeConversationId,
      state: activeState,
      hasInFlightRequest: false,
    })
      ? activeState?.loadError ?? null
      : null;
  const isViewingArchivedConversation =
    activeConversation?.archivedAt !== null &&
    activeConversation?.archivedAt !== undefined;
  const isStarting = activeState?.isStarting === true;
  const hasOutstandingRuns =
    (activeConversation !== undefined &&
      conversationHasOutstandingRuns(activeConversation)) ||
    conversationStateHasOutstandingRuns(activeState);
  const currentError = activeState?.error ?? workspaceError;
  const conversationTimeline =
    activeConversationSummaryIsMissing
      ? []
      : projectLoadedConversationTimeline(
          activeState,
          activeConversation?.selectedRunId ?? null,
        );
  const blockedWaitingRunIds = new Set<string>();
  const retryableRunIds = new Set<string>();
  if (activeState !== undefined) {
    for (const run of activeState.runs) {
      if (run.status === "waiting" && waitingRunIsBlocked(activeState, run)) {
        blockedWaitingRunIds.add(run.id);
      }
      if (
        canRetryRun(activeState, run) &&
        run.executionConfig.provenance === "captured"
      ) {
        retryableRunIds.add(run.id);
      }
    }
  }
  const isSelectingRun =
    activeConversationId !== null &&
    selectingRunConversationIds.has(activeConversationId);
  const conversationMutationDisabledReason =
    activeConversationId !== null &&
    mutatingConversationIds.has(activeConversationId)
      ? "该对话正在处理其他操作，请稍候。"
      : null;
  const runSelectionDisabledReason =
    conversationMutationDisabledReason ??
    (hasOutstandingRuns ? activeRunSelectionMessage : null);
  const userMessageEditDisabledReason = isViewingArchivedConversation
    ? "恢复已归档对话后才能编辑消息"
    : hasOutstandingRuns
      ? "研究正在运行或等待中，完成或停止后才能编辑消息"
      : isStarting
        ? "消息正在提交，请稍候再编辑"
        : isSelectingRun
          ? "正在切换会话分支，请稍候再编辑"
          : isConversationLoading
            ? "会话加载完成后才能编辑消息"
            : null;

  return (
    <div
      className={`workspace-shell${
        isActivityOpen ? " workspace-shell--activity" : ""
      }${isCitationSourcesOpen ? " workspace-shell--sources" : ""}`}
    >
      <ConversationSidebar
        activeConversationId={isLibraryRoute ? null : activeConversationId}
        busyConversationIds={mutatingConversationIds}
        conversations={bootstrap.conversations}
        conversationBrowserView={conversationBrowserView}
        credits={bootstrap.credits}
        isCreating={isCreating}
        isLibraryActive={isLibraryRoute}
        isLoadingMore={isLoadingMoreConversations}
        isOpen={isSidebarOpen}
        loadMoreError={conversationLoadMoreError}
        mobileMenuTriggerRef={mobileSidebarMenuTriggerRef}
        nextCursor={bootstrap.nextCursor}
        onClose={() => setIsSidebarOpen(false)}
        onCreate={() => void handleCreateConversation()}
        onArchiveAllConversations={handleArchiveAllConversations}
        onDeleteAllConversations={handleDeleteAllConversations}
        onLoadMore={() => void loadMoreConversations()}
        onOpenArchived={() => openConversationBrowser("archived")}
        onOpenKeyboardShortcuts={() => setIsKeyboardShortcutsOpen(true)}
        onOpenLibrary={handleOpenLibrary}
        onOpenSearch={() => openConversationBrowser("active")}
        onRequestDelete={setDeleteTarget}
        onRequestRename={setRenameTarget}
        onRequestShare={setShareTargetConversationId}
        onSelect={handleSelectConversation}
        onSetArchived={handleSetArchived}
        onSetPinned={handleSetPinned}
        runStatusByConversation={runStatusByConversation}
        user={bootstrap.user}
      />

      {route.kind === "library" ? (
        <LibraryView
          backgroundRunCenterTriggerRef={headerBackgroundRunButtonRef}
          backgroundRunCount={backgroundRunBadgeCount}
          isSidebarOpen={isSidebarOpen}
          isBackgroundRunCenterOpen={isBackgroundRunCenterOpen}
          mobileMenuTriggerRef={mobileSidebarMenuTriggerRef}
          onNavigateSnapshot={handleNavigateLibrarySnapshot}
          onNavigateTab={handleNavigateLibraryTab}
          onOpenBackgroundRunCenter={handleOpenBackgroundRunCenter}
          onOpenConversation={handleSelectConversation}
          onOpenSidebar={() => setIsSidebarOpen(true)}
          refreshVersion={conversationBrowserVersion}
          snapshotId={route.snapshotId}
          tab={route.tab}
        />
      ) : (
      <section className="research-pane">
        <header className="research-header">
          <div className="research-header__identity">
            <button
              aria-controls="conversation-sidebar"
              aria-expanded={isSidebarOpen}
              aria-label="打开会话侧边栏"
              className="icon-button research-header__menu"
              onClick={() => setIsSidebarOpen(true)}
              ref={mobileSidebarMenuTriggerRef}
              type="button"
            >
              <MenuIcon />
            </button>
            <span>
              <small>
                {isViewingArchivedConversation ? "已归档研究" : "当前研究"}
              </small>
              <strong>{activeConversation?.title ?? "开始新研究"}</strong>
            </span>
            {activeConversation === undefined ? null : (
              <ConversationHeaderMenu
                busy={mutatingConversationIds.has(activeConversation.id)}
                conversation={activeConversation}
                disabledReason={
                  hasOutstandingRuns ? activeRunMutationMessage : null
                }
                onRequestDelete={setDeleteTarget}
                onRequestRename={setRenameTarget}
                onSetArchived={handleSetArchived}
                onSetPinned={handleSetPinned}
              />
            )}
          </div>
          <div className="research-header__actions">
            <button
              aria-controls="conversation-share-dialog"
              aria-expanded={isHeaderShareDialogOpen}
              aria-haspopup="dialog"
              aria-label="分享对话"
              className="header-share-button"
              disabled={activeConversation === undefined}
              onClick={() => {
                if (activeConversation !== undefined) {
                  setShareTargetConversationId(activeConversation.id);
                }
              }}
              type="button"
            >
              <ShareIcon />
              <span>分享</span>
            </button>
            <button
              aria-controls="run-activity-panel"
              aria-expanded={isActivityOpen}
              aria-label="活动"
              className="header-activity-button"
              disabled={selectedActivityRun === null && !isActivityOpen}
              onClick={() => {
                if (isActivityOpen) {
                  if (selectedActivityRun === null) {
                    closeDesktopPanelAndRestoreFocus(
                      closeActiveActivity,
                      headerBackgroundRunButtonRef.current,
                    );
                  } else {
                    closeActiveActivity();
                  }
                  return;
                }
                if (selectedActivityRun !== null) {
                  handleOpenActivity(selectedActivityRun.id);
                }
              }}
              ref={headerActivityButtonRef}
              type="button"
            >
              <ActivityIcon />
              <span>活动</span>
            </button>
            <BackgroundRunCenterTrigger
              count={backgroundRunBadgeCount}
              isOpen={isBackgroundRunCenterOpen}
              onOpen={handleOpenBackgroundRunCenter}
              triggerRef={headerBackgroundRunButtonRef}
            />
            <span className="header-credit" aria-label="可用研究积分">
              <CoinsIcon />
              <strong>{bootstrap.credits.available.toLocaleString("zh-CN")}</strong>
              <small>积分</small>
            </span>
            <button
              aria-keyshortcuts={
                workspaceKeyboardShortcutAriaKeyShortcuts.new_conversation
              }
              aria-label={isCreating ? "正在创建新研究" : "新建研究"}
              className="header-new-button"
              disabled={isCreating}
              onClick={() => void handleCreateConversation()}
              type="button"
            >
              <PlusIcon />
              <span>新建研究</span>
            </button>
          </div>
        </header>

        {activeState?.isLoading === true ? (
          <div className="conversation-progress" aria-label="正在载入会话" />
        ) : null}

        {currentError !== null && activeConversationLoadError === null ? (
          <div className="workspace-alert" role="alert">
            <AlertIcon />
            <span>{currentError}</span>
            <button
              aria-label="关闭错误提示"
              onClick={() => {
                if (activeConversationId === null) {
                  setWorkspaceError(null);
                } else {
                  dispatchConversation({
                    type: "clear_error",
                    conversationId: activeConversationId,
                  });
                }
              }}
              type="button"
            >
              ×
            </button>
          </div>
        ) : null}

        <div
          aria-busy={isConversationLoading || isStarting}
          className="conversation-scroll"
          onScroll={handleConversationScroll}
          ref={conversationScrollRef}
        >
          {activeConversationLoadError !== null && activeConversationId !== null ? (
            <ConversationLoadFailure
              error={activeConversationLoadError}
              isRetrying={activeState?.isLoading === true}
              onRetry={() => {
                retryConversationLoad(activeConversationId, activeState);
              }}
            />
          ) : isConversationLoading ? (
            <div className="message-list message-list--loading">
              <div className="message-skeleton message-skeleton--short" />
              <div className="message-skeleton" />
              <div className="message-skeleton message-skeleton--medium" />
            </div>
          ) : conversationTimeline.length === 0 && activeRun === null ? (
            <ResearchEmptyState
              onUsePrompt={handleUsePrompt}
              userName={bootstrap.user.name}
            />
          ) : (
            <div className="message-list">
              {conversationTimeline.map((item) => {
                if (item.kind === "standalone_message") {
                  return (
                    <MessageView
                      events={[]}
                      isFeedbackPending={feedbackPendingMessageIds.has(
                        item.message.id,
                      )}
                      isSearchMatch={
                        activeConversationId !== null &&
                        conversationMessageIsSearchTarget(
                          conversationSearchTarget,
                          activeConversationId,
                          item.message.id,
                        )
                      }
                      key={`message:${item.message.id}`}
                      message={item.message}
                      onFeedback={(messageId, feedback) =>
                        void handleMessageFeedback(messageId, feedback)
                      }
                      onOpenActivity={handleOpenActivity}
                      onOpenSources={handleOpenCitationSources}
                      run={null}
                    />
                  );
                }

                const firstAttempt = item.attempts[0];
                if (firstAttempt === undefined) {
                  throw new Error(
                    `会话 Turn ${item.conversationTurn} 缺少首个 attempt`,
                  );
                }
                if (activeConversationId === null) {
                  throw new Error("会话 Turn 缺少 activeConversationId");
                }
                const attemptIndex = item.selectedAttemptIndex;
                const attempt = item.attempts[attemptIndex];
                if (attempt === undefined) {
                  throw new Error(
                    `会话 Turn ${item.conversationTurn} 缺少选中的 attempt`,
                  );
                }
                const run = attempt.run;
                const events = eventsForRun(activeState, run.id);
                const status = effectiveRunStatus(run, events);
                const isRegenerating = regeneratingRunIds.has(run.id);
                const isRegenerateEligible =
                  attemptIndex === item.attempts.length - 1 &&
                  run.status === "completed" &&
                  run.executionConfig.provenance === "captured";
                const regenerateDisabledReason =
                  conversationMutationDisabledReason ??
                  (isViewingArchivedConversation
                    ? archivedConversationRegenerateMessage
                    : hasOutstandingRuns
                      ? activeRunRegenerateMessage
                      : null);
                const renderAttemptControls = (inline: boolean) => (
                  <TurnAttemptControls
                    attemptCount={item.attempts.length}
                    attemptIndex={attemptIndex}
                    inline={inline}
                    isRegenerateEligible={isRegenerateEligible}
                    isRegenerating={isRegenerating}
                    isSelecting={isSelectingRun}
                    mutationDisabledReason={runSelectionDisabledReason}
                    onNext={() => {
                      const nextAttempt = item.attempts[attemptIndex + 1];
                      if (nextAttempt === undefined) {
                        throw new Error("已经是最新回答");
                      }
                      void handleSelectRun(
                        activeConversationId,
                        nextAttempt.run.id,
                      );
                    }}
                    onPrevious={() => {
                      const previousAttempt = item.attempts[attemptIndex - 1];
                      if (previousAttempt === undefined) {
                        throw new Error("已经是最早回答");
                      }
                      void handleSelectRun(
                        activeConversationId,
                        previousAttempt.run.id,
                      );
                    }}
                    onRegenerate={() => void handleRegenerateRun(run.id)}
                    regenerateDisabledReason={regenerateDisabledReason}
                  />
                );
                const renderedAttempt = (() => {
                  if (attempt.assistantMessage !== null) {
                    return (
                      <MessageView
                        assistantActions={renderAttemptControls(true)}
                        assistantActionsPersistent={
                          item.attempts.length > 1 ||
                          isRegenerating ||
                          isSelectingRun
                        }
                        branchToNewConversation={
                          status === "completed"
                            ? {
                                disabledReason:
                                  conversationMutationDisabledReason,
                                isPending: branchingMessageKeys.has(
                                  messageBranchRequestKey(
                                    activeConversationId,
                                    attempt.assistantMessage.id,
                                  ),
                                ),
                                onBranch: (target, trigger) =>
                                  void handleBranchToNewConversation(
                                    target,
                                    trigger,
                                  ),
                              }
                            : undefined
                        }
                        events={events}
                        connectionState={
                          runEventConnectionStates[run.id] ??
                          idleRunEventConnectionState
                        }
                        isActivityPanelOpen={
                          isActivityOpen && activityRunId === run.id
                        }
                        isFeedbackPending={feedbackPendingMessageIds.has(
                          attempt.assistantMessage.id,
                        )}
                        isSearchMatch={conversationMessageIsSearchTarget(
                          conversationSearchTarget,
                          activeConversationId,
                          attempt.assistantMessage.id,
                        )}
                        message={attempt.assistantMessage}
                        onFeedback={(messageId, feedback) =>
                          void handleMessageFeedback(messageId, feedback)
                        }
                        onOpenActivity={handleOpenActivity}
                        onOpenSources={handleOpenCitationSources}
                        run={run}
                      />
                    );
                  }

                  switch (status) {
                    case "waiting":
                      return (
                        <WaitingRunMessage
                          isBlocked={blockedWaitingRunIds.has(run.id)}
                          isCancelling={runCancellationIsPending(
                            run,
                            cancellingRunIds.has(run.id),
                          )}
                          onCancel={(runId) => void handleCancelRun(runId)}
                          run={run}
                        />
                      );
                    case "queued":
                    case "running":
                      return (
                        <StreamingMessage
                          artifacts={artifactsForRun(events)}
                          connectionState={
                            runEventConnectionStates[run.id] ??
                            idleRunEventConnectionState
                          }
                          events={events}
                          isActivityPanelOpen={
                            isActivityOpen && activityRunId === run.id
                          }
                          onOpenActivity={handleOpenActivity}
                          run={run}
                          text={textForRun(events)}
                        />
                      );
                    case "failed":
                    case "cancelled":
                    case "reconciliation_required":
                      return (
                        <TerminalRunMessage
                          canRetry={retryableRunIds.has(run.id)}
                          connectionState={
                            runEventConnectionStates[run.id] ??
                            idleRunEventConnectionState
                          }
                          events={events}
                          isActivityPanelOpen={
                            isActivityOpen && activityRunId === run.id
                          }
                          isRetrying={retryingRunIds.has(run.id)}
                          mutationDisabledReason={
                            conversationMutationDisabledReason
                          }
                          onOpenActivity={handleOpenActivity}
                          onRetry={(runId) => void handleRetryRun(runId)}
                          run={run}
                        />
                      );
                    case "completed":
                      throw new Error(
                        `已完成 Run ${run.id} 缺少 assistant 消息`,
                      );
                  }
                })();
                const editState =
                  userMessageEdit?.conversationId === activeConversationId &&
                  userMessageEdit.messageId === item.inputMessage.id
                    ? userMessageEdit
                    : null;
                const editDisabledReason =
                  userMessageEditDisabledReason ??
                  (firstAttempt.run.executionConfig.provenance !== "captured"
                    ? "旧版运行没有可恢复的执行配置，不能编辑后重新运行"
                    : null) ??
                  (userMessageEdit !== null && editState === null
                    ? "请先保存或取消正在编辑的消息"
                    : null);
                const retainedAttachments =
                  editState === null
                    ? item.inputMessage.attachments
                    : retainedUserMessageAttachments(
                        item.inputMessage,
                        editState.retainedAttachmentIds,
                      );
                return (
                  <Fragment key={`turn:${item.inputMessage.id}`}>
                    <MessageView
                      events={eventsForRun(activeState, firstAttempt.run.id)}
                      isFeedbackPending={feedbackPendingMessageIds.has(
                        item.inputMessage.id,
                      )}
                      isSearchMatch={conversationMessageIsSearchTarget(
                        conversationSearchTarget,
                        activeConversationId,
                        item.inputMessage.id,
                      )}
                      message={item.inputMessage}
                      onFeedback={(messageId, feedback) =>
                        void handleMessageFeedback(messageId, feedback)
                      }
                      onOpenActivity={handleOpenActivity}
                      onOpenSources={handleOpenCitationSources}
                      run={firstAttempt.run}
                      userEdit={{
                        canEdit: editDisabledReason === null,
                        disabledReason: editDisabledReason,
                        isEditing: editState !== null,
                        value: editState?.value ?? item.inputMessage.content,
                        retainedAttachments,
                        newAttachments: editState?.newAttachments ?? [],
                        attachmentError: editState?.attachmentError ?? null,
                        inputAttachmentLimits: bootstrap.inputAttachmentLimits,
                        isSaving: editState?.isSaving ?? false,
                        error: editState?.error ?? null,
                        onBegin: () =>
                          beginUserMessageEdit(
                            activeConversationId,
                            item.inputMessage,
                          ),
                        onChange: (value) =>
                          changeUserMessageEdit(
                            activeConversationId,
                            item.inputMessage.id,
                            value,
                          ),
                        onFilesSelected: (files) =>
                          selectUserMessageEditFiles(
                            activeConversationId,
                            item.inputMessage,
                            files,
                          ),
                        onRemoveRetainedAttachment: (attachmentId) =>
                          removeRetainedUserMessageAttachment(
                            activeConversationId,
                            item.inputMessage.id,
                            attachmentId,
                          ),
                        onRemoveNewAttachment: (clientId) =>
                          void removeNewUserMessageEditAttachment(
                            activeConversationId,
                            item.inputMessage.id,
                            clientId,
                          ),
                        onRetryNewAttachment: (clientId) =>
                          retryUserMessageEditAttachment(
                            activeConversationId,
                            item.inputMessage.id,
                            clientId,
                          ),
                        onDismissAttachmentError: () =>
                          dismissUserMessageEditAttachmentError(
                            activeConversationId,
                            item.inputMessage.id,
                          ),
                        onCancel: () =>
                          void cancelUserMessageEdit(
                            activeConversationId,
                            item.inputMessage.id,
                          ),
                        onSave: () =>
                          void handleEditUserMessage(
                            activeConversationId,
                            item,
                          ),
                      }}
                    />
                    <TurnBranchControls
                      branchCount={item.branches.length}
                      branchIndex={item.selectedBranchIndex}
                      isSelecting={isSelectingRun}
                      mutationDisabledReason={
                        runSelectionDisabledReason
                      }
                      onNext={() => {
                        const nextBranch =
                          item.branches[item.selectedBranchIndex + 1];
                        if (nextBranch === undefined) {
                          throw new Error("已经是最新用户消息分支");
                        }
                        void handleSelectRun(
                          activeConversationId,
                          nextBranch.latestAttemptRunId,
                        );
                      }}
                      onPrevious={() => {
                        const previousBranch =
                          item.branches[item.selectedBranchIndex - 1];
                        if (previousBranch === undefined) {
                          throw new Error("已经是最早用户消息分支");
                        }
                        void handleSelectRun(
                          activeConversationId,
                          previousBranch.latestAttemptRunId,
                        );
                      }}
                    />
                    <Fragment key={`attempt-state:${run.id}`}>
                      {renderedAttempt}
                    </Fragment>
                    {attempt.assistantMessage === null
                      ? renderAttemptControls(false)
                      : null}
                  </Fragment>
                );
              })}
            </div>
          )}
        </div>

        <div className="scroll-to-latest-anchor">
          {showScrollToLatest ? (
            <button
              aria-label="滚动到最新消息"
              className="scroll-to-latest"
              onClick={handleScrollToLatest}
              title="滚动到最新消息"
              type="button"
            >
              <ChevronDownIcon />
            </button>
          ) : null}
        </div>

        {isViewingArchivedConversation && activeConversation !== undefined ? (
          <div className="archived-conversation-notice" role="status">
            <ArchiveIcon />
            <span>
              <strong>这是已归档对话</strong>
              <small>恢复后才能继续发送消息。</small>
            </span>
            <button
              disabled={mutatingConversationIds.has(activeConversation.id)}
              onClick={() =>
                void handleSetArchived(activeConversation, false)
              }
              type="button"
            >
              恢复对话
            </button>
          </div>
        ) : null}

        {draftAttachmentRecoveryState.phase === "restoring" ? (
          <AttachmentDraftRecoveryNotice
            message="正在确认已上传的附件草稿…"
            phase="restoring"
          />
        ) : draftAttachmentRecoveryState.phase === "failed" ? (
          <AttachmentDraftRecoveryNotice
            message={draftAttachmentRecoveryState.message}
            onDiscard={() =>
              discardAttachmentDraftScope(
                draftKey,
                draftScope,
                bootstrap.user.id,
              )
            }
            onRetry={() =>
              void restoreAttachmentDraftScope(
                draftKey,
                draftScope,
                bootstrap.user.id,
              )
            }
            phase="failed"
          />
        ) : null}

        <ChatComposer
          attachmentError={draftAttachmentError}
          attachments={draftAttachments}
          disabled={
            isConversationUnavailable ||
            isConversationLoading ||
            (activeConversationId === null && isCreating) ||
            isStarting ||
            isSelectingRun ||
            isViewingArchivedConversation ||
            draftAttachmentRecoveryState.phase !== "ready"
          }
          focusRequestToken={composerFocusRequestToken}
          isStopping={
            activeRun !== null &&
            runCancellationIsPending(
              activeRun,
              cancellingRunIds.has(activeRun.id),
            )
          }
          isStreaming={activeRun !== null}
          inputAttachmentLimits={bootstrap.inputAttachmentLimits}
          executionProfiles={bootstrap.executionProfiles.options}
          executionProfileScopeKey={draftKey}
          selectedExecutionProfileId={
            executionProfileDraftIdForCatalog(
              executionProfileDrafts[draftKey] ??
                bootstrap.executionProfiles.defaultId,
              bootstrap.executionProfiles,
            )
          }
          onChange={setDraft}
          onDismissAttachmentError={() =>
            setAttachmentDraftError(draftKey, null)
          }
          onExecutionProfileChange={setExecutionProfileDraft}
          onFilesSelected={handleFilesSelected}
          onRemoveAttachment={handleRemoveDraftAttachment}
          onRetryAttachment={handleRetryDraftAttachment}
          onStop={() => void handleStop()}
          onSubmit={() => void handleSend()}
          value={draft}
        />
      </section>
      )}

      {isBackgroundRunCenterOpen ? (
        <BackgroundRunCenterDialog
          historyRevision={conversationBrowserVersion}
          items={backgroundRunItems}
          onClose={() => setIsBackgroundRunCenterOpen(false)}
          onSelect={handleOpenBackgroundRunItem}
          onSelectHistory={handleOpenBackgroundRunHistoryItem}
          returnFocusRef={headerBackgroundRunButtonRef}
        />
      ) : null}

      <RunActivityPanel
        connectionState={selectedActivityConnectionState}
        detailState={selectedActivityDetailState}
        events={selectedActivityEvents}
        isOpen={isActivityOpen}
        onClose={closeActiveActivity}
        onRetryLoad={handleRetryActivityLoad}
        onRetryConnection={handleRetryRunEventConnection}
        replayState={selectedActivityReplayState}
        returnFocusRef={activityReturnFocusRef}
        run={selectedActivityRun}
      />

      <CitationSourcesPanel
        activeNumber={activeCitationSourcesView?.activeNumber}
        citations={activeCitationSourcesView?.citations ?? []}
        isOpen={isCitationSourcesOpen}
        onClose={closeCitationSources}
        returnFocusRef={citationSourcesReturnFocusRef}
      />

      <RunCompletionNotifications
        notifications={runCompletionNotifications}
        onDismiss={dismissRunCompletion}
        onOpenConversation={handleOpenRunCompletion}
      />
      <RunCompletionSystemNotifications
        notifications={runCompletionNotifications}
        onOpenConversation={handleOpenRunCompletion}
      />

      {conversationBrowserView === null ? null : (
        <ConversationBrowserDialog
          busyConversationIds={mutatingConversationIds}
          initialView={conversationBrowserView}
          onClose={closeConversationBrowser}
          onRequestDelete={setDeleteTarget}
          onRestore={handleRestoreConversation}
          onSelect={handleBrowserConversationSelect}
          refreshVersion={conversationBrowserVersion}
        />
      )}

      {renameTarget === null ? null : (
        <RenameConversationDialog
          conversation={renameTarget}
          isBusy={mutatingConversationIds.has(renameTarget.id)}
          key={renameTarget.id}
          onClose={closeRenameDialog}
          onRename={handleRenameConversation}
        />
      )}

      {deleteTarget === null ? null : (
        <DeleteConversationDialog
          conversation={deleteTarget}
          isBusy={mutatingConversationIds.has(deleteTarget.id)}
          key={deleteTarget.id}
          onClose={closeDeleteDialog}
          onDelete={handleDeleteConversation}
        />
      )}

      {shareTargetConversation === null ? null : (
        <ConversationShareDialog
          conversation={shareTargetConversation}
          key={shareTargetConversation.id}
          onClose={closeShareDialog}
        />
      )}

      {isKeyboardShortcutsOpen ? (
        <KeyboardShortcutsDialog
          onClose={() => setIsKeyboardShortcutsOpen(false)}
        />
      ) : null}
    </div>
  );
}
