import { parseEntities } from "parse-entities";

import type {
  InlineCitationPlacement,
  NumberedCitation,
} from "@/components/inline-citation-state";
import { groupInlineCitationsByEndIndex } from "@/components/inline-citation-state";

type SourcePoint = {
  offset?: number;
};

type SourcePosition = {
  end: SourcePoint;
  start: SourcePoint;
};

type MarkdownNode = {
  children?: MarkdownNode[];
  position?: SourcePosition;
  properties?: Record<string, unknown>;
  tagName?: string;
  type: string;
  value?: string;
};

type MarkdownParent = MarkdownNode & {
  children: MarkdownNode[];
};

type PositionedText = {
  end: number;
  node: MarkdownNode & { type: "text"; value: string };
  parent: MarkdownParent;
  parentIndex: number;
  path: NodePathStep[];
  renderedOffsets?: Array<number | null>;
  start: number;
};

type NodePathStep = {
  node: MarkdownNode;
  parent: MarkdownParent;
  parentIndex: number;
};

type TextInsertion = {
  localOffset: number;
  placement: InlineCitationPlacement;
};

type TextInsertionGroup = {
  insertions: TextInsertion[];
  leaf: PositionedText;
};

type BoundaryInsertion = {
  parent: MarkdownParent;
  parentIndex: number;
  placement: InlineCitationPlacement;
};

const citationForbiddenAncestors = new Set(["a", "code", "pre"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMarkdownParent(node: unknown): node is MarkdownParent {
  if (!isRecord(node)) {
    return false;
  }
  return typeof node.type === "string" && Array.isArray(node.children);
}

function citationSourceHost(url: string): string {
  return new URL(url).hostname.replace(/^www\./u, "");
}

function sourceOffsets(
  node: MarkdownNode,
): { end: number; start: number } | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    return null;
  }
  return { end, start };
}

function collectPositionedText(
  parent: MarkdownParent,
  path: readonly NodePathStep[],
  output: PositionedText[],
): void {
  parent.children.forEach((node, parentIndex) => {
    const nextPath = [...path, { node, parent, parentIndex }];
    const offsets = sourceOffsets(node);
    if (
      node.type === "text" &&
      typeof node.value === "string" &&
      offsets !== null
    ) {
      output.push({
        end: offsets.end,
        node: { ...node, type: "text", value: node.value },
        parent,
        parentIndex,
        path: nextPath,
        start: offsets.start,
      });
    }
    if (isMarkdownParent(node)) {
      collectPositionedText(node, nextPath, output);
    }
  });
}

function citationMarker(placement: InlineCitationPlacement): MarkdownNode {
  const primaryCitation = placement.citations[0];
  if (primaryCitation === undefined) {
    throw new Error("行内引用位置缺少来源");
  }
  const additionalSourceCount = placement.citations.length - 1;
  const citationNumbers = placement.citations
    .map(({ number }) => number)
    .join("、");
  const host = citationSourceHost(primaryCitation.citation.url);

  return {
    type: "element",
    tagName: "sup",
    properties: {
      ariaLabel: `引用来源：${citationNumbers}`,
      className: ["inline-citation-group"],
      role: "group",
    },
    children: [
      {
        type: "element",
        tagName: "a",
        properties: {
          ariaLabel:
            additionalSourceCount === 0
              ? `来源 ${primaryCitation.number}：${primaryCitation.citation.title}`
              : `来源 ${citationNumbers}：${primaryCitation.citation.title} 等 ${placement.citations.length} 个来源`,
          className: ["inline-citation"],
          dataCitationNumber: primaryCitation.number,
          href: primaryCitation.citation.url,
          rel: ["noreferrer"],
          target: "_blank",
          title:
            additionalSourceCount === 0
              ? primaryCitation.citation.title
              : `${primaryCitation.citation.title}，另有 ${additionalSourceCount} 个来源`,
        },
        children: [
          {
            type: "element",
            tagName: "span",
            properties: { className: ["inline-citation__host"] },
            children: [{ type: "text", value: host }],
          },
          ...(additionalSourceCount === 0
            ? []
            : [
                {
                  type: "element",
                  tagName: "span",
                  properties: { className: ["inline-citation__count"] },
                  children: [
                    { type: "text", value: `+${additionalSourceCount}` },
                  ],
                } satisfies MarkdownNode,
              ]),
        ],
      },
    ],
  };
}

function forbiddenBoundary(
  leaf: PositionedText,
): { parent: MarkdownParent; parentIndex: number } | null {
  for (const step of leaf.path) {
    if (
      step.node.type === "element" &&
      typeof step.node.tagName === "string" &&
      citationForbiddenAncestors.has(step.node.tagName)
    ) {
      return { parent: step.parent, parentIndex: step.parentIndex + 1 };
    }
  }
  return null;
}

