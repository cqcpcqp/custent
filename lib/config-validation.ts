import { z } from "zod";

export const POSTGRES_INTEGER_MAX = 2_147_483_647;

export const PositivePostgresIntegerSchema = z
  .number()
  .int()
  .min(1)
  .max(POSTGRES_INTEGER_MAX);

export const NonnegativePostgresIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(POSTGRES_INTEGER_MAX);

export const ProviderBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .url({ protocol: /^https?$/u })
  .refine((value) => {
    const parsed = new URL(value);
    return parsed.username.length === 0 && parsed.password.length === 0;
  }, "Provider base URL must not contain credentials");
