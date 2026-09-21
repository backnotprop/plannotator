# Spec: Mobile Platform Foundation — Phase 1

Date: 2026-08-12
Status: Checkpoints 1A and 1B implemented; 1B accepted on physical iPhone; 1C next
Baseline: started from `origin/main` at `ef49c701c23b867cec2a5d78343813ba89d2a025`; refreshed through `356b628b6fd0e956e058ec684b103e1e68311999` before the 1B closeout
Implementation branches: `codex-mobile-phase-1-foundation`, then stacked `codex-mobile-phase-1b-input`

Related research: [`adr/research/SPIKE-mobile-web-compatibility-20260812.md`](../research/SPIKE-mobile-web-compatibility-20260812.md)

## Phase contract

Phase 1 makes Plannotator behave like a stable mobile web application before either review experience is redesigned for mobile.

It establishes one shared contract for:

- the visible Safari viewport and software keyboard;
- notch, Dynamic Island, rounded-corner, and home-indicator safe areas;
- readable text-entry controls that do not trigger iOS focus zoom;
- touch target sizing and press feedback in shared controls;
- focus, dismissal, and scroll behavior in representative overlays;
- unchanged desktop presentation when a fine pointer and keyboard are in use.

The visitor mode is **Operate**. A reviewer may arrive from a QR code while away from the development machine, with one hand, uncertain network continuity, and little patience for browser-chrome failures. The desired feeling is calm and direct: the artifact remains stable, input follows the keyboard, and controls respond where the reviewer touches them.

## Outcome and proof

At the Phase 1 gate, a reviewer must be able to open both Plan and Code Review over Tailscale on an iPhone or iPad, rotate the device, show and dismiss the software keyboard, write and submit a representative comment, and reach every control in that comment flow without the application canvas jumping, zooming, or falling behind system UI.

Proof consists of:

1. automated tests for the viewport environment calculations and cleanup;
2. production builds of both single-file applications;
3. responsive-browser evidence at the agreed reference widths;
4. a physical-device pass over Tailscale on Mobile Safari;
5. a desktop regression pass showing the incumbent composition is preserved.

This phase is complete only after the physical-device review passes. Emulation alone cannot close it.

## Scope boundaries

### In scope

- Plan/document and Code Review application roots, including loading states.
- The shared `@plannotator/ui` environment and control primitives.
- The primary plan comment composer and primary code-annotation composer.
- Shared dialog close behavior and representative modal bounds.
- Mobile Safari and iPadOS Safari; Chromium responsive mode remains a fast preflight.
- Touch-only iPad and iPad with pointer/keyboard, without forcing either into the other's layout.

### Explicit non-goals

Phase 1 does **not**:

- build the mobile document/files navigator (`MOB-001`);
- simplify the Plan header, toolstrip, or review actions (`MOB-015`–`MOB-019`);
- choose the phone Code Review composition, Unified override, or Guide default (`MOB-002`, `MOB-003`, `MOB-020`, `MOB-021`);
- modify Pierre rendering, line selection, or `DiffViewer` (`MOB-006`);
- redesign Settings (`MOB-014`);
- solve arbitrary author-page responsiveness inside raw HTML annotation (`MOB-022`);
- change server APIs, Tailscale exposure, authentication, or session lifecycle;
- optimize the single-file payload (`MOB-023`);
- introduce a new visual language, new design system, or replacement document UI.

Those remain later phases. A Phase 1 patch that starts rearranging product information architecture has exceeded its authority.

## Design and engineering invariants