function precedingLeaf(
  leaves: readonly PositionedText[],
  offset: number,
): PositionedText | null {
  let candidate: PositionedText | null = null;
  for (const leaf of leaves) {
    if (leaf.end > offset) {
      continue;
    }
    if (
      candidate === null ||
      leaf.end > candidate.end ||
      (leaf.end === candidate.end && leaf.start > candidate.start)
    ) {
      candidate = leaf;
    }
  }
  return candidate;
}

function followingLeaf(
  leaves: readonly PositionedText[],
  offset: number,
): PositionedText | null {
  let candidate: PositionedText | null = null;
  for (const leaf of leaves) {
    if (leaf.start < offset) {
      continue;
    }
    if (
      candidate === null ||
      leaf.start < candidate.start ||
      (leaf.start === candidate.start && leaf.end < candidate.end)
    ) {
      candidate = leaf;
    }
  }
  return candidate;
}

function insertionLeaf(
  leaves: readonly PositionedText[],
  offset: number,
): { leaf: PositionedText; sourceOffset: number } | null {
  const containing = leaves.find(
    (leaf) => leaf.start < offset && offset < leaf.end,
  );
  if (containing !== undefined) {
    return { leaf: containing, sourceOffset: offset };
  }

  const preceding = precedingLeaf(leaves, offset);
  if (preceding !== null && preceding.end === offset) {
    return { leaf: preceding, sourceOffset: preceding.end };
  }

  const following = followingLeaf(leaves, offset);
  if (following !== null && following.start === offset) {
    return { leaf: following, sourceOffset: following.start };
  }
  if (preceding !== null) {
    return { leaf: preceding, sourceOffset: preceding.end };
  }
  if (following !== null) {
    return { leaf: following, sourceOffset: following.start };
  }
  return null;
}

function renderedTextOffset(
  leaf: PositionedText,
  sourceContent: string,
  sourceOffset: number,
): number {
  const relativeSourceOffset = sourceOffset - leaf.start;
  const renderedOffsets =
    leaf.renderedOffsets ??
    markdownTextRenderedOffsets(
      sourceContent.slice(leaf.start, leaf.end),
      leaf.node.value,
    );
  leaf.renderedOffsets = renderedOffsets;
  const renderedOffset = renderedOffsets[relativeSourceOffset];
  if (renderedOffset === null || renderedOffset === undefined) {
    throw new Error(
      `引用终点 ${sourceOffset} 落在 Markdown 转义结构内部`,
    );
  }
  return renderedOffset;
}

type MarkdownEntitySpan = {
  end: number;
  start: number;
  value: string;
};

function markdownPunctuation(character: string): boolean {
  if (character.length !== 1) {
    return false;
  }
  const code = character.charCodeAt(0);
  return (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126)
  );
}

function isEscapedMarkdownCharacter(source: string, index: number): boolean {
  let backslashCount = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && source[cursor] === "\\";
    cursor -= 1
  ) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

function markdownEntitySpans(source: string): MarkdownEntitySpan[] {
  const spans: MarkdownEntitySpan[] = [];
  parseEntities(source, {
    nonTerminated: false,
    position: { line: 1, column: 1, offset: 0 },
    reference(value, position) {
      const start = position.start.offset;
      const end = position.end.offset;
      if (start === undefined || end === undefined) {
        throw new TypeError("Markdown 字符实体缺少源码偏移");
      }
      if (!isEscapedMarkdownCharacter(source, start)) {
        spans.push({ end, start, value });
      }
    },
  });
  return spans;
}

/**
 * Map CommonMark source boundaries to the corresponding UTF-16 boundaries in
 * a rendered text node. Boundaries inside an escape or character reference do
 * not represent a rendered-text boundary and intentionally remain null.
 */
export function markdownTextRenderedOffsets(
  source: string,
  rendered: string,
): Array<number | null> {
  const offsets = new Array<number | null>(source.length + 1).fill(null);
  const entities = markdownEntitySpans(source);
  let entityIndex = 0;
  let sourceIndex = 0;
  let renderedIndex = 0;
  let reconstructed = "";
  offsets[0] = 0;

  while (sourceIndex < source.length) {
    const entity = entities[entityIndex];
    if (entity !== undefined && entity.start === sourceIndex) {
      reconstructed += entity.value;
      renderedIndex += entity.value.length;
      sourceIndex = entity.end;
      offsets[sourceIndex] = renderedIndex;
      entityIndex += 1;
      continue;
    }

    const character = source[sourceIndex];
    const escapedCharacter = source[sourceIndex + 1];
    if (
      character === "\\" &&
      escapedCharacter !== undefined &&
      markdownPunctuation(escapedCharacter)
    ) {
      reconstructed += escapedCharacter;
      renderedIndex += escapedCharacter.length;
      sourceIndex += 2;
      offsets[sourceIndex] = renderedIndex;
      continue;
    }

    reconstructed += character;
    renderedIndex += character.length;
    sourceIndex += 1;
    offsets[sourceIndex] = renderedIndex;
  }

  if (entityIndex !== entities.length || reconstructed !== rendered) {
    throw new Error("Markdown 文本节点的源码无法精确映射到渲染文本");
  }
  return offsets;
}

