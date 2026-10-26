# PayMe Donation Gateway — Design Spec

**Date:** 2026-09-25
**Status:** Approved for planning
**Domain:** `donations`
**Scope:** Add HSBC PayMe for Business as a real API-integrated online payment
gateway for public donations, converting the current _manual_ PayMe method into
a live create-request → PayCode/deep-link → webhook + poll → reconcile flow.

## 1. Goal & Scope

Enable the public donation form (`/donate`) so a donor can complete an online
PayMe payment end-to-end:

1. Enable the donation form (currently disabled behind
   `VITE_PUBLIC_DONATION_CHECKOUT_ENABLED`).
2. Persist the submitted donation before contacting PayMe (existing behaviour;
   `donation` + `payment` rows written first).
3. Obtain a PayMe OAuth access token (cached, reused for 60 minutes).
4. Create a PayMe payment request with our `notificationUri`,
   `appSuccessCallback`, `appFailCallback`; receive `paymentRequestId`,
   `webLink`, `appLink`.
5. **Desktop:** show a modal with an `<iframe>` of `webLink` (PayCode scan page).
   **Mobile (wap):** redirect to `appLink` to open the PayMe app.
6. Confirm payment via **both** the `notificationUri` webhook **and** browser
   polling of our own status endpoint (which refreshes from PayMe's Get Payment
   Request Status API). Show success / failure to the donor.

### Decisions locked during brainstorming

- **Public methods live now:** PayMe (API) **+** the existing manual FPS
  bank-transfer instructions. Stripe / AlipayHK / PayPal stay hidden until
  separately approved.
- **Credentials:** built against the sandbox contract with env placeholders;
  verification is via mocked-HTTP unit/integration tests. No live sandbox call
  is made as part of this work. (Sandbox iframe framing of `webLink` was
  confirmed working by the requester.)
- **Desktop display:** `<iframe>` of `webLink` (confirmed working in sandbox).
- **Refunds:** deferred. Token + create + status + webhook + receipts only.

### Non-goals

- No refund flow (`POST /payments/transactions/{id}/refunds`).
- No Cancel Payment Request call (donors abandon; PayCode expires naturally).
- No admin PayMe configuration UI beyond the data migration that adjusts
  `payment_public_config` visibility.
- No new enum values (existing constraints already permit `payme`).

## 2. Architecture

Follows the established COD/AlipayHK blueprint, which is the closest analog
(OAuth token, signed requests, webhook + status-poll backstop). New files live
in `src/lib/donations/` alongside the `cod-*.server.ts` cluster and reuse the
existing `reconcileProviderPayment` / `failProviderPayment` pipeline and the
existing public status endpoint.

```
donate.tsx  ──POST /api/donations (method=payme)──▶ createDonation (service.ts)
                                                      │ writes donation(pending)+payment(payme,pending)
                                                      ▼
                                        providers.createPayMeCheckout (payme-provider.server.ts)
                                                      │ getAccessToken (cached) + signed POST /payments/paymentrequests
                                                      ▼
                                        { paymentRequestId, webLink, appLink }
                                                      │ updatePaymentProviderRef(paymentId, paymentRequestId)
                                                      ▼
                          CreateDonationResult { kind:"payme", donationId, paymentRequestId, webLink, appLink }

Confirmation (both idempotent via webhook_event):
  PayMe ──POST notificationUri──▶ /api/webhooks/payme ─verify sig─▶ reconcileProviderPayment / failProviderPayment
  browser ─poll─▶ GET /api/donations/$id/status ─▶ refreshPendingPayMeDonation ─▶ Get Status ─▶ reconcile / fail
                                                      ▼
                                    receipts + email + audit_log (existing pipeline)
```

## 3. PayMe API contract (from Postman collection + HSBC guide + test pack)

- **Base URL:** `PAYME_API_BASE`, default `https://sandbox.api.payme.hsbc.com.hk`.
- **API version header:** `Api-Version: 0.12`.

### 3.1 Access token

`POST {base}/oauth2/token`, `Content-Type: application/x-www-form-urlencoded`,
`Accept: application/json`, `Api-Version`. Body: URL-encoded `client_id`,
`client_secret`. Response: `{ accessToken }`. Reusable for 60 minutes; do **not**
mint per request; do **not** validate the token locally.

### 3.2 Request signing (calls we make to PayMe)

HTTP Message Signatures, `algorithm="hmac-sha256"`, key = base64-decoded
`PAYME_SIGNING_KEY`, `keyId = PAYME_SIGNING_KEY_ID`.

