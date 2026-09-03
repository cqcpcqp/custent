import { z } from "zod";

import {
  inputAttachmentFormatSpecifications,
  INPUT_ATTACHMENT_MIME_TYPES,
} from "@/lib/input-attachment-formats";
import {
  CompanyTypeSchema,
  ContactRoleSchema,
} from "@/lib/domain/research";
import {
  NonnegativePostgresIntegerSchema,
  PositivePostgresIntegerSchema,
  ProviderBaseUrlSchema,
} from "@/lib/config-validation";
import { APP_ERROR_CODES } from "@/lib/errors";

export const CitationSchema = z.object({
  url: z.url({ protocol: /^https?$/u }),
  title: z.string(),
  startIndex: z.number().int().nonnegative(),
  endIndex: z.number().int().nonnegative(),
});

export type Citation = z.infer<typeof CitationSchema>;

export const ArtifactSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  mimeType: z.enum(["text/csv", "application/pdf"]),
  sizeBytes: z.number().int().nonnegative(),
  downloadUrl: z.string(),
  createdAt: z.string().datetime(),
});

export type ArtifactSummary = z.infer<typeof ArtifactSummarySchema>;

export const InputAttachmentKindSchema = z.enum(["file", "image"]);

export type InputAttachmentKind = z.infer<typeof InputAttachmentKindSchema>;

export const InputAttachmentMimeTypeSchema = z.enum(
  INPUT_ATTACHMENT_MIME_TYPES,
);

export type InputAttachmentMimeType = z.infer<
  typeof InputAttachmentMimeTypeSchema
>;

export const InputAttachmentSummarySchema = z
  .object({
    id: z.string().uuid(),
    kind: InputAttachmentKindSchema,
    name: z.string().min(1).max(255),
    mimeType: InputAttachmentMimeTypeSchema,
    sizeBytes: z.number().int().positive(),
    downloadUrl: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((attachment, context) => {
    if (
      attachment.kind !==
      inputAttachmentFormatSpecifications[attachment.mimeType].kind
    ) {
      context.addIssue({
        code: "custom",
        message: "Attachment kind does not match its MIME type",
        path: ["kind"],
      });
    }
  });

export type InputAttachmentSummary = z.infer<
  typeof InputAttachmentSummarySchema
>;

export const MessageFeedbackSchema = z.enum(["up", "down"]);

export type MessageFeedback = z.infer<typeof MessageFeedbackSchema>;

export const ChatMessageSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid().nullable(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    citations: z.array(CitationSchema),
    artifacts: z.array(ArtifactSummarySchema),
    attachments: z.array(InputAttachmentSummarySchema),
    feedback: MessageFeedbackSchema.nullable(),
    createdAt: z.string().datetime(),
  })
  .superRefine((message, context) => {
    if (message.role === "user" && message.feedback !== null) {
      context.addIssue({
        code: "custom",
        message: "User messages cannot have feedback",
        path: ["feedback"],
      });
    }
  });

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const AgentRunStatusSchema = z.enum([
  "waiting",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "reconciliation_required",
]);

export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const TerminalAgentRunStatusSchema = z.enum([
  "completed",
  "failed",
  "cancelled",
  "reconciliation_required",
]);

export type TerminalAgentRunStatus = z.infer<
  typeof TerminalAgentRunStatusSchema
>;

export const BackgroundRunHistoryStatusFilterSchema = z.enum([
  "all",
  ...TerminalAgentRunStatusSchema.options,
]);

export type BackgroundRunHistoryStatusFilter = z.infer<
  typeof BackgroundRunHistoryStatusFilterSchema
>;

const PositivePostgresBigintStringSchema = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .refine(
    (value) => BigInt(value) <= 9_223_372_036_854_775_807n,
    "Value exceeds the PostgreSQL bigint range",
  );

export const ActiveRunSummarySchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["queued", "running"]),
  startedAt: z.string().datetime().nullable(),
});

export type ActiveRunSummary = z.infer<typeof ActiveRunSummarySchema>;

export const ConversationAttentionSchema = z
  .object({
    terminalEventId: z
      .string()
      .pipe(PositivePostgresBigintStringSchema),
    runId: z.string().uuid(),
    status: TerminalAgentRunStatusSchema,
    finishedAt: z.string().datetime(),
  })
  .strict();

export type ConversationAttention = z.infer<
  typeof ConversationAttentionSchema
>;