1. **Content breakage determines layout; device names do not.** CSS handles geometry. Pointer and hover media features handle input affordances. JavaScript observes the visual viewport only where browser APIs expose state CSS cannot reliably provide.
2. **No disabled zoom.** The viewport declaration may add `viewport-fit=cover`, but must not set `maximum-scale=1` or `user-scalable=no`.
3. **No global desktop preference mutation.** Phase 1 does not write review layout, diff presentation, or sidebar preferences based on device width.
4. **The document remains the authority.** Foundation chrome may reserve safe space but may not restyle or reflow authored markdown, code, or raw HTML to disguise artifact overflow.
5. **Touch size may differ from visual size.** A 16 px icon can remain visually compact, but its non-overlapping interactive region must be at least 44×44 CSS px whenever `any-pointer: coarse` is present. This preserves touch safety on hybrid iPads after a trackpad is attached.
6. **No overlapping invisible targets.** When neighboring controls cannot support expanded pseudo-hit regions without overlap, the actual layout must make room. Precision is not an acceptable mobile dependency.
7. **Press feedback starts immediately.** Shared buttons expose a pressed state on pointer-down/touch-down. Hover only enhances controls under `(hover: hover) and (pointer: fine)`.
8. **Safe-area ownership is singular.** The app root owns top and lateral insets. A bottom-edge surface owns its own bottom inset. Parent and child must not both add the same inset.
9. **Keyboard adaptation does not discard work.** Opening, resizing, rotating, backgrounding, or dismissing a composer must preserve its draft and return focus/scroll to a coherent place.
10. **Shared UI remains shared.** Changes belong in `@plannotator/ui` when both applications need them. Plannotator continues to use the existing package rather than building a parallel mobile component set.

## Implementation shape

### Checkpoint 1A — Viewport and safe-area contract

#### Entry documents

Update the source HTML used by the production single-file builds:

- `apps/hook/index.html`
- `apps/review/index.html`

The viewport declaration becomes:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

The generated Hook, Review, OpenCode, and Pi assets inherit these source builds. Generated HTML files are not edited by hand. The VS Code webview is not an edge-to-edge mobile delivery surface and is not part of the physical-device gate.

#### Shared viewport observer

Add a small exported hook under `packages/ui/hooks/`, tentatively `useViewportEnvironment.ts`. It must:

- prefer `window.visualViewport` when present;
- fall back to `window.innerWidth` and `window.innerHeight`;
- write CSS custom properties on `document.documentElement` rather than causing React renders on every visual-viewport event;
- coalesce `resize` and `scroll` updates with one `requestAnimationFrame`;
- clean up listeners, a pending animation frame, and properties it owns;
- be idempotent or reference-counted so two mounted consumers cannot remove each other's document-level environment;
- tolerate tests, SSR-like imports, and browsers without `visualViewport`;
- expose a pure calculation function so the geometry is unit-testable without Safari.

The observer-owned contract is:

```css
--pn-viewport-width
--pn-viewport-height
--pn-viewport-offset-top
--pn-viewport-offset-left
--pn-keyboard-inset
```

The theme-owned safe-area contract is set directly from CSS `env()` values:

```css
--pn-safe-top
--pn-safe-right
--pn-safe-bottom
--pn-safe-left
```

`--pn-keyboard-inset` is diagnostic/layout evidence, not a promise that every virtual keyboard is rectangular. It is calculated from the layout viewport minus the visible viewport, clamped at zero. The application canvas uses the visible height; it does not translate the whole document in response to offset changes.

#### Shared CSS

Add deliberately named mobile-environment utilities in `packages/ui/theme.css`:

- `.pn-app-viewport` uses the observed visible height, with `100vh` followed by `100dvh` fallbacks before the observer value is available;
- `.pn-safe-top`, `.pn-safe-inline`, and `.pn-safe-bottom` consume only the inset they own;
- `.pn-viewport-bounded` caps overlay height to the visible viewport;
- all values retain zero-cost behavior on devices without safe-area insets.

Avoid a second mobile stylesheet and avoid app-specific copies of the same variables.

#### App integration

Call the hook once at the root of:

- `packages/editor/App.tsx`
- `packages/review-editor/App.tsx`