- **Digest** (POST bodies): `Digest: SHA-256=` + `base64(sha256(rawBody))`.
- **Signing base:** for each signed header, one line `headerName.toLowerCase() + ": " + value`, joined by `\n`.
- **Create Payment Request** signed headers (order matters):
  `(request-target)`, `Api-Version`, `Request-Date-Time`, `Trace-Id`,
  `Authorization`, `Digest`.
  `(request-target)` value = `post /payments/paymentrequests`.
- **Get Status** signed headers: same list **minus `Digest`** (no body).
  `(request-target)` value = `get /payments/paymentrequests/{id}`.
- **Signature header format:**
  `keyId="…",algorithm="hmac-sha256",headers="…",signature="<base64>"`.
- Additional request headers: `Authorization: Bearer <token>`,
  `Request-Date-Time` (ISO-8601 / RFC-1123 timestamp), `Trace-Id` (uuid v4),
  `Accept: application/json`, `Accept-Language: en-US`, and (POST)
  `Content-Type: application/json`.

### 3.3 Create Payment Request

`POST {base}/payments/paymentrequests`. Body:

```jsonc
{
  "totalAmount": 300.0, // (amount_cents/100).toFixed(2), number
  "currencyCode": "HKD",
  "effectiveDuration": 600, // seconds; must be >= 15; config default 600
  "notificationUri": "https://<app>/api/webhooks/payme",
  "appSuccessCallback": "https://<app>/donate?status=success&donation=<id>",
  "appFailCallback": "https://<app>/donate?status=cancelled&donation=<id>",
  "merchantData": {
    "orderId": "<donationId>",
    "orderDescription": "HKSCDA donation — <purpose label>",
  },
}
```

Response (relevant fields): `paymentRequestId`, `webLink`, `appLink`,
`businessLogos` (ignored for now).

### 3.4 Get Payment Request Status

`GET {base}/payments/paymentrequests/{paymentRequestId}` (signed, no digest).
Response `statusCode`:

| statusCode | meaning                              | our action             |
| ---------- | ------------------------------------ | ---------------------- |
| `PR001`    | Request for Payment Initiated        | pending (keep polling) |
| `PR005`    | Payment Success                      | reconcile (succeed)    |
| `PR004`    | Request for Payment Rejected/Aborted | fail                   |
| `PR007`    | Payment Request Expired              | fail                   |

On `PR005` the response also carries transaction details incl. `transactionId`
(retained in `payment.provider_order_ref` for future refunds).
Poll no more than once per 10 s, and only after 60 s without a webhook; the
existing frontend poll interval (10 s) already satisfies this.

### 3.5 Webhook (notificationUri)

PayMe `POST`s JSON to our `notificationUri`. Headers:

- `Digest: SHA-256=<base64 of body>`
- `Signature: keyId="…",algorithm="hmac-sha256",headers="digest x-client-id x-event-type (request-target)",signature="<base64>"`
- `x-event-type`: `payment.success` | `payment.failure`
- `x-client-id`: uuid
  Body includes `paymentRequestId`, `totalAmount`, `currencyCode`, `statusCode`
  (`PR001|PR004|PR005|PR007`), `statusDescription`, `transactionId`, etc.
  We **must** respond HTTP 200 on success; PayMe retries up to 5× otherwise.

### 3.6 Sandbox behaviour (for later manual verification, not automated here)

Cent-amount triggers: `.44` → auto-pay success; `.77` → payment failure;
`.80`/`.81` → PayCode expiry scenarios; other amounts → normal expiry after
`effectiveDuration`.

## 4. New / changed modules

### 4.1 `src/lib/donations/payme-crypto.server.ts` (pure, no I/O)

```ts
export function computeDigest(rawBody: string): string; // "SHA-256=<base64>"
export function buildRequestSignature(input: {
  keyId: string;
  signingKeyBase64: string;
  signedHeaders: string[]; // in signing order
  headerValues: Record<string, string>; // lowercased-name → value
}): string; // full Signature header value
export function verifyNotificationSignature(input: {
  signatureHeader: string;
  signingKeyBase64: string;
  headerValues: Record<string, string>; // digest, x-client-id, x-event-type, (request-target)
}): boolean; // timing-safe compare
```

### 4.2 `src/lib/donations/payme-client.server.ts`

Injectable `fetchImpl = fetch`, `now = () => new Date()`, `newTraceId`.
Module-level token cache `{ token, expiresAt }` (60 min; refresh at ~55 min).

```ts
export function createPayMeClient(deps?): {
  getAccessToken(): Promise<string>;
  createPaymentRequest(body: PayMeCreateBody): Promise<PayMeCreateResponse>;
  getPaymentRequestStatus(id: string): Promise<PayMeStatusResponse>;
};
```

