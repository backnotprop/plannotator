# Synthesis: Mobile Feedback Triage and Phase Sequence

Date: 2026-08-12
Status: Phase 2A implementation accepted as the working mobile baseline;
filename micro-gate pending in parallel, Phase 2B.2 ready for physical review
Source dossier: [`SPIKE-mobile-web-compatibility-20260812.md`](./SPIKE-mobile-web-compatibility-20260812.md)
Foundation spec: [`mobile-platform-foundation-phase1-20260812.md`](../specs/mobile-platform-foundation-phase1-20260812.md)
Phase 2B spec: [`mobile-plan-shell-phase2b-20260813.md`](../specs/mobile-plan-shell-phase2b-20260813.md)

## Decision

The accumulated physical-device review is sufficient. Do not ask the reviewer
to repeat the Phase 1B composer checklist. The Safari stage failure was the
blocking defect, and the final iPhone pass confirmed its correction.

Work now proceeds in this order:

1. **Phase 1C — shared touch and dialog contract.** Finish the small,
   capability-gated foundation without rearranging either product surface.
2. **Phase 2A — mobile Code Review shell and arrival.** Replace the minified
   desktop composition with one primary phone surface and transient secondary
   navigation/context.
3. **Phase 2B — mobile Plan shell and navigation.** Reduce persistent Plan
   chrome, restore the blocked folder/multi-file path, and stabilize edit and
   completion controls.
4. **Phase 3 — touch selection and annotation semantics.** Prototype and
   validate multi-block Plan selection and multi-line Pierre selection as
   dedicated interactions.

This order is not a ranking of product importance alone. It separates shared
mechanical safety from information architecture, then separates layout from
the harder selection semantics. That keeps every review gate understandable
and prevents a phone workaround from mutating desktop preferences.

## Closed or already moving in parallel

| Area | Disposition | Evidence / constraint |
|---|---|---|
| Tailscale installation and HTTPS Serve | Working | Physical iPhone sessions opened through the tailnet and returned real Plan and Review feedback. |
| Mobile Safari page stage | Closed in 1B | Body scrolling and non-sticky compact Plan chrome now allow both Safari control regions to collapse; the user passed the result. |
| Primary comment composition | Closed in 1B | 16 px authoring text, deliberate touch focus, visible-viewport bounds, draft recovery, and explicit Save are implemented. |
| Release / first-use noise | Parallel stack already implemented | The release promo became a compact Grid/Clean decision; Vim, Ask AI, and analysis-layer startup announcements no longer mount. Features remain in Settings and their real surfaces. |
| New-user Code Review panel default | Merged independently | `origin/main` includes the Tree-first change. Mobile presentation must not overwrite that desktop-first product default. |
| Guided Review intro | Preserve | The reviewer found the initial Guide explanation useful. Guide is a strong candidate for mobile comprehension, not noise to remove. |
| Edit Code to Suggest | Preserve | The tested dialog was acceptable; suggestion editing is not pulled into the next layout phase. |
| All Files | Preserve and learn from | It was the cleanest Code Review presentation observed on the phone. |

## Phase 2B physical feedback incorporated

The first 2B.1 phone pass clarified that restoring folder navigation was not
enough: once a file was selected, the Plan still exposed its entire desktop
annotation matrix plus Wide / Focus / Edit micro-links. The reviewer also asked
for Plan completion decisions to follow the Code Review pattern and move into
Options.

This feedback is assigned to 2B.2 and implemented as one compact document-
chrome contract:

- arrival shows one `Annotate · <method>` entry instead of Select / Pinpoint
  beside Markup / Comment / Redline / Label;
- compact targeting is always presented through Markup semantics, with Select
  text and Pinpoint as the only up-front acquisition choices;
- compact method choices remain session-only, protecting desktop preferences;
- Wide and Focus are removed from compact touch entirely;
- Edit moves into Options and gains a normal-flow Save / Done / Cancel row while
  active; and
- terminal decisions move into Options while calling the exact incumbent
  handlers and warning paths.

No Phase 3 multi-block or multi-line selection semantics are claimed by this
cleanup. Pinpoint one-block targeting and native drag selection remain the
known input foundations for the 2B.2 physical gate.

The next iPhone folder pass exposed one state-transition defect inside 2B.1:
file selection closed the navigator, then asynchronous linked-document
activation replayed the desktop “open Files sidebar” behavior and resurrected
the compact navigator. That close/reopen sequence caused the visible flashing
and forced the reviewer to use X before seeing the selected document. Compact
activation now suppresses that desktop-only side effect; the selected filename
and document render with the navigator remaining closed, while fine-pointer
desktop keeps its incumbent sidebar activation.