export const ConversationSummarySchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    updatedAt: z.string().datetime(),
    pinnedAt: z.string().datetime().nullable(),
    archivedAt: z.string().datetime().nullable(),
    selectedRunId: z.string().uuid().nullable(),
    activeRun: ActiveRunSummarySchema.nullable(),
    waitingRunCount: z.number().int().nonnegative().safe(),
    attention: ConversationAttentionSchema.nullable(),
  })
  .strict();

export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationListViewSchema = z.enum(["active", "archived"]);

export type ConversationListView = z.infer<
  typeof ConversationListViewSchema
>;

export const ConversationSearchExcerptSchema = z
  .object({
    before: z.string(),
    match: z.string().min(1),
    after: z.string(),
    beforeTruncated: z.boolean(),
    afterTruncated: z.boolean(),
  })
  .strict();

export type ConversationSearchExcerpt = z.infer<
  typeof ConversationSearchExcerptSchema
>;

export const ConversationSearchMatchSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("title"),
      excerpt: ConversationSearchExcerptSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("message"),
      messageId: z.string().uuid(),
      role: z.enum(["user", "assistant"]),
      createdAt: z.string().datetime(),
      excerpt: ConversationSearchExcerptSchema,
    })
    .strict(),
]);

export type ConversationSearchMatch = z.infer<
  typeof ConversationSearchMatchSchema
>;

export const ConversationListItemSchema = z
  .object({
    ...ConversationSummarySchema.shape,
    searchMatch: ConversationSearchMatchSchema.nullable(),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.searchMatch?.kind !== "title") {
      return;
    }
    const { excerpt } = item.searchMatch;
    if (
      excerpt.beforeTruncated ||
      excerpt.afterTruncated ||
      `${excerpt.before}${excerpt.match}${excerpt.after}` !== item.title
    ) {
      context.addIssue({
        code: "custom",
        message: "Title search excerpt must contain the complete title",
        path: ["searchMatch", "excerpt"],
      });
    }
  });

export type ConversationListItem = z.infer<
  typeof ConversationListItemSchema
>;

export function conversationSummaryFromListItem(
  item: ConversationListItem,
): ConversationSummary {
  const { searchMatch, ...summary } = item;
  void searchMatch;
  return ConversationSummarySchema.parse(summary);
}

export const ListConversationsResponseSchema = z
  .object({
    items: z.array(ConversationListItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type ListConversationsResponse = z.infer<
  typeof ListConversationsResponseSchema
>;

export const BulkConversationMutationRequestSchema = z
  .object({
    action: z.literal("archive_all"),
  })
  .strict();

export type BulkConversationMutationRequest = z.infer<
  typeof BulkConversationMutationRequestSchema
>;

export const BulkConversationMutationSchema = z
  .object({
    action: z.enum(["archive_all", "delete_all"]),
    conversationCount: z.number().int().nonnegative().safe(),
    completedAt: z.string().datetime(),
  })
  .strict();

export type BulkConversationMutation = z.infer<
  typeof BulkConversationMutationSchema
>;

export const BulkConversationMutationResponseSchema = z
  .object({
    mutation: BulkConversationMutationSchema,
  })
  .strict();

export type BulkConversationMutationResponse = z.infer<
  typeof BulkConversationMutationResponseSchema
>;

export const PatchConversationRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("rename"),
      title: z.string().trim().min(1).max(500),
    })
    .strict(),
  z
    .object({
      action: z.literal("set_pinned"),
      pinned: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("set_archived"),
      archived: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("mark_read"),
      throughEventId: ConversationAttentionSchema.shape.terminalEventId,
    })
    .strict(),
  z
    .object({
      action: z.literal("select_run"),
      runId: z.string().uuid(),
    })
    .strict(),
]);

export type PatchConversationRequest = z.infer<
  typeof PatchConversationRequestSchema
>;

export const PatchConversationResponseSchema = z.object({
  conversation: ConversationSummarySchema,
});

export type PatchConversationResponse = z.infer<
  typeof PatchConversationResponseSchema
>;

export const DeleteConversationResponseSchema = z.object({
  deletion: z.object({
    conversationId: z.string().uuid(),
    deletedAt: z.string().datetime(),
  }),
});

export type DeleteConversationResponse = z.infer<
  typeof DeleteConversationResponseSchema
>;

export const SharedConversationFileSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("input_attachment"),
      name: z.string().min(1).max(255),
      mimeType: InputAttachmentMimeTypeSchema,
      sizeBytes: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("artifact"),
      name: z.string().min(1).max(500),
      mimeType: z.enum(["text/csv", "application/pdf"]),
      sizeBytes: z.number().int().nonnegative(),
    })
    .strict(),
]);

