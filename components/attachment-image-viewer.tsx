"use client";

import Image from "next/image";
import { createPortal } from "react-dom";
import {
  useId,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";

import { CloseIcon, DownloadIcon, ImageIcon } from "@/components/icons";
import { formatAttachmentBytes } from "@/components/input-attachment-state";
import { useModalFocus } from "@/components/modal-focus";

type AttachmentImageViewerProps = {
  downloadUrl: string;
  name: string;
  sizeBytes: number;
};

type AttachmentImageViewerDialogProps = AttachmentImageViewerProps & {
  backdropRef?: RefObject<HTMLDivElement | null>;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  dialogRef?: RefObject<HTMLElement | null>;
  dialogId: string;
  downloadActionRef: RefObject<HTMLAnchorElement | null>;
  onClose: () => void;
  titleId: string;
};

export function AttachmentImageViewerDialog({
  backdropRef,
  closeButtonRef,
  dialogRef,
  dialogId,
  downloadActionRef,
  downloadUrl,
  name,
  onClose,
  sizeBytes,
  titleId,
}: AttachmentImageViewerDialogProps) {
  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div
      className="attachment-image-viewer-backdrop"
      data-modal-layer=""
      onMouseDown={handleBackdropMouseDown}
      ref={backdropRef}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="attachment-image-viewer"
        id={dialogId}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="attachment-image-viewer__header">
          <span className="attachment-image-viewer__title">
            <ImageIcon />
            <span>
              <strong id={titleId}>
                <span className="visually-hidden">图片预览：</span>
                {name}
              </strong>
              <small>{formatAttachmentBytes(sizeBytes)}</small>
            </span>
          </span>
          <span className="attachment-image-viewer__actions">
            <a
              aria-label={`下载图片：${name}`}
              className="attachment-image-viewer__action"
              download
              href={downloadUrl}
              ref={downloadActionRef}
            >
              <DownloadIcon />
              <span>下载</span>
            </a>
            <button
              aria-label={`关闭图片预览：${name}`}
              className="attachment-image-viewer__action"
              onClick={onClose}
              ref={closeButtonRef}
              type="button"
            >
              <CloseIcon />
              <span>关闭</span>
            </button>
          </span>
        </header>
        <div className="attachment-image-viewer__canvas">
          {/* The fixed content URL requires the user's session, so the Next image optimizer must not proxy it. */}
          <Image
            alt={name}
            draggable={false}
            fill
            loading="eager"
            sizes="100vw"
            src={downloadUrl}
            unoptimized
          />
        </div>
      </section>
    </div>
  );
}

export function AttachmentImageViewer({
  downloadUrl,
  name,
  sizeBytes,
}: AttachmentImageViewerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const downloadActionRef = useRef<HTMLAnchorElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const generatedId = useId();
  const dialogId = `${generatedId}-attachment-image-dialog`;
  const titleId = `${generatedId}-attachment-image-title`;

  useModalFocus({
    backdropRef,
    canClose: true,
    containerRef: dialogRef,
    enabled: isOpen,
    initialFocusRef: closeButtonRef,
    onClose: closeViewer,
    returnFocusRef,
  });

  function closeViewer() {
    setIsOpen(false);
  }

  function openViewer(event: MouseEvent<HTMLButtonElement>) {
    returnFocusRef.current = event.currentTarget;
    setIsOpen(true);
  }

  return (
    <>
      <button
        aria-controls={isOpen ? dialogId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={`预览图片：${name}`}
        className="message-input-attachment message-input-attachment--image"
        onClick={openViewer}
        type="button"
      >
        {/* The fixed content URL requires the user's session, so the Next image optimizer must not proxy it. */}
        <Image
          alt={name}
          fill
          loading="lazy"
          sizes="(max-width: 600px) 68vw, 240px"
          src={downloadUrl}
          unoptimized
        />
        <span className="message-input-attachment__image-meta">
          <ImageIcon />
          <span>
            <strong>{name}</strong>
            <small>{formatAttachmentBytes(sizeBytes)}</small>
          </span>
        </span>
      </button>
      {isOpen
        ? createPortal(
            <AttachmentImageViewerDialog
              backdropRef={backdropRef}
              closeButtonRef={closeButtonRef}
              dialogRef={dialogRef}
              dialogId={dialogId}
              downloadActionRef={downloadActionRef}
              downloadUrl={downloadUrl}
              name={name}
              onClose={closeViewer}
              sizeBytes={sizeBytes}
              titleId={titleId}
            />,
            document.body,
          )
        : null}
    </>
  );
}
