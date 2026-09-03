import {
  conversationSummaryFromListItem,
  type BootstrapResponse,
} from "@/lib/contracts";
import { errorResponse } from "@/lib/api/errors";
import { getCurrentUserId } from "@/lib/auth";
import {
  getUserAccount,
  listConversationPage,
  listTrackedConversations,
  withReadOnlyRepeatableReadTransaction,
} from "@/lib/db";
import { getEnv } from "@/lib/env";
import { getExecutionProfileCatalog } from "@/lib/run-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const userId = getCurrentUserId();
    const environment = getEnv();
    const snapshot = await withReadOnlyRepeatableReadTransaction(
      async (client) => {
        const { user, credits } = await getUserAccount(userId, client);
        const conversationPage = await listConversationPage(
          {
            userId,
            view: "active",
            query: "",
            cursor: null,
            limit: 30,
          },
          client,
        );
        const trackedConversations = await listTrackedConversations(
          userId,
          client,
        );
        const conversations = conversationPage.items.map((item) => {
          if (item.searchMatch !== null) {
            throw new TypeError(
              "Bootstrap conversation page contains a search match",
            );
          }
          return conversationSummaryFromListItem(item);
        });
        return {
          user,
          credits,
          conversations,
          nextCursor: conversationPage.nextCursor,
          trackedConversations,
        };
      },
    );

    return Response.json({
      user: snapshot.user,
      credits: snapshot.credits,
      conversations: snapshot.conversations,
      nextCursor: snapshot.nextCursor,
      trackedConversations: snapshot.trackedConversations,
      inputAttachmentLimits: {
        maxFileBytes: environment.INPUT_ATTACHMENT_MAX_BYTES,
        maxFilesPerMessage: environment.INPUT_ATTACHMENT_MAX_PER_MESSAGE,
        maxTotalBytesPerMessage:
          environment.INPUT_ATTACHMENT_MAX_TOTAL_BYTES,
      },
      executionProfiles: getExecutionProfileCatalog(),
    } satisfies BootstrapResponse);
  } catch (error) {
    return errorResponse(error);
  }
}
