# DESIGN-SPEC — Poofyco Reference Study

> **Historical reference only — superseded.** This study documents an earlier
> third-party visual reference and must not be used as the current HKSCDA design
> direction. The approved identity is primary blue `#05648E`, accent magenta
> `#A61C56`, Noto Sans HK, warm neutral surfaces, a roughly 1200px/12-column
> layout, an 8px spacing scale, and 8px/16px/pill radii. See
> `docs/brand-guidelines.md` and `brand/design-tokens.{json,css}`.
>
> In particular, the Poofyco rose/navy palette, Baloo typography, 25px dominant
> radii, dashed-card motif, and copied template compositions below are not
> approved implementation requirements. They remain here only as provenance.


Source: https://kitpro.site/poofyco/ (live demo behind the ThemeForest preview at
`themeforest.net/item/...55964358`; the preview wrapper is Cloudflare-gated, so the
vendor demo was studied directly).

Method: Chrome DevTools protocol — DOM + computed-CSS extraction, stepped-scroll
observation at 1920/1024/390 viewports, Swiper API introspection, stylesheet keyframe
and media-query parsing. The full-page captures were removed in the 2026-10-26
docs cleanup; the measurements below remain the record.

> Note: requested via Playwright MCP; it was registered mid-session so its tools were
> not yet loadable. Chrome DevTools MCP is the same engine (CDP) and produced identical
> data. All numbers below are measured, not eyeballed.

---

## 1. MOVEMENT

### Scroll behavior

- **No parallax, no scroll-jacking, no sticky elements.** Header is `position:
relative` at every scroll depth — it scrolls away. Zero `motion_fx` (Elementor
  motion effects) in any `data-settings`. The page reads as _calm_: movement comes
  only from entrance reveals and two slow carousels.
- **Reveal-on-enter, once.** 37 elements start `.elementor-invisible` (opacity 0)
  and reveal when they intersect the viewport. Measured reveal waves at scroll
  positions (1920×800 viewport): y=0 → 37 hidden, y≈400 → 35, y≈1600 → 24,
  y≈3200 → 14, y≈4800 → 9, bottom → 8 (the remaining 8 are responsive-only
  variants that never display on desktop). Reveals never replay on scroll-up.
- **Trigger geometry:** elements fire as their section's content area enters the
  viewport (Elementor waypoint default ≈ element top crossing ~viewport bottom
  − small offset). Whole logical groups (a heading + its paragraph + its button)
  fire in the same wave.

### Hover / cursor interactions

- **No custom cursor.** All interaction is conventional hover.
- **One global hover transition** carried by 169 elements:
  `transition: background .3s ease, border .3s ease, box-shadow .3s ease,
transform .4s ease`. Hover effects are **color swaps and soft shadows** —
  cards do NOT lift/translate. The 0.4s transform slot is used by:
  - nav menu pointer effects (underline/frame `scale(0)→scale(1)` on hover)
  - gallery captions sliding up `translateY(100%)→0` inside image bounds
  - occasional `translateY(±8px)` float/sink on menu text variants
- **Buttons:** pill (`border-radius: 99px`, `padding: 20px 40px`), `all .3s ease`
  background/text color swap on hover. No scale, no shadow growth.

### Reveal timing (the "feel")

- Reveal = `fadeInUp`, `1.25s`, `ease`, fill-forwards, once per element.
- The travel distance is `translate3d(0, 100%, 0)` — **100% of the element's own
  height**, so small captions barely drift while photos travel far. This is why the
  page feels soft and slightly "bouncy-slow" rather than snappy.
- **No programmed stagger** — every reveal has `animation-delay: 0s`. The cascade
  you perceive is purely elements at different page depths entering the viewport
  at different times during the same 1.25s window.
- One accent exception: the video play button reveals with `zoomIn` (1.25s ease).

---

## 2. GRID

### Column system

- **Boxed container: `min(100%, 1300px)`**, centered (`--container-max-width: 1300px`).
- **Universal gutter: 20px** (`--widgets-spacing: 20px 20px`). Almost every flex
  gap on the page is exactly 20px; one exception is the photo marquee (53px).
