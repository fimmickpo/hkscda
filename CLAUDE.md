# Project Instructions

HKSCDA (香港拯救貓狗協會) — animal-rescue site with a public adoption/donation/
volunteer journey and a role-gated admin back office.

## Tech Stack

- **Language**: TypeScript 5.x (strict; hand-written code has zero `any`)
- **Framework**: TanStack Start (SSR React 19 + TanStack Router + Vite 7 + Nitro)
- **Database**: Supabase Postgres — RLS on every table, project ref `iihqjzilgawhfdhdevam`
- **Styling**: Tailwind CSS v4 (utility-first, CSS variables for theming)
- **UI components**: shadcn/ui on Radix UI primitives (`src/components/ui/`)
- **Payments/email**: Stripe, PayPal, AlipayHK (COD) and HSBC PayMe webhooks, Resend, pdf-lib receipts
- **Abuse controls**: Postgres rate limiting (`rate_limit_hit`), Cloudflare Turnstile
- **Runtime/package manager**: Bun
- **Deploy target**: Vercel (Nitro `vercel` preset → `.vercel/output`)

## Build & Run

- Dev: `bun run dev`
- Build: `bun run build`
- Test: `bun run test` (adds `--isolate`, as CI does; ≈5,480 tests in 636 files, about two minutes). `supabase/rls-tests` run only when a local stack answers on port 55321; a stack shared with other worktrees gives false failures, so for a unit-only run set `SUPABASE_LOCAL_URL=http://127.0.0.1:1`.
- Typecheck: `bunx tsc --noEmit` — **the build does NOT typecheck.** Run this
  before pushing; Vite transpiles without type checking, so type errors ship green.
- Lint: `bun run lint` (~30s over the whole tree) — `bunx eslint <file>` for a
  single file, but the full run is cheap enough to just do before pushing
- Format: `bun run format`

CI (`.github/workflows/ci.yml`) runs typecheck → test → lint → build → public brand
verification on push and PR. Run the same gates locally before requesting review.

## Architecture

Layered, dependency-injected. Follow this for all new server work:

```
src/routes/api/**/route.ts     Thin route: rate limit → Turnstile → delegate
  └ -handlers.ts               Wires deps (auth fn, service) into the handler factory
      └ lib/<domain>/http.server.ts   HTTP shape: parse, status codes, error mapping
          └ lib/<domain>/service.ts   Business rules — pure, no Supabase import
              └ lib/<domain>/repository.server.ts   Supabase queries only
```

Handler factories take their dependencies as arguments (`requireAdmin`, `service`,
`verifyPublicRegistration`), which is what makes them testable without a database.
Domains following this: `adoptions`, `crm`, `donations`, `volunteers`, `admin`,
`publicAdoption`, `sponsorship`.

**Animal audit trigger**: admin browser code no longer reads or writes tables directly —
every admin surface goes through the API layer (`adminBrowserDataGuard.test.ts` enforces
it). The `log_animal_mutation` trigger (migrations `20260803120000` + `20260805120000`)
still audits any animal-table write that carries a real JWT (`auth.uid()` is set);
service-role writes are skipped there and must write their own `audit_log` row at the
app layer instead, so the same event is never logged twice with two different actors.
Write that row inside a `*_with_audit` RPC, not as a second PostgREST call:
the mutation commits first, so a separate audit insert that fails leaves the change
applied, unaudited, and reported to the caller as a 500. `adminRouteAuditing.test.ts`
enforces the pairing.

## Security Invariants

- `*.server.ts` never reaches the client bundle. Secrets and the service-role
  client live behind that suffix; `import.meta.env.VITE_*` is public.
- Every admin API route calls `requireAdmin(request, roles, client)`
  (`lib/donations/supabase.server.ts`) — bearer token → `admin_user` row → role check.
  The role matrix lives in `lib/admin/access.ts` and is mirrored by RLS policies.
- Every table has RLS enabled; every `security definer` function pins its
  `search_path` — either `public, pg_temp` (the house default) or `''`, which is
  stricter and requires every reference in the body to be schema-qualified
  (see `20260719120000_document_admin_mutation_hardening.sql`). Keep both true
  for new migrations; `supabaseMigrations.test.ts` enforces it.
- App-called RPCs go in the `public` schema and must be granted to `service_role` —
  the `private` schema is not exposed to PostgREST.
- Public POST endpoints accepting a **user-submitted form** are rate limited
  (`enforceRateLimit`) and Turnstile-verified. Rate limits are counted in Postgres
  (`rate_limit_hit`, service role only) and enforced in production only; elsewhere they
  are not enforced and the database is not touched. In production a route marked
  `requireAvailability` refuses (503) when the counter cannot be reached, and Turnstile
  refuses (403) when `TURNSTILE_SECRET_KEY` is missing. `assertTurnstileConfigFromEnv()`
  boot-fails on an inconsistent production pair (one of the two required env vars set,
  one missing).
  Endpoints that receive a **browser-native automated payload** instead (e.g.
  `/api/csp-report`, populated by the browser's own CSP reporting machinery, not
  by page JS or a user action) have no Turnstile widget to obtain a token from —
  rate limiting alone is the correct control there.
  Page-JS telemetry beacons that carry only a server-re-sanitised, non-identifying value (e.g. /api/help/search-gap) are rate limited, JSON-only and size-capped instead of Turnstile-verified: there is no form to attach a token to.
