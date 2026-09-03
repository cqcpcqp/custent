import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import type { InputAttachmentMimeType } from "@/lib/contracts";
import {
  inputAttachmentMimeTypeForUpload,
  inputAttachmentFormatSpecifications,
  INPUT_ATTACHMENT_SUPPORT_TEXT,
} from "@/lib/input-attachment-formats";
import { AppError } from "@/lib/errors";

import { validateInputAttachmentBytes } from "./file-validation";
import type { StoredInputAttachment } from "./types";

function invalidAttachment(message: string, status = 400): AppError {
  return new AppError("INVALID_REQUEST", message, status);
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function validateOriginalName(
  originalName: string,
  mimeType: InputAttachmentMimeType,
): void {
  if (
    originalName.length === 0 ||
    originalName.length > 255 ||
    originalName === "." ||
    originalName === ".." ||
    /[\\/\u0000-\u001f\u007f]/u.test(originalName)
  ) {
    throw invalidAttachment("附件名称不符合要求。");
  }

  const expectedExtensions =
    inputAttachmentFormatSpecifications[mimeType].extensions;
  const originalExtension = path.extname(originalName);
  const actualExtension = originalExtension.toLowerCase();
  if (
    !expectedExtensions.some((extension) => extension === actualExtension) ||
    originalName.length === originalExtension.length
  ) {
    const extensionList = expectedExtensions.join(" 或 ");
    throw invalidAttachment(
      `附件名称必须使用 ${extensionList} 扩展名。`,
      415,
    );
  }
}

function resolveStorageDirectory(storageDirectory: string): string {
  if (storageDirectory.length === 0) {
    throw new TypeError("storageDirectory must not be empty");
  }
  return path.resolve(storageDirectory);
}

export async function writeInputAttachmentChunk(
  fileHandle: Pick<FileHandle, "write">,
  chunk: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await fileHandle.write(chunk.subarray(offset));
    if (
      !Number.isSafeInteger(bytesWritten) ||
      bytesWritten <= 0 ||
      bytesWritten > chunk.byteLength - offset
    ) {
      throw new Error("Input attachment storage returned an invalid write length");
    }
    offset += bytesWritten;
  }
}

export function resolveStoredInputAttachmentPath(
  storageDirectory: string,
  storagePath: string,
): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(storagePath)) {
    throw new TypeError("Input attachment storage path must be a UUID");
  }
  return path.join(resolveStorageDirectory(storageDirectory), storagePath);
}

async function removeTemporaryFile(temporaryPath: string): Promise<void> {
  try {
    await unlink(temporaryPath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

export async function storeInputAttachment(input: {
  file: File;
  storageDirectory: string;
  maxBytes: number;
}): Promise<StoredInputAttachment> {
  validatePositiveInteger(input.maxBytes, "maxBytes");
  const mimeType = inputAttachmentMimeTypeForUpload(
    input.file.type,
    input.file.name,
  );
  if (mimeType === null) {
    throw invalidAttachment(
      `仅支持 ${INPUT_ATTACHMENT_SUPPORT_TEXT} 附件。`,
      415,
    );
  }
  validateOriginalName(input.file.name, mimeType);

  if (!Number.isSafeInteger(input.file.size) || input.file.size <= 0) {
    throw invalidAttachment("附件不能为空。");
  }
  if (input.file.size > input.maxBytes) {
    throw invalidAttachment("附件超过单文件大小限制。", 413);
  }

  const id = randomUUID();
  const storageDirectory = resolveStorageDirectory(input.storageDirectory);
  const storagePath = id;
  const finalPath = resolveStoredInputAttachmentPath(
    storageDirectory,
    storagePath,
  );
  const temporaryPath = path.join(
    storageDirectory,
    `.${id}.${randomUUID()}.tmp`,
  );
  const hash = createHash("sha256");
  const validationBytes = Buffer.allocUnsafe(input.file.size);
  await mkdir(storageDirectory, { recursive: true, mode: 0o700 });

  const fileHandle = await open(temporaryPath, "wx", 0o600);
  let sizeBytes = 0;

  try {
    const reader = input.file.stream().getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) {
          break;
        }
        const chunk = Buffer.from(part.value);
        const nextSizeBytes = sizeBytes + chunk.byteLength;
        if (nextSizeBytes > input.maxBytes) {
          throw invalidAttachment("附件超过单文件大小限制。", 413);
        }
        if (nextSizeBytes > validationBytes.byteLength) {
          throw invalidAttachment("附件字节数与上传声明不一致。");
        }
        hash.update(chunk);
        chunk.copy(validationBytes, sizeBytes);
        await writeInputAttachmentChunk(fileHandle, chunk);
        sizeBytes = nextSizeBytes;
      }
    } finally {
      reader.releaseLock();
    }

    if (sizeBytes !== input.file.size || sizeBytes === 0) {
      throw invalidAttachment("附件字节数与上传声明不一致。");
    }
    await validateInputAttachmentBytes(mimeType, validationBytes);

    await fileHandle.sync();
    await fileHandle.close();
    await rename(temporaryPath, finalPath);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await fileHandle.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await removeTemporaryFile(temporaryPath);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Input attachment staging failed and cleanup was incomplete",
      );
    }
    throw error;
  }

  return {
    id,
    kind: inputAttachmentFormatSpecifications[mimeType].kind,
    originalName: input.file.name,
    mimeType,
    sizeBytes,
    sha256: hash.digest("hex"),
    storagePath,
  };
}

export async function deleteStoredInputAttachment(
  storageDirectory: string,
  storagePath: string,
): Promise<void> {
  await unlink(
    resolveStoredInputAttachmentPath(storageDirectory, storagePath),
  );
}

export async function deleteStoredInputAttachmentIfPresent(
  storageDirectory: string,
  storagePath: string,
): Promise<void> {
  try {
    await deleteStoredInputAttachment(storageDirectory, storagePath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}