function textReplacements({
  insertions,
  leaf,
}: TextInsertionGroup): MarkdownNode[] {
  const replacements: MarkdownNode[] = [];
  let cursor = 0;
  for (const insertion of [...insertions].sort(
    (left, right) =>
      left.localOffset - right.localOffset ||
      left.placement.endIndex - right.placement.endIndex,
  )) {
    if (insertion.localOffset > cursor) {
      replacements.push({
        type: "text",
        value: leaf.node.value.slice(cursor, insertion.localOffset),
      });
    }
    replacements.push(citationMarker(insertion.placement));
    cursor = insertion.localOffset;
  }
  if (cursor < leaf.node.value.length) {
    replacements.push({
      type: "text",
      value: leaf.node.value.slice(cursor),
    });
  }
  return replacements;
}

type ParentMutation =
  | {
      group: TextInsertionGroup;
      kind: "text";
      parentIndex: number;
    }
  | {
      kind: "boundary";
      parentIndex: number;
      placements: InlineCitationPlacement[];
    };

function applyInsertions(
  textGroups: readonly TextInsertionGroup[],
  boundaryInsertions: readonly BoundaryInsertion[],
): void {
  const mutations = new Map<MarkdownParent, ParentMutation[]>();
  for (const group of textGroups) {
    const parentMutations = mutations.get(group.leaf.parent) ?? [];
    parentMutations.push({
      group,
      kind: "text",
      parentIndex: group.leaf.parentIndex,
    });
    mutations.set(group.leaf.parent, parentMutations);
  }

  const boundaryGroups = new Map<
    MarkdownParent,
    Map<number, InlineCitationPlacement[]>
  >();
  for (const insertion of boundaryInsertions) {
    let byIndex = boundaryGroups.get(insertion.parent);
    if (byIndex === undefined) {
      byIndex = new Map();
      boundaryGroups.set(insertion.parent, byIndex);
    }
    const placements = byIndex.get(insertion.parentIndex);
    if (placements === undefined) {
      byIndex.set(insertion.parentIndex, [insertion.placement]);
    } else {
      placements.push(insertion.placement);
    }
  }
  for (const [parent, byIndex] of boundaryGroups) {
    const parentMutations = mutations.get(parent) ?? [];
    for (const [parentIndex, placements] of byIndex) {
      parentMutations.push({
        kind: "boundary",
        parentIndex,
        placements,
      });
    }
    mutations.set(parent, parentMutations);
  }

  for (const [parent, parentMutations] of mutations) {
    parentMutations.sort(
      (left, right) => {
        const positionOrder = right.parentIndex - left.parentIndex;
        if (positionOrder !== 0 || left.kind === right.kind) {
          return positionOrder;
        }
        return left.kind === "text" ? -1 : 1;
      },
    );
    for (const mutation of parentMutations) {
      if (mutation.kind === "text") {
        parent.children.splice(
          mutation.parentIndex,
          1,
          ...textReplacements(mutation.group),
        );
      } else {
        parent.children.splice(
          mutation.parentIndex,
          0,
          ...mutation.placements
            .sort((left, right) => left.endIndex - right.endIndex)
            .map(citationMarker),
        );
      }
    }
  }
}

function addInlineCitationMarkers(
  root: MarkdownParent,
  citations: readonly NumberedCitation[],
  sourceContent: string,
): void {
  const placements = groupInlineCitationsByEndIndex(citations);
  if (placements.length === 0) {
    return;
  }

  const leaves: PositionedText[] = [];
  collectPositionedText(root, [], leaves);
  const textGroups = new Map<MarkdownNode, TextInsertionGroup>();
  const boundaryInsertions: BoundaryInsertion[] = [];

  for (const placement of placements) {
    const target = insertionLeaf(leaves, placement.endIndex);
    if (target === null) {
      boundaryInsertions.push({ parent: root, parentIndex: 0, placement });
      continue;
    }

    const boundary = forbiddenBoundary(target.leaf);
    if (boundary !== null) {
      boundaryInsertions.push({ ...boundary, placement });
      continue;
    }

    const localOffset = renderedTextOffset(
      target.leaf,
      sourceContent,
      target.sourceOffset,
    );
    const existing = textGroups.get(target.leaf.node);
    if (existing === undefined) {
      textGroups.set(target.leaf.node, {
        insertions: [{ localOffset, placement }],
        leaf: target.leaf,
      });
    } else {
      existing.insertions.push({ localOffset, placement });
    }
  }

  applyInsertions([...textGroups.values()], boundaryInsertions);
}

export function inlineCitationMarkdownPlugin(
  citations: readonly NumberedCitation[],
  sourceContent: string,
): () => (tree: unknown) => void {
  return () => (tree: unknown) => {
    if (!isMarkdownParent(tree)) {
      throw new TypeError("Markdown 渲染树缺少固定的 children 结构");
    }
    addInlineCitationMarkers(tree, citations, sourceContent);
  };
}
