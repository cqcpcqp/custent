import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { getPool, withTransaction } from "@/lib/db/pool";
import type { Queryable } from "@/lib/db/types";
import {
  type ResearchCompany,
  type ResearchSnapshot,
  type ResearchSnapshotSummary,
  SaveResearchInputSchema,
  type SaveResearchInput,
} from "@/lib/domain/research";
import { AppError } from "@/lib/errors";

import { ResearchDataConsistencyError } from "./errors";

type SnapshotRow = {
  id: string;
  title: string;
  query_summary: string;
  limitations: string;
  created_at: Date;
};

type SnapshotSummaryRow = Omit<SnapshotRow, "limitations"> & {
  company_count: number;
};

type CompanyRow = {
  id: string;
  ordinal: number;
  name: string;
  website_url: string;
  country: string;
  company_type: ResearchCompany["companyType"];
  relevance_summary: string;
};

type ContactRow = {
  id: string;
  company_id: string;
  ordinal: number;
  name: string;
  title_original: string;
  role_category: ResearchCompany["contacts"][number]["roleCategory"];
  public_profile_url: string | null;
  confidence: ResearchCompany["contacts"][number]["confidence"];
};

type EvidenceRow = {
  id: string;
  company_id: string | null;
  contact_id: string | null;
  ordinal: number;
  claim: string;
  source_url: string;
  source_title: string;
  supports: ResearchCompany["evidence"][number]["supports"];
};

type PersistedEvidence = ResearchCompany["evidence"][number] & {
  id: string;
  ordinal: number;
};

type PersistedContact = Omit<ResearchCompany["contacts"][number], "evidence"> & {
  id: string;
  ordinal: number;
  evidence: PersistedEvidence[];
};

type PersistedCompany = Omit<ResearchCompany, "contacts" | "evidence"> & {
  ordinal: number;
  contacts: PersistedContact[];
  evidence: PersistedEvidence[];
};

function snapshotSummary(row: SnapshotSummaryRow): ResearchSnapshotSummary {
  return {
    id: row.id,
    title: row.title,
    querySummary: row.query_summary,
    companyCount: row.company_count,
    createdAt: row.created_at.toISOString(),
  };
}

function materializeCompanies(input: SaveResearchInput): PersistedCompany[] {
  return input.companies.map((company, companyOrdinal) => ({
    ...company,
    id: randomUUID(),
    ordinal: companyOrdinal,
    evidence: company.evidence.map((evidence, ordinal) => ({
      ...evidence,
      id: randomUUID(),
      ordinal,
    })),
    contacts: company.contacts.map((contact, contactOrdinal) => ({
      ...contact,
      id: randomUUID(),
      ordinal: contactOrdinal,
      evidence: contact.evidence.map((evidence, ordinal) => ({
        ...evidence,
        id: randomUUID(),
        ordinal,
      })),
    })),
  }));
}

async function insertCompanies(
  client: PoolClient,
  snapshotId: string,
  companies: PersistedCompany[],
): Promise<void> {
  await client.query(
    `
      INSERT INTO research_companies (
        id,
        snapshot_id,
        ordinal,
        name,
        website_url,
        country,
        company_type,
        relevance_summary
      )
      SELECT
        company.id,
        $1,
        company.ordinal,
        company.name,
        company.website_url,
        company.country,
        company.company_type,
        company.relevance_summary
      FROM jsonb_to_recordset($2::jsonb) AS company(
        id uuid,
        ordinal integer,
        name text,
        website_url text,
        country text,
        company_type text,
        relevance_summary text
      )
    `,
    [
      snapshotId,
      JSON.stringify(
        companies.map((company) => ({
          id: company.id,
          ordinal: company.ordinal,
          name: company.name,
          website_url: company.websiteUrl,
          country: company.country,
          company_type: company.companyType,
          relevance_summary: company.relevanceSummary,
        })),
      ),
    ],
  );
}

