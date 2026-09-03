import type {
  AgentContext,
  AgentToolServices,
  ArtifactToolInput,
} from "@/lib/agent";
import {
  createCsvArtifact,
  createGenericCsvArtifact,
  createGenericPdfArtifact,
  createPdfArtifact,
  requestedArtifactName,
} from "@/lib/artifacts";
import type { ResearchSnapshot } from "@/lib/domain/research";
import { AppError } from "@/lib/errors";
import {
  getResearchSnapshot,
  listResearchSnapshotsForRun,
  saveResearchSnapshot,
} from "@/lib/research";

async function loadConversationSnapshot(
  context: AgentContext,
  snapshotId: string,
): Promise<ResearchSnapshot> {
  const summaries = await listResearchSnapshotsForRun(
    context.userId,
    context.conversationId,
    context.runId,
  );
  const belongsToConversation = summaries.some(
    (snapshot) => snapshot.id === snapshotId,
  );

  if (!belongsToConversation) {
    throw new AppError("NOT_FOUND", "研究快照不存在。", 404);
  }

  const snapshot = await getResearchSnapshot(context.userId, snapshotId);
  if (snapshot === null) {
    throw new AppError("NOT_FOUND", "研究快照不存在。", 404);
  }
  return snapshot;
}

async function createArtifact(
  format: "csv" | "pdf",
  input: ArtifactToolInput,
  context: AgentContext,
) {
  const snapshot = await loadConversationSnapshot(context, input.snapshotId);
  const artifactInput = {
    userId: context.userId,
    conversationId: context.conversationId,
    messageId: null,
    runId: context.runId,
    leaseOwner: context.leaseOwner,
    leaseToken: context.leaseToken,
    snapshot,
    name: requestedArtifactName(input.fileName, format),
  };

  return format === "csv"
    ? createCsvArtifact(artifactInput)
    : createPdfArtifact(artifactInput);
}

export const agentToolServices: AgentToolServices = {
  research: {
    listResearch(context) {
      return listResearchSnapshotsForRun(
        context.userId,
        context.conversationId,
        context.runId,
      );
    },
    async saveResearch(research, context) {
      const snapshot = await saveResearchSnapshot({
        userId: context.userId,
        conversationId: context.conversationId,
        runId: context.runId,
        leaseOwner: context.leaseOwner,
        leaseToken: context.leaseToken,
        research,
      });

      return {
        id: snapshot.id,
        title: snapshot.title,
        querySummary: snapshot.querySummary,
        companyCount: snapshot.companies.length,
        createdAt: snapshot.createdAt,
      };
    },
  },
  artifacts: {
    createCsv(input, context) {
      return createArtifact("csv", input, context);
    },
    createPdf(input, context) {
      return createArtifact("pdf", input, context);
    },
    createGenericCsv(input, context) {
      return createGenericCsvArtifact({
        userId: context.userId,
        conversationId: context.conversationId,
        messageId: null,
        runId: context.runId,
        leaseOwner: context.leaseOwner,
        leaseToken: context.leaseToken,
        request: input,
      });
    },
    createGenericPdf(input, context) {
      return createGenericPdfArtifact({
        userId: context.userId,
        conversationId: context.conversationId,
        messageId: null,
        runId: context.runId,
        leaseOwner: context.leaseOwner,
        leaseToken: context.leaseToken,
        request: input,
      });
    },
  },
};
