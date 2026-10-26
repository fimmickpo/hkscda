# Donations MVP Runbook

This build is sandbox-only until the separate production approval gates below
are completed. Do not activate a live payment method from this runbook.

## Required Environment

Copy `.env.example` to `.env.local` and fill test-mode values only:

- Supabase URL, anon key, and service role key.
- Stripe test secret key and webhook signing secret.
- PayPal sandbox client id and secret.
- Resend API key for a verified test domain.
- `APP_URL` matching the local or preview origin used by payment redirects.

Do not commit real keys. Do not put service role or provider secrets in `VITE_*`
variables.

## COD AlipayHK Sandbox Setup

Direct COD is the processor for AlipayHK; Stripe remains card-only. Copy
`.env.example` to `.env.local`, then set only sandbox values for these six
server-only variables:

- `COD_ENV=sandbox`
- `COD_MERCHANT_ID`
- `COD_SEGMENT_ID`
- `COD_AES_SECRET_BASE64`
- `COD_PRIVATE_KEY_BASE64`
- `COD_NOTIFICATION_PUBLIC_KEY_BASE64`

The values ending in `_BASE64` are encoded server secrets or keys, not browser
configuration. `COD_PRIVATE_KEY_BASE64` is the merchant private key used to
sign outbound COD requests. `COD_NOTIFICATION_PUBLIC_KEY_BASE64` is the
separate COD notification public key used to verify inbound notifications.
Never substitute one for the other, commit either value, log their decoded
contents, or expose any COD value through a `VITE_*` variable.

Configure COD to send signed notifications to `POST {APP_URL}/api/webhooks/cod`
only after the webhook-registration gate is approved. The route verifies and
deduplicates notifications before reconciliation. A browser return cannot mark
a donation paid: it remains pending until a verified notification or server-side
status refresh confirms the transaction.

## PayMe Sandbox Setup

PayMe is an online, API-driven method. It is **not** a manual-instruction
method any more: only FPS keeps the assisted-manual flow. Copy `.env.example`
to `.env.local`, then set only sandbox values for these server-only variables:

- `PAYME_API_BASE=https://sandbox.api.payme.hsbc.com.hk`
- `PAYME_API_VERSION=0.12`
- `PAYME_CLIENT_ID`
- `PAYME_CLIENT_SECRET`
- `PAYME_SIGNING_KEY_ID`
- `PAYME_SIGNING_KEY` (base64 signing key from onboarding)
- `PAYME_EFFECTIVE_DURATION=600` (PayCode lifetime in seconds, integer >= 15)

All PayMe values are server-only. Never expose them through a `VITE_*`
variable, log the decoded signing key, or commit real credentials.

The server creates a signed payment request and returns two links: `webLink`
(the hosted PayCode page, opened in a new tab on desktop because PayMe sends
`X-Frame-Options` and refuses framing) and `appLink` (the PayMe app deep link
used on mobile). Confirmation arrives from the signed webhook at
`POST {APP_URL}/api/webhooks/payme`, with a `getPaymentRequest` status poll as
the backstop. The route verifies the digest and HMAC signature, then reconciles
idempotently through the shared lifecycle.

Enabling the method is an operator action, not part of a code deploy. Checkout
is gated in the database, not by a `VITE_*` flag or by
`payment_public_config.is_publicly_visible` alone: `/donate` only offers a method
with an enabled `checkout_method_approval` row, and only while
`checkout_policy.enabled` is true.

1. Approve the PayMe sandbox credentials, set the `PAYME_*` variables in the
   target environment (they take effect only after a redeploy) and register
   `{APP_URL}/api/webhooks/payme` with HSBC. `APP_URL` must be a public https
   origin that PayMe can reach.
2. Create and publish a new `payme` config in `payment_public_config` through
   `/admin/payment-methods` (draft, submit, publish), with the details from the
   next step. The seeded row has no `published_by`, so `admit_new_checkout`
   rejects it until a version has been published there.
3. Keep `payableTo` and `identifier` filled in on that published `payme` config.
   A PayMe donation never shows them, but the database still requires them for
   `payme`: `admit_new_checkout` and the `checkout_method_manual_details_guard`
   trigger reject a `payme` checkout or approval without them, and sponsorship
   pledges still show them as manual PayMe instructions. Only the application
   code has been relaxed to require them for `fps` alone. Scoping the database
   check by purpose would need its own migration and is not part of this change.
4. Approve the method. There is no admin screen for approvals or for the global
   switch; use the audited RPCs through reviewed operator SQL, as the treasurer or
   admin who owns the decision: `set_checkout_method_approval_with_audit` for
   `payme` and the `donation` purpose, then `set_checkout_policy_with_audit`
   once to turn checkout on.
