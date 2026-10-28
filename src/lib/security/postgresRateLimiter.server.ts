import { createHmac } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { RateLimitOptions, RateLimitWindow, RateLimiter } from "./rate-limit.server";

const unitMilliseconds = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

// The same bounds as rate_limit_hit: a window of one second to one day.
const minWindowMilliseconds = 1_000;
const maxWindowMilliseconds = 86_400_000;
const maxBucketLength = 200;

/** "1 m" is 60000. Throws for a window the database would refuse. */
export function windowToMilliseconds(window: RateLimitWindow): number {
  const match = /^(\d+) (ms|s|m|h|d)$/.exec(window);
  if (!match) throw new Error(`Unsupported rate limit window: ${window}`);
  const milliseconds =
    Number(match[1]) * unitMilliseconds[match[2] as keyof typeof unitMilliseconds];
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < minWindowMilliseconds ||
    milliseconds > maxWindowMilliseconds
  ) {
    throw new Error(`Rate limit window out of range: ${window}`);
  }
  return milliseconds;
}

/**
 * The bucket stored for one client: the route's prefix plus a keyed hash of the identifier.
 * The rate-limit table then never holds an IP address or an email address, and a copy of it
 * cannot be matched to a client without the server's key. The prefix is part of what is
 * hashed, so the same client has a different hash under every prefix.
 */
export function rateLimitBucket(prefix: string, identifier: string, secret: string): string {
  if (!secret) throw new Error("A secret is required to name rate limit buckets");
  const digest = createHmac("sha256", secret)
    .update(`${prefix}\0${identifier}`)
    .digest("hex")
    .slice(0, 32);
  const bucket = `${prefix}:${digest}`;
  if (bucket.length > maxBucketLength) throw new Error(`Rate limit prefix too long: ${prefix}`);
  return bucket;
}

/** The store could not count the request. `code` is the database error code, never user data. */
export class RateLimitStoreError extends Error {
  constructor(readonly code: string | null) {
    super(code ? `Rate limit store failed (${code})` : "Rate limit store failed");
    this.name = "RateLimitStoreError";
  }
}

const hitResultSchema = z.object({
  success: z.boolean(),
  limit: z.number(),
  remaining: z.number(),
  reset: z.number(),
});

/**
 * A rate limiter that counts in Postgres through the rate_limit_hit function, which only the
 * service role may call. `secret` keys the hash that names buckets; the service role key does.
 */
export function createPostgresLimiter(
  options: Pick<RateLimitOptions, "prefix" | "max" | "window">,
  deps: { client: Pick<SupabaseClient, "rpc">; secret: string },
): RateLimiter {
  const windowMilliseconds = windowToMilliseconds(options.window);
  return {
    async limit(identifier) {
      const { data, error } = await deps.client.rpc("rate_limit_hit", {
        p_bucket: rateLimitBucket(options.prefix, identifier, deps.secret),
        p_limit: options.max,
        p_window_ms: windowMilliseconds,
      });
      if (error) throw new RateLimitStoreError(error.code || null);
      const result = hitResultSchema.safeParse(data);
      if (!result.success) throw new RateLimitStoreError(null);
      return result.data;
    },
  };
}
