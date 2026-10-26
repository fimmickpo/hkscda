import { describe, expect, test } from "bun:test";
import { buildSignatureHeader, computeDigest } from "./payme-crypto.server";
import {
  PayMeNotificationError,
  parsePayMeNotification,
  processPayMeNotification,
} from "./payme-webhook.server";
import type { PayMeConfig } from "./config.server";
import type { ReconcileProviderArgs } from "./reconcile.server";

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

function parseSuccess(body: Record<string, unknown>) {
  const rawBody = JSON.stringify({ paymentRequestId: "pr1", statusCode: "PR005", ...body });
  return parsePayMeNotification({
    rawBody,
    headers: signedHeaders(rawBody, "payment.success"),
    signingKeyBase64: KEY,
    requestTarget: REQUEST_TARGET,
  });
}

describe("parsePayMeNotification", () => {
  test("parses a valid success notification with its settlement", () => {
    const action = parseSuccess({
      transactionId: "t1",
      totalAmount: "300.00",
      currencyCode: "HKD",
    });
    expect(action).toEqual({
      kind: "success",
      paymentRequestId: "pr1",
      statusCode: "PR005",
      transactionId: "t1",
      settlement: { amountCents: 30000, currency: "HKD" },
    });
  });

  test("reads totalAmount as the decimal string PayMe sends or as a number", () => {
    const cases: Array<[unknown, number]> = [
      ["102.30", 10230],
      ["11.5", 1150],
      ["300", 30000],
      [" 300.00 ", 30000],
      [102.3, 10230],
      [300, 30000],
      [0.07, 7],
    ];
    for (const [totalAmount, amountCents] of cases) {
      const action = parseSuccess({ totalAmount, currencyCode: "HKD" });
      expect(action).toMatchObject({ settlement: { amountCents, currency: "HKD" } });
    }
  });

  test("an amount that cannot be read exactly becomes a null settlement", () => {
    const unreadable: unknown[] = [
      null,
      "",
      "abc",
      "-5.00",
      "300.005",
      "1e3",
      "300,00",
      "0x10",
      true,
      {},
      [],
      -5,
      1e21,
    ];
    for (const totalAmount of unreadable) {
      const action = parseSuccess({ totalAmount, currencyCode: "HKD" });
      expect(action).toMatchObject({ settlement: { amountCents: null } });
    }
    expect(parseSuccess({ currencyCode: "HKD" })).toMatchObject({
      settlement: { amountCents: null },
    });
  });

  test("a missing or non-text currency becomes a null settlement currency", () => {
    expect(parseSuccess({ totalAmount: "300.00" })).toMatchObject({
      settlement: { amountCents: 30000, currency: null },
    });
    expect(parseSuccess({ totalAmount: "300.00", currencyCode: 344 })).toMatchObject({
      settlement: { currency: null },
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
  test("success routes to reconcile with a stable event id and the signed settlement", async () => {
    const rawBody = JSON.stringify({
      paymentRequestId: "pr1",
      statusCode: "PR005",
      transactionId: "t1",
      totalAmount: "300.00",
      currencyCode: "HKD",
    });
    let args: Partial<ReconcileProviderArgs> = {};
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
    expect(args.providerSettlement).toEqual({ amountCents: 30000, currency: "HKD" });
  });

  test("a success notification without a readable amount reaches reconcile as a null settlement", async () => {
    // Stripe and PayPal behave the same way: reconcile records a settlement mismatch and does
    // not credit the donation, rather than trusting a payload it cannot verify.
    const rawBody = JSON.stringify({ paymentRequestId: "pr1", statusCode: "PR005" });
    let args: Partial<ReconcileProviderArgs> = {};
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
    expect(args.providerSettlement).toEqual({ amountCents: null, currency: null });
  });

  test("failure routes to fail", async () => {
    const rawBody = JSON.stringify({ paymentRequestId: "pr1", statusCode: "PR004" });
    let failed: Partial<ReconcileProviderArgs> | null = null;
    await processPayMeNotification({
      rawBody,
      headers: signedHeaders(rawBody, "payment.failure"),
      requestTarget: REQUEST_TARGET,
      client: {} as never,
      config,
      reconcile: async () => ({}),
      fail: async (a) => {
        failed = a;
        return {};
      },
    });
    expect(failed).not.toBeNull();
    expect(failed).not.toHaveProperty("providerSettlement");
  });
});
