export const MAX_REQUESTED_ARTIFACT_FILE_NAME_LENGTH = 240;

const unsafeFileNameCharacters =
  /[\u0000-\u001f\u007f/\\:*?"<>|\u202a-\u202e\u2066-\u2069]/u;
const windowsReservedName =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export function isSafeRequestedArtifactFileName(value: string): boolean {
  const normalized = value.normalize("NFKC").trim();
  return (
    normalized.length > 0 &&
    normalized.length <= MAX_REQUESTED_ARTIFACT_FILE_NAME_LENGTH &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith(".") &&
    !normalized.endsWith(".") &&
    !unsafeFileNameCharacters.test(normalized) &&
    !windowsReservedName.test(normalized)
  );
}

export function requestedArtifactName(
  value: string,
  extension: "csv" | "pdf",
): string {
  const normalized = value.normalize("NFKC").trim();
  if (!isSafeRequestedArtifactFileName(normalized)) {
    throw new TypeError("Artifact fileName is unsafe");
  }

  return normalized.toLocaleLowerCase("en-US").endsWith(`.${extension}`)
    ? normalized
    : `${normalized}.${extension}`;
}

export function defaultResearchArtifactName(
  title: string,
  snapshotId: string,
  extension: "csv" | "pdf",
): string {
  const base = title
    .normalize("NFKC")
    .replaceAll(/[\u0000-\u001f\u007f/\\:*?"<>|]/gu, "_")
    .trim()
    .slice(0, 120);
  return `${base.length === 0 ? `research-${snapshotId}` : base}.${extension}`;
}