Replace `h-screen` on the loading and application roots with `.pn-app-viewport`. Do not replace every historical `100vh` occurrence in this checkpoint. Only roots and overlays in the primary comment journeys are authorized; unrelated popouts are inventoried for their owning phase.

#### Checkpoint review

Before proceeding to input work, review on a physical device:

- expand/collapse Safari browser chrome;
- rotate portrait ↔ landscape;
- open from a fresh Tailscale URL and return from background;
- inspect notch/rounded-corner clearance;
- compare plan and review root height against the visible viewport.

No product-layout opinion is judged here. We are checking whether the stage itself is trustworthy.

### Checkpoint 1B — Keyboard and text-entry contract

#### Mobile editable style

Define one explicit shared marker for user-authored text controls, tentatively `data-pn-mobile-editable`. When `any-pointer: coarse` is present or the viewport is compact, it guarantees a computed font size of at least 16 px. It must not enlarge code labels, counters, or read-only diff text.

Adopt the marker in the primary Phase 1 journeys:

- plan/document comment composition in `packages/ui/components/CommentPopover.tsx` and its directly used shared textarea primitive;
- the plan annotation panel's direct comment entry where it is part of the same submission journey;
- code annotation composition in `packages/review-editor/components/AnnotationToolbar.tsx`;
- expanded code-comment editing in `packages/review-editor/components/ExpandedCommentDialog.tsx` when reached from that journey.

Search, Settings, Ask AI, agent prompts, source editing, and suggestion editing remain inventoried but are not silently pulled into this phase. Their owning surface phase must adopt the same marker rather than inventing a different fix.

#### Placement bounds

Extract a shared, pure visible-viewport bounds helper instead of scattering new `visualViewport` reads. Replace `window.innerHeight` / `window.innerWidth` only in the primary composer placement paths:

- `packages/ui/components/CommentPopover.tsx`;
- `packages/review-editor/hooks/useAnnotationToolbar.ts`;
- `packages/review-editor/components/AnnotationToolbar.tsx`.

The composer must remain inside the visible viewport with safe padding. When the keyboard leaves insufficient room for an anchored popover, it should use the existing modal/overlay presentation bounded to the visible viewport; inventing the final mobile bottom-sheet design belongs to the Plan or Code Review phase.

#### Focus and dismissal

- Do not autofocus a newly opened text field on a coarse pointer unless opening it was itself an explicit “write” action.
- When an overlay closes, restore focus to its trigger when that trigger remains mounted.
- Escape remains available with a hardware keyboard.
- Backdrop dismissal must not submit or erase a non-empty draft.
- Submission remains explicit and is disabled during an in-flight request where duplicate submission is possible.

#### Checkpoint review

On iPhone and iPad:

- open a plan comment, type multiple lines, rotate, dismiss and reopen the keyboard, and submit;
- open a code annotation comment, type multiple lines, rotate, dismiss and submit;
- verify no Safari focus zoom;
- verify the caret, draft, dismiss control, and submit control remain reachable;
- verify closing the keyboard does not leave the canvas at the wrong scale or scroll position.

### Checkpoint 1C — Shared touch and dialog contract

#### Touch targets

Add a shared touch-target marker and token in `packages/ui/theme.css`:

```css
--pn-touch-target: 44px;
[data-pn-touch-target]
```

When `any-pointer: coarse` is present, the marker enforces a 44 px minimum block size and, for icon-only controls, a 44 px minimum inline size. On devices with only fine pointers it has no geometric effect.

Adopt it by default in the two existing shared button primitives:

- `packages/ui/components/ui/button.tsx` (canonical Base UI button);
- `packages/ui/components/core/button.tsx` (legacy shared primitive still in use).

Also apply it to the shared dialog close control in `packages/ui/components/ui/dialog.tsx`. Hand-authored Plan and Code Review toolbar buttons are not mass-converted in Phase 1; each later surface phase must resolve its control grouping and noise before expanding every target.

