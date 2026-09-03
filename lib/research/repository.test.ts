import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { ResearchCompany } from "@/lib/domain/research";

import { ResearchDataConsistencyError } from "./errors";
import { getResearchSnapshot } from "./repository";

type CompanyRowFixture = {
  id: string;
  ordinal: number;
  name: string;
  website_url: string;
  country: string;
  company_type: ResearchCompany["companyType"];
  relevance_summary: string;
};

type ContactRowFixture = {
  id: string;
  company_id: string;
  ordinal: number;
  name: string;
  title_original: string;
  role_category: ResearchCompany["contacts"][number]["roleCategory"];
  public_profile_url: string | null;
  confidence: ResearchCompany["contacts"][number]["confidence"];
};

type EvidenceRowFixture = {
  id: string;
  company_id: string | null;
  contact_id: string | null;
  ordinal: number;
  claim: string;
  source_url: string;
  source_title: string;
  supports: ResearchCompany["evidence"][number]["supports"];
};

const userId = "user-1";
const snapshotId = "snapshot-1";

const snapshotRow = {
  id: snapshotId,
  title: "German pump buyers",
  query_summary: "Industrial pump buyers in Germany",
  limitations: "Public sources only.",
  created_at: new Date("2026-08-24T08:00:00.000Z"),
};

const companyRow: CompanyRowFixture = {
  id: "company-1",
  ordinal: 0,
  name: "Acme GmbH",
  website_url: "https://example.com",
  country: "Germany",
  company_type: "distributor",
  relevance_summary: "Distributes industrial pumps.",
};

const contactRow: ContactRowFixture = {
  id: "contact-1",
  company_id: companyRow.id,
  ordinal: 0,
  name: "Erika Muster",
  title_original: "Head of Procurement",
  role_category: "procurement",
  public_profile_url: "https://example.com/team/erika",
  confidence: "A",
};

const companyEvidenceRow: EvidenceRowFixture = {
  id: "evidence-company-1",
  company_id: companyRow.id,
  contact_id: null,
  ordinal: 0,
  claim: "Acme distributes industrial pumps.",
  source_url: "https://example.com/pumps",
  source_title: "Acme pumps",
  supports: "business_fit",
};

const contactEvidenceRow: EvidenceRowFixture = {
  id: "evidence-contact-1",
  company_id: null,
  contact_id: contactRow.id,
  ordinal: 0,
  claim: "The team page identifies the procurement lead.",
  source_url: "https://example.com/team/erika",
  source_title: "Acme team",
  supports: "contact_role",
};

function queryResult<T>(rows: T[]) {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

function createDatabase({
  companies = [companyRow],
  contacts = [],
  evidence = [companyEvidenceRow],
}: {
  companies?: CompanyRowFixture[];
  contacts?: ContactRowFixture[];
  evidence?: EvidenceRowFixture[];
} = {}): Pool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM research_snapshots")) {
      return queryResult([snapshotRow]);
    }
    if (sql.includes("FROM research_contacts")) {
      return queryResult(contacts);
    }
    if (sql.includes("FROM research_evidence")) {
      return queryResult(evidence);
    }
    if (sql.includes("FROM research_companies")) {
      return queryResult(companies);
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  return { query } as unknown as Pool;
}

async function readConsistencyError(database: Pool) {
  try {
    await getResearchSnapshot(userId, snapshotId, database);
  } catch (error) {
    expect(error).toBeInstanceOf(ResearchDataConsistencyError);
    return error as ResearchDataConsistencyError;
  }
  throw new Error("Expected getResearchSnapshot to reject");
}

describe("getResearchSnapshot", () => {
  it("materializes valid company and contact evidence", async () => {
    const snapshot = await getResearchSnapshot(
      userId,
      snapshotId,
      createDatabase({
        contacts: [contactRow],
        evidence: [companyEvidenceRow, contactEvidenceRow],
      }),
    );

    expect(snapshot?.companies[0].evidence).toEqual([
      {
        claim: companyEvidenceRow.claim,
        sourceUrl: companyEvidenceRow.source_url,
        sourceTitle: companyEvidenceRow.source_title,
        supports: companyEvidenceRow.supports,
      },
    ]);
    expect(snapshot?.companies[0].contacts[0].evidence).toEqual([
      {
        claim: contactEvidenceRow.claim,
        sourceUrl: contactEvidenceRow.source_url,
        sourceTitle: contactEvidenceRow.source_title,
        supports: contactEvidenceRow.supports,
      },
    ]);
  });

  it("preserves a valid empty contacts list", async () => {
    const snapshot = await getResearchSnapshot(
      userId,
      snapshotId,
      createDatabase(),
    );

    expect(snapshot?.companies[0].contacts).toEqual([]);
  });

  it("rejects a company without required evidence", async () => {
    const error = await readConsistencyError(createDatabase({ evidence: [] }));

    expect(error.message).toContain(`company ${companyRow.id} has no evidence`);
  });

  it("rejects a contact without required evidence", async () => {
    const error = await readConsistencyError(
      createDatabase({ contacts: [contactRow] }),
    );

    expect(error.message).toContain(`contact ${contactRow.id} has no evidence`);
  });

  it("rejects evidence that references a company outside the snapshot", async () => {
    const error = await readConsistencyError(
      createDatabase({
        evidence: [
          {
            ...companyEvidenceRow,
            company_id: "company-outside-snapshot",
          },
        ],
      }),
    );

    expect(error.message).toContain(
      "references unknown company company-outside-snapshot",
    );
  });

  it("rejects evidence that references a contact outside the snapshot", async () => {
    const error = await readConsistencyError(
      createDatabase({
        evidence: [
          companyEvidenceRow,
          {
            ...contactEvidenceRow,
            contact_id: "contact-outside-snapshot",
          },
        ],
      }),
    );

    expect(error.message).toContain(
      "references unknown contact contact-outside-snapshot",
    );
  });

  it.each([
    {
      label: "both a company and a contact",
      companyId: companyRow.id,
      contactId: contactRow.id,
    },
    {
      label: "neither a company nor a contact",
      companyId: null,
      contactId: null,
    },
  ])("rejects evidence owned by $label", async ({ companyId, contactId }) => {
    const error = await readConsistencyError(
      createDatabase({
        contacts: [contactRow],
        evidence: [
          companyEvidenceRow,
          contactEvidenceRow,
          {
            ...companyEvidenceRow,
            id: "evidence-invalid-owner",
            company_id: companyId,
            contact_id: contactId,
          },
        ],
      }),
    );

    expect(error.message).toContain(
      "must belong to exactly one company or contact",
    );
  });

  it("rejects a contact whose company is outside the snapshot", async () => {
    const error = await readConsistencyError(
      createDatabase({
        contacts: [
          { ...contactRow, company_id: "company-outside-snapshot" },
        ],
        evidence: [companyEvidenceRow, contactEvidenceRow],
      }),
    );

    expect(error.message).toContain(
      `contact ${contactRow.id} references unknown company company-outside-snapshot`,
    );
  });
});
