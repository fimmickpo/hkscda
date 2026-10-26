import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { getPayMeConfigurationErrorField } from "../../../../lib/donations/config.server";
import { cancelPayMeDonation } from "../../../../lib/donations/payme-paycode.server";
import { createSupabaseServiceClient } from "../../../../lib/donations/supabase.server";
import {
  enforceRateLimit,
  getClientIp,
  retryAfterSeconds,
} from "../../../../lib/security/rate-limit.server";

const donationIdSchema = z.string().uuid();

type HandlerDependencies = {
  enforce?: typeof enforceRateLimit;
  cancel?: typeof cancelPayMeDonation;
  createClient?: typeof createSupabaseServiceClient;
};

function jsonNoStore(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

/**
 * The PayCode page's Cancel button. It acts on one pending PayMe payment, named by the donation id
 * only the donor holds, and PayMe has the last word on whether the PayCode can still be cancelled.
 * There is no form to attach a Turnstile token to, so the control is the rate limit, which fails
 * closed in production when it is unavailable, like every other public write.
 */
export async function handlePayCodeCancelRequest(
  request: Request,
  params: { donationId?: string },
  {
    enforce = enforceRateLimit,
    cancel = cancelPayMeDonation,
    createClient = createSupabaseServiceClient,
  }: HandlerDependencies = {},
) {
  const limit = await enforce(getClientIp(request), {
    prefix: "donation-cancel",
    max: 10,
    window: "1 m",
    requireAvailability: true,
  });
  if (limit.unavailable) {
    return jsonNoStore(
      { error: "Temporarily unavailable. Please try again later." },
      { status: 503, headers: { "retry-after": "60" } },
    );
  }
  if (!limit.ok) {
    return jsonNoStore(
      { error: "Too many requests. Please try again shortly." },
      { status: 429, headers: { "retry-after": String(retryAfterSeconds(limit)) } },
    );
  }

  const parsed = donationIdSchema.safeParse(params.donationId);
  if (!parsed.success) return jsonNoStore({ error: "Donation not found" }, { status: 404 });

  try {
    const result = await cancel({ donationId: parsed.data, client: createClient() });
    if (result.kind === "not_found") {
      return jsonNoStore({ error: "Donation not found" }, { status: 404 });
    }
    return jsonNoStore(result.body);
  } catch (error) {
    console.error("PayMe cancel failed", {
      configurationField: getPayMeConfigurationErrorField(error),
    });
    return jsonNoStore({ error: "The payment could not be cancelled" }, { status: 502 });
  }
}

export const Route = createFileRoute("/api/donations/$donationId/cancel")({
  server: {
    handlers: {
      POST: ({ request, params }) => handlePayCodeCancelRequest(request, params),
    },
  },
});