If default adoption exposes a layout that cannot accommodate correct targets, record that as evidence for the surface phase. Do not add an undocumented compact escape hatch merely to preserve a cramped mobile row.

#### Press, hover, and motion

- Shared buttons get immediate restrained press feedback without changing font weight or layout.
- Hover-only visual changes are gated to a fine hover-capable pointer where practical in the touched primitives.
- Any new transition names exact properties and has a reduced-motion equivalent.
- No spring, swipe dismissal, or translucent-sheet system is added in this foundation phase. Those require interaction prototypes and their owning surface decisions.

#### Dialog bounds

Update the shared dialog primitive so its width and maximum height account for safe areas and the visible viewport. The close affordance must remain reachable at 320 px width and with the keyboard visible. Existing Base UI focus containment and restoration remain the authority.

Do not convert every custom historical modal to the shared dialog in this phase. Record outliers for later hardening.

#### Checkpoint review

- Measure representative shared buttons and dialog close on coarse-pointer emulation and physical devices.
- Confirm the visual glyphs remain appropriately compact even when hit regions grow.
- Confirm adjacent targets do not overlap.
- Confirm touch press feedback has no sticky hover state.
- Confirm keyboard and pointer navigation on desktop are unchanged.

## Expected file map

The implementation should remain close to this map:

| Area | Expected files | Responsibility |
|---|---|---|
| Entry viewport | `apps/hook/index.html`, `apps/review/index.html` | Edge-to-edge opt-in without disabling zoom |
| Shared environment | `packages/ui/hooks/useViewportEnvironment.ts`, focused test file | Visual viewport observation and pure geometry |
| Shared styling | `packages/ui/theme.css` | Viewport, safe-area, editable, and touch-target contracts |
| Shared controls | `packages/ui/components/ui/button.tsx`, `packages/ui/components/core/button.tsx`, `packages/ui/components/ui/dialog.tsx` | Coarse-pointer targets, press state, bounded dialog |
| Plan integration | `packages/editor/App.tsx`, `packages/ui/components/CommentPopover.tsx`, possibly the directly shared annotation input | Root and primary plan comment journey |
| Review integration | `packages/review-editor/App.tsx`, `packages/review-editor/hooks/useAnnotationToolbar.ts`, `packages/review-editor/components/AnnotationToolbar.tsx`, `ExpandedCommentDialog.tsx` | Root and primary code-comment journey |

Files outside this map require a short scope justification in the implementation handoff. No server file or Pierre/DiffViewer file is expected to change.

## State and edge-case matrix

| State | Required behavior in Phase 1 |
|---|---|
| Initial phone load | Root fills the visible viewport without horizontal page overflow |
| Safari chrome expands/collapses | Root follows the visible height without a persistent blank or clipped strip |
| Keyboard opens | Active composer remains bounded; input stays at normal page scale |
| Keyboard closes | Prior artifact scroll and page scale remain coherent |
| Rotation with composer open | Draft survives; overlay recomputes its visible bounds |
| Device locks/backgrounds | Draft remains; returning does not leave stale viewport geometry |
| Hardware keyboard on iPad | Focus and Escape behavior remain available; no forced touch-only composition |
| Trackpad attached to iPad | Fine-pointer hover may enhance controls; touch still works |
| Safe inset is zero | Desktop and rectangular mobile viewports gain no phantom padding |
| Visual Viewport API absent | `innerWidth` / `innerHeight` fallback produces a usable app |
| Reduced Motion | New press/overlay feedback does not introduce motion dependence |
| 200% layout stress | Primary composer controls remain reachable; text is not clipped |

## Verification plan

### Automated

Run at minimum:

```bash
bun run typecheck
bun test <new viewport environment tests>
bun test packages/ui/components/CommentPopover*.test.tsx
bun run build:review
bun run build:hook
```

Add focused component tests for any new button/dialog prop or attribute behavior. Do not use a broad snapshot as the only proof of viewport geometry.

### Responsive browser preflight

