import { randomUUID } from "node:crypto";

import { getPayMeConfig, type PayMeConfig } from "./config.server";
import { buildSignatureHeader, computeDigest } from "./payme-crypto.server";

export type PayMeCreateBody = {
  totalAmount: number;
  currencyCode: "HKD";
  effectiveDuration: number;
  notificationUri: string;
  appSuccessCallback: string;
  appFailCallback: string;
  merchantData: { orderId: string; orderDescription: string };
};
export type PayMeCreateResponse = { paymentRequestId: string; webLink: string; appLink: string };
export type PayMeStatusResponse = {
  statusCode: string;
  statusDescription?: string;
  transactionId?: string;
};

// What cancelling a payment request achieved. PayMe answers a request it can no longer cancel with
// HTTP 400 and an error code, and each of those codes means something different to the donor.
export type PayMeCancelOutcome =
  | { kind: "cancelled" }
  // EB020 (already aborted) or EB007 (expired): nothing is left to pay.
  | { kind: "already_ended" }
  // EB021: the PayCode was already paid.
  | { kind: "paid" }
  // EB022: a payment on the PayCode is being processed right now.
  | { kind: "in_progress" };

export type PayMeClient = {
  getAccessToken(): Promise<string>;
  createPaymentRequest(body: PayMeCreateBody): Promise<PayMeCreateResponse>;
  getPaymentRequestStatus(paymentRequestId: string): Promise<PayMeStatusResponse>;
  cancelPaymentRequest(paymentRequestId: string): Promise<PayMeCancelOutcome>;
};

// PayMe reports failures as { message, errors: [{ errorCode, errorDescription }] }.
async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { errors?: Array<{ errorCode?: unknown }> };
    const code = body.errors?.[0]?.errorCode;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

// Module-scoped so the 60-minute token is reused across requests, not per client.
let cachedToken: { token: string; expiresAt: number } | null = null;
const TOKEN_TTL_MS = 55 * 60 * 1000; // refresh 5 min early

export function __resetPayMeTokenCacheForTests(): void {
  cachedToken = null;
}

export function createPayMeClient(
  deps: {
    config?: PayMeConfig;
    fetchImpl?: typeof fetch;
    now?: () => Date;
    newTraceId?: () => string;
  } = {},
): PayMeClient {
  const config = deps.config ?? getPayMeConfig();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const newTraceId = deps.newTraceId ?? (() => randomUUID());

  async function fetchToken(): Promise<string> {
    const res = await fetchImpl(`${config.apiBase}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "api-version": config.apiVersion,
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }).toString(),
    });
    if (!res.ok) throw new Error(`PayMe token request failed with ${res.status}`);
    const data = (await res.json()) as { accessToken?: string };
    if (!data.accessToken) throw new Error("PayMe token response missing accessToken");
    cachedToken = { token: data.accessToken, expiresAt: now().getTime() + TOKEN_TTL_MS };
    return data.accessToken;
  }

  async function getAccessToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > now().getTime()) return cachedToken.token;
    return fetchToken();
  }

  async function signedRequest(
    method: "POST" | "GET" | "PUT",
    path: string,
    rawBody: string | null,
  ): Promise<Response> {
    async function attempt(token: string): Promise<Response> {
      const requestDateTime = now().toISOString();
      const traceId = newTraceId();
      const headerValues: Record<string, string> = {
        "(request-target)": `${method.toLowerCase()} ${path}`,
        "api-version": config.apiVersion,
        "request-date-time": requestDateTime,
        "trace-id": traceId,
        authorization: `Bearer ${token}`,
      };
      const signedHeaders = [
        "(request-target)",
        "api-version",
        "request-date-time",
        "trace-id",
        "authorization",
      ];
      const headers: Record<string, string> = {
        accept: "application/json",
        "accept-language": "en-US",
        "api-version": config.apiVersion,
        "request-date-time": requestDateTime,
        "trace-id": traceId,
        authorization: `Bearer ${token}`,
      };
      if (rawBody !== null) {
        const digest = computeDigest(rawBody);
        headerValues.digest = digest;
        signedHeaders.push("digest");
        headers["content-type"] = "application/json";
        headers.digest = digest;
      }
      headers.signature = buildSignatureHeader({
        keyId: config.signingKeyId,
        signingKeyBase64: config.signingKeyBase64,
        signedHeaders,
        headerValues,
      });
      return fetchImpl(`${config.apiBase}${path}`, {
        method,
        headers,
        ...(rawBody !== null ? { body: rawBody } : {}),
      });
    }

    let res = await attempt(await getAccessToken());
    if (res.status === 401) {
      cachedToken = null;
      res = await attempt(await getAccessToken());
    }
    return res;
  }

  return {
    getAccessToken,
    async createPaymentRequest(body) {
      const rawBody = JSON.stringify(body);
      const res = await signedRequest("POST", "/payments/paymentrequests", rawBody);
      if (!res.ok) throw new Error(`PayMe create payment request failed with ${res.status}`);
      const data = (await res.json()) as Partial<PayMeCreateResponse>;
      if (!data.paymentRequestId || !data.webLink || !data.appLink) {
        throw new Error("PayMe create payment request response missing fields");
      }
      return {
        paymentRequestId: data.paymentRequestId,
        webLink: data.webLink,
        appLink: data.appLink,
      };
    },
    async getPaymentRequestStatus(paymentRequestId) {
      const path = `/payments/paymentrequests/${encodeURIComponent(paymentRequestId)}`;
      const res = await signedRequest("GET", path, null);
      if (!res.ok) throw new Error(`PayMe get status failed with ${res.status}`);
      const data = (await res.json()) as PayMeStatusResponse;
      if (!data.statusCode) throw new Error("PayMe status response missing statusCode");
      return data;
    },
    async cancelPaymentRequest(paymentRequestId) {
      const path = `/payments/paymentrequests/${encodeURIComponent(paymentRequestId)}/cancel`;
      const res = await signedRequest("PUT", path, null);
      if (res.ok) return { kind: "cancelled" };
      const code = await readErrorCode(res);
      if (code === "EB020" || code === "EB007") return { kind: "already_ended" };
      if (code === "EB021") return { kind: "paid" };
      if (code === "EB022") return { kind: "in_progress" };
      throw new Error(`PayMe cancel payment request failed with ${res.status}`);
    },
  };
}
