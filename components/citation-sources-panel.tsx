"use client";

import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";

import {
  CloseIcon,
  ExternalLinkIcon,
  SearchIcon,
} from "@/components/icons";
import type { NumberedCitation } from "@/components/inline-citation-state";
import { useModalFocus } from "@/components/modal-focus";
import {
  closeDesktopPanelAndRestoreFocus,
  documentHasOpenModal,
} from "@/components/workspace-ux-state";

const narrowCitationSourcesPanelMediaQuery = "(max-width: 1180px)";

function subscribeToNarrowCitationSourcesPanel(
  onStoreChange: () => void,
): () => void {
  const mediaQuery = window.matchMedia(narrowCitationSourcesPanelMediaQuery);
  mediaQuery.addEventListener("change", onStoreChange);
  return () => mediaQuery.removeEventListener("change", onStoreChange);
}

function narrowCitationSourcesPanelSnapshot(): boolean {
  return window.matchMedia(narrowCitationSourcesPanelMediaQuery).matches;
}

export function citationSourcesPanelIsModal(
  isOpen: boolean,
  isNarrowViewport: boolean,
): boolean {
  return isOpen && isNarrowViewport;
}

export function closeCitationSourcesPanelFromBackdrop(
  event: Pick<
    ReactMouseEvent<HTMLDivElement>,
    "currentTarget" | "preventDefault" | "target"
  >,
  onClose: () => void,
): void {
  if (event.target !== event.currentTarget) {
    return;
  }

  event.preventDefault();
  onClose();
}

export function closeCitationSourcesPanelFromButton(
  isModalOpen: boolean,
  onClose: () => void,
  returnFocusTarget: Pick<HTMLElement, "focus"> | null,
): void {
  if (isModalOpen) {
    onClose();
    return;
  }
  closeDesktopPanelAndRestoreFocus(onClose, returnFocusTarget);
}

export function scrollActiveCitationSourceIntoView(
  isOpen: boolean,
  activeNumber: number | undefined,
  activeItem: Pick<HTMLElement, "scrollIntoView"> | null,
): void {
  if (!isOpen || activeNumber === undefined) {
    return;
  }
  if (activeItem === null) {
    throw new Error(`活动引用 ${activeNumber} 缺少对应的来源元素`);
  }

  activeItem.scrollIntoView({ block: "nearest" });
}

export function closeDesktopCitationSourcesPanelFromEscape(
  event: Pick<KeyboardEvent, "key" | "preventDefault">,
  onClose: () => void,
  returnFocusTarget: Pick<HTMLElement, "focus"> | null,
  hasOpenModal: boolean,
): boolean {
  if (event.key !== "Escape" || hasOpenModal) {
    return false;
  }

  event.preventDefault();
  closeDesktopPanelAndRestoreFocus(onClose, returnFocusTarget);
  return true;
}

function sourceHost(url: string): string {
  return new URL(url).hostname.replace(/^www\./u, "");
}

function assertActiveCitation(
  citations: readonly NumberedCitation[],
  activeNumber: number | undefined,
): void {
  if (activeNumber === undefined) {
    return;
  }
  if (!Number.isSafeInteger(activeNumber) || activeNumber <= 0) {
    throw new Error("活动引用编号必须是正安全整数");
  }
  if (!citations.some((citation) => citation.number === activeNumber)) {
    throw new Error(`活动引用编号 ${activeNumber} 不在回答来源中`);
  }
}

