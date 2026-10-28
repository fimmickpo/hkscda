import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseServerConfig } from "../donations/config.server";
import { createSupabaseServiceClient } from "../supabase.server";
import { createPostgresLimiter, RateLimitStoreError } from "./postgresRateLimiter.server";
import { isProductionRuntime } from "./turnstile.server";

// A sliding-window duration string, e.g. "1 m". The database accepts one second to one day.
export type RateLimitWindow = `${number} ${"ms" | "s" | "m" | "h" | "d"}`;

export type RateLimitOptions = {
  /** Namespace so different endpoints keep independent counters. */
  prefix: string;
  /** Maximum requests allowed within the window. */
  max: number;
  /** Sliding window size, e.g. "1 m". */
  window: RateLimitWindow;
  /** Public submissions require the limiter in production. */
  requireAvailability?: boolean;
};

export type RateLimitResult = {
  ok: boolean;
  unavailable?: boolean;
  limit?: number;
  remaining?: number;
  /** Unix ms timestamp when the window resets (for Retry-After). */
  reset?: number;
};

// Minimal structural type so call sites and tests can inject a fake limiter
// without a database.
export type RateLimiter = {
  limit(identifier: string): Promise<{
    success: boolean;
    limit: number;
    remaining: number;
    reset: number;
  }>;
};

/**
 * Resolve the originating client IP from platform-trusted headers.
 *
 * SECURITY: `x-forwarded-for` is partly client-controlled. A client can send
 * its own `x-forwarded-for`, and Vercel APPENDS the real client IP to the end —
 * so the LEFTMOST entry is attacker-supplied and must never be trusted for
 * rate-limiting (trusting index 0 lets an attacker rotate the header to mint a
 * fresh bucket per request and bypass every per-IP limit).
 *
 * We therefore prefer the headers Vercel sets itself (not client-spoofable):
 *   1. `x-vercel-forwarded-for` — Vercel's real client IP.
 *   2. `x-real-ip` — Vercel's real client IP.
 * Only if neither is present (non-Vercel/local dev, where rate limits are not
 * enforced) do we fall back to the RIGHTMOST
 * `x-forwarded-for` entry (the hop appended closest to our edge) — never the
 * leftmost, attacker-controlled one.
 */
export function getClientIp(request: Request): string {
  return clientIpFromHeaders((name) => request.headers.get(name));
}

/**
 * Same resolution as {@link getClientIp} but driven by a header getter, for
 * server-function contexts that expose headers rather than a `Request`
 * (e.g. `getRequestHeader` from `@tanstack/react-start/server`). Keeping one
 * implementation guarantees the donation and adoption paths resolve the IP
 * identically and stay spoof-resistant.
 */
export function clientIpFromHeaders(get: (name: string) => string | null | undefined): string {
  const vercel = firstHeaderEntry(get("x-vercel-forwarded-for"));
  if (vercel) return vercel;

  const realIp = get("x-real-ip")?.trim();
  if (realIp && realIp.length > 0) return realIp;

  const forwarded = get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length > 0) return parts[parts.length - 1]!;
  }

  return "unknown";
}

function firstHeaderEntry(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const first = value.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

/** How the limiter reaches the database. `secret` keys the hash that names buckets. */
export type RateLimitDatabase = { client: Pick<SupabaseClient, "rpc">; secret: string };

// Throws when the Supabase service settings are missing.
function serviceDatabase(): RateLimitDatabase {
  const { serviceRoleKey } = getSupabaseServerConfig();
  return { client: createSupabaseServiceClient(), secret: serviceRoleKey };
}

let warnedUnavailable = false;
function warnUnavailableOnce(): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.error(
    "Rate limiting is unavailable in production: the limiter could not be created. " +
      "Check the Supabase service settings.",
  );
}

/**
 * Counts in Postgres, and only in production. Elsewhere (local development, previews, unit
 * tests) nothing is enforced and the database is not touched, so a developer's repeated
 * attempts are never blocked and a unit test needs no database.
 */
function getLimiter(
  opts: RateLimitOptions,
  deps: { isProduction: boolean; database: () => RateLimitDatabase },
): RateLimiter | null {
  if (!deps.isProduction) return null;
  try {
    return createPostgresLimiter(opts, deps.database());
  } catch {
    warnUnavailableOnce();
    return null;
  }
}

/**
 * Enforce a rate limit for `identifier` (typically a client IP).
 *
 * Limits are counted in Postgres (the `rate_limit_hit` function) and enforced in production
 * only. There, public submissions marked `requireAvailability` fail closed when the counter
 * cannot be reached; other callers fail open, including signed webhooks and status reads.
 *
 * Pass `deps.limiter` to inject a fake limiter in tests (or `null` to force the
 * unconfigured path), and `deps.database` to stand in for the Supabase service client.
 */
export async function enforceRateLimit(
  identifier: string,
  opts: RateLimitOptions,
  deps: {
    limiter?: RateLimiter | null;
    isProduction?: boolean;
    database?: () => RateLimitDatabase;
  } = {},
): Promise<RateLimitResult> {
  const isProduction = deps.isProduction ?? isProductionRuntime();
  const failClosed = opts.requireAvailability && isProduction;
  const limiter =
    deps.limiter !== undefined
      ? deps.limiter
      : getLimiter(opts, { isProduction, database: deps.database ?? serviceDatabase });
  if (!limiter) return failClosed ? { ok: false, unavailable: true } : { ok: true };

  try {
    const { success, limit, remaining, reset } = await limiter.limit(identifier);
    return { ok: success, limit, remaining, reset };
  } catch (error) {
    // The database error code, never the message: it may carry the user's data.
    console.error("Rate limit check failed", {
      failClosed: Boolean(failClosed),
      code: error instanceof RateLimitStoreError ? error.code : undefined,
    });
    return failClosed ? { ok: false, unavailable: true } : { ok: true };
  }
}

/** Seconds until the window resets, for a `Retry-After` header. */
export function retryAfterSeconds(result: RateLimitResult, now = Date.now()): number {
  if (!result.reset) return 60;
  return Math.max(1, Math.ceil((result.reset - now) / 1000));
}
