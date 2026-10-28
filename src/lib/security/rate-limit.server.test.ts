import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  clientIpFromHeaders,
  enforceRateLimit,
  getClientIp,
  retryAfterSeconds,
  type RateLimitDatabase,
  type RateLimiter,
} from "./rate-limit.server";

function request(headers: Record<string, string>): Request {
  return new Request("https://example.test", { headers });
}

describe("getClientIp", () => {
  test("prefers x-vercel-forwarded-for (platform-set, not client-spoofable)", () => {
    expect(
      getClientIp(
        request({
          // Attacker-supplied chain — must be ignored.
          "x-forwarded-for": "1.2.3.4, 5.6.7.8",
          "x-vercel-forwarded-for": "203.0.113.7",
        }),
      ),
    ).toBe("203.0.113.7");
  });

  test("does NOT trust the leftmost (client-supplied) x-forwarded-for entry", () => {
    // Vercel APPENDS the real client IP, so the real IP is the rightmost entry.
    expect(getClientIp(request({ "x-forwarded-for": "1.2.3.4, 70.41.3.18" }))).toBe("70.41.3.18");
  });

  test("falls back to x-real-ip over x-forwarded-for", () => {
    expect(getClientIp(request({ "x-real-ip": "192.0.2.44", "x-forwarded-for": "1.2.3.4" }))).toBe(
      "192.0.2.44",
    );
  });

  test("uses the rightmost x-forwarded-for entry, trimmed, when it is the only header", () => {
    expect(getClientIp(request({ "x-forwarded-for": "  1.2.3.4 , 198.51.100.2 " }))).toBe(
      "198.51.100.2",
    );
  });

  test("returns 'unknown' when no IP headers are present", () => {
    expect(getClientIp(request({}))).toBe("unknown");
  });
});

describe("clientIpFromHeaders", () => {
  test("works with a header getter (for server-fn contexts) and ignores spoofed XFF", () => {
    const headers: Record<string, string> = {
      "x-forwarded-for": "1.2.3.4",
      "x-vercel-forwarded-for": "203.0.113.9",
    };
    expect(clientIpFromHeaders((name) => headers[name.toLowerCase()] ?? null)).toBe("203.0.113.9");
  });

  test("returns 'unknown' when the getter has nothing", () => {
    expect(clientIpFromHeaders(() => null)).toBe("unknown");
  });
});