- Layout engine is flex containers (Elementor `e-con`), not CSS grid:
  - Hero: 3 columns in a row (content ~420px / pets photo / rating chip),
    hero section top padding **197px** (clears the absolutely-floating pill nav).
  - Feature band: 3 equal columns with **dashed vertical separators** between them,
    full-bleed indigo `rgb(11,5,76)` background.
  - "Best rescue": 2 asymmetric columns (~575px media / content), then a 4-up
    stat row (rose numbers, small grey labels).
  - Community gallery: photo marquee, ~3 cards visible, 25px radius images.
  - Adoption steps: 4 equal cards in a row; card 1 is the "active" indigo variant;
    ghost step numbers (01–04) oversized, low-contrast, top-right.
  - Fundraising: 2 columns — content+photo left, indigo form card right.
  - Testimonials: 2-up slider + heading column to the right.
  - Articles: 3 equal cards.
  - Footer: offset logo panel (lighter indigo box overlapping the footer top-left),
    4 link columns, then a **47px salmon strip** (copyright) as the page's last band.

### Card language

- Card radius: **25px** dominant (29 uses); pills `999px` / `99px` (17 uses);
  large arch/blob shapes on feature photos (`222px`, `30px` mixes).
- **Dashed borders are the signature**: adoption-step cards, FAQ wrapper, and
  vertical separators all use 1px dashed in muted lavender/grey.
- Section rhythm: large sections are 500–1100px tall with generous internal
  padding (e.g. 62px/52px), all spacing in multiples of ~4 with 20px as the beat.

### Responsive reflow

- Elementor stock breakpoints: **≤1024px (tablet), ≤767px (mobile)**
  (media queries confirmed in compiled CSS; a few widget-level 480px rules).
- At **1024**: multi-column rows collapse to single column (measured: the 2-col
  "best rescue" and 4-col steps both become 1-per-row); only the hero keeps its
  3-in-row trio briefly. Content width ≈ 964px → fluid.
- At **390**: everything is one centered column; H1 drops 64px → **44.8px**
  (same 1.1 line-height); hero top padding 197px → 0; text and CTAs center-align;
  the cut-out pets photo keeps overlapping the indigo band below (signature kept
  on mobile).
- Order on mobile: headline → paragraph → CTA pair → social-proof counter →
  rating chip → cut-out photo → feature band.

---

## 3. ANIMATION

### Entrance animations

- **One motif everywhere: `fadeInUp` 1.25s ease** (`0% { opacity:0;
translate3d(0,100%,0) } 100% { opacity:1; transform:none }`), once, on viewport
  entry. ~47 elements; applies equally to headings, text blocks, buttons, images,
  and whole sub-containers.
- Single accent: `zoomIn` 1.25s on the hero video play button.
- The kit's CSS ships hundreds of unused keyframes (jkit/ekit libraries);
  only the two above (plus UI-chrome spinners) actually run. **Restraint is the
  design decision.**

### Stagger / sequence

- No `animation-delay` anywhere (all 0s). Sequencing = document order + viewport
  geometry. Replicating the feel does NOT require orchestration tooling — it
  requires per-element (not per-section) reveal triggers.

### Easing & durations (complete palette)

| Use                                      | Duration                     | Easing                        |
| ---------------------------------------- | ---------------------------- | ----------------------------- |
| Entrance reveals                         | 1.25s                        | `ease`                        |
| Hover color/border/shadow                | 0.3s                         | `ease`                        |
| Hover transforms (captions, nav pointer) | 0.4s                         | `ease`                        |
| Photo marquee slide                      | 7000ms per snap, 500ms dwell | linear-feel glide             |
| Testimonial slide                        | 1000ms                       | swiper default (ease-out-ish) |

No cubic-bezier customs anywhere — the kit lives entirely on `ease` + durations.

### Looping motifs

- **Photo marquee** (community gallery): Swiper, `slidesPerView: 2 (≈3 visible
with peek), spaceBetween: 53, speed: 7000, autoplay delay: 500, loop: true` —
  i.e. a near-continuous slow conveyor of rescue photos.
- **Testimonials:** Swiper, 2-up, `speed: 1000, autoplay: 3000, loop: false`,
  dot pagination.
- No other infinite animations run (verified: zero `animation-iteration-count:
infinite` elements outside UI chrome at every scroll depth).

### Color/type tokens observed (for cross-checking, already in our brand)

