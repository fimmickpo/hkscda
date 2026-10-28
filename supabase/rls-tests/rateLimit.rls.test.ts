import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// See moneyPii.rls.test.ts for the rationale behind these fixed local demo
// keys and the env var overrides -- this file mirrors the setup of
// faqSearchGap.rls.test.ts rather than inventing a second convention.
const SUPABASE_URL = process.env.SUPABASE_LOCAL_URL ?? "http://127.0.0.1:55321";
const ANON_KEY =
  process.env.SUPABASE_LOCAL_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_LOCAL_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function isLocalStackReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: ANON_KEY },
      // See moneyPii.rls.test.ts for why this timeout is generous rather than
      // tight.
      signal: AbortSignal.timeout(5000),
    });
    return res.status > 0;
  } catch {
    return false;
  }
}

let warnedSkip = false;
function warnSkipOnce() {
  if (warnedSkip) return;
  warnedSkip = true;
  console.log(
    "Skipping RLS behavioral tests: local Supabase stack not reachable at " +
      SUPABASE_URL +
      ". Run `bunx supabase start` first, then `bun run test:rls` (not plain `bun test`).",
  );
}

// Top-level await: Bun evaluates a test file's module body before registering
// its describe/test blocks, so describe.skipIf gets a resolved check.
const reachable = await isLocalStackReachable();
if (!reachable) warnSkipOnce();

// Every bucket this file writes starts with this prefix, so afterAll can delete
// exactly its own rows and the assertions can ignore whatever else the shared
// local table holds.
const BUCKET_PREFIX = `rls-rate-limit-${crypto.randomUUID().slice(0, 8)}`;

const AUTHENTICATED_EMAIL = "rls-test-rate-limit-authenticated@example.test";
const AUTHENTICATED_PASSWORD = "test-password-12345";

// The 22023 raised by rate_limit_hit for an out-of-range argument.
const INVALID_PARAMETER_VALUE = "22023";
// PostgREST's code for a role that lacks the table or function privilege.
const INSUFFICIENT_PRIVILEGE = "42501";
// Some PostgREST versions leave a function the role cannot execute out of the
// schema cache, so a denied RPC answers "function not found" instead.
const FUNCTION_NOT_FOUND = "PGRST202";

const HOUR_MS = 3_600_000;

function expectRpcDenied(error: { code?: string } | null) {
  expect(error).not.toBeNull();
  expect([INSUFFICIENT_PRIVILEGE, FUNCTION_NOT_FOUND]).toContain(error?.code ?? "");
}

type Hit = { success: boolean; limit: number; remaining: number; reset: number };

let service: SupabaseClient | undefined;
let anon: SupabaseClient;
let authenticated: SupabaseClient;
let authenticatedUserId: string | undefined;

function svc(): SupabaseClient {
  if (!service) throw new Error("service client was not created");
  return service;
}

async function hit(bucket: string, limit: number, windowMs = HOUR_MS): Promise<Hit> {
  const { data, error } = await svc().rpc("rate_limit_hit", {
    p_bucket: bucket,
    p_limit: limit,
    p_window_ms: windowMs,
  });
  if (error) throw new Error(`rate_limit_hit failed: ${error.message}`);
  return data as Hit;
}

async function storedHits(bucket: string): Promise<number> {
  const { data, error } = await svc().from("rate_limit_window").select("hits").eq("bucket", bucket);
  if (error) throw new Error(`Failed to read rate_limit_window: ${error.message}`);
  return (data ?? []).reduce((sum, row) => sum + Number(row.hits), 0);
}

