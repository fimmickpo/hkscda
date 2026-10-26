import { describe, expect, test } from "bun:test";
import { buildSignatureHeader, computeDigest } from "./payme-crypto.server";
import {
  PayMeNotificationError,
  parsePayMeNotification,
  processPayMeNotification,
} from "./payme-webhook.server";
import type { PayMeConfig } from "./config.server";

const KEY = Buffer.from("payme-signing-key").toString("base64");
const config = { signingKeyBase64: KEY } as unknown as PayMeConfig;
const REQUEST_TARGET = "post /api/webhooks/payme";

function signedHeaders(rawBody: string, eventType: string) {
  const digest = computeDigest(rawBody);
  const headerValues = {
    digest,
    "x-client-id": "11111111-1111-4111-8111-111111111111",
    "x-event-type": eventType,
    "(request-target)": REQUEST_TARGET,
  };
  const signature = buildSignatureHeader({
    keyId: "kid",
    signingKeyBase64: KEY,
    signedHeaders: ["digest", "x-client-id", "x-event-type", "(request-target)"],
    headerValues,
  });
  return new Headers({
    digest,
    "x-client-id": headerValues["x-client-id"],
    "x-event-type": eventType,
    signature,
    "content-type": "application/json",
  });
}

describe("parsePayMeNotification", () => {
  test("parses a valid success notification", () => {
    const rawBody = JSON.stringify({
      paymentRequestId: "pr1",
      statusCode: "PR005",
      transactionId: "t1",
    });
    const action = parsePayMeNotification({
      rawBody,
      headers: signedHeaders(rawBody, "payment.success"),
      signingKeyBase64: KEY,
      requestTarget: REQUEST_TARGET,
    });
    expect(action).toEqual({
      kind: "success",
      paymentRequestId: "pr1",
      statusCode: "PR005",
      transactionId: "t1",
    });
  });

  test("rejects a bad signature", () => {
    const rawBody = JSON.stringify({ paymentRequestId: "pr1", statusCode: "PR005" });
    const headers = signedHeaders(rawBody, "payment.success");
    headers.set(
      "signature",
      headers.get("signature")!.replace(/signature="[^"]*"/, 'signature="AAAA"'),
    );
    expect(() =>
      parsePayMeNotification({
        rawBody,
        headers,
        signingKeyBase64: KEY,
        requestTarget: REQUEST_TARGET,
      }),
    ).toThrow(PayMeNotificationError);
  });

  test("rejects a tampered body (digest mismatch)", () => {
    const rawBody = JSON.stringify({ paymentRequestId: "pr1", statusCode: "PR005" });
    const headers = signedHeaders(rawBody, "payment.success");
    expect(() =>
      parsePayMeNotification({
        rawBody: JSON.stringify({ paymentRequestId: "pr1", statusCode: "PR007" }),
        headers,
        signingKeyBase64: KEY,
        requestTarget: REQUEST_TARGET,
      }),
    ).toThrow(PayMeNotificationError);
  });
});

describe("processPayMeNotification", () => {
  test("success routes to reconcile with a stable event id", async () => {
    const rawBody = JSON.stringify({
      paymentRequestId: "pr1",
      statusCode: "PR005",
      transactionId: "t1",
    });
    let args: { providerEventId?: string; provider?: string } = {};
    await processPayMeNotification({
      rawBody,
      headers: signedHeaders(rawBody, "payment.success"),
      requestTarget: REQUEST_TARGET,
      client: {} as never,
      config,
      reconcile: async (a) => {
        args = a;
        return {};
      },
      fail: async () => ({}),
    });
    expect(args.provider).toBe("payme");
    expect(args.providerEventId).toBe("payme:pr1:PR005");
  });

  test("failure routes to fail", async () => {
    const rawBody = JSON.stringify({ paymentRequestId: "pr1", statusCode: "PR004" });
    let failed = false;
    await processPayMeNotification({
      rawBody,
      headers: signedHeaders(rawBody, "payment.failure"),
      requestTarget: REQUEST_TARGET,
      client: {} as never,
      config,
      reconcile: async () => ({}),
      fail: async () => {
        failed = true;
        return {};
      },
    });
    expect(failed).toBe(true);
  });
});
