# PayMe Donation Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HSBC PayMe for Business as a live, API-integrated online donation gateway (OAuth token → signed create-payment-request → PayCode/deep-link → webhook + poll → reconcile), and enable the public donate form for PayMe + manual FPS.

**Architecture:** Mirror the existing COD/AlipayHK gateway cluster in `src/lib/donations/`. A new `payme-*.server.ts` set (crypto, client, provider, status, webhook) plugs into the existing `PaymentProviders` provider seam, the existing `reconcileProviderPayment`/`failProviderPayment` idempotency pipeline (receipts + email + audit), and the existing `/api/donations/$id/status` poll endpoint. The service returns a new `kind:"payme"` checkout result carrying `paymentRequestId`, `webLink`, `appLink`; the frontend shows a desktop iframe modal or a mobile `appLink` redirect.

**Tech Stack:** TypeScript 5 (strict, no `any`), TanStack Start (React 19 + Router + Nitro), Supabase Postgres, Bun + `bun:test`, Node `crypto` for HMAC/SHA-256, zod.

**Spec:** `docs/superpowers/specs/2026-09-25-payme-donation-gateway-design.md`

## Global Constraints

- Language: TypeScript strict; hand-written code has zero `any`.
- Runtime/test/package manager: Bun. Tests: `bun test`. Typecheck: `bunx tsc --noEmit` (build does NOT typecheck — run before pushing). Lint: `bun run lint`. Format: `bun run format`.
- Server-only code uses the `.server.ts` suffix; secrets and the service-role client never reach the client bundle. `import.meta.env.VITE_*` is public.
- Non-route files inside `src/routes/` use the `-name.ts` prefix; `routeTree.gen.ts` is generated — never edit.
- Public POST endpoints for user-submitted forms are rate-limited + Turnstile-verified. Browser-native/server-to-server automated payloads (webhooks) are rate-limited + signature-verified only (no Turnstile) — consistent with `/api/csp-report` and the COD webhook.
- Never trust `x-forwarded-for[0]`; use `getClientIp()`.
- Admin/payment mutations write an `audit_log` row — reused automatically via the existing reconcile pipeline.
- Every table has RLS; every `security definer` function pins `search_path`. This plan's only migration is plain `UPDATE`s (no new function), so no `search_path` concern; `supabaseMigrations.test.ts` still runs.
- CSS: use `var(--color-*)` tokens from `src/styles.css`; never hardcode colours. zh-HK is primary; copy is compassionate, factual, collective; Noto Sans HK typeface.
- Commits: Conventional Commits. **Note:** this workspace reports `git: false` — if `git` is unavailable, perform the "Commit" steps only where a repo exists; otherwise treat each Commit step as a checkpoint boundary (stage/record equivalently) and continue.
- Amounts are stored as integer `amount_cents`; PayMe `totalAmount` is HKD dollars as a number with 2 decimals: `Number((amountCents / 100).toFixed(2))`.

---

## File Structure

**Create:**

- `src/lib/donations/payme-crypto.server.ts` — pure digest + HTTP-message-signature build/verify.
- `src/lib/donations/payme-crypto.server.test.ts`
- `src/lib/donations/payme-client.server.ts` — token cache + create + get-status HTTP client (injectable `fetch`/`now`).
- `src/lib/donations/payme-client.server.test.ts`
- `src/lib/donations/payme-provider.server.ts` — `createPayMeCheckout` (provider seam).
- `src/lib/donations/payme-provider.server.test.ts`
- `src/lib/donations/payme-status.server.ts` — `refreshPendingPayMeDonation` (poll backstop).
- `src/lib/donations/payme-status.server.test.ts`
- `src/lib/donations/payme-webhook.server.ts` — parse + verify + process notification.
- `src/lib/donations/payme-webhook.server.test.ts`
- `src/routes/api/webhooks/payme.ts` — webhook route.
- `src/routes/api/webhooks/-payme.test.ts` — webhook route test.
- `src/components/site/PayMePayCodeModal.tsx` — desktop iframe modal.
- `supabase/migrations/20260925120000_payme_go_live_public_config.sql` — public-config visibility.

**Modify:**

- `src/lib/donations/config.server.ts` — add `getPayMeConfig()` + `getPayMeConfigurationErrorField()`.
- `src/lib/donations/contracts.ts` — widen `OnlinePaymentProvider` to include `"payme"`.
- `src/lib/donations/service.ts` — `PaymentProviders.createPayMeCheckout`, `CreateDonationResult` `kind:"payme"`, split `fps|payme` branch.
- `src/lib/donations/providers.server.ts` — add `createPayMeCheckout` to `createPaymentProviders()`.
- `src/lib/donations/service.test.ts` — cover the `payme` branch.
- `src/lib/donations/publicStatus.server.ts` — add `refreshPendingPayMe?` to repository type + call it best-effort.
- `src/lib/donations/supabase.server.ts` — `createSupabaseDonationStatusRepository` forwards `refreshPendingPayMe`.
- `src/routes/api/donations/$donationId/status.ts` — inject `refreshPendingPayMe`.
- `src/routes/donate.tsx` — `PayMeResult` type + `kind:"payme"` handling.
- `src/routes/donate.test.tsx` — cover PayMe desktop + mobile branches.
- `.env.example` (if present) — document `PAYME_*`, `APP_URL`, `VITE_PUBLIC_DONATION_CHECKOUT_ENABLED`.

---

## Task 1: PayMe configuration

**Files:**

- Modify: `src/lib/donations/config.server.ts`
- Test: `src/lib/donations/config.server.test.ts` (create if absent; otherwise append)

**Interfaces:**

- Consumes: `required(name)` (already in `config.server.ts`).
- Produces:

  ```ts
  export interface PayMeConfig {
    apiBase: string; // no trailing slash
    apiVersion: string; // "0.12"
    clientId: string;
    clientSecret: string;
    signingKeyId: string;
    signingKeyBase64: string;
    effectiveDuration: number; // seconds, >= 15
  }
  export function getPayMeConfig(): PayMeConfig;
  export function getPayMeConfigurationErrorField(error: unknown): string | null;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/donations/config.server.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { getPayMeConfig, getPayMeConfigurationErrorField } from "./config.server";

const KEYS = [
  "PAYME_API_BASE",
  "PAYME_API_VERSION",
  "PAYME_CLIENT_ID",
  "PAYME_CLIENT_SECRET",
  "PAYME_SIGNING_KEY_ID",
  "PAYME_SIGNING_KEY",
  "PAYME_EFFECTIVE_DURATION",
];
function clear() {
  for (const k of KEYS) delete process.env[k];
}
afterEach(clear);

describe("getPayMeConfig", () => {
  test("reads env with sandbox + 0.12 + 600 defaults", () => {
    process.env.PAYME_CLIENT_ID = "cid";
    process.env.PAYME_CLIENT_SECRET = "secret";
    process.env.PAYME_SIGNING_KEY_ID = "kid";
    process.env.PAYME_SIGNING_KEY = "c2lnbmluZ2tleQ==";
    const cfg = getPayMeConfig();
    expect(cfg.apiBase).toBe("https://sandbox.api.payme.hsbc.com.hk");
    expect(cfg.apiVersion).toBe("0.12");
    expect(cfg.effectiveDuration).toBe(600);
    expect(cfg.clientId).toBe("cid");
  });

  test("throws on missing client id and reports the field", () => {
    process.env.PAYME_CLIENT_SECRET = "secret";
    process.env.PAYME_SIGNING_KEY_ID = "kid";
    process.env.PAYME_SIGNING_KEY = "c2lnbmluZ2tleQ==";
    let error: unknown;
    try {
      getPayMeConfig();
    } catch (e) {
      error = e;
    }
    expect(getPayMeConfigurationErrorField(error)).toBe("PAYME_CLIENT_ID");
  });

  test("rejects effectiveDuration below 15", () => {
    process.env.PAYME_CLIENT_ID = "cid";
    process.env.PAYME_CLIENT_SECRET = "secret";
    process.env.PAYME_SIGNING_KEY_ID = "kid";
    process.env.PAYME_SIGNING_KEY = "c2lnbmluZ2tleQ==";
    process.env.PAYME_EFFECTIVE_DURATION = "5";
    expect(() => getPayMeConfig()).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/donations/config.server.test.ts`
