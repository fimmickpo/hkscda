import { describe, expect, test } from "bun:test";

import {
  MANAGED_KEYS,
  isLocalApiUrl,
  localEnvValues,
  mergeEnvFile,
  parseStatusEnv,
} from "./write-local-env.mjs";

const STATUS_OUTPUT = [
  "Stopped services: [supabase_imgproxy_hkscda supabase_pooler_hkscda]",
  "WARN: INBUCKET_URL is deprecated and will be removed in v3, use MAILPIT_URL instead.",
  'ANON_KEY="anon-key-value"',
  'API_URL="http://127.0.0.1:55321"',
  'DB_URL="postgresql://postgres:postgres@127.0.0.1:55322/postgres"',
  'SERVICE_ROLE_KEY="service-role-value"',
  "",
].join("\n");

const LOCAL_VALUES = {
  VITE_SUPABASE_URL: "http://127.0.0.1:55321",
  VITE_SUPABASE_ANON_KEY: "anon-key-value",
  SUPABASE_URL: "http://127.0.0.1:55321",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-value",
};

describe("MANAGED_KEYS", () => {
  test("owns exactly the four Supabase keys the app reads", () => {
    expect([...MANAGED_KEYS].sort()).toEqual(
      [
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_URL",
        "VITE_SUPABASE_ANON_KEY",
        "VITE_SUPABASE_URL",
      ].sort(),
    );
  });
});

describe("parseStatusEnv", () => {
  test("reads quoted values and skips the CLI's notice lines", () => {
    const status = parseStatusEnv(STATUS_OUTPUT);
    expect(status.API_URL).toBe("http://127.0.0.1:55321");
    expect(status.ANON_KEY).toBe("anon-key-value");
    expect(status.SERVICE_ROLE_KEY).toBe("service-role-value");
    expect(Object.keys(status).sort()).toEqual([
      "ANON_KEY",
      "API_URL",
      "DB_URL",
      "SERVICE_ROLE_KEY",
    ]);
  });

  test("tolerates unquoted values and CRLF line endings", () => {
    const status = parseStatusEnv('API_URL=http://127.0.0.1:55321\r\nANON_KEY="a=b=c"\r\n');
    expect(status.API_URL).toBe("http://127.0.0.1:55321");
    expect(status.ANON_KEY).toBe("a=b=c");
  });

  test("returns an empty object for output without KEY=value lines", () => {
    expect(parseStatusEnv("supabase local development setup is not running.\n")).toEqual({});
  });
});

describe("localEnvValues", () => {
  test("maps the CLI's status keys onto the names the app reads", () => {
    expect(localEnvValues(parseStatusEnv(STATUS_OUTPUT))).toEqual(LOCAL_VALUES);
  });

  test("throws, naming the missing keys, instead of writing a partial file", () => {
    expect(() => localEnvValues({ API_URL: "http://127.0.0.1:55321" })).toThrow(
      "supabase status did not report: ANON_KEY, SERVICE_ROLE_KEY",
    );
  });
});

describe("isLocalApiUrl", () => {
  test("accepts the loopback hosts the local stack can report", () => {
    expect(isLocalApiUrl("http://127.0.0.1:55321")).toBe(true);
    expect(isLocalApiUrl("http://localhost:55321")).toBe(true);
    expect(isLocalApiUrl("http://[::1]:55321")).toBe(true);
  });

  test("rejects hosted and malformed URLs", () => {
    expect(isLocalApiUrl("https://iihqjzilgawhfdhdevam.supabase.co")).toBe(false);
    expect(isLocalApiUrl("http://127.0.0.1.example.com:55321")).toBe(false);
    expect(isLocalApiUrl("not-a-url")).toBe(false);
  });
});

describe("mergeEnvFile", () => {
  test("replaces the managed keys in place and leaves everything else untouched", () => {
    const existing = [
      "# Local Supabase stack for HKSCDA.",
      "VITE_SUPABASE_URL=https://old.supabase.co",
      "VITE_SUPABASE_ANON_KEY=old-anon",
      "SUPABASE_RECEIPT_BUCKET=receipts",
      "",
      "APP_URL=http://localhost:5173",
      "ADMIN_EMAIL=admin@hkscda.test",
      "SUPABASE_URL=https://old.supabase.co",
      "SUPABASE_SERVICE_ROLE_KEY=old-service",
      "",
    ].join("\n");

    expect(mergeEnvFile(existing, LOCAL_VALUES)).toBe(
      [
        "# Local Supabase stack for HKSCDA.",
        "VITE_SUPABASE_URL=http://127.0.0.1:55321",
        "VITE_SUPABASE_ANON_KEY=anon-key-value",
        "SUPABASE_RECEIPT_BUCKET=receipts",
        "",
        "APP_URL=http://localhost:5173",
        "ADMIN_EMAIL=admin@hkscda.test",
        "SUPABASE_URL=http://127.0.0.1:55321",
        "SUPABASE_SERVICE_ROLE_KEY=service-role-value",
        "",
      ].join("\n"),
    );
  });

  test("appends keys the file does not define yet, under a comment", () => {
    const existing = "APP_URL=http://localhost:5173\n";

    expect(mergeEnvFile(existing, LOCAL_VALUES)).toBe(
      [
        "APP_URL=http://localhost:5173",
        "",
        "# Supabase local stack (written by `bun run db:env`).",
        "VITE_SUPABASE_URL=http://127.0.0.1:55321",
        "VITE_SUPABASE_ANON_KEY=anon-key-value",
        "SUPABASE_URL=http://127.0.0.1:55321",
        "SUPABASE_SERVICE_ROLE_KEY=service-role-value",
        "",
      ].join("\n"),
    );
  });

  test("collapses duplicate definitions to one, because the last duplicate would win", () => {
    const existing = [
      "VITE_SUPABASE_URL=http://first",
      "APP_URL=http://localhost:5173",
      "VITE_SUPABASE_URL=http://second",
      "",
    ].join("\n");

    const merged = mergeEnvFile(existing, LOCAL_VALUES);
    expect(merged.match(/^VITE_SUPABASE_URL=/gm)).toHaveLength(1);
    expect(merged).toContain("VITE_SUPABASE_URL=http://127.0.0.1:55321");
    expect(merged).toContain("APP_URL=http://localhost:5173");
  });

  test("builds a complete file from empty content", () => {
    expect(mergeEnvFile("", LOCAL_VALUES)).toBe(
      [
        "# Supabase local stack (written by `bun run db:env`).",
        "VITE_SUPABASE_URL=http://127.0.0.1:55321",
        "VITE_SUPABASE_ANON_KEY=anon-key-value",
        "SUPABASE_URL=http://127.0.0.1:55321",
        "SUPABASE_SERVICE_ROLE_KEY=service-role-value",
        "",
      ].join("\n"),
    );
  });

  test("is idempotent, so db:start and db:env can run back to back", () => {
    const once = mergeEnvFile("APP_URL=http://localhost:5173\n", LOCAL_VALUES);
    expect(mergeEnvFile(once, LOCAL_VALUES)).toBe(once);
  });

  test("normalises CRLF line endings", () => {
    const merged = mergeEnvFile("APP_URL=http://localhost:5173\r\n", LOCAL_VALUES);
    expect(merged).not.toContain("\r");
  });
});