Run both applications at:

- 320×568;
- 390×844;
- 430×932;
- 768×1024;
- 820×1180;
- 1180×820;
- 1440×900 desktop control.

At each relevant width inspect light and dark themes, root overflow, computed input font size, target geometry, modal bounds, console errors, and draft preservation.

### Physical-device gate over Tailscale

Required devices for the phase gate:

- one current notched iPhone in portrait and landscape;
- one 11-inch-class iPad in portrait and landscape;
- iPad touch-only, then with trackpad/keyboard if available.

Required network/session conditions:

- open from the advertised HTTPS URL or QR code;
- Wi-Fi tailnet path;
- device background and restore;
- host session still alive on return;
- no Funnel or public exposure.

The host commands for this phase remain explicit:

```bash
plannotator annotate <fixture.md> --tailscale --gate
plannotator review --tailscale
```

Automatic plan hooks do not gain Tailscale behavior in this phase.

### Desktop regression

At 1440×900 with a fine pointer:

- compare Plan and Review shell screenshots to the baseline;
- verify keyboard shortcuts, focus rings, popovers, and dialogs;
- verify no safe-area gap when all insets are zero;
- verify persisted panel and diff preferences are unchanged;
- verify no extra React render loop is introduced by viewport events.

## Checkpoint 1A implementation record

Checkpoint 1A establishes the browser-stage contract without changing either
surface's information architecture:

- both HTML entry points opt into `viewport-fit=cover` without disabling zoom;
- Plan and Code Review use the same `pn-app-viewport` root contract in loading
  and interactive states;
- `useViewportEnvironment` publishes observed viewport geometry as shared CSS
  properties, coalesces event work into one animation frame, reference-counts
  consumers, and restores pre-existing properties after the final cleanup;
- normal-scale Visual Viewport changes can shrink the usable stage for browser
  chrome and the software keyboard, while pinch zoom keeps layout geometry
  stable so accessibility zoom is not fought by application reflow;
- CSS safe-area tokens are available before React mounts, with singular root
  ownership for top and lateral insets and explicit opt-in for bottom surfaces.

Automated and browser preflight evidence:

- viewport unit/DOM tests: 7 passed;
- repository typecheck, including the strict `@plannotator/ui` consumer: passed;
- Plan and Code Review production builds: passed;
- responsive browser checks at 390×844 and 844×390: root geometry matched the
  viewport and neither page introduced horizontal overflow;
- desktop controls at 1280×720: both roots matched the viewport, safe-area
  padding computed to zero, and the existing compositions remained intact;
- no new console errors were observed (the Review demo still reports the
  pre-existing Pierre parser diagnostics recorded as `MOB-024`).

This record does not pass Checkpoint 1A. The required iPhone and iPad Safari
evidence over Tailscale remains the joint acceptance gate.

### Checkpoint 1A physical-device evidence

The first tailnet-published iPhone pass completed on 2026-08-12:

- Plan opened, remained readable once auxiliary chrome was dismissed, and
  returned an approved decision cleanly;
- Code Review remained reachable and its underlying stage held together, but
  the desktop multi-pane composition was unusable at phone width;
- no new blank strip, root overflow, safe-area collision, or persistent Safari
  scale failure was reported against the 1A environment contract;
- the code comment composer did not scale coherently, which directly validates
  the planned 1B keyboard/text-entry checkpoint rather than expanding 1A;
- the iPad portion of the agreed 1A gate remains untested unless explicitly
  deferred by the user.

Product hierarchy, selection, and onboarding findings from this pass are
tracked in the related research inventory and assigned to their owning surface
phase instead of being pulled into the viewport foundation.

## Checkpoint 1B implementation record

Checkpoint 1B establishes one input and overlay contract for the primary Plan
and Code Review writing journeys without changing either desktop information
architecture:

- the existing viewport observer now exposes reactive, pure visible-viewport
  bounds to overlays without installing a second set of Visual Viewport
  listeners;
