import { notFound } from "next/navigation";

import { ConversationIdSchema } from "@/components/conversation-route";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const parsed = ConversationIdSchema.safeParse(
    (await params).conversationId,
  );
  if (!parsed.success) {
    notFound();
  }
  return null;
}
