import type { InputAttachmentMimeType } from "@/lib/contracts";

export type InputAttachmentSourcePreviewMimeType = Extract<
  InputAttachmentMimeType,
  "text/plain" | "text/markdown" | "application/json"
>;

export type LoadedInputAttachmentSourcePreview = {
  lineCount: number;
  presentation: "source" | "formatted-json-source";
  source: string;
};

export type InputAttachmentTextViewerRenderState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      content: LoadedInputAttachmentSourcePreview;
    };

export type InputAttachmentTextViewerLifecycleState = {
  isOpen: boolean;
  preview: InputAttachmentTextViewerRenderState;
};

export class InputAttachmentSourcePreviewRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Input attachment source preview request failed with status ${status}`);
    this.name = "InputAttachmentSourcePreviewRequestError";
    this.status = status;
  }
}

export class InputAttachmentSourceInvariantError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "InputAttachmentSourceInvariantError";
  }
}

export function isInputAttachmentSourcePreviewMimeType(
  mimeType: InputAttachmentMimeType,
): mimeType is InputAttachmentSourcePreviewMimeType {
  switch (mimeType) {
    case "text/plain":
    case "text/markdown":
    case "application/json":
      return true;
    default:
      return false;
  }
}

function sourceLineCount(source: string): number {
  if (source.length === 0) {
    return 0;
  }
  return source.split(/\r\n|\r|\n/u).length;
}

function nextJsonTokenIndex(source: string, initialIndex: number): number {
  let index = initialIndex;
  while (
    index < source.length &&
    (source[index] === " " ||
      source[index] === "\t" ||
      source[index] === "\r" ||
      source[index] === "\n")
  ) {
    index += 1;
  }
  return index;
}

function formatValidatedJsonSource(source: string): string {
  const containerMultilineStack: boolean[] = [];
  let depth = 0;
  let escaped = false;
  let formatted = "";
  let insideString = false;

  function indentation(): string {
    return "  ".repeat(depth);
  }

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (insideString) {
      formatted += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        insideString = false;
      }
      continue;
    }

    if (character === '"') {
      formatted += character;
      insideString = true;
      continue;
    }
    if (
      character === " " ||
      character === "\t" ||
      character === "\r" ||
      character === "\n"
    ) {
      continue;
    }
    if (character === "{" || character === "[") {
      const closingCharacter = character === "{" ? "}" : "]";
      const nextIndex = nextJsonTokenIndex(source, index + 1);
      const isMultiline = source[nextIndex] !== closingCharacter;
      containerMultilineStack.push(isMultiline);
      formatted += character;
      if (isMultiline) {
        depth += 1;
        formatted += `\n${indentation()}`;
      }
      continue;
    }
    if (character === "}" || character === "]") {
      const isMultiline = containerMultilineStack.pop();
      if (isMultiline === undefined) {
        throw new InputAttachmentSourceInvariantError(
          "Validated JSON source formatter found an unmatched container",
        );
      }
      if (isMultiline) {
        depth -= 1;
        formatted += `\n${indentation()}`;
      }
      formatted += character;
      continue;
    }
    if (character === ",") {
      formatted += `,\n${indentation()}`;
      continue;
    }
    if (character === ":") {
      formatted += ": ";
      continue;
    }
    formatted += character;
  }

  if (insideString || containerMultilineStack.length !== 0 || depth !== 0) {
    throw new InputAttachmentSourceInvariantError(
      "Validated JSON source formatter ended in an invalid state",
    );
  }
  return formatted;
}

export function prepareInputAttachmentSourcePreview(
  source: string,
  mimeType: InputAttachmentSourcePreviewMimeType,
): LoadedInputAttachmentSourcePreview {
  if (mimeType !== "application/json") {
    return {
      lineCount: sourceLineCount(source),
      presentation: "source",
      source,
    };
  }

  try {
    JSON.parse(source);
  } catch (error) {
    throw new InputAttachmentSourceInvariantError(
      "Validated JSON input attachment contained invalid JSON",
      error,
    );
  }

  const formattedSource = formatValidatedJsonSource(source);

  return {
    lineCount: sourceLineCount(formattedSource),
    presentation: "formatted-json-source",
    source: formattedSource,
  };
}

export async function loadInputAttachmentSourcePreview(
  downloadUrl: string,
  mimeType: InputAttachmentSourcePreviewMimeType,
  signal: AbortSignal,
): Promise<LoadedInputAttachmentSourcePreview> {
  const response = await fetch(downloadUrl, {
    method: "GET",
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    throw new InputAttachmentSourcePreviewRequestError(response.status);
  }

  return prepareInputAttachmentSourcePreview(await response.text(), mimeType);
}

export function closeInputAttachmentTextViewerState(
  current: InputAttachmentTextViewerLifecycleState,
): InputAttachmentTextViewerLifecycleState {
  if (!current.isOpen && current.preview.status === "loading") {
    return current;
  }
  return {
    isOpen: false,
    preview: { status: "loading" },
  };
}

export function inputAttachmentSourcePreviewRequestCanCommit(
  activeRequestIdentity: object | null,
  requestIdentity: object,
  aborted: boolean,
): boolean {
  return !aborted && activeRequestIdentity === requestIdentity;
}