- `data-pn-mobile-editable` guarantees 16 px user-authored text on compact or
  coarse-pointer surfaces, including the Plan skill-token mirror, while fine
  desktop inputs retain their incumbent scale;
- compact/coarse Plan composition uses the existing expanded comment surface,
  while Code Review line selection uses its existing expanded comment dialog;
  both remain bounded when the visible height changes;
- touch-opened composition does not force textarea focus, hardware Escape
  remains available, and fine-pointer desktop preserves its existing autofocus;
- Plan selection, code-block, global, Plan-diff, and HTML comment targets now
  receive stable draft keys; Code Review retains its existing per-range draft
  store. Backdrop/Escape dismissal preserves those drafts and explicit submit
  clears them;
- the mobile Code Review overlay keeps the existing Suggest Code route by
  handing off to the already-shipped suggestion modal rather than duplicating
  source editing inside the comment dialog.

Automated and rendered-browser preflight evidence:

- focused viewport/composer suite: 52 passed, including coarse-pointer focus,
  draft recovery, skill-mirror parity, and visible-bound geometry;
- repository typecheck and strict `@plannotator/ui` consumer: passed;
- Plan and Code Review production builds: passed;
- Plan checks at 320×568, 390×844, 568×320, 820×1180, 1180×820, and a
  390×500 keyboard-sized viewport kept the surface and submission control in
  bounds with zero page-level horizontal overflow;
- Code Review at 390×844 opened the expanded composer directly from a Pierre
  line tap without focusing the textarea. At 390×500 the 468 px dialog and its
  submit control remained fully visible; Escape closed it and reopening the
  same line restored the multi-line draft;
- desktop controls at 1440×900 retained the 384 px / 14 px Plan popover and
  the incumbent floating Review toolbar and focus behavior;
- no new Plan console warnings or errors were observed.

