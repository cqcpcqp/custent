import { RunContext, type Tool } from "@openai/agents";
import { describe, expect, it, vi } from "vitest";

import type { ArtifactSummary } from "@/lib/contracts";
import type {
  ResearchSnapshotSummary,
  SaveResearchInput,
} from "@/lib/domain/research";

import { AGENT_TOOL_NAMES, createAgentTools } from "./tools";
import type { AgentContext, AgentToolServices } from "./types";

const context: AgentContext = {
  userId: "user-1",
  conversationId: "conversation-1",
  requestId: "request-1",
  runId: "run-1",
  assistantMessageId: "message-1",
  leaseOwner: "worker-1",
  leaseToken: "1",
};

const researchInput: SaveResearchInput = {
  title: "German pump importers",
  querySummary: "Industrial pump importers in Germany",
  limitations: "Only public sources were used.",
  companies: [
    {
      name: "Acme GmbH",
      websiteUrl: "https://example.com",
      country: "Germany",
      companyType: "distributor",
      relevanceSummary: "Distributes industrial pumps.",
      contacts: [],
      evidence: [
        {
          claim: "Acme distributes pumps.",
          sourceUrl: "https://example.com/pumps",
          sourceTitle: "Acme pumps",
          supports: "business_fit",
        },
      ],
    },
  ],
};

const snapshot: ResearchSnapshotSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  title: researchInput.title,
  querySummary: researchInput.querySummary,
  createdAt: "2026-08-24T08:00:00.000Z",
  companyCount: 1,
};

const artifact: ArtifactSummary = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "buyers.csv",
  mimeType: "text/csv",
  sizeBytes: 128,
  downloadUrl: "/api/artifacts/33333333-3333-4333-8333-333333333333/download",
  createdAt: "2026-08-24T08:01:00.000Z",
};

function createServices(): AgentToolServices {
  return {
    research: {
      listResearch: vi.fn(async (): Promise<ResearchSnapshotSummary[]> => []),
      saveResearch: vi.fn(async () => snapshot),
    },
    artifacts: {
      createCsv: vi.fn(async () => artifact),
      createPdf: vi.fn(async () => ({
        ...artifact,
        name: "buyers.pdf",
        mimeType: "application/pdf" as const,
      })),
      createGenericCsv: vi.fn(async () => artifact),
      createGenericPdf: vi.fn(async () => ({
        ...artifact,
        name: "report.pdf",
        mimeType: "application/pdf" as const,
      })),
    },
  };
}

function functionTool(
  tools: ReturnType<typeof createAgentTools>,
  name: string,
): Extract<Tool<AgentContext>, { type: "function" }> {
  const result = tools.find((candidate) => candidate.name === name);
  if (result === undefined || result.type !== "function") {
    throw new Error(`Function tool ${name} was not found`);
  }
  return result;
}

function toolsForTest(
  services: AgentToolServices,
  codeInterpreterEnabled = false,
) {
  return createAgentTools(services, { codeInterpreterEnabled });
}

