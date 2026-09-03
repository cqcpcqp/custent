import { z } from "zod";

const NativeUrlSchema = z.string().url();
const ToolCompatibleUrlSchema = z.string().refine(
  (value) => NativeUrlSchema.safeParse(value).success,
  "Invalid URL",
);

export const CompanyTypeSchema = z.enum([
  "importer",
  "distributor",
  "retailer",
  "brand",
  "manufacturer",
  "industrial_end_user",
  "other",
]);

export const ContactRoleSchema = z.enum([
  "procurement",
  "purchasing",
  "sourcing",
  "buyer",
  "category_product",
  "supply_chain",
  "operations",
  "engineering_project",
  "owner_executive",
  "business_development",
  "other",
]);

export const EvidenceInputSchema = z.object({
  claim: z.string().min(1).max(2_000),
  sourceUrl: ToolCompatibleUrlSchema,
  sourceTitle: z.string().min(1).max(500),
  supports: z.enum(["company_identity", "business_fit", "contact_role"]),
});

export const ContactInputSchema = z.object({
  name: z.string().min(1).max(300),
  titleOriginal: z.string().min(1).max(500),
  roleCategory: ContactRoleSchema,
  publicProfileUrl: ToolCompatibleUrlSchema.nullable(),
  confidence: z.enum(["A", "B", "C"]),
  evidence: z.array(EvidenceInputSchema).min(1),
});

export const CompanyInputSchema = z.object({
  name: z.string().min(1).max(500),
  websiteUrl: ToolCompatibleUrlSchema,
  country: z.string().min(2).max(120),
  companyType: CompanyTypeSchema,
  relevanceSummary: z.string().min(1).max(2_000),
  contacts: z.array(ContactInputSchema),
  evidence: z.array(EvidenceInputSchema).min(1),
});

export const SaveResearchInputSchema = z.object({
  title: z.string().min(1).max(500),
  querySummary: z.string().min(1).max(4_000),
  limitations: z.string().min(1).max(4_000),
  companies: z.array(CompanyInputSchema).min(1).max(100),
});

export type SaveResearchInput = z.infer<typeof SaveResearchInputSchema>;

export const ResearchSnapshotSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  querySummary: z.string(),
  companyCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export type ResearchSnapshotSummary = z.infer<
  typeof ResearchSnapshotSummarySchema
>;

export type ResearchEvidence = z.infer<typeof EvidenceInputSchema> & {
  id: string;
};

export type ResearchContact = z.infer<typeof ContactInputSchema> & {
  id: string;
};

export type ResearchCompany = z.infer<typeof CompanyInputSchema> & {
  id: string;
};

export type ResearchSnapshot = {
  id: string;
  title: string;
  querySummary: string;
  limitations: string;
  createdAt: string;
  companies: ResearchCompany[];
};
