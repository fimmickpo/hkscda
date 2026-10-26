# Public Route Design-System Port Design

**Date:** 2026-08-28
**Status:** Design approved; implementation plan not yet written
**Prior art:** `docs/public-route-parity.md`, `CODEX_STAGE_B_HANDOFF.md` (Stage B, WP1–WP7, merged 2026-08-28)

## Summary

The Stage B layout merge (WP1–WP7) ported HKSCDA's approved design system onto 14 of the 27 public routes: the shared header/footer/nav, the home page, both animal listings, and most content pages now render through `PublicPageFrame` with server loaders. `docs/public-route-parity.md` records the remaining 13 routes as still carrying pre-port markup.

This spec ports those 13 routes, using the same discipline WP1–7 followed: presentation only, no changes to loaders, `/api/*` contracts, Zod schemas, RLS, or client-side state keys. It also introduces two new shared frame components — `PublicDetailFrame` and `PublicFormFrame` — because the remaining routes don't fit `PublicPageFrame`'s hero→chapters→CTA shape, and forcing them into it would be worse than not porting them.

## Decisions

- Two new shared components join `PublicPageFrame`: `PublicDetailFrame` (photo/facts split pages) and `PublicFormFrame` (wizards, forms, status pages, and `/donate`).
- The three private status/token routes reuse `PublicFormFrame` rather than getting a fourth template — structurally they're a form frame with no form fields.
- `/stories` does not get a new template. Its duplicated hero markup moves onto `PublicPageFrame`; the filter bar, story grid, rescue map, and content cross-links become its `children`, matching the pattern `/knowledge` already uses.
- The rescue map on `/stories` is full-bleed (edge-to-edge), following the precedent the home page's photo marquee already set for full-bleed sections.
- `/donate` uses `PublicFormFrame`. Its existing `copy.eyebrow/title/intro` map directly onto the frame's header slot, and its existing PICS/privacy paragraph becomes the frame's trust note.
- Work is sequenced as four groups — detail/status, wizards/forms, stories/map, donate — in that order, lowest risk first. One design doc and one implementation plan cover all four groups; each group is a separate reviewable unit of the same plan rather than a separate spec.
- No behavior changes anywhere in this scope. This is presentation-layer work.

## Goals

1. Bring the remaining 13 public routes onto the shared design system so the whole public site is visually and structurally consistent.
2. Do it without touching loaders, API contracts, RLS, or any client-persisted state (shortlist, drafts, hydration behavior).
3. Introduce exactly as many new template components as the actual page shapes require — not one universal template, not one bespoke layout per route.
4. Leave `docs/public-route-parity.md` accurate: all 27 routes read `yes` in the Design system column, and the stale line claiming `/sponsors` and `/about` still read data in the browser (already false as of the Stage B merge) is removed.

## Non-goals

- Any change to `/api/*` request/response shapes, Zod schemas, domain services, or repositories.
- Any Supabase migration, RLS policy, or Storage policy change.
- Any change to shortlist localStorage keys or the application/pledge draft keys.
- Unblocking GitHub Actions (billing) or otherwise fixing CI infrastructure — tracked separately.
- BP-1 (privacy-safe adoption aggregate) and BP-3 (governance/team CMS records) — separate specs; `/report/adoption` and `/about/team` keep their current honest "not published yet" states in this port.
- Changing which fields or data a route displays. Only how it's laid out.

## New shared components

### `PublicDetailFrame`

Replaces the ad hoc markup currently duplicated across the routes that render `AnimalDetail`. Composition:

- Breadcrumb (`助養區 / 妞妞`-style, replacing today's plain "back" link)
- Photo/facts split panel — the existing `AnimalDetail` photo + facts layout, unchanged in content and behavior, restyled onto shared tokens
- Optional related-content strip (e.g. "more animals like this") rendered below the split

Used by `/animals/cat/$id`, `/animals/dog/$id`, and `/sponsors/$id` (all three currently render `AnimalDetail`).

### `PublicFormFrame`

A minimal frame for conversion and status pages, deliberately lighter than `PublicPageFrame`:

- Breadcrumb (omitted where there's no meaningful parent to break out to, e.g. the token status pages)
- One-line intro (eyebrow + title, no multi-paragraph hero copy)
- A single content slot for the form, wizard, or status content
- A small trust/safety note beneath the content slot, matching the payment-safety notice already kept verbatim on `/sponsors`

No chapters, no bottom CTA band — both would compete with completing the flow, which is the opposite of what these pages are for.

Used by `/adoption/apply`, `/adoption/status/$token`, `/sponsors/pledge`, `/sponsors/status/$token`, `/volunteer`, `/volunteer/group`, `/volunteer/status/$token`, and `/donate`.

## Route-by-route plan

Implemented in this order; each group should be independently reviewable and mergeable before the next starts.

### Group 1 — Detail/status

| Route | Change |
|---|---|
| `/animals/cat/$id` | `AnimalDetail` renders inside `PublicDetailFrame` |
| `/animals/dog/$id` | Same |
| `/sponsors/$id` | Same — shares `AnimalDetail` with the two routes above |
| `/adoption/status/$token` | Existing status component renders inside `PublicFormFrame`, no form slot content, breadcrumb omitted |
| `/sponsors/status/$token` | `PledgeStatusPage` renders inside `PublicFormFrame`, same treatment |
| `/volunteer/status/$token` | Same treatment |

### Group 2 — Wizards/forms

| Route | Change |
|---|---|
| `/adoption/apply` | `ApplicationWizard` becomes `PublicFormFrame`'s content slot; today the route renders nothing but the wizard |
| `/sponsors/pledge` | `PledgeWizard` becomes the content slot |
| `/volunteer` | The six role cards move above `PublicFormFrame`; the existing hero copy trims to the frame's one-line intro; the registration form (with Turnstile) becomes the content slot |
| `/volunteer/group` | `GroupEnquiryForm` becomes the content slot |

### Group 3 — Stories/map

| Route | Change |
|---|---|
| `/stories` | `StoryWall`'s duplicated `page-hero` section is deleted; its copy feeds `PublicPageFrame` directly. The filter bar, story grid, `RescueMap` (full-bleed), and `StoryContentGrid` become `PublicPageFrame`'s `children` |
| `/stories/$slug` | `StoryDetail` gets the same `PublicPageFrame` treatment already used by the other ported content-detail pages |

### Group 4 — Donate

| Route | Change |
|---|---|
| `/donate` | `copy.eyebrow`/`copy.title`/`copy.intro` feed `PublicFormFrame` directly; the amount/purpose/method/donor-details form becomes the content slot; the existing PICS paragraph becomes the trust note |

## Constraints

Carried over from the Stage B (WP1–7) discipline documented in `CODEX_STAGE_B_HANDOFF.md`:

- No changes to loaders, `/api/*` request/response shapes, Zod schemas, domain services, or repositories.
- No Supabase, migration, RLS, or Storage policy changes.
- Shortlist localStorage keys and the application/pledge draft keys are unchanged.
- The three token routes keep `noindex,nofollow`, stay out of the sitemap, and never carry a real token into analytics.
- The `PledgeWizard` SSR/localStorage hydration fix already landed in Stage B must not regress — verified explicitly per route in Group 2, not just visually.
- Real HKSCDA photography and copy only; no invented content, consistent with the standing rule already enforced on `/about/team` and `/report/adoption`.

## Testing strategy

TDD, matching the project's existing convention (`bun:test`, dependency-injected fakes, tests beside source):

1. **New components first.** `PublicDetailFrame` and `PublicFormFrame` each get component tests (breadcrumb/trust-note/children render correctly, omitted-breadcrumb case, empty content slot) — red, then green — before any route is wired to them.
2. **Per route, per group.** Wire one route, extend its existing route test (e.g. `stories.test.tsx`, `volunteer.test.tsx`) with an assertion that the route renders through the new frame, red then green, before moving to the next route in the group.
3. **Per group gate.** After each group: `bunx tsc --noEmit`, `bun test`, `bun run lint`, `bun run build`, `bun run verify:brand`.
4. **Per group manual pass.** Responsive breakpoints, keyboard/focus order, zero hydration console errors — the same checklist Stage B used.

## Success criteria

- `docs/public-route-parity.md` reads `yes` in the Design system column for all 27 public routes.
- The stale "`/sponsors` and `/about` still read their primary data in the browser" line is removed from that doc's Known gaps section (it's already false as of the Stage B merge).
- No route's loader, action, or API behavior changes — verified by the existing route tests continuing to pass unmodified in their data-layer assertions.
- `PublicDetailFrame` and `PublicFormFrame` each have component tests independent of any specific route.
- All four groups pass their own gate (typecheck, test, lint, build, brand verify) before the next group starts.

## Open follow-ups (explicitly out of scope here)

- BP-1: privacy-safe adoption-impact aggregate for `/report/adoption`.
- BP-3: governance/team CMS records with a review trail for `/about/team`.
- CI: GitHub Actions is blocked on account billing; nothing in Stage B or this port has run through CI yet.