- Never trust `x-forwarded-for[0]` — use `getClientIp()`.
- Admin mutations write an `audit_log` row. Match that in new domains.

## Conventions

- File naming: PascalCase components, camelCase utilities, `.server.ts` for
  server-only, `-name.ts` prefix for non-route files inside `src/routes/`
- Routes: file-based in `src/routes/` (see `src/routes/README.md`);
  `routeTree.gen.ts` is generated — never edit
- Validation: zod schemas in `lib/<domain>/schemas.ts`, parsed at the service boundary
- **Injectable clocks**: functions whose behaviour depends on time take
  `now = () => new Date()` as a parameter. Never call `Date.now()` inline in logic
  you intend to test — that is what makes tests rot on a calendar date.
- **Discarded side-effect deps**: a DI factory dependency whose result is
  intentionally ignored (e.g. an email sender that resolves to a delivery status
  the caller doesn't act on) is typed `Promise<unknown>`, never `Promise<void>` —
  TypeScript's void-return exemption does not apply through a `Promise<T>` type
  argument, so `Promise<void>` rejects the real implementation at the call site.
- CSS theming: use `var(--color-*)` tokens from `styles.css`, never hardcoded colours
- Tests: `*.test.ts` beside the source, `bun:test`, dependency-injected fakes
- Admin copy: every admin string lives in a bilingual copy.ts / *Copy.ts module built with defineAdminCopy (tsc enforces zh/en parity); adminCopyGuard.test.ts fails on Chinese anywhere else in src/components/admin or src/routes/admin. Terms follow docs/admin-glossary.md.
- Admin UX: load errors render LoadFailure with retry; destructive actions use ConfirmActionDialog; status uses StatusBadge; dates and money use the shared formatters in both languages. The admin*Guard.test.ts files enforce each rule. Financial and irreversible actions take a required reason (requiredReasonActions.ts; requiredReasonGuard.test.ts).
- Commits: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`)
- Plans/specs land in `docs/superpowers/{plans,specs}/` before large features

## Project Structure

```
src/
  routes/         File-based routes; routes/api/ = server handlers
  components/
    site/         Public page sections      admin/  Back-office UI
    ui/           shadcn/ui primitives — do not edit manually
  lib/<domain>/   schemas · service · repository.server · http.server
  styles.css      Tailwind + CSS variable theme tokens
supabase/migrations/   Timestamped SQL; RLS + grants live here
docs/superpowers/      Design specs and implementation plans
```

## Approved Public Design System (2026-08)

The public experience uses HKSCDA's current official identity. The values in
`brand/design-tokens.{json,css}` and `docs/brand-guidelines.md` are authoritative.

- Primary blue `#05648E`; deep interaction blue `#034A69`; soft blue `#E4F2F7`
- Accent magenta `#A61C56`; deep interaction magenta `#821442`; soft magenta `#F9E7EF`
- Warm paper `#FFFDF9`, warm section `#F6F1E9`, ink `#162C36`, muted ink `#5B6E76`
- Typeface: Noto Sans HK with PingFang HK, Microsoft JhengHei, and system fallbacks
- Content width about 1200px on a 12-column desktop grid; spacing follows an 8px scale
- Approved radii are 8px, 16px, and pill; body copy is 16–18px with comfortable zh-HK leading
- Public components use one hero family and one consistent card anatomy, adapted by domain
- Real, approved HKSCDA photography comes first; never generate an image that could be
  mistaken for a real adoptable animal or documented rescue event
- Motion explains hierarchy or feedback, normally 350–500ms, and respects reduced motion

Do not reintroduce the stale Poofyco/Baloo rose-and-navy theme. Do not hardcode
component colours: use semantic `var(--color-*)` tokens from `src/styles.css`.
Traditional Chinese (`zh-HK`) is primary. Copy stays compassionate, factual, and
collective; avoid comparative superlatives and founder-centric organisational framing.

## Adding Pages / Sections

- New routes go in `src/routes/` — TanStack Router auto-generates `routeTree.gen.ts`
- New UI sections go in `src/components/site/`
- New shadcn/ui primitives: `bunx shadcn add <component>` (writes to `src/components/ui/`)

## Deployment

- Linked to Vercel project `hkscda` under `ynwaforevers-projects`
- Push to `main` triggers a production deployment automatically; merge only after explicit release approval
- Do not create or share a public preview while review access is meant to remain private
- Preview command (only after approval): `vercel deploy --scope ynwaforevers-projects`
- Nitro preset: `vercel` (configured in `vite.config.ts`)
- Vercel plan is Pro: the crons in vercel.json run at their declared schedules. Every /api/jobs/* route and /api/internal/readiness require CRON_SECRET; without it Vercel's cron calls get 401 and no background job runs. Environment-variable changes take effect only after a redeploy. Switch-on steps: docs/background-jobs-runbook.md.

