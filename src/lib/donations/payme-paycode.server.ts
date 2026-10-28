import type { SupabaseClient } from "@supabase/supabase-js";

import { createPayMeClient, type PayMeClient } from "./payme-client.server";
import type { CancelResponse, PayCodeLanguage, PayCodeResponse } from "./payme-paycode";
import { failProviderPayment, type ReconcileProviderArgs } from "./reconcile.server";

type PayMePaymentRow = {
  id: string;
  status: "pending" | "succeeded" | "failed" | "refunded";
  provider_ref: string | null;
  amount_cents: number;
  checkout_url: string | null;
  created_at: string;
  donation: { contact_language: string | null } | null;
};

async function findPayMePayment(
  client: SupabaseClient,
  donationId: string,
): Promise<PayMePaymentRow | null> {
  const { data, error } = await client
    .from("payment")
    .select(
      "id,status,provider_ref,amount_cents,checkout_url,created_at,donation:donation_id(contact_language)",
    )
    .eq("donation_id", donationId)
    .eq("provider", "payme")
    .maybeSingle<PayMePaymentRow>();
  if (error) throw error;
  return data;
}

function languageOf(payment: PayMePaymentRow): PayCodeLanguage {
  return payment.donation?.contact_language === "en" ? "en" : "zh-HK";
}

export type LoadPayCodeResult =
  | { kind: "ok"; body: PayCodeResponse }
  | { kind: "not_found" }
  | { kind: "not_ready" };

/**
 * What the PayCode page needs to draw itself: the link to encode, the amount and when PayMe stops
 * accepting it. A payment that is no longer pending returns only its status, so the page can show
 * the outcome instead of a code nobody can pay.
 *
 * The expiry is the payment row's creation time plus the configured PayCode lifetime. The row is
 * written just before the request goes to PayMe, so this runs a moment earlier than PayMe's own
 * clock: the page stops showing the code slightly too soon, never too late.
 */
export async function loadPayMePayCode(args: {
  donationId: string;
  client: SupabaseClient;
  effectiveDurationSeconds: number;
  now?: () => Date;
}): Promise<LoadPayCodeResult> {
  const { donationId, client, effectiveDurationSeconds, now = () => new Date() } = args;

  const payment = await findPayMePayment(client, donationId);
  if (!payment) return { kind: "not_found" };

  const language = languageOf(payment);
  if (payment.status !== "pending") {
    return { kind: "ok", body: { status: payment.status, language } };
  }
  if (!payment.checkout_url) return { kind: "not_ready" };

  const expiresAt = new Date(Date.parse(payment.created_at) + effectiveDurationSeconds * 1000);
  return {
    kind: "ok",
    body: {
      status: "pending",
      webLink: payment.checkout_url,
      amountCents: payment.amount_cents,
      currency: "HKD",
      expiresAt: expiresAt.toISOString(),
      serverNow: now().toISOString(),
      language,
    },
  };
}

export type CancelPayMeResult = { kind: "ok"; body: CancelResponse } | { kind: "not_found" };

/**
 * Cancel the PayCode the donor is looking at. PayMe is asked first, and the payment is only failed
 * once PayMe has confirmed that nothing more can be paid: if the donor paid in the same moment, or a
 * payment is being processed, the PayCode stays payable and the page keeps waiting for the outcome.
 * A PayMe error propagates, so we never tell the donor "cancelled" for a PayCode that is still live.
 */
export async function cancelPayMeDonation(args: {
  donationId: string;
  client: SupabaseClient;
  createClient?: () => Pick<PayMeClient, "cancelPaymentRequest">;
  fail?: (a: ReconcileProviderArgs) => Promise<unknown>;
}): Promise<CancelPayMeResult> {
  const {
    donationId,
    client,
    createClient = () => createPayMeClient(),
    fail = failProviderPayment,
  } = args;

  const payment = await findPayMePayment(client, donationId);
  if (!payment) return { kind: "not_found" };

  if (payment.status === "succeeded") return { kind: "ok", body: { status: "paid" } };
  if (payment.status !== "pending") return { kind: "ok", body: { status: "cancelled" } };
  if (!payment.provider_ref) return { kind: "not_found" };

  const outcome = await createClient().cancelPaymentRequest(payment.provider_ref);
  if (outcome.kind === "paid") return { kind: "ok", body: { status: "paid" } };
  if (outcome.kind === "in_progress") return { kind: "ok", body: { status: "in_progress" } };

  const result = (await fail({
    client,
    provider: "payme",
    providerRef: payment.provider_ref,
    providerEventId: `payme:cancel:${payment.provider_ref}`,
    eventType: "payment.cancelled",
    payload: { source: "cancel", outcome: outcome.kind },
  })) as { kind?: string } | null;

  // "duplicate" is a second click on the same cancel. Anything else means the payment was not
  // pending after all (it succeeded, or needs review), so the donor should not be told it is gone.
  const cancelled = result?.kind === "failed" || result?.kind === "duplicate";
  return { kind: "ok", body: { status: cancelled ? "cancelled" : "in_progress" } };
}
