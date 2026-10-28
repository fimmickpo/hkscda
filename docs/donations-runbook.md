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

In Production the public forms, donations included, need two things that local and
preview builds do without:

- **Turnstile**: `VITE_TURNSTILE_SITE_KEY`, read at build time, and
  `TURNSTILE_SECRET_KEY`. Without the secret every submission is refused with 403.
- **Rate limiting**: the `rate_limit_hit` function from migration
  `20261028074500_postgres_rate_limit.sql`. Limits are counted in Supabase
  Postgres, so no Redis service or variable is involved, but the migration must be
  applied before the deployment that needs it (see Supabase below). Without it
  every submission is refused with 503, and `/api/internal/readiness` reports
  `RATE_LIMIT_UNAVAILABLE`.

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
and `appLink`. What the donor sees depends on the device:

- **Phone** (viewport under 768 px): the form sends the donor to `appLink`,
  which opens the PayMe app. PayMe then returns them to
  `/donate?status=success|cancelled&donation=<id>`.
- **Desktop or tablet**: the form sends the donor to `/donate/payme/<donationId>`.
  That page turns `webLink` into a QR code (the PayCode, drawn in the browser),
  shows the amount and a countdown to the PayCode's expiry, and moves on by
  itself: to `/donate?status=success…` once the payment is confirmed, or to a
  clear message when the PayCode expires or its status cannot be confirmed.
  `webLink` is the data inside the QR code, not a page to open (PayMe refuses
  framing). Business logos are not drawn into the code yet; see the go-live steps.
- **Cancel** on that page asks PayMe to cancel the payment request
  (`PUT /payments/paymentrequests/{id}/cancel`) and only then fails the payment
  and returns to `/donate?status=cancelled…`, so a donor who leaves cannot pay the
  PayCode afterwards. If PayMe answers that the PayCode was just paid (`EB021`) or
  a payment is in progress (`EB022`), nothing is failed and the page keeps waiting.
  If PayMe cannot be reached the donor is told the PayCode is still valid.

Confirmation arrives from the signed webhook at
`POST {APP_URL}/api/webhooks/payme`. The status poll is the backstop: the page
asks our own status route every 10 seconds, and that route asks PayMe
(`getPaymentRequest`) only once 60 seconds have passed since the request was
created without a notification, and at most once every 10 seconds per payment,
as HSBC recommends. The route verifies the digest and HMAC signature, then
reconciles idempotently through the shared lifecycle.

If the PayCode has expired and the payment is still pending after a further 30
seconds, the page says the status could not be confirmed, tells the donor not to
pay again and to contact the donation inbox with the donation reference. The
saved checkout is kept in that case, so the same details cannot start a second
payment. The page keeps listening for 30 minutes and turns into the confirmation
if the payment is confirmed late.

A `payment.failure` notification fails the payment only when its `statusCode` is
`PR004` (rejected or aborted) or `PR007` (expired), the same two codes the status
poll acts on. HSBC's sample failure carries `PR001` plus a `reasonCode`, which
reports one payer's failed attempt while the PayCode is still payable. That is
acknowledged with a 200 and the payment stays pending, because a failed payment
is final and a later payment on the same PayCode would otherwise be skipped. The
donor sees "waiting" until the PayCode expires. Confirm in the sandbox which
codes real failure notifications carry.

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

## PayMe Local Testing

A new local database has checkout switched off, so `/donate` shows the notice
"網上捐款尚未完成正式啟用審批" and offers no payment method. To run a PayMe sandbox
payment from a laptop you need three things: a `payme` config the checkout gate
accepts, the sandbox credentials, and an amount with cents. Start the local
database and the app first (`bun run db:start`, `bun run db:migrate` if
migrations are pending, then `bun run dev`).

### 1. Open the gate for PayMe

The seeded `payme` config has no publisher and no `payableTo` or `identifier`, so
the gate rejects it. In a deployed environment two different admins fix that in
`/admin/payment-methods` (the submitter cannot publish), as described under
"PayMe Sandbox Setup". A local database has one admin, so this script gives the
seeded config a publisher and the two details directly (placeholders: a PayMe
donation never shows them), then approves PayMe for donations and turns checkout
on through the audited RPCs. `audit_log` records the approval and the switch, but
not a publish. It can be run again. The container is named
`supabase_db_<project_id>`; here that is `supabase_db_hkscda`. Run it against the
local database only.