- Indigo `rgb(11,5,76)`, rose/salmon `rgb(236,133,142)`, body grey
  `rgb(65,66,67)`, cool surface `rgb(240,243,247)`, lavender-blue top bar
  `rgb(210,220,232)`.
- Poppins 700 display: H1 64/70.4, H2 44.8/49.28, H3 22.4/24.64; body 16/24;
  buttons Roboto 500 15px. (Our equivalent: Baloo 2 + Noto Sans HK.)

---

## 4. RE-IMPLEMENTATION MAP (existing stack only — no copied assets/code)

Stack available: React 19 + TanStack Start, Tailwind v4 (CSS-first), shadcn/ui,
`embla-carousel-react` (already used in `VolunteerCarousel.tsx`), `tw-animate-css`,
existing tokens in `src/styles.css`. **No new dependencies required.**

| Reference effect                                       | Our implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reveal-on-enter `fadeInUp` 1.25s ease, once            | Small `useReveal` hook (one shared `IntersectionObserver`, `unobserve` after fire) toggling a class; CSS in `styles.css`: `.reveal { opacity:0; translate:0 40px } .reveal-in { transition: opacity 1.25s ease, translate 1.25s ease; opacity:1; translate:0 }`. Fixed 40px travel instead of 100%-of-height (same perceived motion on text/cards, avoids huge jumps on tall images; can use 64px for media blocks). Gate with `@media (prefers-reduced-motion: reduce)`. |
| Per-element cascade, no delays                         | Apply the hook per element (heading, paragraph, button each) exactly like the reference — not per section. No orchestration library needed.                                                                                                                                                                                                                                                                                                                               |
| `zoomIn` accent on video button                        | Same hook with a `variant="zoom"` class (`scale(.6)→1`).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Hover language (color/shadow only, no lifts)           | Tailwind utilities standardized: `transition-[background,border-color,box-shadow] duration-300` on cards/buttons, `duration-[400ms]` for transform-based bits (caption slide-ups). Encode once as small `@utility` entries in `styles.css`.                                                                                                                                                                                                                               |
| Nav pointer underline grow                             | CSS `::after` scale-x 0→1, `transition: transform .4s ease` on Header links.                                                                                                                                                                                                                                                                                                                                                                                              |
| Photo marquee (7000ms conveyor)                        | **Pure CSS marquee** — duplicated track + `@keyframes marquee { to { translate: -50% 0 } }`, `animation: marquee 40s linear infinite`, `:hover { animation-play-state: paused }`. Closer to the linear glide than embla autoplay, zero JS. (Alternative: embla + its auto-scroll plugin = new dep — not needed.)                                                                                                                                                          |
| Testimonial 2-up autoplay slider                       | Existing `embla-carousel-react` (pattern already in `VolunteerCarousel.tsx`); autoplay via a 3000ms `setInterval` → `scrollNext()` with pause-on-hover (no plugin). 1000ms feel via embla's `duration: 25`.                                                                                                                                                                                                                                                               |
| Stat counters (rose numbers)                           | `useCountUp` hook driven by the same IntersectionObserver (800ms, `requestAnimationFrame`), fires once. `AdoptionChart`/`StatCard` already exist to receive it.                                                                                                                                                                                                                                                                                                           |
| 1300px boxed / 20px gutter                             | Already close: keep our `container-wide`; align section gaps to a `--gap-grid: 20px` token.                                                                                                                                                                                                                                                                                                                                                                               |
| Dashed-border signature                                | Already present (`card-dashed` utility) — extend to step separators.                                                                                                                                                                                                                                                                                                                                                                                                      |
| 47px salmon strip, ghost step numbers, cut-out overlap | Static CSS, already partially present in our sections; itemized in build plan.                                                                                                                                                                                                                                                                                                                                                                                            |

### Accessibility / performance constraints for the build

- All reveals and marquee respect `prefers-reduced-motion: reduce` (show final state,
  pause marquee).
- Reveals must not shift layout (`opacity`/`translate` only, never `height/top`).
- One shared IntersectionObserver instance; `unobserve` after reveal (matches
  "once" semantics and keeps scroll cheap).
- SSR (TanStack Start): elements render visible by default and only get the
  pre-reveal class after hydration when JS is available — no flash-of-hidden-content,
  no SEO penalty.