## Triage matrix

`Now` means the next implementation checkpoint. `Next` is the first structural
surface phase. `Later` means deliberately deferred, not forgotten.

| Owner | Findings | Severity | Why grouped here | Disposition |
|---|---|---:|---|---|
| Closed in Phase 1B | MOB-010, MOB-031 | P1 | Safari page-stage and primary composer defects passed the physical iPhone gate. They remain regression contracts, not open design work. | **Closed / protect** |
| Phase 1C: shared touch/dialog | MOB-005, shared portion of MOB-012, shared dialog portion of MOB-014/MOB-030/MOB-032 | P1 | Undersized shared controls and unbounded shared dialogs are mechanical platform defects. Fixing the primitives first gives later layouts safe components without deciding their IA. | **Now** |
| Phase 2A: Review shell/arrival | MOB-002, MOB-003, MOB-017, MOB-020, MOB-021, MOB-030, MOB-032, MOB-033 | P1 | These are one failure: desktop workspace regions remain simultaneous on a phone. Fixing panels separately would preserve the wrong composition. | **Next** |
| Phase 2B: Plan shell/navigation | MOB-001, MOB-004, MOB-013, MOB-015, MOB-016, MOB-018, MOB-019, MOB-028 | P0/P1 | Plan reading now works, but navigation, editing completion, auxiliary arrival state, and persistent annotation chrome still fail or dominate. Folder navigation is the only current P0. | **After 2A** |
| Phase 3A: Plan touch selection | MOB-008, MOB-009, MOB-029 | P1 | Pinpoint proves tap targeting can work, but ordinary native selection conflicts with Safari and multi-block intent has no interaction model. This needs prototypes, not CSS. | **Later, prototype first** |
| Phase 3B: Review touch selection | MOB-006, MOB-007 | P1 | Single-line selection works; extending a range does not. Pierre rendering and line mapping are regression-sensitive and need their own guarded physical-device gate. | **Later, Pierre-guarded** |
| Surface hardening | MOB-011 secondary inputs, MOB-014 Settings, MOB-022 HTML, MOB-024 diagnostics | P2 | These are real but should adopt the shared contract within their owning surfaces rather than expanding the first structural phase. | **Later** |
| Delivery/performance/trust | MOB-023, MOB-025, MOB-026, MOB-027 | P1/P2 | Payload, tailnet trust, hook handoff, and reconnect behavior are cross-cutting delivery work, not layout work. They can be researched in parallel without changing current mobile IA. | **Independent track** |

## Immediate next implementation: Phase 1C

### Outcome

Shared buttons and shared dialog close controls are physically safe to touch,
shared dialogs remain reachable inside the visible Safari viewport, and fine-
pointer desktop geometry is unchanged.

### In scope

- Introduce the shared `--pn-touch-target` token and
  `data-pn-touch-target` marker.
- Apply coarse-pointer 44×44 minimum hit regions to the two incumbent shared
  button primitives and the shared dialog close control.
- Bound the shared dialog primitive to the visible viewport and safe-area
  contract established in 1A/1B.
- Gate hover-only effects to hover-capable fine pointers in touched primitives.
- Provide immediate, restrained press feedback and a reduced-motion path.
- Convert only representative shared dialogs needed to prove the contract.
- Verify iPhone and iPad geometry, including hybrid iPad touch plus pointer.

### Explicitly out of scope

- No mass expansion of every hand-authored Plan or Review toolbar control.
- No Plan toolstrip redesign, bottom action bar, or mobile navigation.
- No Code Review panel, Dockview, header, Guide, or diff composition change.
- No Split/Unified preference write based on viewport.
- No Pierre, `DiffViewer`, line-selection, or suggestion-editing changes.
- No new sheet system or visual language.

### Implementation seam

The expected source boundary remains:

- `packages/ui/theme.css`
- `packages/ui/components/ui/button.tsx`
- `packages/ui/components/core/button.tsx`
- `packages/ui/components/ui/dialog.tsx`
- focused component and geometry tests

If a correct 44 px target breaks a dense hand-authored row, record it for its
surface phase rather than introducing an undocumented compact exception.

### Gate for the next joint review

The checkpoint is ready for review when:

- representative button and dialog-close hit boxes measure at least 44×44 on
  a coarse pointer and do not overlap;
- a shared dialog at 320×568, 390×844, and keyboard-reduced height keeps its
  close control and primary action reachable;
- press feedback appears on touch-down without leaving sticky hover styling;
- reduced-motion and hardware-keyboard dismissal remain functional;
- iPad portrait/landscape and a touch-plus-trackpad path remain usable;
- desktop screenshots and computed geometry show no layout change under a
  fine pointer;
