import type { SupabaseClient } from "@supabase/supabase-js";

import { getPayMeConfig, type PayMeConfig } from "./config.server";
import { computeDigest, verifySignatureHeader } from "./payme-crypto.server";
import {
  failProviderPayment,
  reconcileProviderPayment,
  type ReconcileProviderArgs,
} from "./reconcile.server";

export class PayMeNotificationError extends Error {}

export type PayMeNotificationAction =
  | { kind: "success"; paymentRequestId: string; statusCode: string; transactionId?: string }
  | { kind: "failure"; paymentRequestId: string; statusCode: string };

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

  let body: { paymentRequestId?: string; statusCode?: string; transactionId?: string };
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
    };
  }
  if (eventType === "payment.failure") {
    return {
      kind: "failure",
      paymentRequestId: body.paymentRequestId,
      statusCode: body.statusCode,
    };
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

  const base: ReconcileProviderArgs = {
    client: input.client,
    provider: "payme",
    providerRef: action.paymentRequestId,
    providerEventId: `payme:${action.paymentRequestId}:${action.statusCode}`,
    eventType: action.kind === "success" ? "payment.success" : "payment.failure",
    payload: { source: "webhook", ...action },
  };

  return action.kind === "success" ? reconcile(base) : fail(base);
}