Each method assembles timestamp + trace id + digest (POST) + signature and
throws a typed error on non-2xx.

### 4.3 `src/lib/donations/payme-provider.server.ts`

```ts
export async function createPayMeCheckout(
  input: CheckoutProviderInput,
): Promise<PayMeCheckoutResult>; // { providerRef, webLink, appLink }
```

Builds callback URLs from `getAppUrl()` + donationId, formats amount, sets
`effectiveDuration` from config, `merchantData.orderId = donationId`.

### 4.4 `src/lib/donations/payme-status.server.ts`

```ts
export async function refreshPendingPayMeDonation(args: {
  donationId: string;
  client: SupabaseClient;
  createClient?: () => PayMeStatusClient; // DI for tests
  reconcile?: …; fail?: …;
}): Promise<{ kind: "not_applicable" | "pending" | "reconciled" | "failed" | "recovered" }>;
```

Loads the `payme` payment for the donation; if `succeeded` retries side-effects;
else calls Get Status and maps `PR005`→reconcile, `PR004/PR007`→fail,
`PR001`→pending. Mirrors `cod-status.server.ts`.

### 4.5 `src/lib/donations/payme-webhook.server.ts`

```ts
export class PayMeNotificationError extends Error {}
export function parsePayMeNotification(input: {
  rawBody: string;
  headers: Headers;
  signingKeyBase64: string;
  requestTarget: string; // "post /api/webhooks/payme"
}): PayMeNotificationAction; // { kind:"success"|"failure", paymentRequestId, statusCode, transactionId, … }
export async function processPayMeNotification(args): Promise<unknown>;
```

Verifies Digest + Signature, then routes to `reconcileProviderPayment` /
`failProviderPayment` with
`providerEventId = "payme:" + paymentRequestId + ":" + statusCode`.

### 4.6 `src/lib/donations/config.server.ts` — add `getPayMeConfig()`

Reads `PAYME_API_BASE` (default sandbox), `PAYME_API_VERSION` (`0.12`),
`PAYME_CLIENT_ID`, `PAYME_CLIENT_SECRET`, `PAYME_SIGNING_KEY_ID`,
`PAYME_SIGNING_KEY` (base64), `PAYME_EFFECTIVE_DURATION` (default 600).
Throws with a config-field marker on partial configuration (matches
Stripe/PayPal). Add a `getPayMeConfigurationErrorField()` helper mirroring COD
for safe webhook logging.

### 4.7 `src/lib/donations/domain.ts`

- Widen `OnlinePaymentProvider` to `"stripe" | "paypal" | "cod" | "payme"`
  (required so `reconcileProviderPayment`/`failProviderPayment` accept `payme`).
- Add `PayMeCheckoutResult = { providerRef: string; webLink: string; appLink: string }`.

### 4.8 `src/lib/donations/service.ts`

- Add `createPayMeCheckout` to `PaymentProviders` and to `createPaymentProviders()`
  (`providers.server.ts`).
- Add result variant:
  ```ts
  | { kind: "payme"; donationId: string; paymentRequestId: string;
      webLink: string; appLink: string }
  ```
- Split the `fps || payme` branch: `fps` stays `manual`; `payme` writes the
  pending `payment(provider="payme", provider_ref=null)`, calls
  `providers.createPayMeCheckout`, `updatePaymentProviderRef(id, paymentRequestId)`,
  returns `kind:"payme"`. Reuse `compensateFailedCheckout` on failure.

## 5. Routes

### 5.1 `src/routes/api/webhooks/payme.ts`

Mirrors `cod.ts`: rate-limit `wh-payme` 100/min via `getClientIp`; read **raw**
body (needed for digest/signature); verify signature (→ 400 `PayMeNotificationError`);
process → reconcile/fail; **always return 200** on a valid, processed-or-duplicate
event so PayMe stops retrying; 500 only on unexpected server error. DI seams
(`enforce`, `process`, `getConfig`, `createClient`) for testing. No Turnstile —
this is a browser-native/server-to-server automated payload; rate limiting +
signature verification are the controls (consistent with the CSP-report and COD
webhook precedent).

### 5.2 `src/routes/api/donations/$donationId/status.ts`

Inject `refreshPendingPayMe: (donationId) => refreshPendingPayMeDonation({ donationId, client })`
into `createSupabaseDonationStatusRepository` alongside the existing
`refreshPendingCod`. `publicStatus.server.ts` calls whichever matches the
donation's pending provider.

## 6. Frontend

### 6.1 `src/routes/donate.tsx`