```bash
docker exec -i supabase_db_hkscda psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
begin;

select id as admin_id, auth_user_id as admin_auth_id
  from public.admin_user
 where role in ('admin', 'treasurer') and status = 'active'
 order by created_at limit 1 \gset

update public.payment_public_config
   set published_by = :'admin_id', published_at = now(),
       details = details || jsonb_build_object('payableTo', 'HKSCDA', 'identifier', 'LOCAL-TEST')
 where method = 'payme' and state = 'published';

select id as payme_config_id, version as payme_config_version
  from public.payment_public_config
 where method = 'payme' and state = 'published' \gset

select public.set_checkout_method_approval_with_audit(
  :'admin_auth_id'::uuid, 'payme', 'donation', :'payme_config_id'::uuid, :payme_config_version, true);

select public.set_checkout_policy_with_audit(
  :'admin_auth_id'::uuid, (select version from public.checkout_policy where singleton), true);

commit;
SQL
```

Reload `/donate`; no restart is needed, because the page reads the gate on every
load. PayMe is offered for the General and Medical purposes. Sponsor uses a
separate `sponsorship` approval, which this script does not create. To switch
checkout off again:

```bash
docker exec -i supabase_db_hkscda psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "select public.set_checkout_policy_with_audit((select auth_user_id from public.admin_user where role in ('admin','treasurer') and status='active' order by created_at limit 1), (select version from public.checkout_policy where singleton), false);"
```

### 2. Add the sandbox credentials

Put the `PAYME_*` variables from "PayMe Sandbox Setup" in `.env.local`, which git
ignores, using the sandbox values from the PayMe onboarding, and restart
`bun run dev`: the server reads them at start-up. Without them creating a payment
fails: the form says the donation could not be created, and the dev server log
names the missing variable.

### 3. Enter an amount with cents

The sandbox chooses what to simulate from the cents of the amount (the table in
the next section). The custom amount field takes cents, up to two decimals, in a
development build (`bun run dev`) and in any build that sets
`VITE_PUBLIC_ALLOW_CENT_AMOUNTS=true`, so type `10.81` straight into it. Every
other build only takes whole dollars (`step="1"`), as donors get it in
Production, and the browser refuses to submit `10.81`.

To test on a deployment, set `VITE_PUBLIC_ALLOW_CENT_AMOUNTS=true` for the
environment you test in and redeploy. It is a build-time variable, so a change
shows only in the next build. Remove it when the testing is done: while it is set,
every donor on that environment can type cents too. For a quick check without a
redeploy, lift the limit on the page from the browser console on `/donate`, then
type the amount:

```js
document.getElementById("donation-custom-amount").step = "any";
```

A reload puts the limit back. Chrome asks you to type `allow pasting` in the
console before it accepts pasted code.

The site takes HK$10 to HK$10,000 for every payment method: the field has
`min="10"` and the server rule is `amountCents` in
`src/lib/donations/domain.ts`. So `10.81` is the smallest convenient test amount.
The floor is the site's, not PayMe's: the HSBC material in `docs/payme` states no
minimum for `totalAmount` (an invalid amount is rejected with `EA017`), and HSBC's
own Postman example creates a HK$3.77 request. A whole-dollar amount needs no
cents at all: the sandbox does nothing with it, so the PayCode just counts down
and expires, as it does for `.80`.

### 4. Run a payment

1. On `/donate`, choose the General or Medical purpose and PayMe, and enter an
   amount ending in `.81`, such as `10.81`.
2. On a desktop the form moves to `/donate/payme/<donationId>`, which shows the
   PayCode QR code, the amount and a countdown. There is nothing to scan: the
   sandbox pays a `.81` PayCode by itself.
3. PayMe cannot call `http://localhost`, so the webhook never arrives. The status
   poll confirms the payment about a minute after the request was created (HSBC
   test case 1009), and the page then moves to the confirmation.

A local run has two limits. The webhook path needs a public https `APP_URL`, such
as a deployed preview or a tunnel to the dev server. The phone flow returns to
`APP_URL`, which a phone cannot open while it is `localhost`. If PayMe rejects the
payment request because of the notification address, set `APP_URL` to a public
https address and restart.

## PayMe Sandbox Test Amounts

The PayMe sandbox decides what to simulate from the cent part of the amount, so
the donation has to end in one of these. A development build of the donation form
takes cents, and so does a build that sets `VITE_PUBLIC_ALLOW_CENT_AMOUNTS=true`;
step 3 of "PayMe Local Testing" covers entering them and what any other build
needs. They come from HSBC's test pack
(`docs/payme/PayMe_APIs_Test_Pack_v1.8.xlsx`, "Sandbox Test Summary"):

