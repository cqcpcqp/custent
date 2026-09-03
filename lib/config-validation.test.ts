import { describe, expect, it } from "vitest";

import {
  NonnegativePostgresIntegerSchema,
  POSTGRES_INTEGER_MAX,
  PositivePostgresIntegerSchema,
  ProviderBaseUrlSchema,
} from "./config-validation";

describe("execution configuration value contracts", () => {
  it("accepts only credential-free HTTP(S) provider base URLs", () => {
    expect(
      ProviderBaseUrlSchema.parse("https://provider.example.com/v1"),
    ).toBe("https://provider.example.com/v1");
    expect(() =>
      ProviderBaseUrlSchema.parse("ftp://provider.example.com/v1"),
    ).toThrow();
    expect(() =>
      ProviderBaseUrlSchema.parse(
        "https://user:secret@provider.example.com/v1",
      ),
    ).toThrow("Provider base URL must not contain credentials");
  });

  it("matches PostgreSQL integer storage bounds for billing values", () => {
    expect(PositivePostgresIntegerSchema.parse(POSTGRES_INTEGER_MAX)).toBe(
      POSTGRES_INTEGER_MAX,
    );
    expect(NonnegativePostgresIntegerSchema.parse(0)).toBe(0);
    expect(() =>
      PositivePostgresIntegerSchema.parse(POSTGRES_INTEGER_MAX + 1),
    ).toThrow();
    expect(() => NonnegativePostgresIntegerSchema.parse(-1)).toThrow();
  });
});