describe("createAgentTools", () => {
  it("does not expose Code Interpreter when the capability is disabled", () => {
    const tools = toolsForTest(createServices(), false);

    expect(tools.map((candidate) => candidate.name)).toEqual([
      AGENT_TOOL_NAMES.webSearch,
      AGENT_TOOL_NAMES.listResearch,
      AGENT_TOOL_NAMES.saveResearch,
      AGENT_TOOL_NAMES.createCsv,
      AGENT_TOOL_NAMES.createPdf,
      AGENT_TOOL_NAMES.createGenericCsv,
      AGENT_TOOL_NAMES.createGenericPdf,
    ]);
    expect(
      tools.find(
        (candidate) => candidate.name === AGENT_TOOL_NAMES.codeInterpreter,
      ),
    ).toBeUndefined();
  });

  it("exposes hosted search and Python plus strict local tools", () => {
    const tools = toolsForTest(createServices(), true);

    expect(tools.map((candidate) => candidate.name)).toEqual([
      AGENT_TOOL_NAMES.webSearch,
      AGENT_TOOL_NAMES.codeInterpreter,
      AGENT_TOOL_NAMES.listResearch,
      AGENT_TOOL_NAMES.saveResearch,
      AGENT_TOOL_NAMES.createCsv,
      AGENT_TOOL_NAMES.createPdf,
      AGENT_TOOL_NAMES.createGenericCsv,
      AGENT_TOOL_NAMES.createGenericPdf,
    ]);
    expect(
      tools.find(
        (candidate) => candidate.name === AGENT_TOOL_NAMES.codeInterpreter,
      ),
    ).toMatchObject({
      type: "hosted_tool",
      providerData: {
        type: "code_interpreter",
        container: { type: "auto" },
        include_outputs: true,
      },
    });
    for (const candidate of tools.filter((tool) => tool.type === "function")) {
      expect(candidate.strict).toBe(true);
    }
  });

  it("passes validated research input and the exact run context to services", async () => {
    const services = createServices();
    const tools = toolsForTest(services);
    const result = await functionTool(tools, AGENT_TOOL_NAMES.saveResearch).invoke(
      new RunContext(context),
      JSON.stringify(researchInput),
    );

    expect(result).toEqual(snapshot);
    expect(services.research.saveResearch).toHaveBeenCalledWith(
      researchInput,
      context,
    );
  });

  it("emits an OpenAI-compatible schema while retaining runtime URL validation", async () => {
    const services = createServices();
    const saveTool = functionTool(
      toolsForTest(services),
      AGENT_TOOL_NAMES.saveResearch,
    );

    expect(JSON.stringify(saveTool.parameters)).not.toContain(
      '"format":"uri"',
    );

    const invalidInput = structuredClone(researchInput);
    invalidInput.companies[0].websiteUrl = "not-a-url";

    await expect(
      saveTool.invoke(new RunContext(context), JSON.stringify(invalidInput)),
    ).rejects.toThrow("Invalid JSON input for tool");
    expect(services.research.saveResearch).not.toHaveBeenCalled();
  });

  it("uses one exact artifact parameter contract for CSV and PDF", async () => {
    const services = createServices();
    const tools = toolsForTest(services);
    const input = {
      snapshotId: snapshot.id,
      fileName: "buyers.csv",
    };

    await functionTool(tools, AGENT_TOOL_NAMES.createCsv).invoke(
      new RunContext(context),
      JSON.stringify(input),
    );

    expect(services.artifacts.createCsv).toHaveBeenCalledWith(input, context);
  });

  it("validates generic CSV structure and forwards exact conversation content", async () => {
    const services = createServices();
    const genericCsv = functionTool(
      toolsForTest(services),
      AGENT_TOOL_NAMES.createGenericCsv,
    );
    const input = {
      fileName: "current-table.csv",
      columns: ["company", "country"],
      rows: [["Acme", "Germany"]],
    };

    await expect(
      genericCsv.invoke(new RunContext(context), JSON.stringify(input)),
    ).resolves.toEqual(artifact);
    expect(services.artifacts.createGenericCsv).toHaveBeenCalledWith(
      input,
      context,
    );

    await expect(
      genericCsv.invoke(
        new RunContext(context),
        JSON.stringify({ ...input, rows: [["Acme"]] }),
      ),
    ).rejects.toThrow("Invalid JSON input for tool");
    await expect(
      genericCsv.invoke(
        new RunContext(context),
        JSON.stringify({ ...input, fileName: "../escape.csv" }),
      ),
    ).rejects.toThrow("Invalid JSON input for tool");
    expect(services.artifacts.createGenericCsv).toHaveBeenCalledTimes(1);
  });

  it("validates and forwards generic PDF sections", async () => {
    const services = createServices();
    const input = {
      fileName: "summary.pdf",
      title: "Conversation summary",
      sections: [{ heading: "Decision", body: "Contact Acme first." }],
    };

    await functionTool(
      toolsForTest(services),
      AGENT_TOOL_NAMES.createGenericPdf,
    ).invoke(new RunContext(context), JSON.stringify(input));

    expect(services.artifacts.createGenericPdf).toHaveBeenCalledWith(
      input,
      context,
    );
  });

  it("propagates service failures instead of returning a fallback tool result", async () => {
    const services = createServices();
    const failure = new Error("database unavailable");
    vi.mocked(services.research.saveResearch).mockRejectedValue(failure);
    const saveTool = functionTool(
      toolsForTest(services),
      AGENT_TOOL_NAMES.saveResearch,
    );

    await expect(
      saveTool.invoke(new RunContext(context), JSON.stringify(researchInput)),
    ).rejects.toBe(failure);
  });

  it("does not start a function tool after the run is aborted", async () => {
    const services = createServices();
    const controller = new AbortController();
    controller.abort();
    const saveTool = functionTool(
      toolsForTest(services),
      AGENT_TOOL_NAMES.saveResearch,
    );

    await expect(
      saveTool.invoke(
        new RunContext(context),
        JSON.stringify(researchInput),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(services.research.saveResearch).not.toHaveBeenCalled();
  });
});
