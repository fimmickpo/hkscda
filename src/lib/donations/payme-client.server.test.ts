import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetPayMeTokenCacheForTests,
  createPayMeClient,
  type PayMeCreateBody,
} from "./payme-client.server";
import type { PayMeConfig } from "./config.server";

const config: PayMeConfig = {
  apiBase: "https://sandbox.api.payme.hsbc.com.hk",
  apiVersion: "0.12",
  clientId: "cid",
  clientSecret: "secret",
  signingKeyId: "kid",
  signingKeyBase64: Buffer.from("signing-key").toString("base64"),
  effectiveDuration: 600,
};

const body: PayMeCreateBody = {
  totalAmount: 300,
  currencyCode: "HKD",
  effectiveDuration: 600,
  notificationUri: "https://app.test/api/webhooks/payme",
  appSuccessCallback: "https://app.test/donate?status=success&donation=d1",
  appFailCallback: "https://app.test/donate?status=cancelled&donation=d1",
  merchantData: { orderId: "d1", orderDescription: "HKSCDA donation" },
};

afterEach(() => __resetPayMeTokenCacheForTests());

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createPayMeClient", () => {
  test("fetches token once and reuses it across calls", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/oauth2/token")) return jsonResponse({ accessToken: "tok-1" });
      return jsonResponse({ paymentRequestId: "pr1", webLink: "https://w", appLink: "https://a" });
    }) as unknown as typeof fetch;

    const client = createPayMeClient({
      config,
      fetchImpl,
      now: () => new Date("2026-09-25T00:00:00Z"),
    });
    await client.createPaymentRequest(body);
    await client.createPaymentRequest(body);
    expect(calls.filter((u) => u.endsWith("/oauth2/token")).length).toBe(1);
  });

  test("create sends signed headers + digest and returns links", async () => {
    let createHeaders: Headers | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/oauth2/token")) return jsonResponse({ accessToken: "tok-1" });
      createHeaders = new Headers(init?.headers);
      return jsonResponse({ paymentRequestId: "pr1", webLink: "https://w", appLink: "https://a" });
    }) as unknown as typeof fetch;

    const client = createPayMeClient({
      config,
      fetchImpl,
      now: () => new Date("2026-09-25T00:00:00Z"),
      newTraceId: () => "trace-1",
    });
    const res = await client.createPaymentRequest(body);
    expect(res).toEqual({ paymentRequestId: "pr1", webLink: "https://w", appLink: "https://a" });
    expect(createHeaders!.get("api-version")).toBe("0.12");
    expect(createHeaders!.get("authorization")).toBe("Bearer tok-1");
    expect(createHeaders!.get("digest")!.startsWith("SHA-256=")).toBe(true);
    expect(createHeaders!.get("signature")).toContain('keyId="kid"');
    expect(createHeaders!.get("trace-id")).toBe("trace-1");
  });

  test("status GET omits digest and parses statusCode", async () => {
    let statusHeaders: Headers | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/oauth2/token")) return jsonResponse({ accessToken: "tok-1" });
      statusHeaders = new Headers(init?.headers);
      return jsonResponse({ statusCode: "PR005", transactionId: "t1" });
    }) as unknown as typeof fetch;

    const client = createPayMeClient({
      config,
      fetchImpl,
      now: () => new Date("2026-09-25T00:00:00Z"),
    });
    const res = await client.getPaymentRequestStatus("pr1");
    expect(res.statusCode).toBe("PR005");
    expect(res.transactionId).toBe("t1");
    expect(statusHeaders!.get("digest")).toBeNull();
    expect(statusHeaders!.get("signature")).toContain("headers=");
  });

  test("throws on non-2xx create", async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/oauth2/token")) return jsonResponse({ accessToken: "tok-1" });
      return jsonResponse({ message: "bad" }, 400);
    }) as unknown as typeof fetch;
    const client = createPayMeClient({ config, fetchImpl });
    await expect(client.createPaymentRequest(body)).rejects.toThrow();
  });
});