export type SharedConversationFile = z.infer<
  typeof SharedConversationFileSchema
>;

export const SharedConversationMessageSchema = z
  .object({
    id: z.string().uuid(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    citations: z.array(CitationSchema),
    createdAt: z.string().datetime(),
    files: z.array(SharedConversationFileSchema),
  })
  .strict();

export type SharedConversationMessage = z.infer<
  typeof SharedConversationMessageSchema
>;

export const ConversationShareSummarySchema = z
  .object({
    conversationId: z.string().uuid(),
    publicId: z.string().uuid(),
    publicPath: z
      .string()
      .regex(
        /^\/share\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((share, context) => {
    if (share.publicPath !== `/share/${share.publicId}`) {
      context.addIssue({
        code: "custom",
        message: "Public path must match the public share ID",
        path: ["publicPath"],
      });
    }
  });

export type ConversationShareSummary = z.infer<
  typeof ConversationShareSummarySchema
>;

export const ConversationShareListItemSchema = z
  .object({
    conversationId: z.string().uuid(),
    publicId: z.string().uuid(),
    publicPath: z
      .string()
      .regex(
        /^\/share\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
    title: z.string().min(1).max(500),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((share, context) => {
    if (share.publicPath !== `/share/${share.publicId}`) {
      context.addIssue({
        code: "custom",
        message: "Public path must match the public share ID",
        path: ["publicPath"],
      });
    }
  });

export type ConversationShareListItem = z.infer<
  typeof ConversationShareListItemSchema
>;

export const ListConversationSharesResponseSchema = z
  .object({
    items: z.array(ConversationShareListItemSchema),
    nextCursor: z.string().min(1).max(1_024).nullable(),
  })
  .strict();

export type ListConversationSharesResponse = z.infer<
  typeof ListConversationSharesResponseSchema
>;

export const GetConversationShareResponseSchema = z
  .object({
    share: ConversationShareSummarySchema.nullable(),
  })
  .strict();

export type GetConversationShareResponse = z.infer<
  typeof GetConversationShareResponseSchema
>;

export const PutConversationShareResponseSchema = z
  .object({
    share: ConversationShareSummarySchema,
  })
  .strict();

export type PutConversationShareResponse = z.infer<
  typeof PutConversationShareResponseSchema
>;

export const RevokeConversationShareResponseSchema = z
  .object({
    revocation: z
      .object({
        conversationId: z.string().uuid(),
        publicId: z.string().uuid(),
        revokedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();

export type RevokeConversationShareResponse = z.infer<
  typeof RevokeConversationShareResponseSchema
>;

export const LibraryConversationReferenceSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(500),
    archivedAt: z.string().datetime().nullable(),
  })
  .strict();

export type LibraryConversationReference = z.infer<
  typeof LibraryConversationReferenceSchema
>;

export const LibraryResearchItemSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(500),
    querySummary: z.string().min(1).max(4_000),
    companyCount: z.number().int().nonnegative().safe(),
    createdAt: z.string().datetime(),
    conversation: LibraryConversationReferenceSchema,
    runId: z.string().uuid(),
    assistantMessageId: z.string().uuid(),
  })
  .strict();

export type LibraryResearchItem = z.infer<
  typeof LibraryResearchItemSchema
>;

export const ListLibraryResearchResponseSchema = z
  .object({
    items: z.array(LibraryResearchItemSchema),
    nextCursor: z.string().min(1).max(1_024).nullable(),
  })
  .strict();

export type ListLibraryResearchResponse = z.infer<
  typeof ListLibraryResearchResponseSchema
>;

export const LibraryArtifactItemSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(500),
    mimeType: z.enum(["text/csv", "application/pdf"]),
    sizeBytes: z.number().int().nonnegative().safe(),
    downloadUrl: z.string().min(1),
    createdAt: z.string().datetime(),
    conversation: LibraryConversationReferenceSchema,
    runId: z.string().uuid(),
    assistantMessageId: z.string().uuid(),
    researchSnapshotId: z.string().uuid().nullable(),
  })
  .strict();

export type LibraryArtifactItem = z.infer<typeof LibraryArtifactItemSchema>;

export const ListLibraryArtifactsResponseSchema = z
  .object({
    items: z.array(LibraryArtifactItemSchema),
    nextCursor: z.string().min(1).max(1_024).nullable(),
  })
  .strict();

export type ListLibraryArtifactsResponse = z.infer<
  typeof ListLibraryArtifactsResponseSchema
>;

export const LibraryResearchEvidenceSchema = z
  .object({
    claim: z.string().min(1).max(2_000),
    sourceUrl: z.string().url(),
    sourceTitle: z.string().min(1).max(500),
    supports: z.enum(["company_identity", "business_fit", "contact_role"]),
  })
  .strict();

export type LibraryResearchEvidence = z.infer<
  typeof LibraryResearchEvidenceSchema
>;

export const LibraryResearchContactSchema = z
  .object({
    name: z.string().min(1).max(300),
    titleOriginal: z.string().min(1).max(500),
    roleCategory: ContactRoleSchema,
    publicProfileUrl: z.string().url().nullable(),
    confidence: z.enum(["A", "B", "C"]),
    evidence: z.array(LibraryResearchEvidenceSchema).min(1),
  })
  .strict();

export type LibraryResearchContact = z.infer<
  typeof LibraryResearchContactSchema
>;

export const LibraryResearchCompanySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(500),
    websiteUrl: z.string().url(),
    country: z.string().min(2).max(120),
    companyType: CompanyTypeSchema,
    relevanceSummary: z.string().min(1).max(2_000),
    contacts: z.array(LibraryResearchContactSchema),
    evidence: z.array(LibraryResearchEvidenceSchema).min(1),
  })
  .strict();

export type LibraryResearchCompany = z.infer<
  typeof LibraryResearchCompanySchema
>;

export const LibraryResearchDetailSchema = LibraryResearchItemSchema.extend({
  limitations: z.string().min(1).max(4_000),
  companies: z.array(LibraryResearchCompanySchema).min(1),
})
  .strict()
  .superRefine((research, context) => {
    if (research.companyCount !== research.companies.length) {
      context.addIssue({
        code: "custom",
        message: "companyCount must match companies.length",
        path: ["companyCount"],
      });
    }
  });

export type LibraryResearchDetail = z.infer<
  typeof LibraryResearchDetailSchema
>;

export const GetLibraryResearchResponseSchema = z
  .object({
    research: LibraryResearchDetailSchema,
  })
  .strict();

export type GetLibraryResearchResponse = z.infer<
  typeof GetLibraryResearchResponseSchema
>;

export const PublicConversationShareSchema = z
  .object({
    title: z.string().min(1).max(500),
    messages: z.array(SharedConversationMessageSchema).min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type PublicConversationShare = z.infer<
  typeof PublicConversationShareSchema
>;

export const PatchMessageFeedbackRequestSchema = z
  .object({
    feedback: MessageFeedbackSchema.nullable(),
  })
  .strict();

export type PatchMessageFeedbackRequest = z.infer<
  typeof PatchMessageFeedbackRequestSchema
>;

export const PatchMessageFeedbackResponseSchema = z
  .object({
    messageId: z.string().uuid(),
    feedback: MessageFeedbackSchema.nullable(),
  })
  .strict();

export type PatchMessageFeedbackResponse = z.infer<
  typeof PatchMessageFeedbackResponseSchema
>;

export const CreditBalanceSchema = z.object({
  available: z.number().int(),
  reserved: z.number().int().nonnegative(),
});

export type CreditBalance = z.infer<typeof CreditBalanceSchema>;

const CustomInstructionsContentSchema = z.string().max(4_000);

export const AccountCustomInstructionsSchema = z
  .object({
    enabled: z.boolean(),
    content: CustomInstructionsContentSchema,
    revision: NonnegativePostgresIntegerSchema,
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((customInstructions, context) => {
    if (
      customInstructions.enabled &&
      customInstructions.content.trim().length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Enabled custom instructions cannot be empty",
        path: ["content"],
      });
    }
  });

export type AccountCustomInstructions = z.infer<
  typeof AccountCustomInstructionsSchema
>;

export const PutAccountCustomInstructionsRequestSchema = z
  .object({
    enabled: z.boolean(),
    content: CustomInstructionsContentSchema,
    expectedRevision: NonnegativePostgresIntegerSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.enabled && request.content.trim().length === 0) {
      context.addIssue({
        code: "custom",
        message: "Enabled custom instructions cannot be empty",
        path: ["content"],
      });
    }
  });

export type PutAccountCustomInstructionsRequest = z.infer<
  typeof PutAccountCustomInstructionsRequestSchema
>;

export const AccountCustomInstructionsResponseSchema = z
  .object({
    customInstructions: AccountCustomInstructionsSchema,
  })
  .strict();

export type AccountCustomInstructionsResponse = z.infer<
  typeof AccountCustomInstructionsResponseSchema
>;

export const AccountUsageBalanceSchema = z
  .object({
    available: z.number().int().nonnegative().safe(),
    reserved: z.number().int().nonnegative().safe(),
    frozen: z.number().int().nonnegative().safe(),
  })
  .strict();

export type AccountUsageBalance = z.infer<typeof AccountUsageBalanceSchema>;

export const AccountUsageItemSchema = z
  .object({
    runId: z.string().uuid(),
    conversationId: z.string().uuid(),
    conversationTitle: z.string().min(1).max(500),
    status: AgentRunStatusSchema,
    reservationCredits: z.number().int().positive().safe(),
    chargedCredits: z.number().int().nonnegative().safe().nullable(),
    inputTokens: z.number().int().nonnegative().safe().nullable(),
    outputTokens: z.number().int().nonnegative().safe().nullable(),
    webSearches: z.number().int().nonnegative().safe().nullable(),
    createdAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
  })
  .strict();

export type AccountUsageItem = z.infer<typeof AccountUsageItemSchema>;

export const AccountUsageResponseSchema = z
  .object({
    balance: AccountUsageBalanceSchema,
    items: z.array(AccountUsageItemSchema),
    nextCursor: z.string().min(1).max(1_024).nullable(),
  })
  .strict();

export type AccountUsageResponse = z.infer<
  typeof AccountUsageResponseSchema
>;

export const BackgroundRunHistoryItemSchema = z
  .object({
    runId: z.string().uuid(),
    conversationId: z.string().uuid(),
    conversationTitle: z.string().min(1).max(500),
    status: TerminalAgentRunStatusSchema,
    finishedAt: z.string().datetime(),
  })
  .strict();

export type BackgroundRunHistoryItem = z.infer<
  typeof BackgroundRunHistoryItemSchema
>;

export const BackgroundRunHistoryResponseSchema = z
  .object({
    items: z.array(BackgroundRunHistoryItemSchema),
    nextCursor: z.string().min(1).max(1_024).nullable(),
  })
  .strict();

export type BackgroundRunHistoryResponse = z.infer<
  typeof BackgroundRunHistoryResponseSchema
>;

export const InputAttachmentLimitsSchema = z
  .object({
    maxFileBytes: z.number().int().positive().safe(),
    maxFilesPerMessage: z.number().int().min(1).max(5),
    maxTotalBytesPerMessage: z.number().int().positive().safe(),
  })
  .strict()
  .superRefine((limits, context) => {
    if (limits.maxFileBytes > limits.maxTotalBytesPerMessage) {
      context.addIssue({
        code: "custom",
        message: "maxFileBytes cannot exceed maxTotalBytesPerMessage",
        path: ["maxFileBytes"],
      });
    }
  });

export type InputAttachmentLimits = z.infer<
  typeof InputAttachmentLimitsSchema
>;

export const ExecutionProfileIdSchema = z.enum([
  "standard_research",
  "pro_research",
]);

export type ExecutionProfileId = z.infer<typeof ExecutionProfileIdSchema>;

export const ReasoningModeSchema = z.enum(["standard", "pro"]);

export type ReasoningMode = z.infer<typeof ReasoningModeSchema>;

export const ReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ExecutionProfileOptionSchema = z
  .object({
    id: ExecutionProfileIdSchema,
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(240),
  })
  .strict();

export type ExecutionProfileOption = z.infer<
  typeof ExecutionProfileOptionSchema
>;

export const ExecutionProfileCatalogSchema = z
  .object({
    defaultId: ExecutionProfileIdSchema,
    options: z.array(ExecutionProfileOptionSchema).min(1),
  })
  .strict()
  .superRefine((catalog, context) => {
    const ids = catalog.options.map((option) => option.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Execution profile IDs must be unique",
        path: ["options"],
      });
    }
    if (!ids.includes(catalog.defaultId)) {
      context.addIssue({
        code: "custom",
        message: "Default execution profile must be listed",
        path: ["defaultId"],
      });
    }
  });

export type ExecutionProfileCatalog = z.infer<
  typeof ExecutionProfileCatalogSchema
>;

const CapturedRunExecutionConfigSchema = z
  .object({
    provenance: z.literal("captured"),
    snapshotVersion: z.union([z.literal(1), z.literal(2)]),
    executionProfileId: ExecutionProfileIdSchema,
    profileLabel: z.string().trim().min(1).max(80),
    provider: z.enum(["openai", "sharesub"]),
    baseUrl: ProviderBaseUrlSchema,
    model: z.string().trim().min(1).max(200),
    reasoningMode: ReasoningModeSchema,
    reasoningModeEnabled: z.boolean(),
    reasoningEffort: ReasoningEffortSchema,
    reasoningSummary: z.literal("auto"),
    tools: z
      .object({
        webSearch: z.literal(true),
        codeInterpreter: z.literal(false),
        listResearch: z.literal(true),
        saveResearchResults: z.literal(true),
        createCsv: z.literal(true),
        createPdf: z.literal(true),
        createCsvFile: z.literal(true),
        createPdfFile: z.literal(true),
      })
      .strict(),
    maxAgentTurns: z.number().int().min(1).max(32),
    billing: z
      .object({
        policyVersion: z.literal(1),
        reservationCredits: PositivePostgresIntegerSchema,
        creditsPer1kInputTokens: NonnegativePostgresIntegerSchema,
        creditsPer1kOutputTokens: NonnegativePostgresIntegerSchema,
        creditsPerWebSearch: NonnegativePostgresIntegerSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.snapshotVersion === 1 && !config.reasoningModeEnabled) {
      context.addIssue({
        code: "custom",
        message:
          "Version 1 execution snapshots always enabled reasoning.mode",
        path: ["reasoningModeEnabled"],
      });
    }
  });

const LegacyUnknownRunExecutionConfigSchema = z
  .object({
    provenance: z.literal("legacy_unknown"),
    snapshotVersion: z.literal(0),
  })
  .strict();

export const RunExecutionConfigSchema = z.discriminatedUnion("provenance", [
  CapturedRunExecutionConfigSchema,
  LegacyUnknownRunExecutionConfigSchema,
]);

export type RunExecutionConfig = z.infer<typeof RunExecutionConfigSchema>;

export type CapturedRunExecutionConfig = z.infer<
  typeof CapturedRunExecutionConfigSchema
>;

const CapturedRunExecutionSummarySchema = z
  .object({
    provenance: z.literal("captured"),
    snapshotVersion: z.union([z.literal(1), z.literal(2)]),
    executionProfileId: ExecutionProfileIdSchema,
    profileLabel: z.string().trim().min(1).max(80),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

const LegacyUnknownRunExecutionSummarySchema = z
  .object({
    provenance: z.literal("legacy_unknown"),
    snapshotVersion: z.literal(0),
  })
  .strict();

export const RunExecutionSummarySchema = z.discriminatedUnion(
  "provenance",
  [
    CapturedRunExecutionSummarySchema,
    LegacyUnknownRunExecutionSummarySchema,
  ],
);

export type RunExecutionSummary = z.infer<
  typeof RunExecutionSummarySchema
>;

export const RunWorkerCapabilitySchema = z
  .object({
    provider: z.enum(["openai", "sharesub"]),
    baseUrl: ProviderBaseUrlSchema,
    reasoningMode: z.boolean(),
    codeInterpreter: z.boolean(),
  })
  .strict();

export type RunWorkerCapability = z.infer<
  typeof RunWorkerCapabilitySchema
>;

export const BootstrapResponseSchema = z
  .object({
    user: z
      .object({
        id: z.string().uuid(),
        name: z.string(),
      })
      .strict(),
    credits: CreditBalanceSchema,
    conversations: z.array(ConversationSummarySchema),
    nextCursor: z.string().nullable(),
    trackedConversations: z.array(ConversationSummarySchema),
    inputAttachmentLimits: InputAttachmentLimitsSchema,
    executionProfiles: ExecutionProfileCatalogSchema,
  })
  .strict();

export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;

export const AgentRunSchema = z
  .object({
    id: z.string().uuid(),
    requestId: z.string().uuid(),
    conversationId: z.string().uuid(),
    inputMessageId: z.string().uuid().nullable(),
    assistantMessageId: z.string().uuid().nullable(),
    status: AgentRunStatusSchema,
    conversationTurn: PositivePostgresBigintStringSchema,
    attemptIndex: z.number().int().positive().safe(),
    predecessorRunId: z.string().uuid().nullable(),
    retryOfRunId: z.string().uuid().nullable(),
    regenerateOfRunId: z.string().uuid().nullable(),
    executionConfig: RunExecutionSummarySchema,
    failure: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .strict()
      .nullable(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    cancelRequestedAt: z.string().datetime().nullable(),
  })
  .strict();

export type AgentRun = z.infer<typeof AgentRunSchema>;

export const CreatedAgentRunSchema = AgentRunSchema.extend({
  inputMessageId: z.string().uuid(),
  assistantMessageId: z.string().uuid(),
});

export type CreatedAgentRun = z.infer<typeof CreatedAgentRunSchema>;

export const ConversationResponseSchema = z.object({
  conversation: ConversationSummarySchema,
  messages: z.array(ChatMessageSchema),
  runs: z.array(AgentRunSchema),
});

export type ConversationResponse = z.infer<typeof ConversationResponseSchema>;

export const CreateConversationResponseSchema = z.object({
  conversation: ConversationSummarySchema,
});

export type CreateConversationResponse = z.infer<
  typeof CreateConversationResponseSchema
>;

export const BranchConversationRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    sourceMessageId: z.string().uuid(),
  })
  .strict();

export type BranchConversationRequest = z.infer<
  typeof BranchConversationRequestSchema
>;

export const BranchConversationResponseSchema = z
  .object({
    conversation: ConversationSummarySchema,
  })
  .strict();

export type BranchConversationResponse = z.infer<
  typeof BranchConversationResponseSchema
>;

const ChatRequestCommonShape = {
  message: z.string().trim().max(20_000),
  attachmentIds: z.array(z.string().uuid()).max(5),
  requestId: z.string().uuid(),
  executionProfileId: ExecutionProfileIdSchema,
};

export const ChatRequestSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("append"),
        conversationId: z.string().uuid().nullable(),
        parentRunId: z.string().uuid().nullable(),
        ...ChatRequestCommonShape,
      })
      .strict(),
    z
      .object({
        kind: z.literal("edit"),
        conversationId: z.string().uuid(),
        parentRunId: z.string().uuid().nullable(),
        sourceMessageId: z.string().uuid(),
        ...ChatRequestCommonShape,
      })
      .strict(),
  ])
  .superRefine((request, context) => {
    if (
      request.kind === "append" &&
      request.conversationId === null &&
      request.parentRunId !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "A new conversation cannot have a parent Run",
        path: ["parentRunId"],
      });
    }
    if (request.message.length === 0 && request.attachmentIds.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A message or at least one attachment is required",
        path: ["message"],
      });
    }
    if (new Set(request.attachmentIds).size !== request.attachmentIds.length) {
      context.addIssue({
        code: "custom",
        message: "Attachment IDs must be unique",
        path: ["attachmentIds"],
      });
    }
  });

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const UploadInputAttachmentResponseSchema = z
  .object({
    attachment: InputAttachmentSummarySchema,
    expiresAt: z.string().datetime(),
  })
  .strict();

