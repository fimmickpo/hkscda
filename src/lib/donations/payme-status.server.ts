import type { SupabaseClient } from "@supabase/supabase-js";

import { createPayMeClient, type PayMeClient } from "./payme-client.server";
import {
  failProviderPayment,
  reconcileProviderPayment,
  retrySucceededDonationSideEffects,
  type ReconcileProviderArgs,
} from "./reconcile.server";

type PayMePayment = {
  id: string;
  provider_ref: string | null;
  amount_cents: number;
  status: "pending" | "succeeded";
};

const SUCCESS_CODES = new Set(["PR005"]);
const FAILURE_CODES = new Set(["PR004", "PR007"]);

export async function refreshPendingPayMeDonation(args: {
  donationId: string;
  client: SupabaseClient;
  createClient?: () => Pick<PayMeClient, "getPaymentRequestStatus">;
  reconcile?: (a: ReconcileProviderArgs) => Promise<unknown>;
  fail?: (a: ReconcileProviderArgs) => Promise<unknown>;
  recoverSideEffects?: (client: SupabaseClient, paymentId: string) => Promise<unknown>;
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
  } = args;

  const { data, error } = await client
    .from("payment")
    .select("id,provider_ref,amount_cents,status")
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

  if (SUCCESS_CODES.has(statusCode)) {
    await reconcile(base);
    return { kind: "reconciled", statusCode };
  }
  if (FAILURE_CODES.has(statusCode)) {
    await fail(base);
    return { kind: "failed", statusCode };
  }
  return { kind: "pending", statusCode };
}