describe("enforceRateLimit", () => {
  test("fails open when no limiter is configured", async () => {
    const result = await enforceRateLimit(
      "203.0.113.7",
      {
        prefix: "test",
        max: 5,
        window: "1 m",
      },
      { limiter: null },
    );
    expect(result.ok).toBe(true);
  });

  test("blocks a production public form when the limiter is unavailable", async () => {
    const result = await enforceRateLimit(
      "203.0.113.7",
      { prefix: "public-form", max: 5, window: "1 m", requireAvailability: true },
      { limiter: null, isProduction: true },
    );
    expect(result.ok).toBe(false);
    expect(result.unavailable).toBe(true);
  });

  test("blocks a production public form when the rate limit store fails", async () => {
    const result = await enforceRateLimit(
      "203.0.113.7",
      { prefix: "public-form", max: 5, window: "1 m", requireAvailability: true },
      {
        limiter: {
          async limit() {
            throw new Error("private user detail");
          },
        },
        isProduction: true,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.unavailable).toBe(true);
  });

  test("allows the request when the limiter reports success", async () => {
    const limiter: RateLimiter = {
      async limit() {
        return { success: true, limit: 5, remaining: 4, reset: 1000 };
      },
    };
    const result = await enforceRateLimit(
      "ip",
      { prefix: "t", max: 5, window: "1 m" },
      { limiter },
    );
    expect(result).toEqual({ ok: true, limit: 5, remaining: 4, reset: 1000 });
  });

  test("blocks the request when the limiter reports failure", async () => {
    const limiter: RateLimiter = {
      async limit() {
        return { success: false, limit: 5, remaining: 0, reset: 2000 };
      },
    };
    const result = await enforceRateLimit(
      "ip",
      { prefix: "t", max: 5, window: "1 m" },
      { limiter },
    );
    expect(result.ok).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test("fails open when the limiter throws (e.g. a database outage)", async () => {
    const limiter: RateLimiter = {
      async limit() {
        throw new Error("database down");
      },
    };
    const result = await enforceRateLimit(
      "ip",
      { prefix: "t", max: 5, window: "1 m" },
      { limiter },
    );
    expect(result.ok).toBe(true);
  });
});

describe("retryAfterSeconds", () => {
  test("computes seconds until reset", () => {
    expect(retryAfterSeconds({ ok: false, reset: 10_000 }, 4_000)).toBe(6);
  });

  test("defaults to 60s when reset is absent", () => {
    expect(retryAfterSeconds({ ok: false })).toBe(60);
  });

  test("never returns less than 1", () => {
    expect(retryAfterSeconds({ ok: false, reset: 1_000 }, 5_000)).toBe(1);
  });
});

describe("enforceRateLimit counting in the database", () => {
  const publicForm = {
    prefix: "donations",
    max: 5,
    window: "1 m",
    requireAvailability: true,
  } as const;

  type RpcResponse = { data: unknown; error: { code?: string; message?: string } | null };

  function fakeDatabase(response: RpcResponse) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const database = (): RateLimitDatabase => ({
      client: {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          calls.push({ fn, args });
          return response;
        },
      } as unknown as RateLimitDatabase["client"],
      secret: "test-service-role-key",
    });
    return { calls, database };
  }

  const errors = spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => errors.mockClear());

  test("enforces nothing outside production and never touches the database", async () => {
    const result = await enforceRateLimit("ip", publicForm, {
      isProduction: false,
      database: () => {
        throw new Error("the database must not be reached outside production");
      },
    });
    expect(result).toEqual({ ok: true });
  });

  test("counts through rate_limit_hit in production and passes its answer on", async () => {
    const { calls, database } = fakeDatabase({
      data: { success: true, limit: 5, remaining: 4, reset: 120_000 },
      error: null,
    });

    const result = await enforceRateLimit("203.0.113.7", publicForm, {
      isProduction: true,
      database,
    });

    expect(result).toEqual({ ok: true, limit: 5, remaining: 4, reset: 120_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("rate_limit_hit");
    expect(calls[0]!.args).toMatchObject({ p_limit: 5, p_window_ms: 60_000 });
    // The client's address is hashed before it is stored.
    expect(String(calls[0]!.args.p_bucket)).toStartWith("donations:");
    expect(String(calls[0]!.args.p_bucket)).not.toContain("203.0.113.7");
  });

  test("blocks the request when the database says the limit is reached", async () => {
    const { database } = fakeDatabase({
      data: { success: false, limit: 5, remaining: 0, reset: 120_000 },
      error: null,
    });

    const result = await enforceRateLimit("ip", publicForm, { isProduction: true, database });

    expect(result).toEqual({ ok: false, limit: 5, remaining: 0, reset: 120_000 });
  });

  test("fails closed for a public form when the database errors, and logs only the code", async () => {
    const { database } = fakeDatabase({
      data: null,
      error: { code: "PGRST202", message: "private alice@example.test" },
    });

    const result = await enforceRateLimit("ip", publicForm, { isProduction: true, database });

    expect(result).toEqual({ ok: false, unavailable: true });
    expect(errors).toHaveBeenCalledWith("Rate limit check failed", {
      failClosed: true,
      code: "PGRST202",
    });
    expect(JSON.stringify(errors.mock.calls)).not.toContain("alice@example.test");
  });

  test("fails open for other callers when the database errors", async () => {
    const { database } = fakeDatabase({ data: null, error: { code: "57014" } });

    const result = await enforceRateLimit(
      "ip",
      { prefix: "webhook", max: 100, window: "1 m" },
      { isProduction: true, database },
    );

    expect(result).toEqual({ ok: true });
  });

  test("treats an answer it cannot read as a failure of the store", async () => {
    const { database } = fakeDatabase({ data: { success: "yes" }, error: null });

    const result = await enforceRateLimit("ip", publicForm, { isProduction: true, database });

    expect(result).toEqual({ ok: false, unavailable: true });
  });

  test("fails closed for a public form when the Supabase settings are missing", async () => {
    const database = () => {
      throw new Error("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY");
    };

    expect(await enforceRateLimit("ip", publicForm, { isProduction: true, database })).toEqual({
      ok: false,
      unavailable: true,
    });
    expect(
      await enforceRateLimit(
        "ip",
        { prefix: "status", max: 60, window: "1 m" },
        { isProduction: true, database },
      ),
    ).toEqual({ ok: true });
  });
});
