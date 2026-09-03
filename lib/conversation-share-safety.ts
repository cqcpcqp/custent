import type {
  Citation,
  SharedConversationMessage,
} from "@/lib/contracts";

const uuidPathSegmentSource =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const privateOwnerPathnameSource =
  `\\/api\\/(?:artifacts\\/${uuidPathSegmentSource}\\/download|` +
  `input-attachments\\/${uuidPathSegmentSource}(?:\\/content)?)`;
const absoluteOriginSource =
  "https?:\\/\\/(?:\\[[0-9a-f:.]+\\](?::[0-9]+)?|[^\\s\\/?#<>\"'`()\\[\\]{}]+)";
const urlSuffixSource = "(?:[?#][^\\s<>\"'`()\\[\\]{}]*)?";

const privateOwnerPathnamePattern = new RegExp(
  `^${privateOwnerPathnameSource}$`,
  "iu",
);
const privateOwnerResourceUrlPattern = new RegExp(
  `(?:${absoluteOriginSource})?${privateOwnerPathnameSource}${urlSuffixSource}`,
  "giu",
);

export const CONVERSATION_SHARE_PRIVATE_RESOURCE_SENTINEL_PREFIX =
  "#private-resource";
const privateResourceSentinelPattern = /^#private-resource-*$/u;

function privateResourceSentinel(length: number): string {
  if (length < CONVERSATION_SHARE_PRIVATE_RESOURCE_SENTINEL_PREFIX.length) {
    throw new TypeError("Private resource URL is shorter than its sentinel");
  }
  return CONVERSATION_SHARE_PRIVATE_RESOURCE_SENTINEL_PREFIX.padEnd(
    length,
    "-",
  );
}

export function isConversationSharePrivateResourceSentinel(
  value: string,
): boolean {
  return privateResourceSentinelPattern.test(value);
}

export function redactConversationSharePrivateResourceUrls(
  content: string,
): string {
  return content.replace(privateOwnerResourceUrlPattern, (url) =>
    privateResourceSentinel(url.length),
  );
}

export function isConversationSharePrivateResourceUrl(url: string): boolean {
  return privateOwnerPathnamePattern.test(
    new URL(url, "https://public-share.invalid").pathname,
  );
}

function publicCitations(citations: readonly Citation[]): Citation[] {
  return citations.filter(
    (citation) => !isConversationSharePrivateResourceUrl(citation.url),
  );
}

export function sanitizeConversationShareMessages(
  messages: readonly SharedConversationMessage[],
): SharedConversationMessage[] {
  return messages.map((message) => ({
    ...message,
    content: redactConversationSharePrivateResourceUrls(message.content),
    citations: publicCitations(message.citations),
  }));
}
