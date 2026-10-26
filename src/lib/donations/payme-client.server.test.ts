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

  test("cancel sends a signed PUT with no body or digest", async () => {
    let seen: { method?: string; url: string; headers: Headers; body?: unknown } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/oauth2/token")) return jsonResponse({ accessToken: "tok-1" });
      seen = {
        method: init?.method,
        url: u,
        headers: new Headers(init?.headers),
        body: init?.body,
      };
      return jsonResponse({ paymentRequestId: "pr/1", statusCode: "PR004" });
    }) as unknown as typeof fetch;

    const client = createPayMeClient({
      config,
      fetchImpl,
      now: () => new Date("2026-09-25T00:00:00Z"),
      newTraceId: () => "trace-1",
    });
    const outcome = await client.cancelPaymentRequest("pr/1");

    expect(outcome).toEqual({ kind: "cancelled" });
    expect(seen!.method).toBe("PUT");
    expect(seen!.url).toBe(`${config.apiBase}/payments/paymentrequests/pr%2F1/cancel`);
    expect(seen!.body).toBeUndefined();
    expect(seen!.headers.get("digest")).toBeNull();
    expect(seen!.headers.get("authorization")).toBe("Bearer tok-1");
    // The signature covers the request target, so it must name the cancel path and the PUT verb.
    expect(seen!.headers.get("signature")).toContain(
      'headers="(request-target) api-version request-date-time trace-id authorization"',
    );
  });

  test("cancel maps PayMe's refusal codes to what the donor needs to know", async () => {
    const outcomes: Record<string, string> = {};
    for (const errorCode of ["EB020", "EB007", "EB021", "EB022"]) {
      const fetchImpl = (async (url: string | URL | Request) => {
        if (String(url).endsWith("/oauth2/token")) return jsonResponse({ accessToken: "tok-1" });
        return jsonResponse(
          { message: "refused", errors: [{ errorCode, errorDescription: "x" }] },
          400,
        );
      }) as unknown as typeof fetch;
      const client = createPayMeClient({ config, fetchImpl });
      outcomes[errorCode] = (await client.cancelPaymentRequest("pr1")).kind;
    }
    expect(outcomes).toEqual({
      EB020: "already_ended",
      EB007: "already_ended",
      EB021: "paid",
      EB022: "in_progress",
    });
  });

  test("cancel throws for any other failure, so the caller never reports a cancel that did not happen", async () => {
    const failures: Array<() => Response> = [
      () => jsonResponse({ errors: [{ errorCode: "EB008" }] }, 400),
      () => jsonResponse({ message: "boom" }, 500),
      () => new Response("not json", { status: 502 }),
    ];
    for (const failure of failures) {
      const fetchImpl = (async (url: string | URL | Request) => {
        if (String(url).endsWith("/oauth2/token")) return jsonResponse({ accessToken: "tok-1" });
        return failure();
      }) as unknown as typeof fetch;
      const client = createPayMeClient({ config, fetchImpl });
      await expect(client.cancelPaymentRequest("pr1")).rejects.toThrow("cancel payment request");
    }
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