describe.skipIf(!reachable)("RLS behavioral matrix: rate_limit_window", () => {
  beforeAll(async () => {
    // Assigned before anything that can throw, so afterAll can always reach it.
    const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    service = serviceClient;
    anon = createClient(SUPABASE_URL, ANON_KEY);

    let { data, error } = await serviceClient.auth.admin.createUser({
      email: AUTHENTICATED_EMAIL,
      password: AUTHENTICATED_PASSWORD,
      email_confirm: true,
    });
    // Self-heal a collision left by a previous interrupted run -- see
    // moneyPii.rls.test.ts's createRoleUser. Only ever touches this suite's own
    // `rls-test-*@example.test` address, on the loopback stack.
    if (error && /already.*registered/i.test(error.message)) {
      const { data: existing } = await serviceClient.auth.admin.listUsers();
      const stale = existing?.users.find((user) => user.email === AUTHENTICATED_EMAIL);
      if (stale) await serviceClient.auth.admin.deleteUser(stale.id);
      ({ data, error } = await serviceClient.auth.admin.createUser({
        email: AUTHENTICATED_EMAIL,
        password: AUTHENTICATED_PASSWORD,
        email_confirm: true,
      }));
    }
    if (error || !data.user) {
      throw new Error(`Failed to create test user ${AUTHENTICATED_EMAIL}: ${error?.message}`);
    }
    authenticatedUserId = data.user.id;

    authenticated = createClient(SUPABASE_URL, ANON_KEY);
    const { error: signInError } = await authenticated.auth.signInWithPassword({
      email: AUTHENTICATED_EMAIL,
      password: AUTHENTICATED_PASSWORD,
    });
    if (signInError) {
      throw new Error(`Failed to sign in test user ${AUTHENTICATED_EMAIL}: ${signInError.message}`);
    }
    // Creates an auth user over HTTP and signs it in -- see moneyPii.rls.test.ts
    // for why the budget is raised well above bun:test's 5s default.
  }, 60_000);

  afterAll(async () => {
    if (!service) return;
    // Each cleanup step is isolated so one failure cannot leak the other.
    try {
      await service.from("rate_limit_window").delete().like("bucket", `${BUCKET_PREFIX}%`);
    } catch (err) {
      console.error(`Failed to clean up rate_limit_window rows for ${BUCKET_PREFIX}:`, err);
    }
    if (authenticatedUserId) {
      try {
        await service.auth.admin.deleteUser(authenticatedUserId);
      } catch (err) {
        console.error(`Failed to clean up auth user ${authenticatedUserId}:`, err);
      }
    }
  });

  describe("client access is denied", () => {
    const roles = [
      ["anon", () => anon],
      ["authenticated", () => authenticated],
    ] as const;

    // A real row exists so a misconfigured grant could not pass vacuously by
    // reading an empty table.
    test.each(roles)("%s can neither select nor insert on the table", async (name, client) => {
      await hit(`${BUCKET_PREFIX}-denied-seed-${name}`, 5);

      const read = await client().from("rate_limit_window").select("bucket");
      expect(read.error?.code).toBe(INSUFFICIENT_PRIVILEGE);

      const write = await client()
        .from("rate_limit_window")
        .insert({
          bucket: `${BUCKET_PREFIX}-denied-insert-${name}`,
          window_start: 0,
          hits: 1,
          expires_at: new Date(Date.now() + HOUR_MS).toISOString(),
        });
      expect(write.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    test.each(roles)("%s cannot call the hit or purge functions", async (name, client) => {
      const bucket = `${BUCKET_PREFIX}-denied-rpc-${name}`;
      const counted = await client().rpc("rate_limit_hit", {
        p_bucket: bucket,
        p_limit: 5,
        p_window_ms: HOUR_MS,
      });
      expectRpcDenied(counted.error);

      const purged = await client().rpc("purge_rate_limit_windows");
      expectRpcDenied(purged.error);

      // Nothing slipped through the denied hit.
      expect(await storedHits(bucket)).toBe(0);
    });
  });

  describe("counting", () => {
    test("allows up to the limit, then refuses, and a refused request is not counted", async () => {
      const bucket = `${BUCKET_PREFIX}-limit`;

      const answers = [];
      for (let i = 0; i < 5; i++) answers.push(await hit(bucket, 3));

      expect(answers.map((answer) => answer.success)).toEqual([true, true, true, false, false]);
      expect(answers.map((answer) => answer.remaining)).toEqual([2, 1, 0, 0, 0]);
      expect(answers.every((answer) => answer.limit === 3)).toBe(true);
      expect(await storedHits(bucket)).toBe(3);
    });

    test("keeps buckets apart", async () => {
      const first = `${BUCKET_PREFIX}-apart-first`;
      const second = `${BUCKET_PREFIX}-apart-second`;

      expect((await hit(first, 1)).success).toBe(true);
      expect((await hit(first, 1)).success).toBe(false);
      expect((await hit(second, 1)).success).toBe(true);
    });

    test("answers with the end of the current window as the reset time", async () => {
      const windowMs = 60_000;
      const answer = await hit(`${BUCKET_PREFIX}-reset`, 5, windowMs);

      expect(answer.reset % windowMs).toBe(0);
      expect(answer.reset).toBeGreaterThan(Date.now() - 5_000);
      expect(answer.reset - Date.now()).toBeLessThanOrEqual(windowMs + 5_000);
    });

    test("never lets concurrent requests past the limit", async () => {
      const bucket = `${BUCKET_PREFIX}-concurrent`;

      const answers = await Promise.all(Array.from({ length: 25 }, () => hit(bucket, 10)));

      expect(answers.filter((answer) => answer.success)).toHaveLength(10);
      expect(await storedHits(bucket)).toBe(10);
    });

    test("counts the previous window: a very busy one blocks the start of the next", async () => {
      const bucket = `${BUCKET_PREFIX}-previous-busy`;
      const first = await hit(bucket, 10);
      const previousStart = first.reset - 2 * HOUR_MS;
      const { error } = await svc()
        .from("rate_limit_window")
        .insert({
          bucket,
          window_start: previousStart,
          hits: 1_000_000,
          expires_at: new Date(Date.now() + HOUR_MS).toISOString(),
        });
      expect(error).toBeNull();

      // Its weight, 1,000,000 x (1 - elapsed share), is above 10 for all but the last
      // few milliseconds of the hour.
      expect((await hit(bucket, 10)).success).toBe(false);
    });

    test("weighs a quiet previous window by how much of it is left", async () => {
      const bucket = `${BUCKET_PREFIX}-previous-quiet`;
      const first = await hit(bucket, 1000);
      const { error } = await svc()
        .from("rate_limit_window")
        .insert({
          bucket,
          window_start: first.reset - 2 * HOUR_MS,
          hits: 100,
          expires_at: new Date(Date.now() + HOUR_MS).toISOString(),
        });
      expect(error).toBeNull();

      const second = await hit(bucket, 1000);

      // The previous window weighs between 0 and 100 hits, and the current one holds 1 and
      // is now counting a second.
      expect(second.success).toBe(true);
      expect(second.remaining).toBeGreaterThanOrEqual(1000 - (100 + 2));
      expect(second.remaining).toBeLessThanOrEqual(1000 - 2);
    });

    test("keeps a row for two windows after its window starts", async () => {
      const windowMs = 120_000;
      const bucket = `${BUCKET_PREFIX}-expiry`;
      const answer = await hit(bucket, 5, windowMs);

      const { data, error } = await svc()
        .from("rate_limit_window")
        .select("window_start, expires_at")
        .eq("bucket", bucket);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(Number(data![0]!.window_start)).toBe(answer.reset - windowMs);
      expect(Date.parse(data![0]!.expires_at as string) - Number(data![0]!.window_start)).toBe(
        2 * windowMs,
      );
    });
  });

  describe("arguments", () => {
    test.each([
      ["an empty bucket", { p_bucket: "", p_limit: 5, p_window_ms: 60_000 }],
      [
        "a bucket over 200 characters",
        { p_bucket: "x".repeat(201), p_limit: 5, p_window_ms: 60_000 },
      ],
      ["a limit of 0", { p_bucket: "x", p_limit: 0, p_window_ms: 60_000 }],
      ["a limit over 100000", { p_bucket: "x", p_limit: 100_001, p_window_ms: 60_000 }],
      ["a window under a second", { p_bucket: "x", p_limit: 5, p_window_ms: 999 }],
      ["a window over a day", { p_bucket: "x", p_limit: 5, p_window_ms: 86_400_001 }],
    ])("%s is refused with 22023", async (_name, args) => {
      const { error } = await svc().rpc("rate_limit_hit", args);

      expect(error?.code).toBe(INVALID_PARAMETER_VALUE);
    });
  });

  describe("purge", () => {
    test("deletes expired rows and keeps current ones", async () => {
      const expired = `${BUCKET_PREFIX}-purge-expired`;
      const current = `${BUCKET_PREFIX}-purge-current`;
      const { error } = await svc()
        .from("rate_limit_window")
        .insert([
          // Expired long ago, so it is first in line whatever else the table holds.
          { bucket: expired, window_start: 0, hits: 5, expires_at: "1970-01-01T00:00:00Z" },
          {
            bucket: current,
            window_start: 0,
            hits: 5,
            expires_at: new Date(Date.now() + HOUR_MS).toISOString(),
          },
        ]);
      expect(error).toBeNull();

      const purged = await svc().rpc("purge_rate_limit_windows");

      expect(purged.error).toBeNull();
      expect(Number(purged.data)).toBeGreaterThanOrEqual(1);
      expect(await storedHits(expired)).toBe(0);
      expect(await storedHits(current)).toBe(5);
    });
  });
});
