import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";

import { enforceRateLimit, type RateLimitDatabase } from "./rate-limit.server";

// The application's limiter against the real local database, through the same HTTP path the
// server uses. It skips itself when the local stack is not running, like the tests in
// supabase/rls-tests, and honours the same SUPABASE_LOCAL_URL override.
const SUPABASE_URL = process.env.SUPABASE_LOCAL_URL ?? "http://127.0.0.1:55321";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_LOCAL_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function isLocalStackReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: SERVICE_ROLE_KEY },
      signal: AbortSignal.timeout(5000),
    });
    return res.status > 0;
  } catch {
    return false;
  }
}

const reachable = await isLocalStackReachable();

// Every bucket this file writes starts with this prefix, so afterAll deletes exactly its own rows.
const PREFIX = `local-rate-limit-${crypto.randomUUID().slice(0, 8)}`;

describe.skipIf(!reachable)("the application's rate limiter against the local database", () => {
  const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const database = (): RateLimitDatabase => ({ client: service, secret: "local-test-secret" });
  const publicForm = { prefix: PREFIX, max: 2, window: "1 h", requireAvailability: true } as const;
  const errors = spyOn(console, "error").mockImplementation(() => {});

  afterAll(async () => {
    errors.mockRestore();
    await service.from("rate_limit_window").delete().like("bucket", `${PREFIX}%`);
  });

  test("counts each client in production and stores only a hash of it", async () => {
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(
        await enforceRateLimit("203.0.113.77", publicForm, { isProduction: true, database }),
      );
    }

    expect(results.map((result) => result.ok)).toEqual([true, true, false]);
    expect(results[0]).toMatchObject({ limit: 2, remaining: 1 });
    expect(results[2]).toMatchObject({ remaining: 0 });
    expect(results[2]!.reset).toBeGreaterThan(Date.now());

    // Another client has a count of its own.
    expect(
      (await enforceRateLimit("203.0.113.78", publicForm, { isProduction: true, database })).ok,
    ).toBe(true);

    const { data, error } = await service
      .from("rate_limit_window")
      .select("bucket")
      .like("bucket", `${PREFIX}%`);
    expect(error).toBeNull();
    expect(data).toHaveLength(2);
    for (const row of data!) expect(row.bucket).toMatch(new RegExp(`^${PREFIX}:[0-9a-f]{32}$`));
    expect(JSON.stringify(data)).not.toContain("203.0.113");
  });

  test("a public form fails closed when the database refuses the service key", async () => {
    const refused = createClient(SUPABASE_URL, "not-a-real-key", {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const result = await enforceRateLimit("ip", publicForm, {
      isProduction: true,
      database: () => ({ client: refused, secret: "local-test-secret" }),
    });

    expect(result).toEqual({ ok: false, unavailable: true });
  });

  test("a public form fails closed when the database cannot be reached", async () => {
    const unreachable = createClient("http://127.0.0.1:1", SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const result = await enforceRateLimit("ip", publicForm, {
      isProduction: true,
      database: () => ({ client: unreachable, secret: "local-test-secret" }),
    });

    expect(result).toEqual({ ok: false, unavailable: true });
  });

  test("other callers still pass when the database cannot be reached", async () => {
    const unreachable = createClient("http://127.0.0.1:1", SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const result = await enforceRateLimit(
      "ip",
      { prefix: PREFIX, max: 2, window: "1 h" },
      { isProduction: true, database: () => ({ client: unreachable, secret: "s" }) },
    );

    expect(result).toEqual({ ok: true });
  });
});
