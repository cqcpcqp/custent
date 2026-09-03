import { describe, expect, it } from "vitest";

import {
  AccountUsageResponseSchema,
  AgentRunSchema,
  BackgroundRunHistoryResponseSchema,
  BootstrapResponseSchema,
  BulkConversationMutationRequestSchema,
  BulkConversationMutationResponseSchema,
  CancelRunResponseSchema,
  ChatMessageSchema,
  CitationSchema,
  ChatRequestSchema,
  ConversationShareListItemSchema,
  ConversationShareSummarySchema,
  ConversationListItemSchema,
  ConversationSummarySchema,
  CreatedAgentRunSchema,
  DeleteConversationResponseSchema,
  GetConversationShareResponseSchema,
  InputAttachmentSummarySchema,
  GetLibraryResearchResponseSchema,
  LibraryArtifactItemSchema,
  LibraryResearchDetailSchema,
  LibraryResearchItemSchema,
  ListLibraryArtifactsResponseSchema,
  ListLibraryResearchResponseSchema,
  ListConversationSharesResponseSchema,
  ListConversationsResponseSchema,
  PatchConversationRequestSchema,
  PatchMessageFeedbackRequestSchema,
  PatchMessageFeedbackResponseSchema,
  PublicConversationShareSchema,
  PutConversationShareResponseSchema,
  RegenerateRunRequestSchema,
  RegenerateRunResponseSchema,
  RevokeConversationShareResponseSchema,
  RetryRunRequestSchema,
  RetryRunResponseSchema,
  RunEventPayloadSchema,
  SharedConversationFileSchema,
  SharedConversationMessageSchema,
  UploadInputAttachmentResponseSchema,
  conversationSummaryFromListItem,
  encodeSse,
} from "@/lib/contracts";
import {
  TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
  TEST_EXECUTION_PROFILE_CATALOG,
} from "@/tests/fixtures/run-config";
import { SaveResearchInputSchema } from "@/lib/domain/research";
import {
  inputAttachmentFormatSpecifications,
  INPUT_ATTACHMENT_MIME_TYPES,
} from "@/lib/input-attachment-formats";