export function CitationSourcesPanel({
  activeNumber,
  citations,
  isOpen,
  onClose,
  returnFocusRef,
}: {
  activeNumber?: number;
  citations: readonly NumberedCitation[];
  isOpen: boolean;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  assertActiveCitation(citations, activeNumber);

  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const activeItemRef = useRef<HTMLLIElement>(null);
  const isNarrowViewport = useSyncExternalStore(
    subscribeToNarrowCitationSourcesPanel,
    narrowCitationSourcesPanelSnapshot,
    () => false,
  );
  const isModalOpen = citationSourcesPanelIsModal(
    isOpen,
    isNarrowViewport,
  );

  useModalFocus({
    backdropRef,
    canClose: true,
    containerRef: panelRef,
    enabled: isModalOpen,
    initialFocusRef: closeButtonRef,
    onClose,
    returnFocusRef,
  });

  useEffect(() => {
    scrollActiveCitationSourceIntoView(
      isOpen,
      activeNumber,
      activeItemRef.current,
    );
  }, [activeNumber, isOpen]);

  useEffect(() => {
    if (!isOpen || isNarrowViewport) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      closeDesktopCitationSourcesPanelFromEscape(
        event,
        onClose,
        returnFocusRef?.current ?? null,
        documentHasOpenModal(document),
      );
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [isNarrowViewport, isOpen, onClose, returnFocusRef]);

  return (
    <>
      <div
        aria-hidden="true"
        className={`citation-sources-backdrop${
          isModalOpen ? " citation-sources-backdrop--visible" : ""
        }`}
        data-modal-layer={isModalOpen ? "" : undefined}
        onMouseDown={(event) =>
          closeCitationSourcesPanelFromBackdrop(event, onClose)
        }
        ref={backdropRef}
      />
      <aside
        aria-hidden={!isOpen}
        aria-labelledby="citation-sources-panel-title"
        aria-modal={isModalOpen ? "true" : undefined}
        className={`citation-sources-panel${
          isOpen ? " citation-sources-panel--open" : ""
        }`}
        id="citation-sources-panel"
        inert={!isOpen}
        ref={panelRef}
        role="dialog"
        tabIndex={isModalOpen ? -1 : undefined}
      >
        <header className="citation-sources-panel__header">
          <span className="citation-sources-panel__title">
            <SearchIcon />
            <span>
              <strong id="citation-sources-panel-title">来源</strong>
              <small>{citations.length} 个回答引用</small>
            </span>
          </span>
          <button
            aria-label="关闭来源面板"
            className="icon-button citation-sources-panel__close"
            onClick={() =>
              closeCitationSourcesPanelFromButton(
                isModalOpen,
                onClose,
                returnFocusRef?.current ?? null,
              )
            }
            ref={closeButtonRef}
            type="button"
          >
            <CloseIcon />
          </button>
        </header>

        <p className="citation-sources-panel__notice">
          以下仅展示回答中保存的引用信息和原网页链接，不包含额外抓取或网页摘要。
        </p>

        {citations.length === 0 ? (
          <div className="citation-sources-panel__empty" role="status">
            这条回答没有保存来源引用。
          </div>
        ) : (
          <ol
            aria-label="回答来源列表"
            className="citation-sources-panel__list"
          >
            {citations.map(({ citation, citedText, number, originalIndex }) => {
              const isActive = number === activeNumber;
              return (
                <li
                  aria-current={isActive ? "true" : undefined}
                  className={`citation-sources-panel__item${
                    isActive ? " citation-sources-panel__item--active" : ""
                  }`}
                  key={`${citation.url}-${citation.startIndex}-${citation.endIndex}-${originalIndex}`}
                  ref={isActive ? activeItemRef : undefined}
                >
                  <span className="citation-sources-panel__number">
                    {number}
                  </span>
                  <div className="citation-sources-panel__source">
                    <strong>{citation.title}</strong>
                    <span className="citation-sources-panel__domain">
                      {sourceHost(citation.url)}
                    </span>
                    <div className="citation-sources-panel__cited-text">
                      <span>回答中引用的文本</span>
                      <blockquote>{citedText}</blockquote>
                    </div>
                    <a
                      aria-label={`打开原网页：${citation.title}`}
                      className="citation-sources-panel__external-link"
                      href={citation.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <span>打开原网页</span>
                      <ExternalLinkIcon />
                    </a>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </aside>
    </>
  );
}
