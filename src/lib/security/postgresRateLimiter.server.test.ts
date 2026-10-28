import { describe, expect, test } from "bun:test";

import {
  createPostgresLimiter,
  RateLimitStoreError,
  rateLimitBucket,
  windowToMilliseconds,
} from "./postgresRateLimiter.server";
import type { RateLimitWindow } from "./rate-limit.server";

describe("windowToMilliseconds", () => {
  test("reads every unit", () => {
    expect(windowToMilliseconds("1500 ms")).toBe(1_500);
    expect(windowToMilliseconds("10 s")).toBe(10_000);
    expect(windowToMilliseconds("1 m")).toBe(60_000);
    expect(windowToMilliseconds("1 h")).toBe(3_600_000);
    expect(windowToMilliseconds("1 d")).toBe(86_400_000);
  });

  test("refuses a window the database would refuse", () => {
    expect(() => windowToMilliseconds("500 ms")).toThrow(/out of range/);
    expect(() => windowToMilliseconds("0 s")).toThrow(/out of range/);
    expect(() => windowToMilliseconds("2 d")).toThrow(/out of range/);
  });

  test("refuses a window it cannot read", () => {
    expect(() => windowToMilliseconds("1 w" as RateLimitWindow)).toThrow(/Unsupported/);
    expect(() => windowToMilliseconds("1.5 m" as RateLimitWindow)).toThrow(/Unsupported/);
  });
});

describe("rateLimitBucket", () => {
  test("names the bucket with the prefix and a hash, never the identifier", () => {
    const bucket = rateLimitBucket("donations", "203.0.113.7", "secret");

    expect(bucket).toMatch(/^donations:[0-9a-f]{32}$/);
    expect(bucket).not.toContain("203.0.113.7");
  });

  test("is the same for the same client and different for anything else", () => {
    const bucket = rateLimitBucket("donations", "203.0.113.7", "secret");

    expect(rateLimitBucket("donations", "203.0.113.7", "secret")).toBe(bucket);
    expect(rateLimitBucket("donations", "203.0.113.8", "secret")).not.toBe(bucket);
    expect(rateLimitBucket("donations", "203.0.113.7", "another-secret")).not.toBe(bucket);
    // The same client under another prefix does not share, or reveal, a hash.
    expect(rateLimitBucket("adoption", "203.0.113.7", "secret").split(":")[1]).not.toBe(
      bucket.split(":")[1],
    );
  });

  test("keeps within the length the table allows", () => {
    expect(rateLimitBucket("p".repeat(167), "ip", "secret")).toHaveLength(200);
    expect(() => rateLimitBucket("p".repeat(168), "ip", "secret")).toThrow(/too long/);
  });

  test("needs a secret", () => {
    expect(() => rateLimitBucket("donations", "ip", "")).toThrow(/secret/);
  });
});

describe("createPostgresLimiter", () => {
  type Response = { data: unknown; error: { code?: string; message?: string } | null };

  function limiterFor(response: Response) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const client = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return response;
      },
    } as unknown as Parameters<typeof createPostgresLimiter>[1]["client"];
    const limiter = createPostgresLimiter(
      { prefix: "donations", max: 5, window: "1 m" },
      { client, secret: "secret" },
    );
    return { calls, limiter };
  }

  test("counts one request through rate_limit_hit and returns its answer", async () => {
    const { calls, limiter } = limiterFor({
      data: { success: true, limit: 5, remaining: 3, reset: 120_000 },
      error: null,
    });

    expect(await limiter.limit("203.0.113.7")).toEqual({
      success: true,
      limit: 5,
      remaining: 3,
      reset: 120_000,
    });
    expect(calls).toEqual([
      {
        fn: "rate_limit_hit",
        args: {
          p_bucket: rateLimitBucket("donations", "203.0.113.7", "secret"),
          p_limit: 5,
          p_window_ms: 60_000,
        },
      },
    ]);
  });

  test("reports a refusal as success false", async () => {
    const { limiter } = limiterFor({
      data: { success: false, limit: 5, remaining: 0, reset: 120_000 },
      error: null,
    });

    expect((await limiter.limit("ip")).success).toBe(false);
  });

  test("throws the database error code and nothing else when the call fails", async () => {
    const { limiter } = limiterFor({
      data: null,
      error: { code: "PGRST202", message: "private alice@example.test" },
    });

    const failure = await limiter.limit("ip").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RateLimitStoreError);
    expect((failure as RateLimitStoreError).code).toBe("PGRST202");
    expect((failure as Error).message).not.toContain("alice@example.test");
  });

  test("throws when the answer is not what rate_limit_hit returns", async () => {
    for (const data of [null, "ok", { success: "yes" }, { success: true, limit: 5 }]) {
      const { limiter } = limiterFor({ data, error: null });

      const failure = await limiter.limit("ip").catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(RateLimitStoreError);
      expect((failure as RateLimitStoreError).code).toBeNull();
    }
  });

  test("refuses to be built for a window the database would refuse", () => {
    expect(() =>
      createPostgresLimiter(
        { prefix: "p", max: 1, window: "500 ms" },
        { client: { rpc: async () => ({ data: null, error: null }) } as never, secret: "s" },
      ),
    ).toThrow(/out of range/);
  });
});
