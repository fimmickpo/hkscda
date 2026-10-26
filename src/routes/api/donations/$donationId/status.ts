import { createFileRoute } from "@tanstack/react-router";

import { loadPublicDonationStatus } from "../../../../lib/donations/publicStatus.server";
import { refreshPendingCodDonation } from "../../../../lib/donations/cod-status.server";
import { refreshPendingPayMeDonation } from "../../../../lib/donations/payme-status.server";
import {
  createSupabaseDonationStatusRepository,
  createSupabaseServiceClient,
} from "../../../../lib/donations/supabase.server";
import {
  enforceRateLimit,
  getClientIp,
  retryAfterSeconds,
} from "../../../../lib/security/rate-limit.server";

type HandlerContext = {
  params: {
    donationId?: string;
  };
};

function jsonNoStore(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

async function loadDonationStatus({ request, params }: HandlerContext & { request: Request }) {
  const limit = await enforceRateLimit(getClientIp(request), {
    prefix: "donation-status",
    max: 20,
    window: "1 m",
  });
  if (!limit.ok) {
    return jsonNoStore(
      { error: "Too many requests. Please try again shortly." },
      { status: 429, headers: { "retry-after": String(retryAfterSeconds(limit)) } },
    );
  }

  if (!params.donationId) return jsonNoStore({ error: "Donation not found" }, { status: 404 });

  try {
    const client = createSupabaseServiceClient();
    const result = await loadPublicDonationStatus({
      donationId: params.donationId,
      repository: createSupabaseDonationStatusRepository(client, {
        refreshPendingCod: (donationId) => refreshPendingCodDonation({ donationId, client }),
        refreshPendingPayMe: (donationId) => refreshPendingPayMeDonation({ donationId, client }),
      }),
    });
    if (!result) return jsonNoStore({ error: "Donation not found" }, { status: 404 });
    return jsonNoStore(result);
  } catch (error) {
    console.error(error);
    return jsonNoStore({ error: "Could not load donation status" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/donations/$donationId/status")({
  server: {
    handlers: {
      GET: ({ request, params }) => loadDonationStatus({ request, params }),
    },
  },
});