describe("fixed application contracts", () => {
  it("uses the exact account usage balance and per-Run page contract", () => {
    const completed = {
      runId: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      conversationTitle: "German pump buyers",
      status: "completed" as const,
      reservationCredits: 2_000,
      chargedCredits: 37,
      inputTokens: 1_200,
      outputTokens: 320,
      webSearches: 4,
      createdAt: "2026-08-28T08:00:00.000Z",
      finishedAt: "2026-08-28T08:02:00.000Z",
    };
    const response = {
      balance: { available: 7_495, reserved: 1_500, frozen: 500 },
      items: [completed],
      nextCursor: "opaque_cursor",
    };

    expect(AccountUsageResponseSchema.parse(response)).toEqual(response);
    for (const status of [
      "waiting",
      "queued",
      "running",
      "failed",
      "cancelled",
      "reconciliation_required",
    ] as const) {
      expect(
        AccountUsageResponseSchema.parse({
          ...response,
          items: [
            {
              ...completed,
              status,
              chargedCredits: null,
              inputTokens: null,
              outputTokens: null,
              webSearches: null,
              finishedAt:
                status === "failed" ||
                status === "cancelled" ||
                status === "reconciliation_required"
                  ? completed.finishedAt
                  : null,
            },
          ],
        }).items[0]?.status,
      ).toBe(status);
    }

    expect(() =>
      AccountUsageResponseSchema.parse({
        ...response,
        balance: { available: 7_495, reserved: 2_000 },
      }),
    ).toThrow();
    expect(() =>
      AccountUsageResponseSchema.parse({
        ...response,
        items: [{ ...completed, ledgerEntryType: "settle" }],
      }),
    ).toThrow();
    expect(() =>
      AccountUsageResponseSchema.parse({
        ...response,
        unknown: true,
      }),
    ).toThrow();
  });

  it("uses the exact terminal Run history contract needed to open activity", () => {
    const item = {
      runId: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      conversationTitle: "German pump buyers",
      status: "completed" as const,
      finishedAt: "2026-08-28T08:02:00.000Z",
    };
    const response = { items: [item], nextCursor: "opaque_cursor" };

    expect(BackgroundRunHistoryResponseSchema.parse(response)).toEqual(
      response,
    );
    for (const status of [
      "completed",
      "failed",
      "cancelled",
      "reconciliation_required",
    ] as const) {
      expect(
        BackgroundRunHistoryResponseSchema.parse({
          ...response,
          items: [{ ...item, status }],
        }).items[0]?.status,
      ).toBe(status);
    }
    for (const status of ["waiting", "queued", "running"]) {
      expect(() =>
        BackgroundRunHistoryResponseSchema.parse({
          ...response,
          items: [{ ...item, status }],
        }),
      ).toThrow();
    }
    expect(() =>
      BackgroundRunHistoryResponseSchema.parse({
        ...response,
        items: [{ ...item, terminalEventId: "42" }],
      }),
    ).toThrow();
    expect(() =>
      BackgroundRunHistoryResponseSchema.parse({
        ...response,
        unknown: true,
      }),
    ).toThrow();
  });

  it("uses an exact paginated bootstrap contract with tracked conversations", () => {
    const conversation = {
      id: "11111111-1111-4111-8111-111111111111",
      title: "German pump buyers",
      updatedAt: "2026-08-25T08:00:00.000Z",
      pinnedAt: null,
      archivedAt: null,
      selectedRunId: null,
      activeRun: null,
      waitingRunCount: 0,
      attention: null,
    };
    const bootstrap = {
      user: {
        id: "22222222-2222-4222-8222-222222222222",
        name: "测试用户",
      },
      credits: { available: 10_000, reserved: 0 },
      conversations: [conversation],
      nextCursor: "opaque_cursor",
      trackedConversations: [conversation],
      inputAttachmentLimits: {
        maxFileBytes: 100,
        maxFilesPerMessage: 2,
        maxTotalBytesPerMessage: 200,
      },
      executionProfiles: TEST_EXECUTION_PROFILE_CATALOG,
    };

    expect(BootstrapResponseSchema.parse(bootstrap)).toEqual(bootstrap);
    for (const missingField of [
      "nextCursor",
      "trackedConversations",
      "executionProfiles",
    ] as const) {
      const invalid: Partial<typeof bootstrap> = { ...bootstrap };
      delete invalid[missingField];
      expect(BootstrapResponseSchema.safeParse(invalid).success).toBe(false);
    }
    expect(
      BootstrapResponseSchema.safeParse({
        ...bootstrap,
        nextCursor: 42,
      }).success,
    ).toBe(false);
  });

  it("accepts only HTTP(S) citation URLs", () => {
    const citation = {
      title: "Buyer source",
      startIndex: 0,
      endIndex: 5,
    };

    for (const url of ["https://buyer.example/source", "http://buyer.example/source"]) {
      expect(CitationSchema.parse({ ...citation, url })).toEqual({
        ...citation,
        url,
      });
    }
    for (const url of [
      "data:text/html,<script>alert(1)</script>",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "custom-protocol://buyer/source",
    ]) {
      expect(() => CitationSchema.parse({ ...citation, url })).toThrow();
    }
  });

  it("uses exact local feedback contracts on assistant messages", () => {
    const baseMessage = {
      id: "11111111-1111-4111-8111-111111111111",
      runId: "22222222-2222-4222-8222-222222222222",
      content: "Buyer research is complete.",
      citations: [],
      artifacts: [],
      attachments: [],
      createdAt: "2026-08-25T08:00:00.000Z",
    };

    for (const feedback of ["up", "down", null] as const) {
      const message = {
        ...baseMessage,
        role: "assistant" as const,
        feedback,
      };
      expect(ChatMessageSchema.parse(message)).toEqual(message);
      expect(
        PatchMessageFeedbackRequestSchema.parse({ feedback }),
      ).toEqual({ feedback });
      expect(
        PatchMessageFeedbackResponseSchema.parse({
          messageId: baseMessage.id,
          feedback,
        }),
      ).toEqual({ messageId: baseMessage.id, feedback });
    }

    expect(
      ChatMessageSchema.parse({
        ...baseMessage,
        role: "user",
        feedback: null,
      }),
    ).toMatchObject({ role: "user", feedback: null });
    expect(() =>
      ChatMessageSchema.parse({
        ...baseMessage,
        role: "user",
        feedback: "up",
      }),
    ).toThrow();
    expect(() =>
      ChatMessageSchema.parse({
        ...baseMessage,
        role: "assistant",
      }),
    ).toThrow();
    expect(() =>
      PatchMessageFeedbackRequestSchema.parse({
        feedback: "up",
        reason: "useful",
      }),
    ).toThrow();
    expect(() =>
      PatchMessageFeedbackRequestSchema.parse({ feedback: "sideways" }),
    ).toThrow();
    expect(() =>
      PatchMessageFeedbackResponseSchema.parse({
        messageId: baseMessage.id,
        feedback: null,
        providerForwarded: false,
      }),
    ).toThrow();
  });

  it("uses the fixed conversation lifecycle summary and list page", () => {
    const conversation = {
      id: "11111111-1111-4111-8111-111111111111",
      title: "German pump buyers",
      updatedAt: "2026-08-25T08:00:00.000Z",
      pinnedAt: "2026-08-25T08:01:00.000Z",
      archivedAt: null,
      selectedRunId: null,
      activeRun: null,
      waitingRunCount: 0,
      attention: null,
    };
    const listItem = { ...conversation, searchMatch: null };

    expect(ConversationSummarySchema.parse(conversation)).toEqual(conversation);
    expect(ConversationListItemSchema.parse(listItem)).toEqual(listItem);
    expect(conversationSummaryFromListItem(listItem)).toEqual(conversation);
    expect(
      ListConversationsResponseSchema.parse({
        items: [listItem],
        nextCursor: "opaque_cursor",
      }),
    ).toEqual({ items: [listItem], nextCursor: "opaque_cursor" });
    expect(() =>
      ListConversationsResponseSchema.parse({
        items: [conversation],
        nextCursor: null,
      }),
    ).toThrow();
    expect(() =>
      ListConversationsResponseSchema.parse({
        items: [listItem],
        nextCursor: null,
        unknown: true,
      }),
    ).toThrow();
    expect(() =>
      ConversationSummarySchema.parse({
        ...conversation,
        pinnedAt: undefined,
      }),
    ).toThrow();
    expect(() =>
      ConversationSummarySchema.parse({
        ...conversation,
        waitingRunCount: undefined,
      }),
    ).toThrow();
    for (const waitingRunCount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        ConversationSummarySchema.parse({
          ...conversation,
          waitingRunCount,
        }),
      ).toThrow();
    }
    expect(() =>
      ConversationSummarySchema.parse({
        ...conversation,
        unknown: true,
      }),
    ).toThrow();
  });

  it("uses strict title and message search-match contracts", () => {
    const conversation = {
      id: "11111111-1111-4111-8111-111111111111",
      title: "German pump buyers",
      updatedAt: "2026-08-25T08:00:00.000Z",
      pinnedAt: null,
      archivedAt: null,
      selectedRunId: null,
      activeRun: null,
      waitingRunCount: 0,
      attention: null,
    };
    const titleMatch = {
      ...conversation,
      searchMatch: {
        kind: "title" as const,
        excerpt: {
          before: "German ",
          match: "pump",
          after: " buyers",
          beforeTruncated: false,
          afterTruncated: false,
        },
      },
    };
    const messageMatch = {
      ...conversation,
      searchMatch: {
        kind: "message" as const,
        messageId: "22222222-2222-4222-8222-222222222222",
        role: "assistant" as const,
        createdAt: "2026-08-25T08:01:00.000Z",
        excerpt: {
          before: "A verified ",
          match: "pump",
          after: " buyer",
          beforeTruncated: true,
          afterTruncated: false,
        },
      },
    };

    expect(ConversationListItemSchema.parse(titleMatch)).toEqual(titleMatch);
    expect(ConversationListItemSchema.parse(messageMatch)).toEqual(messageMatch);
    expect(() =>
      ConversationListItemSchema.parse({
        ...titleMatch,
        searchMatch: {
          ...titleMatch.searchMatch,
          excerpt: {
            ...titleMatch.searchMatch.excerpt,
            beforeTruncated: true,
          },
        },
      }),
    ).toThrow();
    expect(() =>
      ConversationListItemSchema.parse({
        ...messageMatch,
        searchMatch: { ...messageMatch.searchMatch, unknown: true },
      }),
    ).toThrow();
    expect(() =>
      ConversationListItemSchema.parse({
        ...messageMatch,
        searchMatch: {
          ...messageMatch.searchMatch,
          excerpt: { ...messageMatch.searchMatch.excerpt, match: "" },
        },
      }),
    ).toThrow();
  });

  it("uses the exact terminal-event attention contract", () => {
    const attention = {
      terminalEventId: "9223372036854775807",
      runId: "22222222-2222-4222-8222-222222222222",
      status: "completed" as const,
      finishedAt: "2026-08-25T08:02:00.000Z",
    };
    const conversation = {
      id: "11111111-1111-4111-8111-111111111111",
      title: "German pump buyers",
      updatedAt: "2026-08-25T08:00:00.000Z",
      pinnedAt: null,
      archivedAt: null,
      selectedRunId: attention.runId,
      activeRun: null,
      waitingRunCount: 0,
      attention,
    };

    expect(ConversationSummarySchema.parse(conversation)).toEqual(conversation);
    expect(() =>
      ConversationSummarySchema.parse({
        ...conversation,
        attention: { ...attention, unknown: true },
      }),
    ).toThrow();
    expect(() =>
      ConversationSummarySchema.parse({
        ...conversation,
        attention: { ...attention, terminalEventId: "0" },
      }),
    ).toThrow();
  });

  it("accepts only the strict discriminated conversation patch actions", () => {
    expect(
      PatchConversationRequestSchema.parse({
        action: "rename",
        title: "  German buyers  ",
      }),
    ).toEqual({ action: "rename", title: "German buyers" });
    expect(
      PatchConversationRequestSchema.parse({
        action: "set_pinned",
        pinned: true,
      }),
    ).toEqual({ action: "set_pinned", pinned: true });
    expect(
      PatchConversationRequestSchema.parse({
        action: "set_archived",
        archived: false,
      }),
    ).toEqual({ action: "set_archived", archived: false });
    expect(
      PatchConversationRequestSchema.parse({
        action: "mark_read",
        throughEventId: "42",
      }),
    ).toEqual({ action: "mark_read", throughEventId: "42" });
    expect(
      PatchConversationRequestSchema.parse({
        action: "select_run",
        runId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      action: "select_run",
      runId: "11111111-1111-4111-8111-111111111111",
    });

    expect(() =>
      PatchConversationRequestSchema.parse({
        action: "rename",
        title: "German buyers",
        pinned: true,
      }),
    ).toThrow();
    expect(() =>
      PatchConversationRequestSchema.parse({
        action: "set_archived",
        archived: "true",
      }),
    ).toThrow();
    for (const throughEventId of [
      "0",
      "-1",
      "1.5",
      "9223372036854775808",
    ]) {
      expect(() =>
        PatchConversationRequestSchema.parse({
          action: "mark_read",
          throughEventId,
        }),
      ).toThrow();
    }
    expect(() =>
      PatchConversationRequestSchema.parse({
        action: "mark_read",
        throughEventId: "42",
        extra: true,
      }),
    ).toThrow();
  });

  it("uses one strict bulk conversation mutation request and response", () => {
    expect(
      BulkConversationMutationRequestSchema.parse({ action: "archive_all" }),
    ).toEqual({ action: "archive_all" });
    for (const request of [
      {},
      { action: "delete_all" },
      { action: "archive_all", extra: true },
    ]) {
      expect(() =>
        BulkConversationMutationRequestSchema.parse(request),
      ).toThrow();
    }

    for (const action of ["archive_all", "delete_all"] as const) {
      const response = {
        mutation: {
          action,
          conversationCount: action === "archive_all" ? 2 : 0,
          completedAt: "2026-09-01T08:00:00.000Z",
        },
      };
      expect(BulkConversationMutationResponseSchema.parse(response)).toEqual(
        response,
      );
      expect(() =>
        BulkConversationMutationResponseSchema.parse({
          ...response,
          extra: true,
        }),
      ).toThrow();
      expect(() =>
        BulkConversationMutationResponseSchema.parse({
          mutation: { ...response.mutation, extra: true },
        }),
      ).toThrow();
    }

    for (const mutation of [
      {
        action: "unknown",
        conversationCount: 0,
        completedAt: "2026-09-01T08:00:00.000Z",
      },
      {
        action: "archive_all",
        conversationCount: -1,
        completedAt: "2026-09-01T08:00:00.000Z",
      },
      {
        action: "delete_all",
        conversationCount: 1.5,
        completedAt: "2026-09-01T08:00:00.000Z",
      },
      {
        action: "delete_all",
        conversationCount: 0,
        completedAt: "not-a-date",
      },
    ]) {
      expect(() =>
        BulkConversationMutationResponseSchema.parse({ mutation }),
      ).toThrow();
    }
  });

  it("uses one fixed soft-deletion receipt", () => {
    const response = {
      deletion: {
        conversationId: "11111111-1111-4111-8111-111111111111",
        deletedAt: "2026-08-25T08:00:00.000Z",
      },
    };
    expect(DeleteConversationResponseSchema.parse(response)).toEqual(response);
  });

  it("uses separate strict Library research, detail, and artifact contracts", () => {
    const conversation = {
      id: "11111111-1111-4111-8111-111111111111",
      title: "German pump buyers",
      archivedAt: "2026-08-25T08:00:00.000Z",
    };
    const research = {
      id: "22222222-2222-4222-8222-222222222222",
      title: "Verified buyers",
      querySummary: "Public-source buyer research.",
      companyCount: 1,
      createdAt: "2026-08-25T08:01:00.000Z",
      conversation,
      runId: "33333333-3333-4333-8333-333333333333",
      assistantMessageId: "44444444-4444-4444-8444-444444444444",
    };
    const evidence = {
      claim: "The company distributes industrial pumps.",
      sourceUrl: "https://buyer.example/evidence",
      sourceTitle: "Buyer profile",
      supports: "business_fit" as const,
    };
    const detail = {
      ...research,
      limitations: "Only public evidence was used.",
      companies: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          name: "Buyer GmbH",
          websiteUrl: "https://buyer.example",
          country: "Germany",
          companyType: "distributor" as const,
          relevanceSummary: "Relevant industrial distributor.",
          contacts: [
            {
              name: "Erika Buyer",
              titleOriginal: "Sourcing Manager",
              roleCategory: "sourcing" as const,
              publicProfileUrl: null,
              confidence: "A" as const,
              evidence: [evidence],
            },
          ],
          evidence: [evidence],
        },
      ],
    };
    const artifact = {
      id: "66666666-6666-4666-8666-666666666666",
      name: "buyers.csv",
      mimeType: "text/csv" as const,
      sizeBytes: 128,
      downloadUrl:
        "/api/artifacts/66666666-6666-4666-8666-666666666666/download",
      createdAt: "2026-08-25T08:02:00.000Z",
      conversation,
      runId: research.runId,
      assistantMessageId: research.assistantMessageId,
      researchSnapshotId: research.id,
    };

    expect(LibraryResearchItemSchema.parse(research)).toEqual(research);
    expect(LibraryResearchDetailSchema.parse(detail)).toEqual(detail);
    expect(GetLibraryResearchResponseSchema.parse({ research: detail })).toEqual({
      research: detail,
    });
    expect(LibraryArtifactItemSchema.parse(artifact)).toEqual(artifact);
    expect(
      ListLibraryResearchResponseSchema.parse({
        items: [research],
        nextCursor: "opaque_cursor",
      }),
    ).toEqual({ items: [research], nextCursor: "opaque_cursor" });
    expect(
      ListLibraryArtifactsResponseSchema.parse({
        items: [artifact],
        nextCursor: null,
      }),
    ).toEqual({ items: [artifact], nextCursor: null });

    expect(() =>
      LibraryResearchDetailSchema.parse({
        ...detail,
        companyCount: 2,
      }),
    ).toThrow();
    expect(() =>
      LibraryResearchItemSchema.parse({ ...research, unknown: true }),
    ).toThrow();
    expect(() =>
      LibraryArtifactItemSchema.parse({ ...artifact, storagePath: "/private" }),
    ).toThrow();
    expect(() =>
      GetLibraryResearchResponseSchema.parse({
        research: detail,
        unknown: true,
      }),
    ).toThrow();
  });

  it("uses strict public conversation snapshot contracts without private file locators", () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const publicId = "22222222-2222-4222-8222-222222222222";
    const createdAt = "2026-08-28T08:00:00.000Z";
    const message = {
      id: "33333333-3333-4333-8333-333333333333",
      role: "assistant" as const,
      content: "Verified result",
      citations: [
        {
          url: "https://buyer.example/evidence",
          title: "Buyer evidence",
          startIndex: 0,
          endIndex: 8,
        },
      ],
      createdAt,
      files: [
        {
          kind: "input_attachment" as const,
          name: "requirements.pdf",
          mimeType: "application/pdf" as const,
          sizeBytes: 128,
        },
        {
          kind: "artifact" as const,
          name: "buyers.csv",
          mimeType: "text/csv" as const,
          sizeBytes: 256,
        },
      ],
    };
    const share = {
      conversationId,
      publicId,
      publicPath: `/share/${publicId}`,
      createdAt,
      updatedAt: createdAt,
    };

    expect(SharedConversationMessageSchema.parse(message)).toEqual(message);
    expect(ConversationShareSummarySchema.parse(share)).toEqual(share);
    const listItem = { ...share, title: "German buyers" };
    expect(ConversationShareListItemSchema.parse(listItem)).toEqual(listItem);
    expect(
      ListConversationSharesResponseSchema.parse({
        items: [listItem],
        nextCursor: "opaque_cursor",
      }),
    ).toEqual({ items: [listItem], nextCursor: "opaque_cursor" });
    expect(GetConversationShareResponseSchema.parse({ share: null })).toEqual({
      share: null,
    });
    expect(PutConversationShareResponseSchema.parse({ share })).toEqual({
      share,
    });
    expect(
      RevokeConversationShareResponseSchema.parse({
        revocation: { conversationId, publicId, revokedAt: createdAt },
      }),
    ).toEqual({
      revocation: { conversationId, publicId, revokedAt: createdAt },
    });
    expect(
      PublicConversationShareSchema.parse({
        title: "German buyers",
        messages: [message],
        createdAt,
        updatedAt: createdAt,
      }),
    ).toEqual({
      title: "German buyers",
      messages: [message],
      createdAt,
      updatedAt: createdAt,
    });

    expect(() =>
      ConversationShareSummarySchema.parse({
        ...share,
        publicPath: `/share/${conversationId}`,
      }),
    ).toThrow();
    expect(() =>
      ConversationShareListItemSchema.parse({ ...listItem, messages: [] }),
    ).toThrow();
    expect(() =>
      SharedConversationFileSchema.parse({
        ...message.files[0],
        id: publicId,
      }),
    ).toThrow();
    expect(() =>
      SharedConversationFileSchema.parse({
        ...message.files[1],
        downloadUrl: "/api/artifacts/private/download",
      }),
    ).toThrow();
    expect(() =>
      SharedConversationMessageSchema.parse({ ...message, feedback: "up" }),
    ).toThrow();
    expect(() =>
      PublicConversationShareSchema.parse({
        title: "Empty snapshot",
        messages: [],
        createdAt,
        updatedAt: createdAt,
      }),
    ).toThrow();
  });

  it("accepts a valid chat request", () => {
    expect(
      ChatRequestSchema.parse({
        kind: "append",
        conversationId: null,
        parentRunId: null,
        message: "帮我找德国工业阀门经销商",
        attachmentIds: [],
        requestId: "22222222-2222-4222-8222-222222222222",
        executionProfileId: "standard_research",
      }),
    ).toEqual({
      kind: "append",
      conversationId: null,
      parentRunId: null,
      message: "帮我找德国工业阀门经销商",
      attachmentIds: [],
      requestId: "22222222-2222-4222-8222-222222222222",
      executionProfileId: "standard_research",
    });
  });

  it("rejects an empty chat message", () => {
    expect(() =>
      ChatRequestSchema.parse({
        kind: "append",
        conversationId: null,
        parentRunId: null,
        message: "   ",
        attachmentIds: [],
        requestId: "22222222-2222-4222-8222-222222222222",
        executionProfileId: "standard_research",
      }),
    ).toThrow();
  });

  it("accepts an attachment-only request and preserves unique attachment order", () => {
    const firstAttachmentId = "33333333-3333-4333-8333-333333333333";
    const secondAttachmentId = "44444444-4444-4444-8444-444444444444";
    expect(
      ChatRequestSchema.parse({
        kind: "append",
        conversationId: null,
        parentRunId: null,
        message: "   ",
        attachmentIds: [firstAttachmentId, secondAttachmentId],
        requestId: "22222222-2222-4222-8222-222222222222",
        executionProfileId: "standard_research",
      }),
    ).toEqual({
      kind: "append",
      conversationId: null,
      parentRunId: null,
      message: "",
      attachmentIds: [firstAttachmentId, secondAttachmentId],
      requestId: "22222222-2222-4222-8222-222222222222",
      executionProfileId: "standard_research",
    });
    expect(() =>
      ChatRequestSchema.parse({
        kind: "append",
        conversationId: null,
        parentRunId: null,
        message: "附件",
        attachmentIds: [firstAttachmentId, firstAttachmentId],
        requestId: "22222222-2222-4222-8222-222222222222",
        executionProfileId: "standard_research",
      }),
    ).toThrow();
    expect(() =>
      ChatRequestSchema.parse({
        kind: "append",
        conversationId: null,
        parentRunId: null,
        message: "附件",
        attachmentIds: Array.from(
          { length: 6 },
          (_, index) =>
            `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        ),
        requestId: "22222222-2222-4222-8222-222222222222",
        executionProfileId: "standard_research",
      }),
    ).toThrow();
    expect(() =>
      ChatRequestSchema.parse({
        kind: "append",
        conversationId: null,
        parentRunId: null,
        message: "附件",
        attachmentIds: [],
        requestId: "22222222-2222-4222-8222-222222222222",
        executionProfileId: "standard_research",
        unexpected: true,
      }),
    ).toThrow();
  });

  it("accepts only explicit append/edit branch coordinates", () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const parentRunId = "22222222-2222-4222-8222-222222222222";
    const sourceMessageId = "33333333-3333-4333-8333-333333333333";
    const requestId = "44444444-4444-4444-8444-444444444444";
    expect(
      ChatRequestSchema.parse({
        kind: "edit",
        conversationId,
        parentRunId,
        sourceMessageId,
        message: "edited input",
        attachmentIds: [],
        requestId,
        executionProfileId: "standard_research",
      }),
    ).toMatchObject({ kind: "edit", sourceMessageId, parentRunId });
    expect(() =>
      ChatRequestSchema.parse({
        kind: "append",
        conversationId: null,
        parentRunId,
        message: "invalid new root",
        attachmentIds: [],
        requestId,
        executionProfileId: "standard_research",
      }),
    ).toThrow();
    expect(() =>
      ChatRequestSchema.parse({
        conversationId,
        message: "missing branch coordinates",
        attachmentIds: [],
        requestId,
        executionProfileId: "standard_research",
      }),
    ).toThrow();
  });

  it("uses the exact input attachment summary contract", () => {
    for (const mimeType of INPUT_ATTACHMENT_MIME_TYPES) {
      const attachment = {
        id: "33333333-3333-4333-8333-333333333333",
        kind: inputAttachmentFormatSpecifications[mimeType].kind,
        name: `buyers${inputAttachmentFormatSpecifications[mimeType].extensions[0]}`,
        mimeType,
        sizeBytes: 123,
        downloadUrl:
          "/api/input-attachments/33333333-3333-4333-8333-333333333333/content",
        createdAt: "2026-08-25T08:00:00.000Z",
      };
      expect(InputAttachmentSummarySchema.parse(attachment)).toEqual(
        attachment,
      );
      expect(() =>
        InputAttachmentSummarySchema.parse({
          ...attachment,
          kind: attachment.kind === "file" ? "image" : "file",
        }),
      ).toThrow();
    }
    const attachment = {
      id: "33333333-3333-4333-8333-333333333333",
      kind: "file" as const,
      name: "buyers.pdf",
      mimeType: "application/pdf" as const,
      sizeBytes: 123,
      downloadUrl:
        "/api/input-attachments/33333333-3333-4333-8333-333333333333/content",
      createdAt: "2026-08-25T08:00:00.000Z",
    };
    expect(() =>
      InputAttachmentSummarySchema.parse({ ...attachment, storagePath: "/tmp" }),
    ).toThrow();
    expect(() =>
      InputAttachmentSummarySchema.parse({
        ...attachment,
        mimeType: "image/svg+xml",
      }),
    ).toThrow();
    expect(
      RunEventPayloadSchema.parse({ type: "attachment", attachment }),
    ).toEqual({ type: "attachment", attachment });
  });

  it("uses one exact staged input attachment metadata contract", () => {
    const response = {
      attachment: {
        id: "33333333-3333-4333-8333-333333333333",
        kind: "file" as const,
        name: "buyers.pdf",
        mimeType: "application/pdf" as const,
        sizeBytes: 123,
        downloadUrl:
          "/api/input-attachments/33333333-3333-4333-8333-333333333333/content",
        createdAt: "2026-08-25T08:00:00.000Z",
      },
      expiresAt: "2026-08-26T08:00:00.000Z",
    };

    expect(UploadInputAttachmentResponseSchema.parse(response)).toEqual(
      response,
    );
    expect(() =>
      UploadInputAttachmentResponseSchema.parse({
        attachment: response.attachment,
      }),
    ).toThrow();
    expect(() =>
      UploadInputAttachmentResponseSchema.parse({
        ...response,
        expiresAt: "tomorrow",
      }),
    ).toThrow();
    expect(() =>
      UploadInputAttachmentResponseSchema.parse({
        ...response,
        ttlHours: 24,
      }),
    ).toThrow();
  });

  it("encodes one exact SSE event", () => {
    const encoded = encodeSse({
      type: "delta",
      text: "hello",
    });

    expect(new TextDecoder().decode(encoded)).toBe(
      'event: delta\ndata: {"type":"delta","text":"hello"}\n\n',
    );
  });

  it("accepts the exact reasoning and web-search activity contracts", () => {
    expect(
      RunEventPayloadSchema.parse({
        type: "reasoning",
        itemId: "reasoning-1",
        summaryIndex: 0,
        providerSequence: 12,
        text: "正在核验买家与产品的匹配度。",
      }),
    ).toEqual({
      type: "reasoning",
      itemId: "reasoning-1",
      summaryIndex: 0,
      providerSequence: 12,
      text: "正在核验买家与产品的匹配度。",
    });
    expect(
      RunEventPayloadSchema.parse({
        type: "web_search",
        callId: "search-1",
        phase: "searching",
        outputIndex: 1,
        providerSequence: 13,
        action: null,
      }),
    ).toEqual({
      type: "web_search",
      callId: "search-1",
      phase: "searching",
      outputIndex: 1,
      providerSequence: 13,
      action: null,
    });

    expect(
      RunEventPayloadSchema.parse({
        type: "web_search",
        callId: "search-1",
        phase: "completed",
        outputIndex: 1,
        providerSequence: 14,
        action: {
          type: "search",
          query: "German valve distributors",
          queries: ["German valve distributors"],
          sources: [{ type: "url", url: "https://example.com/source" }],
        },
      }),
    ).toMatchObject({
      phase: "completed",
      action: {
        type: "search",
        sources: [{ url: "https://example.com/source" }],
      },
    });

    expect(() =>
      RunEventPayloadSchema.parse({
        type: "web_search",
        callId: "search-1",
        phase: "searching",
        outputIndex: 1,
        providerSequence: 13,
      }),
    ).toThrow();
    expect(() =>
      RunEventPayloadSchema.parse({
        type: "code_interpreter_result",
        callId: "python-1",
        phase: "completed",
        outputIndex: 2,
        providerSequence: 24,
        containerId: "container-1",
        code: null,
        outputs: [{ type: "image", url: "javascript:alert(1)" }],
      }),
    ).toThrow();
  });

  it("accepts only the exact Code Interpreter activity lifecycle", () => {
    expect(
      RunEventPayloadSchema.parse({
        type: "code_interpreter_status",
        callId: "python-1",
        phase: "interpreting",
        outputIndex: 2,
        providerSequence: 20,
      }),
    ).toMatchObject({ phase: "interpreting" });
    expect(
      RunEventPayloadSchema.parse({
        type: "code_interpreter_code",
        callId: "python-1",
        update: "delta",
        code: "print(6)",
        outputIndex: 2,
        providerSequence: 21,
      }),
    ).toMatchObject({ update: "delta", code: "print(6)" });
    expect(
      RunEventPayloadSchema.parse({
        type: "code_interpreter_code",
        callId: "python-1",
        update: "done",
        code: "print(6)",
        outputIndex: 2,
        providerSequence: 22,
      }),
    ).toMatchObject({ update: "done", code: "print(6)" });
    expect(() =>
      RunEventPayloadSchema.parse({
        type: "code_interpreter_code",
        callId: "python-1",
        delta: "print(6)",
        outputIndex: 2,
        providerSequence: 22,
      }),
    ).toThrow();
    expect(
      RunEventPayloadSchema.parse({
        type: "code_interpreter_result",
        callId: "python-1",
        phase: "completed",
        outputIndex: 2,
        providerSequence: 23,
        containerId: "container-1",
        code: "print(6)",
        outputs: [
          { type: "logs", logs: "6" },
          { type: "image", url: "https://example.com/chart.png" },
        ],
      }),
    ).toMatchObject({
      containerId: "container-1",
      outputs: [{ type: "logs" }, { type: "image" }],
    });
    expect(() =>
      RunEventPayloadSchema.parse({
        type: "code_interpreter_result",
        callId: "python-1",
        phase: "completed",
        outputIndex: 2,
        providerSequence: 22,
        containerId: "container-1",
        code: "print(6)",
      }),
    ).toThrow();
    expect(() =>
      RunEventPayloadSchema.parse({
        type: "code_interpreter_status",
        callId: "python-1",
        phase: "failed",
        outputIndex: 2,
        providerSequence: 23,
      }),
    ).toThrow();
  });

  it("restricts tool activity to local tools with explicit text details", () => {
    expect(
      RunEventPayloadSchema.parse({
        type: "tool_started",
        callId: "call-1",
        toolName: "create_csv",
        title: "生成 CSV",
        input: '{"fileName":"buyers.csv"}',
      }),
    ).toMatchObject({ toolName: "create_csv" });

    expect(
      RunEventPayloadSchema.parse({
        type: "tool_started",
        callId: "call-generic-1",
        toolName: "create_csv_file",
        title: "生成通用 CSV",
        input:
          '{"fileName":"buyers.csv","columns":["name"],"rows":[["Acme"]]}',
      }),
    ).toMatchObject({ toolName: "create_csv_file" });

    expect(() =>
      RunEventPayloadSchema.parse({
        type: "tool_started",
        callId: "search-1",
        toolName: "web_search",
        title: "搜索网页",
        input: "{}",
      }),
    ).toThrow();
    expect(() =>
      RunEventPayloadSchema.parse({
        type: "tool_completed",
        callId: "call-1",
        toolName: "create_csv",
        title: "CSV 已生成",
        output: null,
      }),
    ).toThrow();
  });

  it("uses one fixed cancel-run response shape", () => {
    const run = {
      id: "11111111-1111-4111-8111-111111111111",
      requestId: "22222222-2222-4222-8222-222222222222",
      conversationId: "33333333-3333-4333-8333-333333333333",
      inputMessageId: "44444444-4444-4444-8444-444444444444",
      assistantMessageId: "55555555-5555-4555-8555-555555555555",
      status: "cancelled",
      conversationTurn: "1",
      attemptIndex: 1,
      predecessorRunId: null,
      retryOfRunId: null,
      regenerateOfRunId: null,
      executionConfig: TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
      failure: null,
      createdAt: "2026-08-24T08:00:00.000Z",
      startedAt: null,
      finishedAt: "2026-08-24T08:01:00.000Z",
      cancelRequestedAt: "2026-08-24T08:00:30.000Z",
    };

    expect(CancelRunResponseSchema.parse({ run })).toEqual({ run });
    expect(() =>
      CancelRunResponseSchema.parse({
        run: { ...run, cancelRequestedAt: undefined },
      }),
    ).toThrow();
  });

  it("keeps legacy run message links nullable but requires them for new runs", () => {
    const legacyRun = {
      id: "11111111-1111-4111-8111-111111111111",
      requestId: "22222222-2222-4222-8222-222222222222",
      conversationId: "33333333-3333-4333-8333-333333333333",
      inputMessageId: null,
      assistantMessageId: null,
      status: "completed",
      conversationTurn: "1",
      attemptIndex: 1,
      predecessorRunId: null,
      retryOfRunId: null,
      regenerateOfRunId: null,
      executionConfig: {
        provenance: "legacy_unknown",
        snapshotVersion: 0,
      },
      failure: null,
      createdAt: "2026-08-24T08:00:00.000Z",
      startedAt: "2026-08-24T08:00:05.000Z",
      finishedAt: "2026-08-24T08:01:00.000Z",
      cancelRequestedAt: null,
    };

    expect(AgentRunSchema.parse(legacyRun)).toEqual(legacyRun);
    expect(() => CreatedAgentRunSchema.parse(legacyRun)).toThrow();
  });

  it("uses the strict retry request and response contracts", () => {
    const sourceRunId = "11111111-1111-4111-8111-111111111111";
    const requestId = "22222222-2222-4222-8222-222222222222";
    const retryRun = {
      id: "33333333-3333-4333-8333-333333333333",
      requestId,
      conversationId: "44444444-4444-4444-8444-444444444444",
      inputMessageId: "55555555-5555-4555-8555-555555555555",
      assistantMessageId: "66666666-6666-4666-8666-666666666666",
      status: "queued" as const,
      conversationTurn: "9223372036854775807",
      attemptIndex: 2,
      predecessorRunId: null,
      retryOfRunId: sourceRunId,
      regenerateOfRunId: null,
      executionConfig: TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
      failure: null,
      createdAt: "2026-08-25T08:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      cancelRequestedAt: null,
    };
    const conversation = {
      id: retryRun.conversationId,
      title: "German pump buyers",
      updatedAt: "2026-08-25T08:00:00.000Z",
      pinnedAt: null,
      archivedAt: null,
      selectedRunId: retryRun.id,
      activeRun: {
        id: retryRun.id,
        status: "queued" as const,
        startedAt: null,
      },
      waitingRunCount: 0,
      attention: null,
    };

    expect(RetryRunRequestSchema.parse({ requestId })).toEqual({ requestId });
    expect(() =>
      RetryRunRequestSchema.parse({ requestId, sourceRunId }),
    ).toThrow();
    expect(
      RetryRunResponseSchema.parse({
        conversation,
        run: retryRun,
        credits: { available: 900, reserved: 100 },
      }),
    ).toEqual({
      conversation,
      run: retryRun,
      credits: { available: 900, reserved: 100 },
    });
    expect(() =>
      AgentRunSchema.parse({
        ...retryRun,
        conversationTurn: "9223372036854775808",
      }),
    ).toThrow();
  });

  it("uses strict regenerate request and response contracts", () => {
    const sourceRunId = "11111111-1111-4111-8111-111111111111";
    const requestId = "22222222-2222-4222-8222-222222222222";
    const regenerateRun = {
      id: "33333333-3333-4333-8333-333333333333",
      requestId,
      conversationId: "44444444-4444-4444-8444-444444444444",
      inputMessageId: "55555555-5555-4555-8555-555555555555",
      assistantMessageId: "66666666-6666-4666-8666-666666666666",
      status: "queued" as const,
      conversationTurn: "1",
      attemptIndex: 2,
      predecessorRunId: null,
      retryOfRunId: null,
      regenerateOfRunId: sourceRunId,
      executionConfig: TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
      failure: null,
      createdAt: "2026-08-26T08:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      cancelRequestedAt: null,
    };
    const conversation = {
      id: regenerateRun.conversationId,
      title: "German pump buyers",
      updatedAt: "2026-08-26T08:00:00.000Z",
      pinnedAt: null,
      archivedAt: null,
      selectedRunId: regenerateRun.id,
      activeRun: {
        id: regenerateRun.id,
        status: "queued" as const,
        startedAt: null,
      },
      waitingRunCount: 0,
      attention: null,
    };

    expect(RegenerateRunRequestSchema.parse({ requestId })).toEqual({
      requestId,
    });
    expect(() =>
      RegenerateRunRequestSchema.parse({ requestId, sourceRunId }),
    ).toThrow();
    expect(
      RegenerateRunResponseSchema.parse({
        conversation,
        run: regenerateRun,
        credits: { available: 900, reserved: 100 },
      }),
    ).toEqual({
      conversation,
      run: regenerateRun,
      credits: { available: 900, reserved: 100 },
    });
  });

  it("requires evidence for every saved company", () => {
    expect(() =>
      SaveResearchInputSchema.parse({
        title: "德国经销商",
        querySummary: "工业阀门德国经销商",
        limitations: "仅覆盖公开网页",
        companies: [
          {
            name: "Example GmbH",
            websiteUrl: "https://example.com",
            country: "Germany",
            companyType: "distributor",
            relevanceSummary: "Industrial valve distributor",
            contacts: [],
            evidence: [],
          },
        ],
      }),
    ).toThrow();
  });
});
