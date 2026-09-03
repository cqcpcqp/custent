import { notFound } from "next/navigation";

import { SharedConversationView } from "@/components/shared-conversation-view";
import { ConversationShareSummarySchema } from "@/lib/contracts";
import { getPublicConversationShare } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function PublicConversationSharePage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const parsedPublicId = ConversationShareSummarySchema.shape.publicId.safeParse(
    (await params).publicId,
  );
  if (!parsedPublicId.success) {
    notFound();
  }

  const share = await getPublicConversationShare(parsedPublicId.data);
  if (share === null) {
    notFound();
  }

  return <SharedConversationView share={share} />;
}
