const UUID_V4_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const inputAttachmentStoragePathPattern = new RegExp(
  `^${UUID_V4_SOURCE}$`,
  "u",
);
const inputAttachmentTemporaryFileNamePattern = new RegExp(
  `^\\.${UUID_V4_SOURCE}\\.${UUID_V4_SOURCE}\\.tmp$`,
  "u",
);

export function isInputAttachmentStoragePath(value: string): boolean {
  return inputAttachmentStoragePathPattern.test(value);
}

export function isInputAttachmentTemporaryFileName(value: string): boolean {
  return inputAttachmentTemporaryFileNamePattern.test(value);
}