The first physical iPhone composer pass confirmed legible input, intentional
touch focus, and successful save, then exposed Safari-only follow-ups that
responsive Chromium did not reproduce. The entry body still claimed a
`100vh` minimum while the application used the smaller Visual Viewport,
allowing Safari to scroll the entire app upward into a blank body region when
browser chrome was visible. Hook and Review entries now lock outer overflow
and delegate scrolling exclusively to their application viewports. The next
physical pass showed that the remaining boundary around Safari's floating
bottom controls was not cosmetic. Matching the outer canvas removed the black
color, but the document still ended above browser chrome and Safari never
collapsed its controls because the gesture scrolled a nested `<main>`, not the
page. WebKit documents that body scrolling shifts Safari UI while scrolling a
vertical element intentionally leaves it still
([WebKit #240861](https://bugs.webkit.org/show_bug.cgi?id=240861)). Compact
coarse-pointer Plan layouts now use `document.scrollingElement`; shared
viewport consumers distinguish that page viewport for scroll events,
IntersectionObserver roots, geometry, TOC/hash navigation, Pinpoint, and Vim
motion. The fixed nested application shell remains the desktop path, and Code
Review keeps its existing workspace shell pending its own mobile-composition
phase. The next iPhone pass confirmed that the Plan reaches the bottom and
Safari dismisses its bottom controls, then isolated a top-edge counterpart:
the app's 48 px sticky header was partly obscured and caused Safari to preserve
an opaque background extension. WebKit documents this extension as intentional
for fixed/sticky elements adjoining an obscured browser edge
([WebKit #301756](https://bugs.webkit.org/show_bug.cgi?id=301756#c2)). On the
compact touch Plan path, the app header now scrolls in normal document flow and
both duplicate sticky action treatments are disabled; desktop retains them.
The Plan composer also suppresses its hardware-keyboard submit hint when any
coarse pointer is present; the explicit Save action remains the mobile
instruction.

### Checkpoint 1B physical-device acceptance

The final Tailscale-published iPhone pass closed the Safari-specific blocker:

- ordinary document scrolling now collapses both Safari chrome regions and
  lets the Plan continue beneath the translucent browser controls instead of
  ending at an opaque application boundary;
- the compact touch header scrolls away with the page, so Safari no longer
  preserves the solid top-edge extension associated with sticky edge chrome;
- the Plan composer is legible, opens without forcing the software keyboard,
  does not trigger focus zoom after an explicit textarea tap, and submits
  successfully;
- the user confirmed that the other previously requested input checks were
  behaving acceptably and explicitly declined a redundant checklist rerun.

Checkpoint 1B is therefore accepted for the tested physical iPhone path. This
acceptance does not erase the separately inventoried Plan-selection, Review
composition, or hierarchy defects; they belong to later product phases. A
separate physical iPad pass was not performed and remains part of the final
Phase 1 / 1C device matrix rather than reopening 1B.

## Phase 1 gate

All items are blocking unless explicitly deferred together:

- [ ] Both production applications build and open over Tailscale.
- [ ] The app root tracks Mobile Safari's visible viewport through browser-chrome changes and rotation.
- [ ] Primary plan and code-comment inputs compute to at least 16 px and do not trigger focus zoom.
- [ ] Primary composer dismiss and submit controls remain visible with the keyboard open.
- [ ] Draft text survives rotation, keyboard dismissal, overlay dismissal/reopen, and background/return.
- [ ] Root and tested edge surfaces clear safe areas in portrait and landscape.
- [ ] Shared button and dialog-close targets are at least 44×44 CSS px under a coarse pointer and do not overlap.
- [ ] No essential behavior depends on hover in the touched controls.
- [ ] Reduced-motion and hardware-keyboard paths remain functional.
- [ ] Desktop Plan and Review composition and stored preferences are unchanged.
- [ ] No new console errors, layout loops, or visible load-time regressions are introduced.
- [ ] The user has reviewed the real-device evidence and explicitly passes the phase.

## Review cadence and change control

Implementation begins only after this brief is accepted.

1. Create a `codex/mobile-phase-1-foundation` branch from the then-current `origin/main`.
2. Implement and verify Checkpoint 1A; stop for joint physical-device review.
3. Iterate 1A until accepted, then checkpoint it.
4. Repeat for 1B and 1C without pulling later-phase product decisions forward.
5. Run the complete Phase 1 matrix and present evidence plus known limitations.
6. The user either passes the gate, requests another Phase 1 iteration, or explicitly defers a named criterion.
7. Only after the gate passes do we shape Phase 2 Plan Review.

If a physical-device result contradicts the desktop emulation, physical-device evidence wins and the brief is amended before further implementation.

## Risk register

| Risk | Mitigation |
|---|---|
| `visualViewport` events cause excessive style work | Coalesce writes with one animation frame; do not store frame-by-frame geometry in React state |
| Root height updates fight Safari scroll | Change height variables only; do not translate the full app by viewport offsets |
| Safe-area padding is counted twice | Enforce the ownership rule and inspect computed box geometry on notched landscape |
| Global 16 px rule damages dense read-only UI | Mark user-authored editables explicitly; do not target every input-like visual globally |
| 44 px targets break crowded headers | Apply shared primitives now; let later phases redesign hand-authored dense groups instead of adding hidden exceptions |
| Coarse pointer misclassifies hybrid hardware | Touch correctness is additive; hover enhancements remain gated independently and desktop composition remains width/content-driven |
| Foundation grows into a sheet framework | Use the existing overlay presentation for representative flows; prototype sheets in the owning surface phase |
| Published `@plannotator/ui` consumers regress | Keep behavior capability-gated, export the shared contract, typecheck the strict consumer, and build the package CSS |

## Readiness decision

This brief is implementation-ready once the user confirms the scope boundary: Phase 1 hardens the mobile browser stage and two representative writing journeys, while Plan and Code Review information architecture remain untouched until their dedicated phases.
