import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

function section(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1) {
    throw new Error(`缺少源码边界 ${startMarker} -> ${endMarker}`);
  }
  return source.slice(start, end);
}

describe("regenerate action workspace eligibility", () => {
  it("separates intrinsic eligibility from temporary conversation blockers", async () => {
    const source = await readFile(
      path.join(process.cwd(), "components/research-workspace.tsx"),
      "utf8",
    );
    const eligibility = section(
      source,
      "const isRegenerateEligible =",
      "const regenerateDisabledReason =",
    );
    const temporaryBlockers = section(
      source,
      "const regenerateDisabledReason =",
      "const renderAttemptControls =",
    );
    const controls = section(
      source,
      "const renderAttemptControls =",
      "const renderedAttempt =",
    );

    expect(eligibility).toContain(
      "attemptIndex === item.attempts.length - 1",
    );
    expect(eligibility).toContain('run.status === "completed"');
    expect(eligibility).toContain(
      'run.executionConfig.provenance === "captured"',
    );
    expect(eligibility).not.toContain("hasOutstandingRuns");
    expect(eligibility).not.toContain("isViewingArchivedConversation");
    expect(eligibility).not.toContain("conversationMutationDisabledReason");

    expect(temporaryBlockers).toContain(
      "conversationMutationDisabledReason ??",
    );
    expect(temporaryBlockers).toContain("isViewingArchivedConversation");
    expect(temporaryBlockers).toContain(
      "archivedConversationRegenerateMessage",
    );
    expect(temporaryBlockers).toContain("hasOutstandingRuns");
    expect(temporaryBlockers).toContain("activeRunRegenerateMessage");

    expect(controls).toContain(
      "isRegenerateEligible={isRegenerateEligible}",
    );
    expect(controls).toContain(
      "regenerateDisabledReason={regenerateDisabledReason}",
    );
    expect(controls).toContain(
      "mutationDisabledReason={runSelectionDisabledReason}",
    );
    expect(controls).not.toContain("canRegenerate");
  });
});