Expected: FAIL — `getPayMeConfig is not a function` (export missing).

- [ ] **Step 3: Add the implementation to `config.server.ts`**

```ts
export interface PayMeConfig {
  apiBase: string;
  apiVersion: string;
  clientId: string;
  clientSecret: string;
  signingKeyId: string;
  signingKeyBase64: string;
  effectiveDuration: number;
}

export function getPayMeConfig(): PayMeConfig {
  const rawDuration = process.env.PAYME_EFFECTIVE_DURATION;
  const effectiveDuration = rawDuration ? Number(rawDuration) : 600;
  if (!Number.isInteger(effectiveDuration) || effectiveDuration < 15) {
    throw new Error("PAYME_EFFECTIVE_DURATION must be an integer >= 15");
  }
  return {
    apiBase: (process.env.PAYME_API_BASE ?? "https://sandbox.api.payme.hsbc.com.hk").replace(
      /\/+$/,
      "",
    ),
    apiVersion: process.env.PAYME_API_VERSION ?? "0.12",
    clientId: required("PAYME_CLIENT_ID"),
    clientSecret: required("PAYME_CLIENT_SECRET"),
    signingKeyId: required("PAYME_SIGNING_KEY_ID"),
    signingKeyBase64: required("PAYME_SIGNING_KEY"),
    effectiveDuration,
  };
}

/** Only allowlisted field names may leave a failed configuration check. */
export function getPayMeConfigurationErrorField(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const fields = [
    "PAYME_CLIENT_ID",
    "PAYME_CLIENT_SECRET",
    "PAYME_SIGNING_KEY_ID",
    "PAYME_SIGNING_KEY",
  ];
  for (const field of fields) {
    if (error.message === `Missing required environment variable: ${field}`) return field;
  }
  if (error.message === "PAYME_EFFECTIVE_DURATION must be an integer >= 15") {
    return "PAYME_EFFECTIVE_DURATION";
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/donations/config.server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/donations/config.server.ts src/lib/donations/config.server.test.ts
git commit -m "feat(donations): add PayMe gateway configuration"
```

---

## Task 2: PayMe crypto (digest + HTTP message signature)

**Files:**

- Create: `src/lib/donations/payme-crypto.server.ts`
- Test: `src/lib/donations/payme-crypto.server.test.ts`

**Interfaces:**

- Consumes: Node `node:crypto`.
- Produces:
  ```ts
  export function computeDigest(rawBody: string): string; // "SHA-256=<base64>"
  export function buildSignatureHeader(input: {
    keyId: string;
    signingKeyBase64: string;
    signedHeaders: string[]; // lowercase names, in signing order
    headerValues: Record<string, string>; // lowercase name -> value
  }): string; // 'keyId="…",algorithm="hmac-sha256",headers="…",signature="…"'
  export function verifySignatureHeader(input: {
    signatureHeader: string;
    signingKeyBase64: string;
    headerValues: Record<string, string>; // must contain every name listed in the header's headers=""
  }): boolean; // timing-safe
  ```
- Signing base: for each name in `signedHeaders`, one line `` `${name}: ${headerValues[name]}` ``, joined with `"\n"`. HMAC-SHA256 with `base64-decode(signingKeyBase64)` as key; signature is base64. (Matches the PayMe Postman `computeHttpSignature`.)

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/donations/payme-crypto.server.test.ts
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { buildSignatureHeader, computeDigest, verifySignatureHeader } from "./payme-crypto.server";

const KEY = Buffer.from("payme-signing-key").toString("base64");

describe("computeDigest", () => {
  test("produces SHA-256=<base64> of the body", () => {
    // Known vector from HSBC docs for the string 'hello' is not given; assert format + stability.
    const d = computeDigest('{"totalAmount":3}');
    expect(d.startsWith("SHA-256=")).toBe(true);
    expect(computeDigest('{"totalAmount":3}')).toBe(d);
    expect(computeDigest("other")).not.toBe(d);
  });
});

