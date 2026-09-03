export function deriveConversationTitle(message: string): string {
  const normalized = message.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);

  if (characters.length <= 28) {
    return normalized;
  }

  return `${characters.slice(0, 28).join("")}…`;
}
