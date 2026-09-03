import type { ArtifactSummary } from "@/lib/contracts";
import type { ResearchSnapshot } from "@/lib/domain/research";

import type {
  GenericCsvArtifactRequest,
  GenericPdfArtifactRequest,
} from "./generic";

export type ArtifactRecord = ArtifactSummary & {
  userId: string;
  conversationId: string;
  messageId: string | null;
  runId: string;
  researchSnapshotId: string | null;
  sha256: string;
  storagePath: string;
};

export type CreateRunArtifactInput = {
  userId: string;
  conversationId: string;
  messageId: string | null;
  runId: string;
  leaseOwner: string;
  leaseToken: string;
  storageDirectory?: string;
};

export type CreateArtifactInput = CreateRunArtifactInput & {
  snapshot: ResearchSnapshot;
  name?: string;
};

export type CreateGenericCsvArtifactInput = CreateRunArtifactInput & {
  request: GenericCsvArtifactRequest;
};

export type CreateGenericPdfArtifactInput = CreateRunArtifactInput & {
  request: GenericPdfArtifactRequest;
  fontPath?: string;
};