- production Plan and Review builds, focused tests, and typecheck pass.

The reviewer should expect a short physical-device check of representative
controls and one shared dialog—not another end-to-end Plan or Code Review
critique.

### Phase 1C implementation checkpoint

Implementation is complete on `codex/mobile-phase-1c-touch-dialog` and ready
for the short physical-device gate above. The shared contract now:

- marks both incumbent button primitives and the shared dialog close control;
- applies the 44 px minimum and immediate press feedback only when a coarse
  pointer exists, with a non-animated reduced-motion state;
- guards touched hover treatments behind hover-capable fine pointers;
- centers portaled shared dialogs inside the reactive visible-viewport and
  safe-area stage from Phase 1A/1B; and
- migrates `ConfirmDialog` to that shared primitive while preserving its
  non-dismissible backdrop and Command/Ctrl+Enter behavior. The migration also
  intentionally improves desktop accessibility by containing focus, focusing
  the safe Cancel action first when present, and restoring the opening control.

Responsive browser preflight found no horizontal overflow and kept the real
Plan confirmation popup within 16 px visible-stage padding at 320×568,
390×844, 390×500 keyboard-height, 844×390 phone landscape, 768×1024 iPad
portrait, and 1180×820 iPad landscape. At 1280×720 with a fine pointer, the
incumbent Plan header controls remained 138.17×28 px and 92.54×28 px, matching
the pre-change measurements. Browser emulation does not expose a coarse input
device, so the 44×44 hit region, touch-down state, and hybrid iPad path remain
the deliberate physical-device acceptance check rather than a claimed browser
result.

## Phase 2A preview: mobile Code Review shell and arrival

Phase 2A is the first structural redesign. Its job is to make the review
artifact, not the desktop workspace, own the phone viewport.

### Fixed principles

- One primary full-width surface at a time on phone.
- Tree remains the best new-user desktop default and is never overwritten by a
  mobile presentation decision.
- File navigation, PR context, annotations, AI, and agents become transient
  phone surfaces instead of flex siblings that squeeze the diff.
- Empty PR sections do not render structure merely to announce absence.
- The phone header exposes location, navigation, and one contextual action;
  desktop-only controls move behind progressive disclosure.
- A phone-friendly Unified presentation may be a session/device override, but
  it must not rewrite the user's desktop Split preference.
- Guide and All Files are the two strongest observed mobile starting points.
  The entry decision should be made through working prototypes and physical
  review, not assumed from responsive screenshots.

### Phase 2A review gate

Before implementation is accepted, the reviewer will compare at least two
working phone compositions using the same GitHub PR:

1. artifact-first All Files / Unified arrival;
2. Guide-first arrival with a direct route to the raw diff.

The chosen composition must preserve desktop behavior, make file/PR context
reachable without narrowing the artifact, keep the destination decision fully
visible, and support a complete single-line comment and approve/send journey.
Multi-line touch selection is explicitly evaluated in Phase 3, not used as a
gate for the shell.

### Phase 2A implementation checkpoint

The first implementation is complete on `codex-mobile-phase-2a-review-shell`.
The initial physical iPhone pass did not pass the phase gate: it confirmed the
artifact-first direction, but exposed review chrome and Safari-stage problems
that responsive Chromium could not reproduce. The iteration keeps the same
artifact-first option
while keeping the existing Guided Review takeover directly reachable from the
compact Options menu, so both candidate reading compositions can be compared
against the same review.

The compact shell activates only when the viewport is at most 1024 px wide and
the device exposes a coarse pointer. A narrow fine-pointer desktop window keeps
the desktop workspace. Within the compact shell:

- PR and local reviews arrive in full-width All Files instead of opening the
  tree or PR overview beside the diff;
- Unified is the initial session presentation, but changing it on the phone is
  session-only and never writes the saved desktop Split/Unified preference;
- Git status, Tree, Commits, PR context, and file navigation occupy one
  full-stage transient navigator and close after a destination is chosen;
- annotations, AI, and Review Agents occupy a separate full-stage transient
  surface instead of becoming a fixed flex sibling;
- the header is one 52 px three-column row: navigation, a geometrically centered
  review location, and Options. Destination, Exit, Send/Post, Approve, Guide,
  and secondary tools move into that menu instead of competing for phone width;
- the 33 px dock strip contains tabs only on compact touch. Its prior 44 px cog
  target physically overflowed the strip into the first file header;
- compact file headers are 44 px rows containing collapse, path, status, and
  change counts only. Viewed, Git Add, semantic/call-flow badges, experimental
  Edit, and Open-in-app remain desktop actions rather than mobile file chrome;
