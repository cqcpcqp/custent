import { describe, expect, it } from "vitest";

import {
  nextWorkspaceGeneration,
  workspaceGenerationIsCurrent,
} from "@/components/workspace-lifetime-state";

describe("workspace lifetime state", () => {
  it("keeps operations current across ordinary conversation switches", () => {
    const mountedGeneration = nextWorkspaceGeneration(0);

    expect(
      workspaceGenerationIsCurrent(
        mountedGeneration,
        mountedGeneration,
      ),
    ).toBe(true);
  });

  it("invalidates a pending operation when the workspace unmounts", () => {
    const operationGeneration = nextWorkspaceGeneration(0);
    const unmountedGeneration = nextWorkspaceGeneration(operationGeneration);

    expect(
      workspaceGenerationIsCurrent(
        unmountedGeneration,
        operationGeneration,
      ),
    ).toBe(false);
  });

  it("rejects unsafe generation overflow", () => {
    expect(() => nextWorkspaceGeneration(Number.MAX_SAFE_INTEGER)).toThrow(
      "工作区 generation 已超出安全整数范围",
    );
  });
});