| Amount ends in | The sandbox                                      | What the donor sees on a desktop                                                                               |
| -------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `.81`          | pays the PayCode itself shortly after creation   | "Payment confirmed", then the donation page's confirmation                                                     |
| `.80`          | does nothing (any other ending behaves the same) | the countdown ends, then "The PayCode has expired" with a way back to the form                                 |
| `.44`          | answers the create request with a 500            | the form's error: could not be created, try again or choose another payment method                             |
| `.45`          | answers every status request with a 500          | after expiry, if no notification arrives, "We could not confirm your payment yet", with the donation reference |
| `.77`          | creates a request that eventually fails          | "Payment not completed", with a way back to the form                                                           |

To exercise the 60-second status poll (HSBC test case 1009), create the payment
while `APP_URL` is an address PayMe cannot reach. The webhook then never arrives
and the poll confirms the payment about a minute after the request was created.

## PayMe: Sandbox to Production

Sandbox and production are two separate PayMe environments with their own
credentials. A sandbox token does not work against production. Switching is
configuration only; no code changes:

| Variable                                    | Sandbox                                 | Production                            |
| ------------------------------------------- | --------------------------------------- | ------------------------------------- |
| `PAYME_API_BASE`                            | `https://sandbox.api.payme.hsbc.com.hk` | `https://api.payme.hsbc.com.hk`       |
| `PAYME_CLIENT_ID`, `PAYME_CLIENT_SECRET`    | sandbox credentials                     | production credentials issued by HSBC |
| `PAYME_SIGNING_KEY_ID`, `PAYME_SIGNING_KEY` | sandbox signing key                     | production signing key                |
| `PAYME_API_VERSION`                         | `0.12`                                  | `0.12`, unless HSBC says otherwise    |
| `APP_URL`                                   | an https origin PayMe can reach         | the production origin                 |
| `VITE_PUBLIC_ALLOW_CENT_AMOUNTS`            | `true`, to type the sandbox cents       | unset or `false`: whole dollars only  |

1. Complete HSBC's "Path to live". Run the sandbox test cases above and send the
   PayMe Integration Team the filled-in test execution evidence: screenshots in
   each supported language and, on desktop, at 640 × 480, 1280 × 720 and
   1920 × 1080. HSBC also reviews the PayCode page's design and copy against its
   design guidelines, which are not in this repository: ask the integration
   contact for them. The page draws the QR code without a business logo today.
   PayMe returns `businessLogos` in the create response, and production PayCodes
   are expected to carry the merchant logo.
2. HSBC issues the production credentials once the evidence is accepted, and may
   ask for a closed live test (`Live Test Cases` in the test pack). Refunds are
   not built into the site; refund a live test payment from the PayMe business
   portal.
3. Put the production values in the Vercel **Production** environment only. Keep
   the sandbox values in Preview and in local `.env.local`, so a preview deploy or
   a laptop can never move real money. Check that `VITE_PUBLIC_ALLOW_CENT_AMOUNTS`
   is not set in Production, where donors give whole dollars. Redeploy: variable
   changes apply only to new deployments.
4. The webhook address is sent to PayMe as `notificationUri` with every payment
   request, built from `APP_URL`, so it follows the environment. Tell HSBC the
   production address, `{APP_URL}/api/webhooks/payme`, as in the enabling steps
   above.
5. Switching credentials does not turn anything on. The method is still offered
   only while it has an enabled approval in the checkout gate (steps 2 to 5
   above); approve it for production separately from the sandbox.
6. To go back, restore the sandbox values and redeploy, or disable the `payme`
   approval. PayCodes already created stay payable until they expire.

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

The public form is gated in the database. `/donate` offers a method only while
`checkout_policy.enabled` is true and the method has an enabled
`checkout_method_approval` (see "PayMe Sandbox Setup"). The
`VITE_PUBLIC_DONATION_CHECKOUT_ENABLED` variable that `.env.example` still lists
is no longer read. Keep checkout off in preview and production environments
until every provider intended for public display has passed the production
review above; a local database may switch it on for sandbox testing (see "PayMe
Local Testing"). Switching it on only reveals the existing checkout UI; it does
not replace provider, webhook, reconciliation, or merchant activation checks.

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