- the destination coachmark is not mounted on compact touch because its
  destination decision now lives directly in Options;
- the platform submission dialog uses the shared visible-viewport Dialog,
  does not raise the software keyboard on arrival, keeps authoring text at
  16 px, scrolls long recovery detail, and pins its terminal actions; and
- the expanded review composer is capped at 28 rem while idle and expands only
  as the visible keyboard viewport requires, instead of covering the full phone
  before authoring begins;
- raw diffs retain Pierre's bounded, nested scroll viewport. A compact-only
  page-scroll proxy was implemented and then rejected during the physical
  iPhone pass: the document advanced while Pierre's virtual window stopped,
  leaving a frozen diff followed by a large blank region, and the sticky review
  stage preserved the opaque Safari top extension. The proxy was removed
  immediately to restore reliable file scrolling. Safari chrome contraction
  for a virtualized review remains open design work rather than a shipped claim;
  and
- PR overview uses Summary/Comments as mutually exclusive compact regions.
  Empty discussion renders no Comments region at all. This last removal also
  intentionally improves desktop by eliminating an empty structural panel.

No Pierre library source, line mapping, touch range selection, suggestion
editor, server, Tailscale, or persisted desktop panel-default code changed. The
All Files integration supplies a compact-only 44 px header metric while its
existing nested CodeView scroller remains the source of truth. Tree remains the
desktop first-use default.

Automated proof includes the compact-touch detector and listener cleanup,
session-only diff-style routing, visible-viewport destination/submission
surfaces, exact PR discussion inclusion rules, empty desktop discussion, and
single-region compact PR context. The production Review build, shared
typecheck, focused DOM tests, and diff whitespace checks pass.

Rendered preflight covered 320×568 and 390×844 phone stages, an 820×1180 tablet
stage, and a 1280×720 fine-pointer desktop control. The compact header remained
52 px, both transient surfaces exactly occupied the remaining app stage, file
selection closed navigation, and no page-width overflow was measured. The
desktop control retained its 37 px header and 256 px file tree. Browser
preflight cannot close the real touch, Safari chrome, tailnet PR, or hybrid
iPad gate; those remain the reviewer's acceptance pass.

#### Physical review script

Open the same GitHub PR through Tailscale on iPhone, then iPad if available:

1. Confirm arrival is All Files, full width, and Unified; the tree and PR panels
   must not already be open. Scroll continuously through several files. There
   must be no frozen virtual window, large blank tail, snap to the beginning, or
   loss of touch scrolling. Safari's top chrome and opaque extension are a
   recorded open blocker for the next design iteration, not a pass condition
   for this rollback check.
2. Confirm the phone header contains only Review navigation, a centered review
   location, and Options. Open Options and verify destination, Exit,
   Send/Post (when feedback exists), and Approve are reachable there.
3. Confirm the dock tab row has no cog/collapse cluster overlapping the first
   file. The compact file header should show only collapse, path, status, and
   change counts — no Open-in-app dropdown or desktop badges/actions.
4. Open Review navigation, move between a file, All Files, and PR overview, and
   confirm each choice returns to a full-width primary surface.
5. In PR overview, confirm an empty discussion has no Comments control; when
   discussion exists, switch between Summary and Comments without splitting
   the screen.
6. Open Options → Guided Review, read one chapter, then return to the raw diff.
7. Open Annotations (and AI/Agents if available) from Options, confirm the
   surface replaces rather than squeezes the diff, then close it.
8. Select one code line and open a comment. Before focusing the textarea, the
   expanded composer should occupy a useful card-height region rather than the
   entire phone. After focus, confirm it yields to the keyboard, text stays at
   16 px, and the terminal action remains reachable. Save the comment, then
   open Post Comments or Approve.
9. Rotate once and confirm no rail or prior transient surface reappears. On a
   desktop reload, confirm Tree and the saved diff style are unchanged.

Range accumulation and multi-line touch selection are observations only in
this gate; they remain Phase 3 work.

#### Phase 2A physical closeout status

The physical iPhone iteration established a stable baseline:

- the page-scroll proxy failed decisively (frozen virtual window plus a large
  blank tail) and was removed rather than patched around;
- the restored Pierre-owned scroller was judged “much, much better,” and
  continuous file scrolling works again;
- the reviewer characterized the resulting application behavior as “pretty
  good” and accepted the remaining Safari top-chrome behavior as a deferred,
  isolated experiment rather than grounds for another renderer migration;
- compact app/dock/file chrome and the comment composer remain in the Phase 2A
  baseline; and