5. The go-live scope is whatever has an enabled approval. To offer only PayMe and
   FPS at launch, approve `payme` and `fps` for `donation` and leave `stripe`,
   `paypal` and `alipayhk` unapproved. Do not archive those `payment_public_config`
   rows with direct SQL: the original PayMe design did that in a migration, which
   was deliberately not ported because direct edits skip the audited publish flow
   and no longer decide what `/donate` offers.

The inbound notification must be validated against the HSBC sandbox and the
`docs/payme/PayMe_APIs_Test_Pack_v1.8.xlsx` test pack before go-live: the
`(request-target)`, `digest`, `x-client-id`, and `x-event-type` signature
headers, and the `totalAmount` and `currencyCode` fields of a success
notification. Like the Stripe and PayPal handlers, the webhook credits a success
only when `totalAmount` equals the payment amount and `currencyCode` is `HKD`.
HSBC's samples send `totalAmount` as a decimal string; a number is accepted too.
A success notification without a readable amount is recorded as
`payment.provider_settlement_mismatch` in `audit_log` and is not credited. The
`getPaymentRequest` status poll does not compare amounts, because the HSBC
material in `docs/payme` does not list amount fields for that response. If the
real payload differs, adjust `src/lib/donations/payme-webhook.server.ts` only.

## Supabase

Apply the repository's full ordered migration chain, not only the original
donations migration. In particular, COD AlipayHK requires both:

- `supabase/migrations/20260720100000_cod_alipayhk_payment_support.sql`
- `supabase/migrations/20260816120000_cod_payment_order_reference.sql`

After verifying the linked Supabase project identity, review the pending list
and SQL before applying it:

```bash
supabase migration list --linked
supabase db push --linked --dry-run
supabase db push --linked
```

The earlier `20260623160506_phase_2_donations_mvp.sql` migration creates the
donation, supporter, consent, receipt, message, webhook, audit, and admin-role
tables with RLS enabled. The later lifecycle migrations and both COD migrations
must be applied in timestamp order by the normal CLI flow above.

Admin users are mapped by inserting rows into `admin_user`:

```sql
insert into public.admin_user (auth_user_id, email, role, status)
values ('<supabase-auth-user-id>', 'treasurer@example.com', 'treasurer', 'active');
```

The receipt bucket is private. Receipt PDF links are generated by server code as
signed URLs when needed.

## Payment Test Checklist

- Stripe: use Checkout in test mode with cards only. Do not enable Stripe
  Alipay or AlipayHK for this donation flow.
- AlipayHK: use direct COD sandbox checkout. Mobile uses COD `WAP`; desktop
  uses COD `PC2MOBILE` and the hosted QR flow. Both return the donor to a
  pending confirmation screen until the server confirms payment.
- PayPal: use sandbox buyer approval and capture.
- FPS/PayMe: FPS uses the assisted-manual flow and is confirmed through admin
  reconciliation. PayMe is online: confirm it through the signed webhook (and
  the status-poll backstop), never through the browser return.
- Webhooks: verify Stripe, PayPal, and COD notifications before processing and
  dedupe every provider event id. COD notifications are signed and must be
  idempotent; do not process unverified or mismatched payment data.
- Status refresh: while a COD return remains pending, the public status route
  can request the provider status from the server. It is a recovery path, not
  browser authority to change payment state.
- Refunds: a verified full COD refund reverses the payment through the existing
  lifecycle. Partial refunds require manual review and must not be automatically
  credited or reversed.
- Receipts: only issue for requested gifts of HK$100 or more.

## External Payment Gates

Keep real payment activity disabled by default. A real sandbox smoke test needs
explicit local sandbox credentials and separate network authorization; do not
run it from CI or a preview deployment. Before any sandbox smoke test, approve
the sandbox credential install, merchant public-key registration, and COD
notification endpoint registration.

Production remains a separate review: approve the production endpoint and
credentials, production key registration, webhook registration, deployment,
and activation independently. Confirm the public HTTPS `APP_URL` and the
registered notification URL before activating COD in production.

The public form is additionally gated by
`VITE_PUBLIC_DONATION_CHECKOUT_ENABLED=false`. Keep it false in local,
preview, and production environments until every provider intended for public
display has passed the production review above. Setting the flag to `true`
only reveals the existing checkout UI; it does not replace provider,
webhook, reconciliation, or merchant activation checks.

## Verification

Run:

```bash
bun run test
bun run typecheck
bun run lint
bun run build
```

Only after the deployment gate is approved, upgrade the Vercel CLI before
deployment work:

```bash
npm i -g vercel@latest
```
