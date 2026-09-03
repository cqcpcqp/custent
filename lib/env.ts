import { z } from "zod";

import {
  NonnegativePostgresIntegerSchema,
  PositivePostgresIntegerSchema,
  ProviderBaseUrlSchema,
} from "@/lib/config-validation";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_PROVIDER: z.enum(["openai", "sharesub"]).default("openai"),
  OPENAI_BASE_URL: ProviderBaseUrlSchema.default("https://api.openai.com/v1"),
  OPENAI_MODEL: z.string().trim().min(1).max(200).default("gpt-5.6"),
  OPENAI_REASONING_MODE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  OPENAI_CODE_INTERPRETER_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  DEMO_USER_ID: z
    .string()
    .uuid()
    .default("11111111-1111-4111-8111-111111111111"),
  RUN_RESERVATION_CREDITS: z.coerce
    .number()
    .pipe(PositivePostgresIntegerSchema)
    .default(500),
  RUN_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  RUN_WORKER_POLL_MS: z.coerce.number().int().positive().default(250),
  RUN_LEASE_MS: z.coerce.number().int().min(10_000).default(30_000),
  RUN_RECOVERY_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .safe()
    .default(5_000),
  RUN_RECOVERY_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(100),
  RUN_EVENT_POLL_MS: z.coerce.number().int().positive().default(250),
  CREDITS_PER_1K_INPUT_TOKENS: z.coerce
    .number()
    .pipe(NonnegativePostgresIntegerSchema)
    .default(1),
  CREDITS_PER_1K_OUTPUT_TOKENS: z.coerce
    .number()
    .pipe(NonnegativePostgresIntegerSchema)
    .default(5),
  CREDITS_PER_WEB_SEARCH: z.coerce
    .number()
    .pipe(NonnegativePostgresIntegerSchema)
    .default(10),
  ARTIFACT_DIR: z.string().min(1).default(".data/artifacts"),
  INPUT_ATTACHMENT_DIR: z
    .string()
    .min(1)
    .default(".data/input-attachments"),
  INPUT_ATTACHMENT_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .safe()
    .default(10 * 1024 * 1024),
  INPUT_ATTACHMENT_MAX_PER_MESSAGE: z.coerce
    .number()
    .int()
    .min(1)
    .max(5)
    .default(5),
  INPUT_ATTACHMENT_MAX_TOTAL_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .safe()
    .default(20 * 1024 * 1024),
  INPUT_ATTACHMENT_STAGED_TTL_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .default(24),
  INPUT_ATTACHMENT_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(60_000),
  INPUT_ATTACHMENT_DELETE_RETRY_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(30_000),
  INPUT_ATTACHMENT_SWEEP_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(100),
  INPUT_ATTACHMENT_ORPHAN_MIN_AGE_MS: z.coerce
    .number()
    .int()
    .min(5 * 60 * 1_000)
    .max(Number.MAX_SAFE_INTEGER)
    .default(60 * 60 * 1_000),
  INPUT_ATTACHMENT_TEMP_STALE_AGE_MS: z.coerce
    .number()
    .int()
    .min(5 * 60 * 1_000)
    .max(Number.MAX_SAFE_INTEGER)
    .default(60 * 60 * 1_000),
  PDF_FONT_PATH: z.string().min(1).optional(),
}).superRefine((environment, context) => {
  if (
    environment.INPUT_ATTACHMENT_MAX_BYTES >
    environment.INPUT_ATTACHMENT_MAX_TOTAL_BYTES
  ) {
    context.addIssue({
      code: "custom",
      message:
        "INPUT_ATTACHMENT_MAX_BYTES cannot exceed INPUT_ATTACHMENT_MAX_TOTAL_BYTES",
      path: ["INPUT_ATTACHMENT_MAX_BYTES"],
    });
  }
});

export type AppEnv = z.infer<typeof EnvSchema>;

let cachedEnv: AppEnv | undefined;

export function getEnv(): AppEnv {
  cachedEnv ??= EnvSchema.parse(process.env);
  return cachedEnv;
}

export function resetEnvForTests(): void {
  cachedEnv = undefined;
}
