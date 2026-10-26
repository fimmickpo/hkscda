# Public route parity

> **Historical snapshot — not current.** This document was generated from an
> earlier working tree (27 routes). As of 2026-10-26 the tree has about 30 public
> page routes; `/internships`, `/supporter` and `/volunteer/operations` are not
> listed below. Use `docs/project-overview.md` and `src/routes/` as the current
> map, and treat the counts in this file as historical.

Generated from the working tree by inspecting each route, not written by hand.
Every column is read out of the route source, so this records what the code does
rather than what the plan intends.

Scope: the 27 public routes. `__root`, `/robots.txt` and `/sitemap.xml`
are shell and machine routes, listed separately below.

## Status at a glance

- Routes reframed onto the ported design system: **27 of 27**
- Routes still reading primary data in the browser: **0**
- Content routes missing a canonical: **0**
- Token routes correctly withholding a canonical: **3 of 3**
- Token routes declaring noindex: **3 of 3**

## Per route

| Route | WP | Design system | Data | States | Canonical |
|---|---|---|---|---|---|
| `/` | WP-2 | yes | loader | no | yes |
| `/animals/cat` | WP-3 | yes | loader | yes | yes |
| `/animals/dog` | WP-3 | yes | loader | yes | yes |
| `/animals/cat/$id` | WP-3 | yes | loader | yes | yes |
| `/animals/dog/$id` | WP-3 | yes | loader | yes | yes |
| `/adoption/instructions` | WP-4 | yes | loader | yes | yes |
| `/adoption/apply` | WP-4 | yes | static | no | yes |
| `/adoption/status/$token` | WP-4 | yes | static | no | correctly absent |
| `/sponsors` | WP-5 | yes | loader | yes | yes |
| `/sponsors/$id` | WP-5 | yes | loader | yes | yes |
| `/sponsors/pledge` | WP-5 | yes | static | no | yes |
| `/sponsors/status/$token` | WP-5 | yes | static | no | correctly absent |
| `/donate` | WP-5 | yes | loader | no | yes |
| `/volunteer` | WP-5 | yes | static | no | yes |
| `/volunteer/group` | WP-5 | yes | static | no | yes |
| `/volunteer/status/$token` | WP-5 | yes | static | yes | correctly absent |
| `/stories` | WP-6 | yes | loader | yes | yes |
| `/stories/$slug` | WP-6 | yes | loader | yes | yes |
| `/knowledge` | WP-6 | yes | loader | yes | yes |
| `/help` | WP-6 | yes | static | no | yes |
| `/report/adoption` | WP-6 | yes | loader | yes | yes |
| `/report/audit` | WP-6 | yes | loader | yes | yes |
| `/about` | WP-6 | yes | loader | no | yes |
| `/about/cccp` | WP-6 | yes | static | no | yes |
| `/about/tnr` | WP-6 | yes | static | no | yes |
| `/about/team` | WP-6 | yes | loader | yes | yes |
| `/about/privacy` | WP-6 | yes | static | no | yes |

### Column meanings

- **Design system** - renders through `PublicPageFrame`, `AnimalListingPage`,
  the home modules, or the ported hero and container classes. `no` means the route
  keeps its pre-port markup: it inherits the shared tokens and the shell, so it is
  visually consistent, but its section structure is not the design source layout.
- **Data** - `loader` means server rendered in the first response.
  `browser query` means the first paint carries no data.
- **States** - declares a pending component, an error component, or an empty state.
- **Canonical** - for the three capability-token routes the correct value is
  *absent*. Section 7 requires that a token URL never becomes canonical, never
  enters the sitemap, and never reaches analytics, so those rows read
  `correctly absent` and would read `MUST NOT have one` if one were added.

## Shell and machine routes

| Route | Purpose | Notes |
|---|---|---|
| `__root` | Public and admin shell | `.site-shell` wraps public content, `.admin-shell` wraps admin; skip link and the `data-site-content` marker live here |
| `/robots.txt` | Crawler policy | Route generated; registered in the route tree |
| `/sitemap.xml` | Index surface | Route generated; excludes token routes |

## Contracts held across the port

- URLs, route filenames and query parameter names are unchanged. The only
  addition is `gender` on the two species listings, approved as decision D-4 under
  the PR #60 name rather than the design source `sex`.
- Loader and action signatures, `/api/*` request and response shapes, Zod schemas,
  domain services and repositories are untouched.
- Shortlist localStorage keys and the application and pledge draft keys are unchanged.
- No `supabase/` change, no migration, no RLS or Storage policy change.

## Known gaps

Open by design; each belongs to work that has not run yet.

- BP-3's `board_member` migration (`supabase/migrations/20260829120000_governance_board_members.sql`)
  has not yet been applied to the live database as of this commit. Until it is, the
  loader's query against `board_member` will fail rather than return zero rows, so
  `/about/team` will show its temporarily-unavailable error state, not an empty
  state. Once the migration is applied, real board data (or a genuine empty state
  if none exists yet) will show correctly.
- The brand verifier cannot pass in CI against an empty database: it discovers
  detail routes from listing pages, so with no rows it probes synthetic ids. That
  is a gate design decision, not a route defect.
- `container-wide` (the pre-design-system container utility) is still used in
  roughly 20 files — mostly pending/error/skeleton states that every group in
  this port deliberately left untouched, plus a few shared components. Not
  tracked as a per-route gap since it doesn't affect any route's `yes` status;
  worth a dedicated sweep if full class-level consistency ever matters.