async function insertContacts(
  client: PoolClient,
  companies: PersistedCompany[],
): Promise<void> {
  const contacts = companies.flatMap((company) =>
    company.contacts.map((contact) => ({
      id: contact.id,
      company_id: company.id,
      ordinal: contact.ordinal,
      name: contact.name,
      title_original: contact.titleOriginal,
      role_category: contact.roleCategory,
      public_profile_url: contact.publicProfileUrl,
      confidence: contact.confidence,
    })),
  );
  if (contacts.length === 0) {
    return;
  }

  await client.query(
    `
      INSERT INTO research_contacts (
        id,
        company_id,
        ordinal,
        name,
        title_original,
        role_category,
        public_profile_url,
        confidence
      )
      SELECT
        contact.id,
        contact.company_id,
        contact.ordinal,
        contact.name,
        contact.title_original,
        contact.role_category,
        contact.public_profile_url,
        contact.confidence
      FROM jsonb_to_recordset($1::jsonb) AS contact(
        id uuid,
        company_id uuid,
        ordinal integer,
        name text,
        title_original text,
        role_category text,
        public_profile_url text,
        confidence text
      )
    `,
    [JSON.stringify(contacts)],
  );
}

async function insertEvidence(
  client: PoolClient,
  snapshotId: string,
  companies: PersistedCompany[],
): Promise<void> {
  const evidence = companies.flatMap((company) => [
    ...company.evidence.map((item) => ({
      id: item.id,
      snapshot_id: snapshotId,
      company_id: company.id,
      contact_id: null,
      ordinal: item.ordinal,
      claim: item.claim,
      source_url: item.sourceUrl,
      source_title: item.sourceTitle,
      supports: item.supports,
    })),
    ...company.contacts.flatMap((contact) =>
      contact.evidence.map((item) => ({
        id: item.id,
        snapshot_id: snapshotId,
        company_id: null,
        contact_id: contact.id,
        ordinal: item.ordinal,
        claim: item.claim,
        source_url: item.sourceUrl,
        source_title: item.sourceTitle,
        supports: item.supports,
      })),
    ),
  ]);

  await client.query(
    `
      INSERT INTO research_evidence (
        id,
        snapshot_id,
        company_id,
        contact_id,
        ordinal,
        claim,
        source_url,
        source_title,
        supports
      )
      SELECT
        evidence.id,
        evidence.snapshot_id,
        evidence.company_id,
        evidence.contact_id,
        evidence.ordinal,
        evidence.claim,
        evidence.source_url,
        evidence.source_title,
        evidence.supports
      FROM jsonb_to_recordset($1::jsonb) AS evidence(
        id uuid,
        snapshot_id uuid,
        company_id uuid,
        contact_id uuid,
        ordinal integer,
        claim text,
        source_url text,
        source_title text,
        supports text
      )
    `,
    [JSON.stringify(evidence)],
  );
}

export async function saveResearchSnapshot(
  input: {
    userId: string;
    conversationId: string;
    runId: string;
    leaseOwner: string;
    leaseToken: string;
    research: SaveResearchInput;
  },
  database: Pool = getPool(),
): Promise<ResearchSnapshot> {
  const research = SaveResearchInputSchema.parse(input.research);
  const snapshotId = randomUUID();
  const companies = materializeCompanies(research);

  return withTransaction(async (client) => {
    const run = await client.query<{ id: string }>(
      `
        WITH locked_run AS MATERIALIZED (
          SELECT r.id, r.lease_expires_at
          FROM runs r
          JOIN conversations c ON c.id = r.conversation_id
          WHERE
            r.id = $1
            AND r.user_id = $2
            AND r.conversation_id = $3
            AND c.user_id = $2
            AND c.deleted_at IS NULL
            AND r.status = 'running'
            AND r.lease_owner = $4
            AND r.lease_token = $5::bigint
            AND r.cancel_requested_at IS NULL
          FOR UPDATE OF r
        )
        SELECT id
        FROM locked_run
        WHERE lease_expires_at > clock_timestamp()
      `,
      [
        input.runId,
        input.userId,
        input.conversationId,
        input.leaseOwner,
        input.leaseToken,
      ],
    );
    if (run.rowCount !== 1) {
      throw new AppError("NOT_FOUND", "Run was not found", 404);
    }

    const snapshotResult = await client.query<SnapshotRow>(
      `
        INSERT INTO research_snapshots (
          id,
          user_id,
          conversation_id,
          run_id,
          title,
          query_summary,
          limitations
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, title, query_summary, limitations, created_at
      `,
      [
        snapshotId,
        input.userId,
        input.conversationId,
        input.runId,
        research.title,
        research.querySummary,
        research.limitations,
      ],
    );
    await insertCompanies(client, snapshotId, companies);
    await insertContacts(client, companies);
    await insertEvidence(client, snapshotId, companies);

    const snapshot = snapshotResult.rows[0];
    return {
      id: snapshot.id,
      title: snapshot.title,
      querySummary: snapshot.query_summary,
      limitations: snapshot.limitations,
      createdAt: snapshot.created_at.toISOString(),
      companies: companies.map((company) => ({
        id: company.id,
        name: company.name,
        websiteUrl: company.websiteUrl,
        country: company.country,
        companyType: company.companyType,
        relevanceSummary: company.relevanceSummary,
        contacts: company.contacts.map((contact) => ({
          name: contact.name,
          titleOriginal: contact.titleOriginal,
          roleCategory: contact.roleCategory,
          publicProfileUrl: contact.publicProfileUrl,
          confidence: contact.confidence,
          evidence: contact.evidence.map((evidence) => ({
            claim: evidence.claim,
            sourceUrl: evidence.sourceUrl,
            sourceTitle: evidence.sourceTitle,
            supports: evidence.supports,
          })),
        })),
        evidence: company.evidence.map((evidence) => ({
          claim: evidence.claim,
          sourceUrl: evidence.sourceUrl,
          sourceTitle: evidence.sourceTitle,
          supports: evidence.supports,
        })),
      })),
    };
  }, database);
}