export type UploadInputAttachmentResponse = z.infer<
  typeof UploadInputAttachmentResponseSchema
>;

export const DeleteInputAttachmentResponseSchema = z
  .object({
    deletion: z
      .object({
        attachmentId: z.string().uuid(),
        deletedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();

export type DeleteInputAttachmentResponse = z.infer<
  typeof DeleteInputAttachmentResponseSchema
>;

export const ChatStartResponseSchema = z.object({
  conversation: ConversationSummarySchema,
  userMessage: ChatMessageSchema,
  run: CreatedAgentRunSchema,
  credits: CreditBalanceSchema,
});

export type ChatStartResponse = z.infer<typeof ChatStartResponseSchema>;

export const CancelRunResponseSchema = z.object({
  run: AgentRunSchema,
});

export type CancelRunResponse = z.infer<typeof CancelRunResponseSchema>;

export const RetryRunRequestSchema = z
  .object({
    requestId: z.string().uuid(),
  })
  .strict();

export type RetryRunRequest = z.infer<typeof RetryRunRequestSchema>;

export const RetryRunResponseSchema = z
  .object({
    conversation: ConversationSummarySchema,
    run: CreatedAgentRunSchema,
    credits: CreditBalanceSchema,
  })
  .strict();

export type RetryRunResponse = z.infer<typeof RetryRunResponseSchema>;

export const RegenerateRunRequestSchema = z
  .object({
    requestId: z.string().uuid(),
  })
  .strict();

export type RegenerateRunRequest = z.infer<
  typeof RegenerateRunRequestSchema
>;

export const RegenerateRunResponseSchema = z
  .object({
    conversation: ConversationSummarySchema,
    run: CreatedAgentRunSchema,
    credits: CreditBalanceSchema,
  })
  .strict();

export type RegenerateRunResponse = z.infer<
  typeof RegenerateRunResponseSchema
>;

export const ApiErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.enum(APP_ERROR_CODES),
        message: z.string(),
      })
      .strict(),
  })
  .strict();

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export const AgentToolNameSchema = z.enum([
  "web_search",
  "code_interpreter",
  "list_research",
  "save_research_results",
  "create_csv",
  "create_pdf",
  "create_csv_file",
  "create_pdf_file",
]);

