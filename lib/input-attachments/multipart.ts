import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import Busboy from "busboy";

import { AppError } from "@/lib/errors";

const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024;

function invalidMultipart(message: string, status = 400): AppError {
  return new AppError("INVALID_REQUEST", message, status);
}

function contentLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (value === null) {
    return null;
  }
  if (!/^\d+$/u.test(value)) {
    throw invalidMultipart("Content-Length 不符合要求。");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidMultipart("Content-Length 不符合要求。");
  }
  return parsed;
}

export async function parseSingleInputAttachment(
  request: Request,
  maxFileBytes: number,
): Promise<File> {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new TypeError("maxFileBytes must be a positive safe integer");
  }
  if (request.body === null) {
    throw invalidMultipart("Multipart 请求缺少内容。");
  }

  const maxRawBytes = maxFileBytes + MAX_MULTIPART_OVERHEAD_BYTES;
  const declaredLength = contentLength(request);
  if (declaredLength !== null && declaredLength > maxRawBytes) {
    throw invalidMultipart("上传请求超过大小限制。", 413);
  }

  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: {
        "content-type": request.headers.get("content-type") ?? undefined,
      },
      defParamCharset: "utf8",
      preservePath: true,
      limits: {
        fieldNameSize: 20,
        fields: 0,
        fileSize: maxFileBytes,
        files: 1,
        parts: 2,
        headerPairs: 10,
      },
    });
  } catch {
    throw invalidMultipart("请求必须是包含边界的 multipart/form-data。");
  }

  let contractError: AppError | null = null;
  let fileCount = 0;
  let fileName = "";
  let mimeType = "";
  const chunks: Buffer[] = [];

  const rejectContract = (error: AppError): void => {
    contractError ??= error;
  };

  parser.on("file", (fieldName, fileStream, info) => {
    fileCount += 1;
    if (fieldName !== "file") {
      rejectContract(
        invalidMultipart("文件 part 必须且只能命名为 file。"),
      );
    }
    fileName = info.filename;
    mimeType = info.mimeType;
    fileStream.on("limit", () => {
      rejectContract(invalidMultipart("附件超过单文件大小限制。", 413));
    });
    fileStream.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
    });
    fileStream.on("end", () => {
      if (fileStream.truncated === true) {
        rejectContract(invalidMultipart("附件超过单文件大小限制。", 413));
      }
    });
  });
  parser.on("field", () => {
    rejectContract(invalidMultipart("上传请求不能包含普通表单字段。"));
  });
  parser.on("filesLimit", () => {
    rejectContract(invalidMultipart("上传请求只能包含一个文件。"));
  });
  parser.on("fieldsLimit", () => {
    rejectContract(invalidMultipart("上传请求不能包含普通表单字段。"));
  });
  parser.on("partsLimit", () => {
    rejectContract(invalidMultipart("上传请求只能包含一个 part。"));
  });

  let rawBytes = 0;
  const rawLimit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      rawBytes += chunk.byteLength;
      if (rawBytes > maxRawBytes) {
        callback(invalidMultipart("上传请求超过大小限制。", 413));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.from(request.body),
      rawLimit,
      parser,
    );
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw invalidMultipart("Multipart 请求无法解析。");
  }

  if (contractError !== null) {
    throw contractError;
  }
  if (fileCount !== 1) {
    throw invalidMultipart("请求必须且只能包含一个文件。");
  }
  return new File(
    chunks.map((chunk) => Uint8Array.from(chunk)),
    fileName,
    { type: mimeType },
  );
}