export async function listResearchSnapshots(
  userId: string,
  conversationId: string,
  database: Pool = getPool(),
): Promise<ResearchSnapshotSummary[]> {
  const result = await database.query<SnapshotSummaryRow>(
    `
      SELECT
        snapshot.id,
        snapshot.title,
        snapshot.query_summary,
        snapshot.created_at,
        COUNT(company.id)::integer AS company_count
      FROM research_snapshots snapshot
      JOIN runs run ON run.id = snapshot.run_id
      JOIN conversations conversation ON conversation.id = snapshot.conversation_id
      LEFT JOIN research_companies company ON company.snapshot_id = snapshot.id
      WHERE
        snapshot.user_id = $1
        AND snapshot.conversation_id = $2
        AND conversation.user_id = $1
        AND conversation.deleted_at IS NULL
        AND run.status = 'completed'
      GROUP BY snapshot.id
      ORDER BY snapshot.created_at DESC, snapshot.id DESC
    `,
    [userId, conversationId],
  );
  return result.rows.map(snapshotSummary);
}

export async function listResearchSnapshotsForRun(
  userId: string,
  conversationId: string,
  currentRunId: string,
  database: Pool = getPool(),
): Promise<ResearchSnapshotSummary[]> {
  const result = await database.query<SnapshotSummaryRow>(
    `
      SELECT
        snapshot.id,
        snapshot.title,
        snapshot.query_summary,
        snapshot.created_at,
        COUNT(company.id)::integer AS company_count
      FROM research_snapshots snapshot
      JOIN runs run ON run.id = snapshot.run_id
      JOIN conversations conversation ON conversation.id = snapshot.conversation_id
      LEFT JOIN research_companies company ON company.snapshot_id = snapshot.id
      WHERE
        snapshot.user_id = $1
        AND snapshot.conversation_id = $2
        AND conversation.user_id = $1
        AND conversation.deleted_at IS NULL
        AND (run.status = 'completed' OR snapshot.run_id = $3)
      GROUP BY snapshot.id
      ORDER BY snapshot.created_at DESC, snapshot.id DESC
    `,
    [userId, conversationId, currentRunId],
  );
  return result.rows.map(snapshotSummary);
}

