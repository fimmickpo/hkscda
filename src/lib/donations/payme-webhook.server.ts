import type { SupabaseClient } from "@supabase/supabase-js";

import { getPayMeConfig, type PayMeConfig } from "./config.server";
import { computeDigest, verifySignatureHeader } from "./payme-crypto.server";
import { PAYME_TERMINAL_FAILURE_STATUS_CODES } from "./payme-status-codes";
import {
  failProviderPayment,
  reconcileProviderPayment,
  type ReconcileProviderArgs,
} from "./reconcile.server";

export class PayMeNotificationError extends Error {}

export type PayMeNotificationAction =
  | {
      kind: "success";
      paymentRequestId: string;
      statusCode: string;
      transactionId?: string;
      settlement: NonNullable<ReconcileProviderArgs["providerSettlement"]>;
    }
  | { kind: "failure"; paymentRequestId: string; statusCode: string }
  | { kind: "attempt_failed"; paymentRequestId: string; statusCode: string };

// PayMe documents totalAmount as a number, but its sample notifications send a decimal string
// ("102.30"), so accept both. Anything that is not a plain amount with at most two decimals
// becomes null, which reconcile treats as a settlement mismatch rather than crediting it.
function parsePayMeAmountCents(value: unknown): number | null {
  const text =
    typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function parsePayMeNotification(input: {
  rawBody: string;
  headers: Headers;
  signingKeyBase64: string;
  requestTarget: string;
}): PayMeNotificationAction {
  const digestHeader = input.headers.get("digest");
  const signatureHeader = input.headers.get("signature");
  const eventType = input.headers.get("x-event-type");
  const clientId = input.headers.get("x-client-id");
  if (!digestHeader || !signatureHeader || !eventType || !clientId) {
    throw new PayMeNotificationError("Missing PayMe notification headers");
  }
  if (computeDigest(input.rawBody) !== digestHeader) {
    throw new PayMeNotificationError("PayMe notification digest mismatch");
  }
  const ok = verifySignatureHeader({
    signatureHeader,
    signingKeyBase64: input.signingKeyBase64,
    headerValues: {
      digest: digestHeader,
      "x-client-id": clientId,
      "x-event-type": eventType,
      "(request-target)": input.requestTarget,
    },
  });
  if (!ok) throw new PayMeNotificationError("PayMe notification signature invalid");

  let body: {
    paymentRequestId?: string;
    statusCode?: string;
    transactionId?: string;
    totalAmount?: unknown;
    currencyCode?: unknown;
  };
  try {
    body = JSON.parse(input.rawBody);
  } catch {
    throw new PayMeNotificationError("PayMe notification body is not JSON");
  }
  if (!body.paymentRequestId || !body.statusCode) {
    throw new PayMeNotificationError("PayMe notification missing paymentRequestId/statusCode");
  }

  if (eventType === "payment.success") {
    return {
      kind: "success",
      paymentRequestId: body.paymentRequestId,
      statusCode: body.statusCode,
      transactionId: body.transactionId,
      settlement: {
        amountCents: parsePayMeAmountCents(body.totalAmount),
        currency: typeof body.currencyCode === "string" ? body.currencyCode : null,
      },
    };
  }
  if (eventType === "payment.failure") {
    const failed = { paymentRequestId: body.paymentRequestId, statusCode: body.statusCode };
    // A failure can report one payer's failed attempt while the request is still payable (HSBC's
    // sample is PR001 with a reasonCode). Only PR004 and PR007 mean the request itself has ended.
    return PAYME_TERMINAL_FAILURE_STATUS_CODES.has(body.statusCode)
      ? { kind: "failure", ...failed }
      : { kind: "attempt_failed", ...failed };
  }
  throw new PayMeNotificationError(`Unsupported PayMe event type: ${eventType}`);
}

export async function processPayMeNotification(input: {
  rawBody: string;
  headers: Headers;
  requestTarget: string;
  client: SupabaseClient;
  config?: PayMeConfig;
  reconcile?: (a: ReconcileProviderArgs) => Promise<unknown>;
  fail?: (a: ReconcileProviderArgs) => Promise<unknown>;
}): Promise<unknown> {
  const config = input.config ?? getPayMeConfig();
  const reconcile = input.reconcile ?? reconcileProviderPayment;
  const fail = input.fail ?? failProviderPayment;

  const action = parsePayMeNotification({
    rawBody: input.rawBody,
    headers: input.headers,
    signingKeyBase64: config.signingKeyBase64,
    requestTarget: input.requestTarget,
  });

  // Failing the payment would be final, so a failed attempt changes nothing: the payment stays
  // pending, and a later payment on the same PayCode, the status poll or an expiry settles it.
  if (action.kind === "attempt_failed") {
    return { kind: "pending" as const, statusCode: action.statusCode };
  }

  const base: ReconcileProviderArgs = {
    client: input.client,
    provider: "payme",
    providerRef: action.paymentRequestId,
    providerEventId: `payme:${action.paymentRequestId}:${action.statusCode}`,
    eventType: action.kind === "success" ? "payment.success" : "payment.failure",
    payload: { source: "webhook", ...action },
  };

  return action.kind === "success"
    ? reconcile({ ...base, providerSettlement: action.settlement })
    : fail(base);
}