describe("signature", () => {
  const headerValues = {
    "(request-target)": "post /payments/paymentrequests",
    "api-version": "0.12",
    "request-date-time": "2026-09-25T00:00:00.000Z",
    "trace-id": "11111111-1111-4111-8111-111111111111",
    authorization: "Bearer token",
    digest: "SHA-256=abc",
  };
  const signedHeaders = [
    "(request-target)",
    "api-version",
    "request-date-time",
    "trace-id",
    "authorization",
    "digest",
  ];

  test("builds a header whose signature matches an independent HMAC", () => {
    const header = buildSignatureHeader({
      keyId: "kid",
      signingKeyBase64: KEY,
      signedHeaders,
      headerValues,
    });
    expect(header).toContain('keyId="kid"');
    expect(header).toContain('algorithm="hmac-sha256"');
    expect(header).toContain(
      'headers="(request-target) api-version request-date-time trace-id authorization digest"',
    );

    const base = signedHeaders
      .map((h) => `${h}: ${headerValues[h as keyof typeof headerValues]}`)
      .join("\n");
    const expected = createHmac("sha256", Buffer.from(KEY, "base64")).update(base).digest("base64");
    expect(header).toContain(`signature="${expected}"`);
  });

  test("verifies a header it built", () => {
    const header = buildSignatureHeader({
      keyId: "kid",
      signingKeyBase64: KEY,
      signedHeaders,
      headerValues,
    });
    expect(
      verifySignatureHeader({ signatureHeader: header, signingKeyBase64: KEY, headerValues }),
    ).toBe(true);
  });

  test("rejects a tampered value", () => {
    const header = buildSignatureHeader({
      keyId: "kid",
      signingKeyBase64: KEY,
      signedHeaders,
      headerValues,
    });
    const tampered = { ...headerValues, digest: "SHA-256=DIFFERENT" };
    expect(
      verifySignatureHeader({
        signatureHeader: header,
        signingKeyBase64: KEY,
        headerValues: tampered,
      }),
    ).toBe(false);
  });

  test("rejects a wrong key", () => {
    const header = buildSignatureHeader({
      keyId: "kid",
      signingKeyBase64: KEY,
      signedHeaders,
      headerValues,
    });
    const otherKey = Buffer.from("other-key").toString("base64");
    expect(
      verifySignatureHeader({ signatureHeader: header, signingKeyBase64: otherKey, headerValues }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/donations/payme-crypto.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/donations/payme-crypto.server.ts
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function computeDigest(rawBody: string): string {
  const hash = createHash("sha256").update(rawBody, "utf8").digest("base64");
  return `SHA-256=${hash}`;
}

function signingBase(signedHeaders: string[], headerValues: Record<string, string>): string {
  return signedHeaders
    .map((name) => {
      const value = headerValues[name];
      if (value === undefined) throw new Error(`Missing value for signed header: ${name}`);
      return `${name}: ${value}`;
    })
    .join("\n");
}

function sign(signingKeyBase64: string, base: string): string {
  return createHmac("sha256", Buffer.from(signingKeyBase64, "base64"))
    .update(base, "utf8")
    .digest("base64");
}

export function buildSignatureHeader(input: {
  keyId: string;
  signingKeyBase64: string;
  signedHeaders: string[];
  headerValues: Record<string, string>;
}): string {
  const signature = sign(
    input.signingKeyBase64,
    signingBase(input.signedHeaders, input.headerValues),
  );
  const headers = input.signedHeaders.join(" ");
  return `keyId="${input.keyId}",algorithm="hmac-sha256",headers="${headers}",signature="${signature}"`;
}

function parseSignatureHeader(header: string): { headers: string[]; signature: string } | null {
  const headersMatch = header.match(/headers="([^"]*)"/);
  const signatureMatch = header.match(/signature="([^"]*)"/);
  if (!headersMatch || !signatureMatch) return null;
  return { headers: headersMatch[1].split(/\s+/).filter(Boolean), signature: signatureMatch[1] };
}

export function verifySignatureHeader(input: {
  signatureHeader: string;
  signingKeyBase64: string;
  headerValues: Record<string, string>;
}): boolean {
  const parsed = parseSignatureHeader(input.signatureHeader);
  if (!parsed) return false;
  let expected: string;
  try {
    expected = sign(input.signingKeyBase64, signingBase(parsed.headers, input.headerValues));
  } catch {
    return false;
  }
  const a = Buffer.from(parsed.signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/donations/payme-crypto.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/donations/payme-crypto.server.ts src/lib/donations/payme-crypto.server.test.ts
git commit -m "feat(donations): add PayMe digest + HTTP message signature"
```

---

## Task 3: PayMe HTTP client (token cache + create + status)

**Files:**

- Create: `src/lib/donations/payme-client.server.ts`
- Test: `src/lib/donations/payme-client.server.test.ts`

**Interfaces:**

- Consumes: `getPayMeConfig` (Task 1); `computeDigest`, `buildSignatureHeader` (Task 2).
- Produces:
  ```ts
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
  export type PayMeClient = {
    getAccessToken(): Promise<string>;
    createPaymentRequest(body: PayMeCreateBody): Promise<PayMeCreateResponse>;
    getPaymentRequestStatus(paymentRequestId: string): Promise<PayMeStatusResponse>;
  };
  export function createPayMeClient(deps?: {
    config?: PayMeConfig;
    fetchImpl?: typeof fetch;
    now?: () => Date;
    newTraceId?: () => string;
  }): PayMeClient;
  export function __resetPayMeTokenCacheForTests(): void;
  ```
- Token is cached at module scope and reused until ~55 min after issue (refresh early). On a `401` from a payment call, refresh the token once and retry.
- Signed headers — create: `["(request-target)","api-version","request-date-time","trace-id","authorization","digest"]`; status: same **without** `"digest"`. `(request-target)` = `` `${method} ${path}` `` lowercase, e.g. `post /payments/paymentrequests`, `get /payments/paymentrequests/<id>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/donations/payme-client.server.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/donations/payme-client.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/donations/payme-client.server.ts
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

export type PayMeClient = {
  getAccessToken(): Promise<string>;
  createPaymentRequest(body: PayMeCreateBody): Promise<PayMeCreateResponse>;
  getPaymentRequestStatus(paymentRequestId: string): Promise<PayMeStatusResponse>;
};

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
    method: "POST" | "GET",
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
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/donations/payme-client.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/donations/payme-client.server.ts src/lib/donations/payme-client.server.test.ts
git commit -m "feat(donations): add PayMe API client with token cache"
```

---

## Task 4: Widen `OnlinePaymentProvider` to include `payme`

**Files:**

- Modify: `src/lib/donations/contracts.ts`
- Test: `src/lib/donations/domain.test.ts` (append a type-level assertion test)

**Interfaces:**

- Produces: `OnlinePaymentProvider = "stripe" | "paypal" | "cod" | "payme"`. Required by `reconcileProviderPayment`/`failProviderPayment` (Task 7 & 9) and by `refreshPendingPayMeDonation`.

- [ ] **Step 1: Locate the current definition**

Run: `grep -n "OnlinePaymentProvider" src/lib/donations/contracts.ts`
Expected: a line like `export type OnlinePaymentProvider = "stripe" | "paypal" | "cod";`

- [ ] **Step 2: Write the failing test**

```ts
// append to src/lib/donations/domain.test.ts
import { test, expect } from "bun:test";
import type { OnlinePaymentProvider } from "./contracts";

test("payme is a valid online payment provider", () => {
  const provider: OnlinePaymentProvider = "payme";
  expect(provider).toBe("payme");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bunx tsc --noEmit`
Expected: FAIL — `Type '"payme"' is not assignable to type 'OnlinePaymentProvider'`.

- [ ] **Step 4: Widen the type**

In `src/lib/donations/contracts.ts`, change the `OnlinePaymentProvider` union to:

```ts
export type OnlinePaymentProvider = "stripe" | "paypal" | "cod" | "payme";
```

- [ ] **Step 5: Verify**

Run: `bunx tsc --noEmit && bun test src/lib/donations/domain.test.ts`
Expected: typecheck clean; test PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/donations/contracts.ts src/lib/donations/domain.test.ts
git commit -m "feat(donations): allow payme as an online payment provider"
```

---

## Task 5: PayMe provider (`createPayMeCheckout`)

**Files:**

- Create: `src/lib/donations/payme-provider.server.ts`
- Test: `src/lib/donations/payme-provider.server.test.ts`

**Interfaces:**

- Consumes: `createPayMeClient` (Task 3), `getPayMeConfig` (Task 1), `getAppUrl` (`src/lib/appUrl.server.ts` → `getAppUrl(): string`), `CheckoutProviderInput` (from `service.ts`: `{ donationId, paymentId, amountCents, donorEmail, purpose, checkoutExperience }`).
- Produces:

  ```ts
  export type PayMeCheckoutResult = { providerRef: string; webLink: string; appLink: string };
  export async function createPayMeCheckout(
    input: CheckoutProviderInput,
    deps?: { client?: PayMeClient; config?: PayMeConfig; appUrl?: string },
  ): Promise<PayMeCheckoutResult>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/donations/payme-provider.server.test.ts
import { describe, expect, test } from "bun:test";
import { createPayMeCheckout } from "./payme-provider.server";
import type { PayMeClient, PayMeCreateBody } from "./payme-client.server";
import type { PayMeConfig } from "./config.server";

const config: PayMeConfig = {
  apiBase: "https://sandbox.api.payme.hsbc.com.hk",
  apiVersion: "0.12",
  clientId: "c",
  clientSecret: "s",
  signingKeyId: "k",
  signingKeyBase64: Buffer.from("key").toString("base64"),
  effectiveDuration: 600,
};

function fakeClient(capture: (b: PayMeCreateBody) => void): PayMeClient {
  return {
    getAccessToken: async () => "tok",
    createPaymentRequest: async (body) => {
      capture(body);
      return { paymentRequestId: "pr1", webLink: "https://web", appLink: "https://app" };
    },
    getPaymentRequestStatus: async () => ({ statusCode: "PR001" }),
  };
}

describe("createPayMeCheckout", () => {
  test("builds callbacks + amount + duration and returns links", async () => {
    let captured: PayMeCreateBody | null = null;
    const result = await createPayMeCheckout(
      {
        donationId: "d1",
        paymentId: "p1",
        amountCents: 30000,
        donorEmail: "a@b.com",
        purpose: "general",
        checkoutExperience: "desktop_qr",
      },
      { client: fakeClient((b) => (captured = b)), config, appUrl: "https://app.test" },
    );
    expect(result).toEqual({ providerRef: "pr1", webLink: "https://web", appLink: "https://app" });
    expect(captured!.totalAmount).toBe(300);
    expect(captured!.currencyCode).toBe("HKD");
    expect(captured!.effectiveDuration).toBe(600);
    expect(captured!.notificationUri).toBe("https://app.test/api/webhooks/payme");
    expect(captured!.appSuccessCallback).toBe("https://app.test/donate?status=success&donation=d1");
    expect(captured!.appFailCallback).toBe("https://app.test/donate?status=cancelled&donation=d1");
    expect(captured!.merchantData.orderId).toBe("d1");
  });

  test("formats non-whole amounts to 2 decimals", async () => {
    let captured: PayMeCreateBody | null = null;
    await createPayMeCheckout(
      {
        donationId: "d2",
        paymentId: "p2",
        amountCents: 30081,
        donorEmail: "a@b.com",
        purpose: "medical",
        checkoutExperience: "wap",
      },
      { client: fakeClient((b) => (captured = b)), config, appUrl: "https://app.test" },
    );
    expect(captured!.totalAmount).toBe(300.81);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/donations/payme-provider.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/donations/payme-provider.server.ts
import { getAppUrl } from "../appUrl.server";
import { getPayMeConfig, type PayMeConfig } from "./config.server";
import { createPayMeClient, type PayMeClient } from "./payme-client.server";
import type { CheckoutProviderInput } from "./service";

const purposeLabels: Record<string, string> = {
  general: "一般捐款 General donation",
  medical: "醫療基金 Medical fund",
  sponsor: "助養動物 Sponsor a pet",
};

export type PayMeCheckoutResult = { providerRef: string; webLink: string; appLink: string };

export async function createPayMeCheckout(
  input: CheckoutProviderInput,
  deps: { client?: PayMeClient; config?: PayMeConfig; appUrl?: string } = {},
): Promise<PayMeCheckoutResult> {
  const config = deps.config ?? getPayMeConfig();
  const client = deps.client ?? createPayMeClient({ config });
  const appUrl = deps.appUrl ?? getAppUrl();

  const response = await client.createPaymentRequest({
    totalAmount: Number((input.amountCents / 100).toFixed(2)),
    currencyCode: "HKD",
    effectiveDuration: config.effectiveDuration,
    notificationUri: `${appUrl}/api/webhooks/payme`,
    appSuccessCallback: `${appUrl}/donate?status=success&donation=${input.donationId}`,
    appFailCallback: `${appUrl}/donate?status=cancelled&donation=${input.donationId}`,
    merchantData: {
      orderId: input.donationId,
      orderDescription: `HKSCDA donation — ${purposeLabels[input.purpose] ?? "donation"}`,
    },
  });

  return {
    providerRef: response.paymentRequestId,
    webLink: response.webLink,
    appLink: response.appLink,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/donations/payme-provider.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/donations/payme-provider.server.ts src/lib/donations/payme-provider.server.test.ts
git commit -m "feat(donations): add PayMe checkout provider"
```

---

## Task 6: Service — new `kind:"payme"` result + provider wiring

**Files:**

- Modify: `src/lib/donations/service.ts`
- Modify: `src/lib/donations/providers.server.ts`
- Test: `src/lib/donations/service.test.ts`

**Interfaces:**

- Consumes: `createPayMeCheckout` (Task 5); existing `DonationRepository`, `CheckoutProviderInput`.
- Produces:
  - `PaymentProviders.createPayMeCheckout(input: CheckoutProviderInput): Promise<PayMeCheckoutResult>`.
  - New `CreateDonationResult` variant: `{ kind: "payme"; donationId: string; paymentRequestId: string; webLink: string; appLink: string }`.
  - `createPaymentProviders()` returns `createPayMeCheckout` alongside the others.

- [ ] **Step 1: Write the failing test**

```ts
// add to src/lib/donations/service.test.ts — reuse existing createFakeRepository()/providers pattern.
import { test, expect } from "bun:test";
import { createDonation, type PaymentProviders } from "./service";
// Assume the file already has a createFakeRepository() helper and a base request builder.

test("payme method creates a payment request and returns kind payme", async () => {
  const repository = createFakeRepository();
  const providers: PaymentProviders = {
    createStripeCheckout: async () => ({ providerRef: "s", url: "https://s" }),
    createPayPalOrder: async () => ({ providerRef: "p", url: "https://p" }),
    createCodAlipayHkCheckout: async () => ({ providerRef: "c", url: "https://c" }),
    createPayMeCheckout: async () => ({
      providerRef: "pr1",
      webLink: "https://web",
      appLink: "https://app",
    }),
  };
  const result = await createDonation({
    input: baseRequest({ method: "payme" }),
    repository,
    providers,
  });
  expect(result.kind).toBe("payme");
  if (result.kind === "payme") {
    expect(result.paymentRequestId).toBe("pr1");
    expect(result.webLink).toBe("https://web");
    expect(result.appLink).toBe("https://app");
    expect(result.donationId).toBeTruthy();
  }
});

test("payme checkout failure compensates donation + payment", async () => {
  const deleted = { payment: false, donation: false };
  const repository = {
    ...createFakeRepository(),
    deletePayment: async () => {
      deleted.payment = true;
    },
    deleteDonation: async () => {
      deleted.donation = true;
    },
  };
  const providers: PaymentProviders = {
    createStripeCheckout: async () => ({ providerRef: "s", url: "https://s" }),
    createPayPalOrder: async () => ({ providerRef: "p", url: "https://p" }),
    createCodAlipayHkCheckout: async () => ({ providerRef: "c", url: "https://c" }),
    createPayMeCheckout: async () => {
      throw new Error("payme down");
    },
  };
  await expect(
    createDonation({ input: baseRequest({ method: "payme" }), repository, providers }),
  ).rejects.toThrow("payme down");
  expect(deleted.payment).toBe(true);
  expect(deleted.donation).toBe(true);
});

test("fps method still returns a manual result", async () => {
  const result = await createDonation({
    input: baseRequest({ method: "fps" }),
    repository: createFakeRepository(),
    providers: {
      createStripeCheckout: async () => ({ providerRef: "s", url: "https://s" }),
      createPayPalOrder: async () => ({ providerRef: "p", url: "https://p" }),
      createCodAlipayHkCheckout: async () => ({ providerRef: "c", url: "https://c" }),
      createPayMeCheckout: async () => ({
        providerRef: "pr1",
        webLink: "https://web",
        appLink: "https://app",
      }),
    },
  });
  expect(result.kind).toBe("manual");
});
```

> If `createFakeRepository()`/`baseRequest()` helpers don't already exist in `service.test.ts`, reuse the existing fakes in that file verbatim (the file already tests stripe/paypal/manual). Add `createPayMeCheckout` to every `PaymentProviders` literal in the file so it typechecks.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/donations/service.test.ts`
Expected: FAIL — `createPayMeCheckout` missing on `PaymentProviders`; `kind:"payme"` not produced.

- [ ] **Step 3: Extend `PaymentProviders` + `CreateDonationResult` in `service.ts`**

Add the import and types:

```ts
import type { PayMeCheckoutResult } from "./payme-provider.server";
```

```ts
export type PaymentProviders = {
  createStripeCheckout(input: CheckoutProviderInput): Promise<CheckoutProviderResult>;
  createPayPalOrder(input: CheckoutProviderInput): Promise<CheckoutProviderResult>;
  createCodAlipayHkCheckout(input: CheckoutProviderInput): Promise<CheckoutProviderResult>;
  createPayMeCheckout(input: CheckoutProviderInput): Promise<PayMeCheckoutResult>;
};
```

Add to `CreateDonationResult` union:

```ts
  | {
      kind: "payme";
      donationId: string;
      paymentRequestId: string;
      webLink: string;
      appLink: string;
    }
```

- [ ] **Step 4: Split the `fps || payme` branch in `createDonation`**

Replace the current `if (donationInput.method === "fps" || donationInput.method === "payme")` block so it handles **only** `fps` as manual, and add a dedicated PayMe branch before the generic online-provider block:

```ts
if (donationInput.method === "fps") {
  const reference = createManualPaymentReference(donation.id);
  await repository.createPayment({
    donation_id: donation.id,
    provider: "fps",
    provider_ref: reference,
    amount_cents: donationInput.amountCents,
    status: "pending",
  });
  return {
    kind: "manual",
    donationId: donation.id,
    reference,
    instructions: {
      method: "fps",
      label: "轉數快 FPS",
      payableTo: "香港拯救貓狗協會",
      identifier: "FPS ID 8727588",
      amountCents: donationInput.amountCents,
    },
  };
}

if (donationInput.method === "payme") {
  const pendingPayment = await repository.createPayment({
    donation_id: donation.id,
    provider: "payme",
    provider_ref: null,
    amount_cents: donationInput.amountCents,
    status: "pending",
  });
  let checkout: PayMeCheckoutResult;
  try {
    checkout = await providers.createPayMeCheckout({
      donationId: donation.id,
      paymentId: pendingPayment.id,
      amountCents: donationInput.amountCents,
      donorEmail: donationInput.donor.email,
      purpose: donationInput.purpose,
      checkoutExperience: donationInput.checkoutExperience,
    });
  } catch (error) {
    await compensateFailedCheckout(repository, donation.id, pendingPayment.id);
    throw error;
  }
  await repository.updatePaymentProviderRef(pendingPayment.id, checkout.providerRef);
  return {
    kind: "payme",
    donationId: donation.id,
    paymentRequestId: checkout.providerRef,
    webLink: checkout.webLink,
    appLink: checkout.appLink,
  };
}
```

Leave the existing generic online-provider block (stripe/paypal/alipayhk) unchanged below.

- [ ] **Step 5: Wire the provider in `providers.server.ts`**

```ts
import { createPayMeCheckout } from "./payme-provider.server";
```

```ts
export function createPaymentProviders() {
  return {
    createStripeCheckout,
    createPayPalOrder,
    createCodAlipayHkCheckout,
    createPayMeCheckout,
  };
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test src/lib/donations/service.test.ts && bunx tsc --noEmit`
Expected: PASS + clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add src/lib/donations/service.ts src/lib/donations/providers.server.ts src/lib/donations/service.test.ts
git commit -m "feat(donations): return PayMe checkout result from createDonation"
```

---

## Task 7: PayMe status poll backstop (`refreshPendingPayMeDonation`)

**Files:**

- Create: `src/lib/donations/payme-status.server.ts`
- Test: `src/lib/donations/payme-status.server.test.ts`

**Interfaces:**

- Consumes: `reconcileProviderPayment`, `failProviderPayment`, `retrySucceededDonationSideEffects`, `type ReconcileProviderArgs` (from `reconcile.server.ts`); `createPayMeClient` (Task 3); Supabase `payment` table (`select id,provider_ref,amount_cents,status where donation_id=… and provider='payme'`).
- Produces:
  ```ts
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
  }>;
  ```
- Status mapping: `PR005`→reconcile; `PR004`/`PR007`→fail; `PR001` (or anything else)→pending. `providerEventId = "payme:refresh:" + provider_ref + ":" + statusCode`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/donations/payme-status.server.test.ts
import { describe, expect, test } from "bun:test";
import { refreshPendingPayMeDonation } from "./payme-status.server";
import type { PayMeClient } from "./payme-client.server";

type Row = { id: string; provider_ref: string | null; amount_cents: number; status: string };

function fakeClient(paymentRow: Row | null) {
  // Minimal Supabase query-builder chain returning paymentRow via .maybeSingle().
  return {
    from() {
      return this;
    },
    select() {
      return this;
    },
    eq() {
      return this;
    },
    in() {
      return this;
    },
    maybeSingle: async () => ({ data: paymentRow, error: null }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}
function statusClient(statusCode: string): Pick<PayMeClient, "getPaymentRequestStatus"> {
  return { getPaymentRequestStatus: async () => ({ statusCode, transactionId: "t1" }) };
}

describe("refreshPendingPayMeDonation", () => {
  test("returns not_applicable when there is no payme payment", async () => {
    const res = await refreshPendingPayMeDonation({ donationId: "d1", client: fakeClient(null) });
    expect(res.kind).toBe("not_applicable");
  });

  test("PR005 reconciles", async () => {
    let reconciled = false;
    const res = await refreshPendingPayMeDonation({
      donationId: "d1",
      client: fakeClient({ id: "p1", provider_ref: "pr1", amount_cents: 30000, status: "pending" }),
      createClient: () => statusClient("PR005"),
      reconcile: async () => {
        reconciled = true;
        return {};
      },
      fail: async () => ({}),
    });
    expect(reconciled).toBe(true);
    expect(res.kind).toBe("reconciled");
  });

  test("PR007 fails", async () => {
    let failed = false;
    const res = await refreshPendingPayMeDonation({
      donationId: "d1",
      client: fakeClient({ id: "p1", provider_ref: "pr1", amount_cents: 30000, status: "pending" }),
      createClient: () => statusClient("PR007"),
      reconcile: async () => ({}),
      fail: async () => {
        failed = true;
        return {};
      },
    });
    expect(failed).toBe(true);
    expect(res.kind).toBe("failed");
  });

  test("PR001 stays pending", async () => {
    const res = await refreshPendingPayMeDonation({
      donationId: "d1",
      client: fakeClient({ id: "p1", provider_ref: "pr1", amount_cents: 30000, status: "pending" }),
      createClient: () => statusClient("PR001"),
    });
    expect(res.kind).toBe("pending");
  });

  test("already-succeeded recovers side effects", async () => {
    let recovered = false;
    const res = await refreshPendingPayMeDonation({
      donationId: "d1",
      client: fakeClient({
        id: "p1",
        provider_ref: "pr1",
        amount_cents: 30000,
        status: "succeeded",
      }),
      recoverSideEffects: async () => {
        recovered = true;
        return {};
      },
    });
    expect(recovered).toBe(true);
    expect(res.kind).toBe("recovered");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/donations/payme-status.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/donations/payme-status.server.ts
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
    const result = await reconcile(base);
    return { kind: "reconciled", statusCode, ...(typeof result === "object" ? {} : {}) };
  }
  if (FAILURE_CODES.has(statusCode)) {
    await fail(base);
    return { kind: "failed", statusCode };
  }
  return { kind: "pending", statusCode };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/donations/payme-status.server.test.ts && bunx tsc --noEmit`
Expected: PASS + clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/lib/donations/payme-status.server.ts src/lib/donations/payme-status.server.test.ts
git commit -m "feat(donations): add PayMe status poll backstop"
```

---

## Task 8: Wire PayMe refresh into the public status endpoint

**Files:**

- Modify: `src/lib/donations/publicStatus.server.ts`
- Modify: `src/lib/donations/supabase.server.ts`
- Modify: `src/routes/api/donations/$donationId/status.ts`
- Test: `src/lib/donations/publicStatus.server.test.ts`

**Interfaces:**

- Consumes: `refreshPendingPayMeDonation` (Task 7).
- Produces: `PublicDonationStatusRepository.refreshPendingPayMe?: (donationId: string) => Promise<unknown>` called best-effort alongside `refreshPendingCod`.

- [ ] **Step 1: Write the failing test**

```ts
// add to src/lib/donations/publicStatus.server.test.ts
import { test, expect } from "bun:test";
import { loadPublicDonationStatus } from "./publicStatus.server";

test("calls refreshPendingPayMe before reading status", async () => {
  let called = false;
  const result = await loadPublicDonationStatus({
    donationId: "11111111-1111-4111-8111-111111111111",
    repository: {
      refreshPendingPayMe: async () => {
        called = true;
      },
      findStatus: async () => "succeeded",
    },
  });
  expect(called).toBe(true);
  expect(result).toEqual({ status: "succeeded" });
});

test("a refreshPendingPayMe failure keeps a succeeded status pending", async () => {
  const result = await loadPublicDonationStatus({
    donationId: "11111111-1111-4111-8111-111111111111",
    repository: {
      refreshPendingPayMe: async () => {
        throw new Error("payme timeout");
      },
      findStatus: async () => "succeeded",
    },
  });
  expect(result).toEqual({ status: "pending" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/donations/publicStatus.server.test.ts`
Expected: FAIL — `refreshPendingPayMe` not part of the repository type / not called.

- [ ] **Step 3: Extend the repository type + best-effort call in `publicStatus.server.ts`**

```ts
export type PublicDonationStatusRepository = {
  refreshPendingCod?: (donationId: string) => Promise<unknown>;
  refreshPendingPayMe?: (donationId: string) => Promise<unknown>;
  findStatus: (donationId: string) => Promise<PublicDonationStatus | null>;
};
```

Replace the single refresh call with both, sharing the same best-effort semantics:

```ts
let refreshFailed = false;
try {
  await Promise.all([
    repository.refreshPendingCod?.(donationId),
    repository.refreshPendingPayMe?.(donationId),
  ]);
} catch {
  refreshFailed = true;
}
```

- [ ] **Step 4: Forward the dep in `supabase.server.ts`**

Update `createSupabaseDonationStatusRepository` to accept and forward `refreshPendingPayMe`:

```ts
export function createSupabaseDonationStatusRepository(
  client: SupabaseClient,
  dependencies: Pick<
    PublicDonationStatusRepository,
    "refreshPendingCod" | "refreshPendingPayMe"
  > = {},
): PublicDonationStatusRepository {
  return {
    refreshPendingCod: dependencies.refreshPendingCod,
    refreshPendingPayMe: dependencies.refreshPendingPayMe,
    async findStatus(donationId) {
      // …unchanged…
    },
  };
}
```

- [ ] **Step 5: Inject the refresh in the status route**

In `src/routes/api/donations/$donationId/status.ts`, add the import and dependency:

```ts
import { refreshPendingPayMeDonation } from "../../../../lib/donations/payme-status.server";
```

```ts
      repository: createSupabaseDonationStatusRepository(client, {
        refreshPendingCod: (donationId) => refreshPendingCodDonation({ donationId, client }),
        refreshPendingPayMe: (donationId) => refreshPendingPayMeDonation({ donationId, client }),
      }),
```

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test src/lib/donations/publicStatus.server.test.ts && bunx tsc --noEmit`
Expected: PASS + clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add src/lib/donations/publicStatus.server.ts src/lib/donations/supabase.server.ts src/routes/api/donations/\$donationId/status.ts src/lib/donations/publicStatus.server.test.ts
git commit -m "feat(donations): refresh PayMe status during public polling"
```

---

## Task 9: PayMe webhook processing

**Files:**

- Create: `src/lib/donations/payme-webhook.server.ts`
- Test: `src/lib/donations/payme-webhook.server.test.ts`

**Interfaces:**

- Consumes: `computeDigest`, `verifySignatureHeader` (Task 2); `getPayMeConfig` (Task 1); `reconcileProviderPayment`, `failProviderPayment`, `type ReconcileProviderArgs` (reconcile.server).
- Produces:
  ```ts
  export class PayMeNotificationError extends Error {}
  export type PayMeNotificationAction =
    | { kind: "success"; paymentRequestId: string; statusCode: string; transactionId?: string }
    | { kind: "failure"; paymentRequestId: string; statusCode: string };
  export function parsePayMeNotification(input: {
    rawBody: string;
    headers: Headers;
    signingKeyBase64: string;
    requestTarget: string; // "post /api/webhooks/payme"
  }): PayMeNotificationAction;
  export async function processPayMeNotification(input: {
    rawBody: string;
    headers: Headers;
    requestTarget: string;
    client: SupabaseClient;
    config?: PayMeConfig;
    reconcile?: (a: ReconcileProviderArgs) => Promise<unknown>;
    fail?: (a: ReconcileProviderArgs) => Promise<unknown>;
  }): Promise<unknown>;
  ```
- Verification: recompute `computeDigest(rawBody)` and require it equals the `digest` header; then `verifySignatureHeader` over `{ digest, "x-client-id", "x-event-type", "(request-target)" }`. `x-event-type: payment.success` → success; `payment.failure` → failure. `providerEventId = "payme:" + paymentRequestId + ":" + statusCode`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/donations/payme-webhook.server.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/donations/payme-webhook.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/donations/payme-webhook.server.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/donations/payme-webhook.server.test.ts && bunx tsc --noEmit`
Expected: PASS + clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/lib/donations/payme-webhook.server.ts src/lib/donations/payme-webhook.server.test.ts
git commit -m "feat(donations): verify + process PayMe webhook notifications"
```

---

## Task 10: PayMe webhook route

**Files:**

- Create: `src/routes/api/webhooks/payme.ts`
- Test: `src/routes/api/webhooks/-payme.test.ts`

**Interfaces:**

- Consumes: `processPayMeNotification`, `PayMeNotificationError` (Task 9); `getPayMeConfig`, `getPayMeConfigurationErrorField` (Task 1); `enforceRateLimit`, `getClientIp`, `retryAfterSeconds`; `createSupabaseServiceClient`.
- Produces: `export async function handlePayMeWebhookRequest(request, deps?)` + route `POST /api/webhooks/payme`. Returns 200 on processed/duplicate, 400 on `PayMeNotificationError`, 429 on rate limit, 500 otherwise. `requestTarget` passed to processing is `"post /api/webhooks/payme"`.

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/api/webhooks/-payme.test.ts
import { describe, expect, test } from "bun:test";
import { handlePayMeWebhookRequest } from "./payme";
import { PayMeNotificationError } from "../../../lib/donations/payme-webhook.server";

const okLimit = async () => ({ ok: true }) as never;

function req(body: string) {
  return new Request("https://app.test/api/webhooks/payme", { method: "POST", body });
}

describe("handlePayMeWebhookRequest", () => {
  test("429 when rate limited", async () => {
    const res = await handlePayMeWebhookRequest(req("{}"), {
      enforce: async () => ({ ok: false, reset: Date.now() + 1000 }) as never,
      process: async () => ({}),
    });
    expect(res.status).toBe(429);
  });

  test("200 on a processed event", async () => {
    const res = await handlePayMeWebhookRequest(req(JSON.stringify({ paymentRequestId: "pr1" })), {
      enforce: okLimit,
      process: async () => ({ kind: "applied" }),
    });
    expect(res.status).toBe(200);
  });

  test("400 on a PayMeNotificationError", async () => {
    const res = await handlePayMeWebhookRequest(req("{}"), {
      enforce: okLimit,
      process: async () => {
        throw new PayMeNotificationError("bad signature");
      },
    });
    expect(res.status).toBe(400);
  });

  test("500 on an unexpected error", async () => {
    const res = await handlePayMeWebhookRequest(req("{}"), {
      enforce: okLimit,
      process: async () => {
        throw new Error("db down");
      },
    });
    expect(res.status).toBe(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/routes/api/webhooks/-payme.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/routes/api/webhooks/payme.ts
import { createFileRoute } from "@tanstack/react-router";

import {
  getPayMeConfig,
  getPayMeConfigurationErrorField,
} from "../../../lib/donations/config.server";
import {
  PayMeNotificationError,
  processPayMeNotification,
} from "../../../lib/donations/payme-webhook.server";
import { createSupabaseServiceClient } from "../../../lib/donations/supabase.server";
import {
  enforceRateLimit,
  getClientIp,
  retryAfterSeconds,
} from "../../../lib/security/rate-limit.server";

type HandlerDependencies = {
  enforce?: typeof enforceRateLimit;
  process?: (rawBody: string, headers: Headers) => Promise<unknown>;
  getConfig?: typeof getPayMeConfig;
  createClient?: typeof createSupabaseServiceClient;
};

const REQUEST_TARGET = "post /api/webhooks/payme";

export async function handlePayMeWebhookRequest(
  request: Request,
  {
    enforce = enforceRateLimit,
    process,
    getConfig = getPayMeConfig,
    createClient = createSupabaseServiceClient,
  }: HandlerDependencies = {},
) {
  const limit = await enforce(getClientIp(request), {
    prefix: "wh-payme",
    max: 100,
    window: "1 m",
  });
  if (!limit.ok) {
    return new Response("Too many requests", {
      status: 429,
      headers: { "retry-after": String(retryAfterSeconds(limit)) },
    });
  }

  const rawBody = await request.text();
  const headers = request.headers;

  try {
    const processNotification =
      process ??
      ((body: string, hdrs: Headers) =>
        processPayMeNotification({
          rawBody: body,
          headers: hdrs,
          requestTarget: REQUEST_TARGET,
          client: createClient(),
          config: getConfig(),
        }));
    await processNotification(rawBody, headers);
    return new Response("success");
  } catch (error) {
    if (error instanceof PayMeNotificationError) {
      return new Response("Invalid PayMe notification", { status: 400 });
    }
    console.error("PayMe notification processing failed", {
      configurationField: getPayMeConfigurationErrorField(error),
    });
    return new Response("PayMe notification processing failed", { status: 500 });
  }
}

export const Route = createFileRoute("/api/webhooks/payme")({
  server: {
    handlers: {
      POST: ({ request }) => handlePayMeWebhookRequest(request),
    },
  },
});
```

> Note: the test injects `process` with signature `(rawBody, headers)`; the production default adapts to that shape. Confirm the exact `enforceRateLimit` return contract by reading `src/lib/security/rate-limit.server.ts` and match the `{ ok }` / `retryAfterSeconds` usage already used by `cod.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/routes/api/webhooks/-payme.test.ts && bunx tsc --noEmit`
Expected: PASS + clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/webhooks/payme.ts src/routes/api/webhooks/-payme.test.ts
git commit -m "feat(api): add PayMe webhook route"
```

---

## Task 11: Frontend — PayMe result handling + PayCode modal

**Files:**

- Create: `src/components/site/PayMePayCodeModal.tsx`
- Modify: `src/routes/donate.tsx`
- Test: `src/routes/donate.test.tsx`

**Interfaces:**

- Consumes: the `POST /api/donations` response now includes `{ kind: "payme", donationId, paymentRequestId, webLink, appLink }`; existing `pollDonationSucceeded(donationId, opts)`; existing `checkoutExperienceFromViewport(window.innerWidth)` (`< 768` → `"wap"`).
- Produces: `PayMePayCodeModal` component; `PayMeResult` type in `donate.tsx`; a `kind:"payme"` branch in `handleSubmit`.

- [ ] **Step 1: Write the failing test**

```tsx
// add to src/routes/donate.test.tsx — follow the file's existing render+fetch-mock pattern.
import { test, expect } from "bun:test";
// Reuse existing helpers in the file for rendering DonatePage with methods incl. payme,
// filling the form, and stubbing global fetch.

test("desktop payme response opens the PayCode modal with the webLink iframe", async () => {
  // Arrange: force desktop viewport (window.innerWidth >= 768) and stub fetch for POST /api/donations
  // to resolve { kind:"payme", donationId:"d1", paymentRequestId:"pr1", webLink:"https://web", appLink:"https://app" }.
  // Also stub the status endpoint to keep returning { status: "pending" } so the poll does not resolve.
  // Act: submit the form.
  // Assert: an element with an <iframe src="https://web"> is present (role="dialog").
  expect(true).toBe(true); // replace with real assertions using the file's testing utilities
});

test("mobile payme response redirects to appLink", async () => {
  // Arrange: force window.innerWidth < 768; capture assignments to window.location.href.
  // Act: submit the form with a payme response.
  // Assert: location.href was set to "https://app".
  expect(true).toBe(true); // replace with real assertions
});
```

> The two placeholder-body tests above MUST be fleshed out using the concrete render/fetch/viewport helpers already present in `donate.test.tsx` (read the file first). Model them on the existing "redirect" test: it already stubs `fetch` for `/api/donations` and asserts on `window.location.href`. For the desktop case, assert the modal `<iframe>`’s `src` equals the `webLink`. Do not leave `expect(true).toBe(true)` in the committed test.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/routes/donate.test.tsx`
Expected: FAIL once real assertions are added (no modal / no redirect yet).

- [ ] **Step 3: Create `PayMePayCodeModal.tsx`**

```tsx
// src/components/site/PayMePayCodeModal.tsx
import { Loader2, X } from "lucide-react";
import { useEffect, useRef } from "react";

type PayMeModalStatus = "waiting" | "success" | "failed";

export function PayMePayCodeModal({
  webLink,
  amountLabel,
  status,
  language,
  onClose,
}: {
  webLink: string;
  amountLabel: string;
  status: PayMeModalStatus;
  language: "zh-HK" | "en";
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const t =
    language === "en"
      ? {
          title: "Scan to pay with PayMe",
          waiting: "Waiting for payment confirmation…",
          success: "Payment confirmed. Thank you!",
          failed: "Payment was not completed. Please try again.",
          openTab: "Open PayCode in a new tab",
          close: "Close",
        }
      : {
          title: "使用 PayMe 掃碼付款",
          waiting: "正在等待付款確認…",
          success: "付款已確認，多謝支持！",
          failed: "付款未完成，請再試一次。",
          openTab: "在新分頁開啟 PayCode",
          close: "關閉",
        };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="relative w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-soft">
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label={t.close}
          className="absolute right-3 top-3 rounded-full p-2 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          <X className="h-4 w-4" />
        </button>
        <h2 className="mb-1 font-display text-lg font-bold text-[var(--color-panel)]">{t.title}</h2>
        <p className="mb-3 text-sm font-semibold text-[var(--color-primary)]">{amountLabel}</p>
        <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-white">
          <iframe title={t.title} src={webLink} className="h-[420px] w-full" />
        </div>
        <div className="mt-3 flex items-center gap-2 text-sm" role="status" aria-live="polite">
          {status === "waiting" && (
            <>
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none text-[var(--color-primary)]" />
              <span className="text-[var(--color-text-muted)]">{t.waiting}</span>
            </>
          )}
          {status === "success" && (
            <span className="font-bold text-[var(--color-success)]">{t.success}</span>
          )}
          {status === "failed" && (
            <span className="font-bold text-[var(--color-error)]">{t.failed}</span>
          )}
        </div>
        <a
          href={webLink}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-block text-sm font-semibold text-[var(--color-primary)] underline underline-offset-4"
        >
          {t.openTab}
        </a>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the `payme` branch to `donate.tsx`**

Add the result type near `RedirectResult`:

```ts
type PayMeResult = {
  kind: "payme";
  donationId: string;
  paymentRequestId: string;
  webLink: string;
  appLink: string;
};
```

Import the modal and `pollDonationSucceeded` (already imported). Add modal state in `DonatePage`:

```ts
const [paymeModal, setPaymeModal] = useState<{
  webLink: string;
  status: "waiting" | "success" | "failed";
} | null>(null);
```

Widen the response parse type and handle the new kind in `handleSubmit` (replace the `data.kind === "redirect"` tail):

```ts
const data = (await response.json()) as ManualResult | RedirectResult | PayMeResult;
// …existing attribution snapshot code stays above…
if (data.kind === "redirect") {
  window.location.href = data.url;
  return;
}
if (data.kind === "payme") {
  if (checkoutExperience === "wap") {
    window.location.href = data.appLink;
    return;
  }
  setPaymeModal({ webLink: data.webLink, status: "waiting" });
  const controller = new AbortController();
  void pollDonationSucceeded(data.donationId, { signal: controller.signal }).then((ok) => {
    setPaymeModal((prev) => (prev ? { ...prev, status: ok ? "success" : "failed" } : prev));
    if (ok) setReturnState("confirmed");
  });
  return;
}
setManualResult(data);
```

Render the modal near the end of the returned JSX (inside the top-level `<main>`):

```tsx
{
  paymeModal && (
    <PayMePayCodeModal
      webLink={paymeModal.webLink}
      amountLabel={centsToHkd(Math.round(amountHkd * 100))}
      status={paymeModal.status}
      language={language}
      onClose={() => setPaymeModal(null)}
    />
  );
}
```

Add the import:

```ts
import { PayMePayCodeModal } from "../components/site/PayMePayCodeModal";
```

- [ ] **Step 5: Run the frontend tests + typecheck**

Run: `bun test src/routes/donate.test.tsx && bunx tsc --noEmit`
Expected: PASS + clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add src/components/site/PayMePayCodeModal.tsx src/routes/donate.tsx src/routes/donate.test.tsx
git commit -m "feat(donate): show PayMe PayCode modal + mobile deep link"
```

---

## Task 12: Public-config visibility migration (PayMe + FPS only)

**Files:**

- Create: `supabase/migrations/20260925120000_payme_go_live_public_config.sql`
- Test: `src/lib/donations/supabaseMigrations.test.ts` already validates the migration tree — run it.

**Interfaces:**

- Produces: `payment_public_config` has only `payme` + `fps` publicly visible/published; `stripe`, `alipayhk`, `paypal` hidden.

- [ ] **Step 1: Inspect the current seed to confirm column names + values**

Run: `sed -n '1,40p' supabase/migrations/20260831120000_payment_public_config.sql` and note the exact `state` values (`draft|in_review|published|archived`) and `is_publicly_visible` column, plus how rows were seeded (method, sort_order).

- [ ] **Step 2: Write the migration**

```sql
-- supabase/migrations/20260925120000_payme_go_live_public_config.sql
-- Go-live scope: PayMe (API gateway) + manual FPS visible to the public.
-- Hide Stripe / AlipayHK / PayPal until each is separately approved.
begin;

update public.payment_public_config
   set is_publicly_visible = false,
       state = 'archived'
 where method in ('stripe', 'alipayhk', 'paypal');

update public.payment_public_config
   set is_publicly_visible = true,
       state = 'published'
 where method in ('payme', 'fps');

commit;
```

> If the initial seed left any of `payme`/`fps` in a non-`published` state, the second statement corrects it. Do not add a `security definer` function here — plain `UPDATE`s in migration context are consistent with how the original rows were seeded.

- [ ] **Step 3: Run the migration + brand/migration test suites**

Run: `bun test src/lib/donations/supabaseMigrations.test.ts`
Expected: PASS (migration parses and conforms to conventions).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260925120000_payme_go_live_public_config.sql
git commit -m "feat(donations): show only PayMe + manual FPS on the public form"
```

---

## Task 13: Enable checkout + document env, then full gate run

**Files:**

- Modify: `.env.example` (if it exists; otherwise create it)
- Modify: `src/routes/donate.tsx` is already gated by `VITE_PUBLIC_DONATION_CHECKOUT_ENABLED` — no code change; this task is configuration + documentation + the final CI-parity run.

- [ ] **Step 1: Document the required env vars**

Add to `.env.example` (create if missing):

```dotenv
# Enable the public online donation checkout form
VITE_PUBLIC_DONATION_CHECKOUT_ENABLED=true

# Server base URL used to build PayMe callbacks + webhook URL
APP_URL=https://your-deploy-host

# PayMe for Business (HSBC) — sandbox defaults shown
PAYME_API_BASE=https://sandbox.api.payme.hsbc.com.hk
PAYME_API_VERSION=0.12
PAYME_CLIENT_ID=
PAYME_CLIENT_SECRET=
PAYME_SIGNING_KEY_ID=
PAYME_SIGNING_KEY=            # base64 signing key from onboarding
PAYME_EFFECTIVE_DURATION=600  # PayCode lifetime in seconds (>= 15)
```

- [ ] **Step 2: Run the full CI-parity gate**

Run, in order:

```bash
bunx tsc --noEmit
bun test
bun run lint
bun run build
```

Expected: typecheck clean; all tests pass; lint clean; build succeeds. Fix any failures before proceeding. (Do NOT push or deploy — release requires explicit approval per CLAUDE.md.)

- [ ] **Step 3: Manual sandbox verification checklist (deferred until credentials land)**

Document these in the PR description for when real sandbox credentials are added (from the PayMe test pack cent-amount triggers):

- Desktop success: donate `HK$x.81` → modal iframe shows PayCode → status polls to success.
- Mobile-web/app: donate on a `< 768px` viewport → redirect to `appLink`; return via `appSuccessCallback` shows confirmed.
- Failure: donate `HK$x.77` → status resolves to failed.
- Expiry: donate `HK$x.80` → PayCode expires → failed/unavailable.
- Webhook: confirm PayMe POST to `/api/webhooks/payme` returns 200 and reconciles; re-delivery is a no-op (idempotent).

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "docs(donations): document PayMe env + enable checkout flag"
```

---

## Self-Review

**1. Spec coverage**

| Spec section                                                                                | Task(s)                                                                                  |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| §1 enable form / persist / token / create / desktop+mobile / confirm                        | Tasks 6, 11, 13 (enable), 3 (token), 5/6 (create), 11 (desktop/mobile), 8/9/10 (confirm) |
| §3.1 access token (cache 60 min)                                                            | Task 3                                                                                   |
| §3.2 request signing (digest, signed-header lists, GET omits digest)                        | Tasks 2, 3                                                                               |
| §3.3 create payment request (amount, duration, callbacks, merchantData)                     | Task 5                                                                                   |
| §3.4 get status + PR001/PR004/PR005/PR007 mapping                                           | Tasks 3, 7                                                                               |
| §3.5 webhook (digest+signature verify, x-event-type, 200, idempotent)                       | Tasks 2, 9, 10                                                                           |
| §4 modules (crypto/client/provider/status/webhook/config/domain/service)                    | Tasks 1–9                                                                                |
| §5 routes (webhook + status injection)                                                      | Tasks 8, 10                                                                              |
| §6 frontend (result handling + modal)                                                       | Task 11                                                                                  |
| §7 DB data migration (no enum changes)                                                      | Task 12                                                                                  |
| §8 security invariants (.server, timing-safe, rate-limit, idempotency, audit, amount check) | Tasks 2, 8, 9, 10 (audit/amount reused via reconcile)                                    |
| §9 testing                                                                                  | every task's test steps                                                                  |
| §10 gates                                                                                   | Task 13                                                                                  |

**2. Placeholder scan:** The only intentionally-stubbed code is the two `donate.test.tsx` bodies in Task 11, which carry an explicit instruction (and a "do not leave `expect(true)`" note) to flesh them out against the file's existing helpers, because those helpers can't be reproduced blind. All server-side tasks contain complete, runnable code.

**3. Type consistency check:**

- `PayMeCheckoutResult` `{ providerRef, webLink, appLink }` — defined Task 5, consumed Task 6. ✓
- `PaymentProviders.createPayMeCheckout` — added Task 6, used by `createPaymentProviders()` Task 6. ✓
- `CreateDonationResult` `kind:"payme"` `{ donationId, paymentRequestId, webLink, appLink }` — Task 6, consumed frontend Task 11 as `PayMeResult`. ✓
- `refreshPendingPayMeDonation(args)` — Task 7, wired Task 8, both name it identically. ✓
- `buildSignatureHeader` / `verifySignatureHeader` / `computeDigest` — Task 2, consumed Tasks 3 & 9. ✓
- `OnlinePaymentProvider` includes `"payme"` (Task 4) → required by `ReconcileProviderArgs.provider` in Tasks 7 & 9. ✓
- `getPayMeConfig()` fields — Task 1, consumed Tasks 3, 5, 9. ✓