export async function getResearchSnapshot(
  userId: string,
  snapshotId: string,
  database: Queryable = getPool(),
): Promise<ResearchSnapshot | null> {
  const snapshotResult = await database.query<SnapshotRow>(
    `
      SELECT
        snapshot.id,
        snapshot.title,
        snapshot.query_summary,
        snapshot.limitations,
        snapshot.created_at
      FROM research_snapshots snapshot
      JOIN conversations conversation ON conversation.id = snapshot.conversation_id
      WHERE
        snapshot.id = $1
        AND snapshot.user_id = $2
        AND conversation.user_id = $2
        AND conversation.deleted_at IS NULL
    `,
    [snapshotId, userId],
  );
  if (snapshotResult.rowCount === 0) {
    return null;
  }

  const companiesResult = await database.query<CompanyRow>(
    `
      SELECT
        id,
        ordinal,
        name,
        website_url,
        country,
        company_type,
        relevance_summary
      FROM research_companies
      WHERE snapshot_id = $1
      ORDER BY ordinal
    `,
    [snapshotId],
  );
  const contactsResult = await database.query<ContactRow>(
    `
      SELECT
        contact.id,
        contact.company_id,
        contact.ordinal,
        contact.name,
        contact.title_original,
        contact.role_category,
        contact.public_profile_url,
        contact.confidence
      FROM research_contacts contact
      JOIN research_companies company ON company.id = contact.company_id
      WHERE company.snapshot_id = $1
      ORDER BY company.ordinal, contact.ordinal
    `,
    [snapshotId],
  );
  const evidenceResult = await database.query<EvidenceRow>(
    `
      SELECT
        id,
        company_id,
        contact_id,
        ordinal,
        claim,
        source_url,
        source_title,
        supports
      FROM research_evidence
      WHERE snapshot_id = $1
      ORDER BY ordinal
    `,
    [snapshotId],
  );

  const contactsByCompany = new Map<
    string,
    ResearchCompany["contacts"]
  >();
  const evidenceByCompany = new Map<
    string,
    ResearchCompany["evidence"]
  >();
  const evidenceByContact = new Map<
    string,
    ResearchCompany["evidence"]
  >();

  const companyIds = new Set(companiesResult.rows.map((company) => company.id));
  const contactIds = new Set(contactsResult.rows.map((contact) => contact.id));

  for (const contact of contactsResult.rows) {
    if (!companyIds.has(contact.company_id)) {
      throw new ResearchDataConsistencyError(
        `Research snapshot ${snapshotId} contact ${contact.id} references unknown company ${contact.company_id}`,
      );
    }
  }

  for (const evidence of evidenceResult.rows) {
    const value: ResearchCompany["evidence"][number] = {
      claim: evidence.claim,
      sourceUrl: evidence.source_url,
      sourceTitle: evidence.source_title,
      supports: evidence.supports,
    };
    if (evidence.company_id !== null) {
      if (evidence.contact_id !== null) {
        throw new ResearchDataConsistencyError(
          `Research snapshot ${snapshotId} evidence ${evidence.id} must belong to exactly one company or contact`,
        );
      }
      if (!companyIds.has(evidence.company_id)) {
        throw new ResearchDataConsistencyError(
          `Research snapshot ${snapshotId} evidence ${evidence.id} references unknown company ${evidence.company_id}`,
        );
      }
      const items = evidenceByCompany.get(evidence.company_id) ?? [];
      items.push(value);
      evidenceByCompany.set(evidence.company_id, items);
    } else {
      const contactId = evidence.contact_id;
      if (contactId === null) {
        throw new ResearchDataConsistencyError(
          `Research snapshot ${snapshotId} evidence ${evidence.id} must belong to exactly one company or contact`,
        );
      }
      if (!contactIds.has(contactId)) {
        throw new ResearchDataConsistencyError(
          `Research snapshot ${snapshotId} evidence ${evidence.id} references unknown contact ${contactId}`,
        );
      }
      const items = evidenceByContact.get(contactId) ?? [];
      items.push(value);
      evidenceByContact.set(contactId, items);
    }
  }

  for (const contact of contactsResult.rows) {
    const evidence = evidenceByContact.get(contact.id);
    if (evidence === undefined || evidence.length === 0) {
      throw new ResearchDataConsistencyError(
        `Research snapshot ${snapshotId} contact ${contact.id} has no evidence`,
      );
    }
    const items = contactsByCompany.get(contact.company_id) ?? [];
    items.push({
      name: contact.name,
      titleOriginal: contact.title_original,
      roleCategory: contact.role_category,
      publicProfileUrl: contact.public_profile_url,
      confidence: contact.confidence,
      evidence,
    });
    contactsByCompany.set(contact.company_id, items);
  }

  const snapshot = snapshotResult.rows[0];
  return {
    id: snapshot.id,
    title: snapshot.title,
    querySummary: snapshot.query_summary,
    limitations: snapshot.limitations,
    createdAt: snapshot.created_at.toISOString(),
    companies: companiesResult.rows.map((company) => {
      const evidence = evidenceByCompany.get(company.id);
      if (evidence === undefined || evidence.length === 0) {
        throw new ResearchDataConsistencyError(
          `Research snapshot ${snapshotId} company ${company.id} has no evidence`,
        );
      }

      return {
        id: company.id,
        name: company.name,
        websiteUrl: company.website_url,
        country: company.country,
        companyType: company.company_type,
        relevanceSummary: company.relevance_summary,
        contacts: contactsByCompany.get(company.id) ?? [],
        evidence,
      };
    }),
  };
}
