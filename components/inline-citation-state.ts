import type { Citation } from "@/lib/contracts";

export type NumberedCitation = {
  citation: Citation;
  citedText: string;
  number: number;
  originalIndex: number;
};

export type InlineCitationPlacement = {
  citations: NumberedCitation[];
  endIndex: number;
};

function assertCitationRange(
  content: string,
  citation: Citation,
  originalIndex: number,
): void {
  if (
    !Number.isSafeInteger(citation.startIndex) ||
    citation.startIndex < 0 ||
    !Number.isSafeInteger(citation.endIndex) ||
    citation.endIndex < 0
  ) {
    throw new Error(`引用 ${originalIndex + 1} 的字符索引不是非负安全整数`);
  }
  if (citation.startIndex > citation.endIndex) {
    throw new Error(`引用 ${originalIndex + 1} 的字符区间起点晚于终点`);
  }
  if (citation.endIndex > content.length) {
    throw new Error(`引用 ${originalIndex + 1} 的字符区间超出回答正文`);
  }
}

/**
 * Validates citation spans and assigns display numbers by first appearance.
 *
 * The fixed API contract does not promise citation ordering, non-overlap, or
 * in-range relational constraints, so this function preserves every citation
 * while making those rules explicit for rendering.
 */
export function prepareInlineCitations(
  content: string,
  citations: readonly Citation[],
): NumberedCitation[] {
  const ordered = citations.map((citation, originalIndex) => {
    assertCitationRange(content, citation, originalIndex);
    return { citation, originalIndex };
  });

  ordered.sort(
    (left, right) =>
      left.citation.startIndex - right.citation.startIndex ||
      left.citation.endIndex - right.citation.endIndex ||
      left.originalIndex - right.originalIndex,
  );

  return ordered.map(({ citation, originalIndex }, index) => ({
    citation,
    citedText: content.slice(citation.startIndex, citation.endIndex),
    number: index + 1,
    originalIndex,
  }));
}

export function groupInlineCitationsByEndIndex(
  citations: readonly NumberedCitation[],
): InlineCitationPlacement[] {
  const byEndIndex = new Map<number, NumberedCitation[]>();

  for (const citation of citations) {
    const existing = byEndIndex.get(citation.citation.endIndex);
    if (existing === undefined) {
      byEndIndex.set(citation.citation.endIndex, [citation]);
    } else {
      existing.push(citation);
    }
  }

  return [...byEndIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([endIndex, groupedCitations]) => ({
      citations: groupedCitations,
      endIndex,
    }));
}
