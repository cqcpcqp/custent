export const INPUT_ATTACHMENT_FILE_MIME_TYPES = [
  "text/plain",
  "application/pdf",
  "text/csv",
  "text/markdown",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;

export const INPUT_ATTACHMENT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const INPUT_ATTACHMENT_MIME_TYPES = [
  ...INPUT_ATTACHMENT_FILE_MIME_TYPES,
  ...INPUT_ATTACHMENT_IMAGE_MIME_TYPES,
] as const;

export type InputAttachmentMimeTypeValue =
  (typeof INPUT_ATTACHMENT_MIME_TYPES)[number];
export type InputAttachmentFileMimeType =
  (typeof INPUT_ATTACHMENT_FILE_MIME_TYPES)[number];
export type InputAttachmentImageMimeType =
  (typeof INPUT_ATTACHMENT_IMAGE_MIME_TYPES)[number];

type InputAttachmentFormatSpecification = {
  extensions: readonly [string, ...string[]];
  kind: "file" | "image";
  label: string;
};

export const inputAttachmentFormatSpecifications = {
  "text/plain": {
    extensions: [".txt"],
    kind: "file",
    label: "TXT",
  },
  "application/pdf": {
    extensions: [".pdf"],
    kind: "file",
    label: "PDF",
  },
  "text/csv": {
    extensions: [".csv"],
    kind: "file",
    label: "CSV",
  },
  "text/markdown": {
    extensions: [".md"],
    kind: "file",
    label: "Markdown",
  },
  "application/json": {
    extensions: [".json"],
    kind: "file",
    label: "JSON",
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    extensions: [".docx"],
    kind: "file",
    label: "DOCX",
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    extensions: [".xlsx"],
    kind: "file",
    label: "XLSX",
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    extensions: [".pptx"],
    kind: "file",
    label: "PPTX",
  },
  "image/png": {
    extensions: [".png"],
    kind: "image",
    label: "PNG",
  },
  "image/jpeg": {
    extensions: [".jpg", ".jpeg"],
    kind: "image",
    label: "JPG/JPEG",
  },
  "image/webp": {
    extensions: [".webp"],
    kind: "image",
    label: "WebP",
  },
  "image/gif": {
    extensions: [".gif"],
    kind: "image",
    label: "GIF",
  },
} as const satisfies Record<
  InputAttachmentMimeTypeValue,
  InputAttachmentFormatSpecification
>;

export const INPUT_ATTACHMENT_ACCEPT = INPUT_ATTACHMENT_MIME_TYPES.flatMap(
  (mimeType) => [
    ...inputAttachmentFormatSpecifications[mimeType].extensions,
    mimeType,
  ],
).join(",");

export const INPUT_ATTACHMENT_SUPPORT_TEXT =
  "TXT、PDF、PNG、JPG/JPEG、WebP、非动画 GIF、CSV、Markdown、JSON、DOCX、XLSX 和 PPTX";

const inputAttachmentMimeTypeSet = new Set<string>(
  INPUT_ATTACHMENT_MIME_TYPES,
);

export function inputAttachmentMimeTypeFromName(
  name: string,
): InputAttachmentMimeTypeValue | null {
  const lastDot = name.lastIndexOf(".");
  if (lastDot < 0) {
    return null;
  }
  const extension = name.slice(lastDot).toLowerCase();
  for (const mimeType of INPUT_ATTACHMENT_MIME_TYPES) {
    if (
      inputAttachmentFormatSpecifications[mimeType].extensions.some(
        (candidate) => candidate === extension,
      )
    ) {
      return mimeType;
    }
  }
  return null;
}

/**
 * Browsers may omit the MIME type for a known local file or serialize it as
 * application/octet-stream. In that exact case the fixed extension map is the
 * authoritative upload type; a conflicting non-generic MIME is never coerced.
 */
export function inputAttachmentMimeTypeForUpload(
  declaredMimeType: string,
  name: string,
): InputAttachmentMimeTypeValue | null {
  if (inputAttachmentMimeTypeSet.has(declaredMimeType)) {
    return declaredMimeType as InputAttachmentMimeTypeValue;
  }
  if (
    declaredMimeType === "" ||
    declaredMimeType === "application/octet-stream"
  ) {
    return inputAttachmentMimeTypeFromName(name);
  }
  return null;
}

export function isInputAttachmentFileMimeType(
  mimeType: InputAttachmentMimeTypeValue,
): mimeType is InputAttachmentFileMimeType {
  return inputAttachmentFormatSpecifications[mimeType].kind === "file";
}

export function isInputAttachmentImageMimeType(
  mimeType: InputAttachmentMimeTypeValue,
): mimeType is InputAttachmentImageMimeType {
  return inputAttachmentFormatSpecifications[mimeType].kind === "image";
}