- the final filename complaint was addressed by replacing the hard 14–32
  character basename cut with Diffshub-style full-path, leading-ellipsis
  treatment. That visible filename treatment is the only remaining micro-gate.

Do not reopen the rejected scroll architecture during Phase 2B. A future
document-native Pierre Virtualizer experiment, if pursued, must remain isolated
and earn promotion through complete interaction parity plus physical testing.

## Phase 2B.1 implementation checkpoint

Checkpoint 2B.1 is implemented on `codex/mobile-phase-2b-plan-shell`. It keeps
the Phase 1 document-scroll owner and introduces a session-only compact
foreground state instead of reusing desktop rail booleans.

- Compact touch arrives on the artifact even when the remembered desktop right
  panel is open. Annotation and AI buttons/panels remain out of the compact
  arrival composition; their dedicated foreground states belong to 2B.3.
- A leading **Plan** disclosure opens one full-stage navigator. It is bounded
  by the observed visual viewport and safe areas, contains focus/Escape,
  restores the trigger on explicit close, and gives its tabs and destination
  rows 44 px touch targets.
- The navigator reuses `SidebarContainer`, `TableOfContents`, `FileBrowser`,
  `VersionBrowser`, `MessagesBrowser`, and `ArchiveBrowser`. Desktop keeps the
  incumbent sticky/resizable presentation; there is no second browser model.
- Contents, file, message, archive, and linked-document destinations return to
  the artifact. Tab changes remain inside the navigator. File loading listens
  to the compact Files state without writing `sidebar.activeTab`, so opening
  Files on a phone does not alter the desktop sidebar state.
- Folder annotation no longer instructs a phone user to find a hidden sidebar.
  Its empty state has a touch-safe **Choose a file** action that opens Files.
- The Plan header remains in normal page flow on compact touch. No fixed or
  sticky mobile edge bar, Safari scroll proxy, selection semantic, server,
  Tailscale, or Pierre code changed.

Focused proof covers the foreground reducer, compact-arrival desktop-panel
gate, header disclosure, shared navigator desktop/overlay presentations,
visible-viewport and touch CSS, focus and tab behavior, and the folder empty
state. Shared typecheck, production UI CSS, and the production Hook build pass.
A 1440×900 fine-pointer browser control retained the 48 px sticky header,
240 px sticky Contents rail, 288 px right panel, and zero root/main horizontal
overflow. Responsive Chromium does not expose a coarse pointer in this run, so
it deliberately retained desktop presentation at phone width; physical Safari
remains the authoritative compact checkpoint.

### Phase 2B.1 physical review script

1. Open the folder checkpoint on iPhone. Arrival should show the empty artifact
   and **Choose a file**, not a sidebar or Ask AI.
2. Tap **Choose a file**, select any fixture, and confirm the navigator closes
   to the selected document. Tap **Plan**, return to Files, and choose a second
   file; the same close-to-artifact behavior should repeat.
3. Open **Plan** → Contents and choose a heading. Confirm it returns to the same
   document at that heading without changing Safari's accepted page scrolling.
4. Close the navigator with its close button, reopen it, and rotate once. No
   right rail, AI panel, or stale navigator should squeeze the artifact.
5. Open the ordinary document checkpoint separately. The document—not Ask AI,
   annotations, or navigation—must be the first surface.

This gate judges navigation and arrival only. Persistent annotation chrome,
direct-edit controls, auxiliary surfaces, completion, and multi-block selection
remain checkpoints 2B.2, 2B.3, and Phase 3 respectively.

## Why selection is not bundled into layout

The user's Plan feedback established that Pinpoint is currently the only
reliable touch path. A tap opens its contextual toolbar; Comment then opens the
composer. Ordinary Select taps do nothing, native drag selection invokes the
iOS Copy / Find Selection menu, and neither Plan nor Code Review offers a
credible way to accumulate several logical targets.

This is not a hit-box bug. It is an unresolved gesture and state model. The
selection phase must prototype explicit accumulation, visible range state,
cancel/undo, scroll coexistence, and assistive-technology behavior. Review
selection must additionally preserve Pierre's line mapping and desktop mouse
range selection. Treating it as incidental work inside a layout PR would make
both changes harder to review and easier to regress.

## Desktop preservation contract

Every phase keeps these invariants:

- mobile presentation state is ephemeral or device/session-scoped;
- desktop Tree/Split/panel preferences are never rewritten by phone width;
- fine-pointer geometry and keyboard shortcuts remain incumbent unless the
  phase explicitly names a desktop defect;
- shared changes are capability-gated and tested in a strict
  `@plannotator/ui` consumer;
- no existing working surface is deleted until physical and desktop parity is
  confirmed.
