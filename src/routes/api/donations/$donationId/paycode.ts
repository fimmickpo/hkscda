import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { getPayMeEffectiveDuration } from "../../../../lib/donations/config.server";
import { loadPayMePayCode } from "../../../../lib/donations/payme-paycode.server";
import { createSupabaseServiceClient } from "../../../../lib/donations/supabase.server";
import {
  enforceRateLimit,
  getClientIp,
  retryAfterSeconds,
} from "../../../../lib/security/rate-limit.server";

const donationIdSchema = z.string().uuid();

type HandlerDependencies = {
  enforce?: typeof enforceRateLimit;
  load?: typeof loadPayMePayCode;
  createClient?: typeof createSupabaseServiceClient;
  getDuration?: typeof getPayMeEffectiveDuration;
};

function jsonNoStore(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

/**
 * The PayCode page's one read: the link to turn into a QR code, the amount and the expiry for a
 * donation that is waiting on PayMe. The donation id is an unguessable UUID that only the donor
 * holds, the same way the public status route treats it, and the response is never cached.
 */
export async function handlePayCodeRequest(
  request: Request,
  params: { donationId?: string },
  {
    enforce = enforceRateLimit,
    load = loadPayMePayCode,
    createClient = createSupabaseServiceClient,
    getDuration = getPayMeEffectiveDuration,
  }: HandlerDependencies = {},
) {
  const limit = await enforce(getClientIp(request), {
    prefix: "donation-paycode",
    max: 20,
    window: "1 m",
  });
  if (!limit.ok) {
    return jsonNoStore(
      { error: "Too many requests. Please try again shortly." },
      { status: 429, headers: { "retry-after": String(retryAfterSeconds(limit)) } },
    );
  }

  const parsed = donationIdSchema.safeParse(params.donationId);
  if (!parsed.success) return jsonNoStore({ error: "Donation not found" }, { status: 404 });

  try {
    const result = await load({
      donationId: parsed.data,
      client: createClient(),
      effectiveDurationSeconds: getDuration(),
    });
    if (result.kind === "not_found") {
      return jsonNoStore({ error: "Donation not found" }, { status: 404 });
    }
    if (result.kind === "not_ready") {
      return jsonNoStore({ error: "The PayCode is not ready yet" }, { status: 409 });
    }
    return jsonNoStore(result.body);
  } catch {
    console.error("PayCode lookup failed");
    return jsonNoStore({ error: "Could not load the PayCode" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/donations/$donationId/paycode")({
  server: {
    handlers: {
      GET: ({ request, params }) => handlePayCodeRequest(request, params),
    },
  },
});
