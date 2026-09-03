import { notFound } from "next/navigation";

import { ResearchSnapshotIdSchema } from "@/components/conversation-route";

export default async function LibraryResearchPage({
  params,
}: {
  params: Promise<{ snapshotId: string }>;
}) {
  const parsed = ResearchSnapshotIdSchema.safeParse((await params).snapshotId);
  if (!parsed.success) {
    notFound();
  }
  return null;
}