- New `PayMeResult` type + handling in `handleSubmit`: on `data.kind === "payme"`:
  - `checkoutExperience === "wap"` → `window.location.href = data.appLink`.
  - otherwise → open `<PayMePayCodeModal>` with `webLink`, and start
    `pollDonationSucceeded(data.donationId)`; on success set confirmed state and
    close; on failure/expiry show retry and re-enable the form.
- The return-from-app path (`?donation=&status=success|cancelled`) is already
  handled by the existing `resolveDonationReturn` effect — no change needed.
- Keep the existing `manual` branch for `fps`.

### 6.2 `src/components/site/PayMePayCodeModal.tsx`

Accessible dialog (focus trap, `Esc`, `aria-modal`) rendering:

- Title + amount + zh-HK/en copy.
- `<iframe src={webLink}>` sized for the PayCode page (confirmed frameable).
- A "在新分頁開啟 / Open in new tab" link to `webLink` as a graceful fallback.
- A live-status line driven by the poll (waiting → success/failure), respecting
  `prefers-reduced-motion`.
- Uses `var(--color-*)` tokens only; Noto Sans HK; zh-HK primary.

## 7. Database

No enum migrations — `payment.provider`, `webhook_event.provider` already permit
`payme`; `payment.provider_order_ref` already exists.

**One data migration** `supabase/migrations/<ts>_payme_go_live_public_config.sql`:

- Set `is_publicly_visible = false` (archive) for `payment_public_config` rows
  `stripe`, `alipayhk`, `paypal`; keep `payme` and `fps` published + visible.
- Optionally refresh the `payme` display labels/details (e.g. drop the "WhatsApp
  for QR" manual copy now that it is a live gateway).
- Direct `UPDATE` in migration context (deploy-time seed adjustment, matching how
  the original rows were seeded); RLS/grants unchanged. No new `security definer`
  function, so no `search_path` concern.

**Env / deploy (documented, not committed):**
`VITE_PUBLIC_DONATION_CHECKOUT_ENABLED=true`, plus the `PAYME_*` secrets and
`APP_URL`.

## 8. Security invariants (checklist)

- All PayMe modules are `*.server.ts`; secrets never reach the client bundle.
- Signing key handled only server-side; `verifyNotificationSignature` uses a
  timing-safe compare.
- Webhook: rate-limited, signature-verified, idempotent via `webhook_event`
  (`providerEventId`), returns 200 to stop retries, `getClientIp()` for IP.
- Reconcile writes the `audit_log` row through the existing pipeline
  (`adminRouteAuditing.test.ts` scope unaffected; webhooks reconcile via the
  same path Stripe/PayPal/COD use).
- Amount validation reused: `reconcileProviderPayment` already asserts
  `payment.amount_cents === donation.amount_cents`.

## 9. Testing (bun:test, DI fakes, mocked HTTP — no live sandbox)

- `payme-crypto.server.test.ts` — digest vector (`SHA-256=…`), sign→verify
  round-trip, tampered-body/bad-signature rejection.
- `payme-client.server.test.ts` — fake `fetch`: token cache reuse across calls +
  refresh after expiry; correct headers/signature/body for create + status;
  non-2xx throws typed error.
- `payme-provider.server.test.ts` — callback/notification URLs, `totalAmount`
  formatting, `effectiveDuration`, returns `{webLink, appLink, providerRef}`.
- `payme-status.server.test.ts` — `PR005`→reconcile, `PR004`/`PR007`→fail,
  `PR001`→pending, already-succeeded→recover.
- `payme-webhook.server.test.ts` — signature pass/fail, `payment.success`→
  reconcile, `payment.failure`→fail, duplicate event → 200/no double side-effect.
- `service.test.ts` — `payme` returns `kind:"payme"`; compensation on checkout
  failure; `fps` still `manual`.
- Webhook route test (`-payme.test.ts`) — 429 rate-limit, 400 bad signature, 200
  success/duplicate.
- Frontend: extend `donate.test.tsx` for the `payme` branch (desktop modal open
  - poll; mobile appLink redirect).

## 10. Gates before merge

`bunx tsc --noEmit` → `bun test` → `bun run lint` → `bun run build` → public
brand verification (per CLAUDE.md CI parity). No push/deploy without explicit
release approval.

## 11. Risks & mitigations

- **iframe framing** — confirmed working in sandbox by requester; modal keeps an
  "open in new tab" fallback regardless.
- **Webhook/poll race** — both paths are idempotent through `webhook_event`;
  first writer wins, second returns duplicate.
- **Token expiry mid-flight** — client refreshes at ~55 min and retries once on a
  401 from PayMe.
- **Signature spec ambiguity (header casing/order)** — encoded as explicit
  ordered lists in `payme-crypto`; covered by round-trip + fixed-vector tests;
  final confirmation deferred to live sandbox verification when credentials land.
