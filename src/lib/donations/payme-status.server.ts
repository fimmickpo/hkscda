import type { SupabaseClient } from "@supabase/supabase-js";

import { createPayMeClient, type PayMeClient } from "./payme-client.server";
import {
  PAYME_SUCCESS_STATUS_CODES,
  PAYME_TERMINAL_FAILURE_STATUS_CODES,
} from "./payme-status-codes";
import {
  failProviderPayment,
  reconcileProviderPayment,
  retrySucceededDonationSideEffects,
  type ReconcileProviderArgs,
} from "./reconcile.server";
import { enforceRateLimit } from "../security/rate-limit.server";

type PayMePayment = {
  id: string;
  provider_ref: string | null;
  amount_cents: number;
  status: "pending" | "succeeded";
  created_at: string;
};

// HSBC treats the webhook as the primary signal: getPaymentRequest is for when no notification has
// arrived within 60 seconds of creating the request, and no more than once every 10 seconds.
export const PAYME_POLL_AFTER_MS = 60_000;

async function allowStatusCall(paymentId: string): Promise<boolean> {
  const limit = await enforceRateLimit(paymentId, {
    prefix: "payme-status-refresh",
    max: 1,
    window: "10 s",
  });
  return limit.ok;
}

export async function refreshPendingPayMeDonation(args: {
  donationId: string;
  client: SupabaseClient;
  createClient?: () => Pick<PayMeClient, "getPaymentRequestStatus">;
  reconcile?: (a: ReconcileProviderArgs) => Promise<unknown>;
  fail?: (a: ReconcileProviderArgs) => Promise<unknown>;
  recoverSideEffects?: (client: SupabaseClient, paymentId: string) => Promise<unknown>;
  now?: () => Date;
  pollAfterMs?: number;
  allowCall?: (paymentId: string) => Promise<boolean>;
}): Promise<{
  kind: "not_applicable" | "pending" | "reconciled" | "failed" | "recovered";
  statusCode?: string;
}> {
  const {
    donationId,
    client,
    createClient = () => createPayMeClient(),
    reconcile = reconcileProviderPayment,
    fail = failProviderPayment,
    recoverSideEffects = retrySucceededDonationSideEffects,
    now = () => new Date(),
    pollAfterMs = PAYME_POLL_AFTER_MS,
    allowCall = allowStatusCall,
  } = args;

  const { data, error } = await client
    .from("payment")
    .select("id,provider_ref,amount_cents,status,created_at")
    .eq("donation_id", donationId)
    .eq("provider", "payme")
    .in("status", ["pending", "succeeded"])
    .maybeSingle<PayMePayment>();
  if (error) throw error;
  if (!data) return { kind: "not_applicable" };

  if (data.status === "succeeded") {
    await recoverSideEffects(client, data.id);
    return { kind: "recovered" };
  }
  if (!data.provider_ref) return { kind: "not_applicable" };

  if (now().getTime() - Date.parse(data.created_at) < pollAfterMs) {
    return { kind: "pending", statusCode: "awaiting_notification" };
  }
  if (!(await allowCall(data.id))) return { kind: "pending", statusCode: "throttled" };

  let statusCode: string;
  let transactionId: string | undefined;
  try {
    const res = await createClient().getPaymentRequestStatus(data.provider_ref);
    statusCode = res.statusCode;
    transactionId = res.transactionId;
  } catch {
    return { kind: "pending", statusCode: "unavailable" };
  }

  const base: ReconcileProviderArgs = {
    client,
    provider: "payme",
    providerRef: data.provider_ref,
    providerEventId: `payme:refresh:${data.provider_ref}:${statusCode}`,
    eventType: `status_refresh.${statusCode}`,
    payload: { source: "status_refresh", statusCode, transactionId },
  };

  if (PAYME_SUCCESS_STATUS_CODES.has(statusCode)) {
    await reconcile(base);
    return { kind: "reconciled", statusCode };
  }
  if (PAYME_TERMINAL_FAILURE_STATUS_CODES.has(statusCode)) {
    await fail(base);
    return { kind: "failed", statusCode };
  }
  return { kind: "pending", statusCode };
}