export type AgentToolName = z.infer<typeof AgentToolNameSchema>;

export const LocalAgentToolNameSchema = z.enum([
  "list_research",
  "save_research_results",
  "create_csv",
  "create_pdf",
  "create_csv_file",
  "create_pdf_file",
]);

export type LocalAgentToolName = z.infer<typeof LocalAgentToolNameSchema>;

export const WebSearchSourceSchema = z
  .object({
    type: z.literal("url"),
    url: z.string().url(),
  })
  .strict();

export const WebSearchActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("search"),
      query: z.string().nullable(),
      queries: z.array(z.string()),
      sources: z.array(WebSearchSourceSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal("open_page"),
      url: z.string().url().nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("find_in_page"),
      url: z.string().url(),
      pattern: z.string(),
    })
    .strict(),
]);

export type WebSearchAction = z.infer<typeof WebSearchActionSchema>;

const CodeInterpreterImageUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  }, "Code Interpreter image URL must use HTTP or HTTPS");

export const CodeInterpreterOutputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("logs"),
      logs: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      url: CodeInterpreterImageUrlSchema,
    })
    .strict(),
]);

export type CodeInterpreterOutput = z.infer<
  typeof CodeInterpreterOutputSchema
>;

export const RunEventPayloadSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("status"),
    phase: z.enum([
      "thinking",
      "searching",
      "coding",
      "saving",
      "rendering",
    ]),
    message: z.string(),
  }),
  z.object({
    type: z.literal("reasoning"),
    itemId: z.string(),
    summaryIndex: z.number().int().nonnegative(),
    providerSequence: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("web_search"),
    callId: z.string(),
    phase: z.enum(["in_progress", "searching", "completed", "failed"]),
    outputIndex: z.number().int().nonnegative(),
    providerSequence: z.number().int().nonnegative(),
    action: WebSearchActionSchema.nullable(),
  }),
  z
    .object({
      type: z.literal("code_interpreter_status"),
      callId: z.string(),
      phase: z.enum(["in_progress", "interpreting", "completed"]),
      outputIndex: z.number().int().nonnegative(),
      providerSequence: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("code_interpreter_code"),
      callId: z.string(),
      update: z.enum(["delta", "done"]),
      code: z.string(),
      outputIndex: z.number().int().nonnegative(),
      providerSequence: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("code_interpreter_result"),
      callId: z.string(),
      phase: z.enum([
        "in_progress",
        "interpreting",
        "completed",
        "incomplete",
        "failed",
      ]),
      outputIndex: z.number().int().nonnegative(),
      providerSequence: z.number().int().nonnegative(),
      containerId: z.string(),
      code: z.string().nullable(),
      outputs: z.array(CodeInterpreterOutputSchema).nullable(),
    })
    .strict(),
  z.object({
    type: z.literal("tool_started"),
    callId: z.string(),
    toolName: LocalAgentToolNameSchema,
    title: z.string(),
    input: z.string(),
  }),
  z.object({
    type: z.literal("tool_completed"),
    callId: z.string(),
    toolName: LocalAgentToolNameSchema,
    title: z.string(),
    output: z.string(),
  }),
  z.object({
    type: z.literal("delta"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("artifact"),
    artifact: ArtifactSummarySchema,
  }),
  z
    .object({
      type: z.literal("attachment"),
      attachment: InputAttachmentSummarySchema,
    })
    .strict(),
  z.object({
    type: z.literal("done"),
    message: ChatMessageSchema,
    credits: CreditBalanceSchema,
  }),
  z.object({
    type: z.literal("error"),
    error: z.object({
      code: z.string(),
      message: z.string(),
      runId: z.string().uuid(),
    }),
  }),
]);

export type RunEventPayload = z.infer<typeof RunEventPayloadSchema>;

export const RunEventSchema = z.object({
  id: z.string().regex(/^\d+$/u),
  runId: z.string().uuid(),
  createdAt: z.string().datetime(),
  payload: RunEventPayloadSchema,
});

export type RunEvent = z.infer<typeof RunEventSchema>;

export type ChatStreamEvent = RunEventPayload;

export function encodeRunEventSse(event: RunEvent): Uint8Array {
  return new TextEncoder().encode(
    `id: ${event.id}\nevent: ${event.payload.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

export function encodeSse(event: ChatStreamEvent): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}
