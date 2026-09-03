import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("answer attempt state boundary", () => {
  it("keys the stateful rendered-attempt subtree by run identity", () => {
    const source = readFileSync(
      new URL("../../components/research-workspace.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('<Fragment key={`attempt-state:${run.id}`}>');
    expect(source).toContain("{renderedAttempt}");
  });
});
