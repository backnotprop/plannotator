# Spec: Mobile Plan Shell and Navigation — Phase 2B

Date: 2026-08-13
Status: In progress; checkpoint 2B.3 implementation ready for physical iPhone/iPad review while the Phase 2A filename micro-gate continues in parallel
Depends on: Phase 1 mobile platform foundation and Phase 2A mobile Code Review shell
Research: [`SPIKE-mobile-web-compatibility-20260812.md`](../research/SPIKE-mobile-web-compatibility-20260812.md)
Sequence: [`synthesis-mobile-feedback-triage-20260812.md`](../research/synthesis-mobile-feedback-triage-20260812.md)

## Decision

Phase 2B turns Plan review and document annotation from a responsive desktop
layout into a reading-first compact-touch experience. It does not redesign how
selection works. It removes simultaneous mobile chrome, restores the currently
blocked folder/multi-file journey, makes direct-edit completion reachable, and
keeps annotation, AI, navigation, and terminal review actions available as
deliberate transient tasks.

The Plan artifact remains a normal document-scrolling page on compact touch.
That scroll owner and the non-sticky top edge are accepted Phase 1 behavior:
physical iPhone review proved they allow Safari's top and bottom controls to
contract while the document remains visible behind the browser material.
Phase 2B must not reintroduce a fixed or sticky viewport-edge application bar.

The desired feeling is **calm, legible, and in control**. A reviewer should open
the URL and immediately understand what they are reviewing, read without first
dismissing auxiliary UI, deliberately enter annotation or editing, and reach a
clear completion surface at the end.

## Methodology

The implementation follows the audit method established by the mobile spike:

1. Treat physical Mobile Safari behavior as authoritative and responsive
   Chromium as preflight only.
2. Separate observation, interpretation, implementation, and validation.
3. Inventory every persistent region and assign it to one of four outcomes:
   keep in the artifact, expose contextually, move into a transient surface, or
   remove on compact touch.
4. Model the compact experience as explicit UI states rather than independent
   booleans that can reopen several desktop rails at once.
5. Preserve the document as the scroll owner and trace every navigation,
   focus, selection, edit, draft, and completion dependency before moving UI.
6. Gate compact presentation with available width plus coarse-pointer
   capability. A narrow fine-pointer desktop window retains desktop behavior.
7. Implement and review Phase 2B in three checkpoints, each independently
   usable and reversible.
8. Require physical iPhone and iPad evidence before closing the phase; require
   desktop geometry and preference controls in every checkpoint.

## Evidence being resolved

| Finding | Required outcome |
|---|---|
| MOB-001: folder/multi-file empty state points to a hidden desktop sidebar | A visible mobile navigator opens directly to Files and can switch documents. |
| MOB-004: Wide / Focus / Done sit above the card and are clipped | Editing status and completion live in stable in-flow mobile chrome. |
| MOB-013: 768 px iPad portrait opens a 288 px rail | Compact touch never arrives with a desktop right rail squeezing the artifact. |
| MOB-015: the full annotation matrix dominates the document | Idle reading shows one annotation entry; full tools appear only after intent or selection. |
| MOB-016: view, edit, diff, attachment, annotation, AI, and terminal actions arrive together | Arrival exposes document identity, navigation, and one action entry. |
| MOB-018: terminal review actions live only at the top | A normal-flow completion surface appears at the end of the artifact and is also reachable from Options. |
| MOB-019: touch sees desktop keyboard teaching and loses relevant guidance | Compact touch removes shortcut-only hints and uses direct action labels. |
| MOB-028: Plan arrived with Ask AI already open | Compact touch always arrives artifact-first unless an explicit deep link names an auxiliary surface. |

## Compact-touch activation

Use the shared `useCompactTouchLayout(1024)` capability. The compact shell is
active when the available viewport is at most 1024 CSS px wide and the device
exposes `any-pointer: coarse`.

- Phone portrait and landscape: compact.
- iPad portrait and constrained split view: compact.
- Large iPad landscape may retain desktop when more than 1024 px is available.
- A narrow laptop window with only a fine pointer: desktop.
- A hybrid iPad remains touch-safe even after a trackpad is attached because
  `any-pointer: coarse` continues to match.

Compact presentation state is session-local. It must not write desktop sidebar,
right-panel, input-method, view-mode, or sticky-action preferences.

## Information architecture

### One foreground task

The compact Plan shell has one foreground state at a time:

| State | Primary content | Exit behavior |
|---|---|---|
| `artifact` | Plan/document reading, contextual annotation, or direct editing | Session terminal action only |
| `navigator(tab)` | Contents, Files, Versions, Messages, or Archive | Close or select a destination |
| `annotations` | Existing feedback and direct-edit summary | Close returns to the same artifact position |
| `ai` | Ask AI conversation | Close returns to the same artifact position |
| `review` | Annotation summary plus Close / Send Feedback / Approve policy | Cancel returns to artifact; terminal action uses incumbent confirmation logic |

Historical booleans may remain internally for desktop, but compact rendering
must derive from one foreground state. Opening one transient surface closes the
previous one. Rotation must not resurrect a stale rail or a prior transient
surface.

Modal confirmations remain above these states and retain the shared visible-
viewport, focus-containment, and draft contracts from Phase 1.

### Compact app header

The compact header is one 52 px normal-flow row; it scrolls away with the page.
It contains three geometrically stable regions:

1. **Navigate** — opens the navigator at the most relevant available tab
   (`Files` for an unselected folder session, otherwise the last session-local
   tab).
2. **Document identity** — current basename or plan identity, with the full path
   available to accessibility and leading-ellipsis treatment when constrained.
3. **Options** — opens a compact action menu containing the incumbent terminal
   decisions, Edit when available, and secondary application actions. Annotations
   and Ask AI join this menu in checkpoint 2B.3.

The header does not show simultaneous Send Feedback, Approve, Annotations, AI,
and Options controls. It does not show desktop keyboard shortcuts. Branding is
available in Options/about context instead of displacing document identity.

Desktop `AppHeader` geometry and action placement remain incumbent.

### Mobile navigator

The mobile navigator reuses the contents of `SidebarContainer`; it is not a
second file/version/archive implementation. A new presentation seam lets the
same component render either:

- the incumbent sticky, resizable desktop sidebar; or
- a visible-viewport-bounded compact surface with a 52 px title/close row,
  touch-safe tab controls, and one scroll region.

Available tabs remain contextual: Contents, Versions, Files, Messages, and
Archive. Agent terminal controls are not silently pulled into this navigation
phase.

Selection rules:

- Selecting a Contents destination closes the navigator and scrolls the
  document using the existing document viewport contract.
- Selecting a file/message/archive destination closes the navigator after the
  new artifact is ready and places its title in the header.
- Switching documents must not discard annotations, file edit buffers, or
  drafts. Existing edit-compatibility guards remain authoritative.
- Back/close without choosing preserves the artifact and its scroll position.
- The folder empty state becomes an actionable `Choose a file` surface that
  opens `navigator('files')`; it never instructs the user to find a hidden
  sidebar.

### Reading and annotation chrome

Compact touch arrives in `artifact` with the document first. The existing
input method and annotation semantics are preserved, but their full matrix is
not persistently expanded.

- Compact touch always presents the incumbent Markup semantics: selecting a
  target reveals the contextual Copy / Delete / Comment / Label actions instead
  of requiring a permanent action-mode row. This is a compact presentation
  decision and never overwrites the saved desktop action mode.
- Idle state shows one explicit `Annotate · <method>` entry.
- Opening it reveals only `Select text` and `Pinpoint`. Pinpoint is named as the
  one-block tap method; Select text is named as the drag-over-text method.
  Choices are session-local and never overwrite the saved desktop input method.
- Markup / Comment / Redline / Label actions appear contextually after a valid
  target exists, not as a permanent second toolbar on arrival.
- Compact controls use the shared 44 px touch contract and immediate press
  feedback. They must not depend on hover.
- Command/Enter glyphs and other desktop-only shortcut teaching are hidden on
  coarse-pointer compact layouts. Hardware-keyboard shortcuts still function.
- The duplicate sticky/pinned action lane remains disabled while document
  scrolling owns the compact page.

Multi-block accumulation, native Safari selection conflicts, and Pierre line
range gestures remain Phase 3. A Phase 2B patch must not disguise those
unresolved semantics with CSS.

### Document card and direct editing

Wide and Focus are desktop workspace presentation choices. They are not shown
on compact touch—not above the card and not in Options—because the phone already
gives the artifact its available width and exposes no simultaneous panels to
focus away.

Direct Edit remains supported:

- `Edit` is reachable from Options and from existing document context where it
  remains clear.
- Once editing begins, a stable in-flow edit row precedes the editor and names
  the file plus Save state.
- Done and Cancel/Discard use explicit, touch-safe controls in that row.
- The row participates in normal document flow; it is never positioned at
  `-top-5`, clipped by a viewport, or attached to the Safari edge.
- Save, Done, file switching, external-change reconciliation, and unsaved-edit
  confirmation continue to use the incumbent handlers. Phase 2B moves their UI
  but does not fork their state machine.
- Opening the software keyboard must retain the Phase 1 16 px input, visible
  viewport, draft, and rotation behavior.

### Auxiliary surfaces

Annotations and Ask AI are transient foreground states on compact touch. They
replace the artifact visually while open; they never become a fixed sibling
that narrows it.

- Fresh compact arrival closes both unless an explicit deep link requests one.
- Opening or closing them does not mutate the saved desktop right-panel state.
- Each has a visible 44 px close target and one internal scroll owner.
- Returning restores the prior document and scroll position.
- AI provider/model configuration remains in its established surface; Phase 2B
  does not invent another provider chooser.

### Completion

Terminal actions must be deliberate without reintroducing fixed edge chrome.

- A normal-flow completion block appears after the artifact. It reports the
  current feedback count/state and opens `review`.
- Options exposes the same `Review` entry for reviewers who finish before the
  end of the artifact. These are two entrances to one surface, not duplicate
  action implementations.
- The review surface owns Close, Send Feedback, and Approve according to the
  current session mode, gate policy, callback policy, unsent-feedback guards,
  and annotation state.
- High-stakes actions retain incumbent confirmations. Do not place Approve and
  discard-like actions beside dense navigation targets.
- No fixed/sticky bottom bar ships in this phase. It would risk the Safari edge
  behavior already solved in Phase 1 and is unnecessary until a physical
  prototype proves value beyond the in-flow completion model.

## Checkpoints and review gates

### 2B.1 — Navigator and reading-first arrival

Implement the compact foreground state, mobile `SidebarContainer`
presentation, Navigate header entry, folder empty-state action, and compact
arrival policy that closes auxiliary rails.

Physical gate:

1. Open `annotate <folder> --tailscale` on iPhone.
2. Choose a Markdown file, return to Files, then choose an HTML or second text
   file.
3. Confirm navigation closes after selection and annotations/drafts remain.
4. Open ordinary Plan review and confirm the artifact—not Ask AI or a sidebar—
   is the first surface.
5. Rotate and confirm no desktop rail appears.

Physical correction:

- iPhone review found that selecting a folder file visibly changed the
  document behind the navigator but left the navigator open. The transition
  flashed because it briefly closed and then returned.
- The selection handler was closing the compact foreground state correctly;
  asynchronous document activation later invoked `useLinkedDoc`'s incumbent
  desktop instruction to open the Files sidebar. On compact touch, that desktop
  side effect reopened the navigator after the destination loaded.
- Compact document activation now leaves foreground navigation to the compact
  state owner. A file tap closes the navigator and the later activation cannot
  resurrect it; desktop still opens its incumbent sidebar tab.
- A full-App coarse-pointer test loads a real file tree through the shared
  backend, selects a file, waits for `/api/doc`, and proves that the selected
  document and filename render while the navigator remains closed.
- A later physical cold-load review exposed a second transition defect: the
  navigator closed before the first `/api/doc` request completed, briefly
  revealing the folder landing page and its `Choose a file` action. Warm file
  switches were fast enough to hide the same ordering bug.
- Compact file selection now keeps Files visible, marks the selected
  destination as `Opening…`, and prevents competing selections until document
  activation succeeds. It then closes the initiating navigator; a failed load
  leaves Files open for retry. Desktop retains its incumbent asynchronous
  sidebar behavior.
- The full-App test now holds `/api/doc` behind a deliberate gate and proves
  that the navigator remains visible and the selected file is busy/disabled
  throughout the delay before closing on successful activation.

### 2B.2 — Compact document chrome and direct edit

Implement the three-region header, idle annotation entry/contextual tools,
secondary view choices in Options, and in-flow edit row.

Physical gate:

1. Read a long plan and confirm the header scrolls away while both Safari bars
   retain the accepted contraction behavior.
2. Enter Pinpoint through Annotate, select one paragraph, and save a comment.
   Multi-block selection is explicitly not judged here.
3. Enter direct edit, type with the software keyboard, Save, rotate, and Done.
4. Confirm every edit control is fully visible and at least 44 px tall.
5. Confirm no persistent duplicate toolbar or shortcut glyph dominates arrival.

Implementation checkpoint:

- The compact header is now a stable 52 px grid containing a 44 px navigation
  target, centered current-document basename, and a 44 px Options target. It
  remains normal-flow so the accepted Safari document-scroll behavior is
  unchanged.
- Close / Send Feedback / Approve, callback decisions, archive decisions, and
  goal-setup decisions move into Options only on compact touch. Every item calls
  the incumbent handler and therefore retains the established confirmation,
  unsaved-file, transport, and agent-validation behavior.
- Persistent Select / Pinpoint and Markup / Comment / Redline / Label groups are
  replaced with one `Annotate · <method>` disclosure. The revealed choices are
  only Select text and Pinpoint; contextual feedback actions still come from the
  existing target toolbar.
- Compact annotation always uses Markup semantics without writing the saved
  desktop action mode. Compact input-method changes are session-only as well.
- Wide and Focus are absent on compact touch. Desktop keeps their existing
  absolute micro-controls and behavior unchanged.
- Edit moves into Options. Once editing starts, a normal-flow row above the
  editor identifies the document and exposes source-file Save plus Done/Cancel/
  two-step Discard through the existing edit state machine.
- Desktop rendered preflight retained the incumbent 48 px flex header, full
  toolstrip, Wide / Focus / Edit controls, and exact page width with no overflow.
  A narrow fine-pointer control also retained desktop composition. Compact
  coarse-pointer rendering remains a physical-device gate.
- A full-App coarse-pointer integration test now proves the real compact route:
  current filename in the three-region header, one annotation disclosure, no
  persistent desktop tool matrix, session-only input-method changes, review
  decisions and Edit in Options, and the in-flow edit row. Eighteen focused DOM
  tests and 72 editor tests pass, along with shared typecheck, production UI CSS,
  Hook, and OpenCode builds plus `git diff --check`.

### 2B.3 — Auxiliary and completion surfaces

Implement transient Annotations/AI states, the in-flow completion block, and
the single Review surface reached from both the artifact end and Options.

Physical gate:

1. Open and close Annotations and AI; confirm each replaces rather than
   squeezes the artifact and returns to the same position.
2. Add feedback, reach the completion block, and open Review.
3. Exercise Send Feedback or Approve through the existing confirmation path.
4. Background/restore the phone and rotate once with unsent feedback.
5. Reload at desktop width and confirm the saved sidebar/right-panel layout,
   sticky actions, header actions, and edit controls are unchanged.

Implementation checkpoint:

- Annotations and Ask AI now open as mutually exclusive, visible-viewport
  compact stages. They replace the artifact while active, keep one internal
  scroll owner, and return focus to the opening control when closed.
- The shared annotation timeline gained an embedded presentation seam; its
  incumbent desktop panel geometry, backdrop, header, and persisted open state
  remain unchanged.
- A normal-flow completion block follows eligible Plan and document artifacts.
  It summarizes the current feedback state and opens the same Review surface
  exposed from Options; edit, diff, goal, HTML, and unselected-folder states do
  not render it.
- Review reuses the incumbent decision callbacks and policy rather than adding
  another submission state machine. Feedback-bearing sessions prioritize Send
  Feedback, approval-capable clean sessions prioritize Approve, and close-only
  sessions retain their established exit behavior.
- Compact stages use the Phase 1 visible-viewport and safe-area contract, 44 px
  touch targets, immediate interaction feedback, focus containment, and a
  16 px Ask AI input. No fixed or sticky Safari-edge control was introduced.
- Full-App coarse-pointer tests cover mutual exclusion, close behavior, the
  end-of-document entry, decision submission, edit exclusion, and the absence
  of desktop-only terminal actions in compact Options. Shared component tests
  cover focus containment, embedded annotation presentation, review ordering,
  and terminal action semantics.
- The editor/UI DOM suite passes 111 tests with 412 expectations. Shared
  typecheck, production UI CSS, Hook, and OpenCode builds pass, together with
  `git diff --check`. Fine-pointer rendered preflight retained the incumbent
  desktop sidebar/right-panel composition with no compact completion block or
  full-stage overlay.

Phase 2B passes only when all three checkpoints pass on physical iPhone and the
relevant iPad matrix. Browser preflight cannot close the phase.

## Expected implementation seams

| Area | Expected files | Responsibility |
|---|---|---|
| Compact capability/state | `packages/editor/App.tsx`, shared `useCompactTouchLayout` | One compact foreground state; session-only presentation |
| Header | `packages/editor/components/AppHeader.tsx`, `packages/ui/components/PlanHeaderMenu.tsx` | Three-region normal-flow compact header and progressive disclosure |
| Navigator | `packages/ui/components/sidebar/SidebarContainer.tsx`, focused tests | Reuse sidebar content in a visible-viewport compact presentation |
| Empty folder | `packages/editor/App.tsx` | Actionable Files entry instead of hidden-sidebar instruction |
| Document chrome | `packages/editor/App.tsx`, `packages/ui/components/Viewer.tsx`, existing toolbar components | Idle annotation entry, contextual tools, remove compact persistent noise |
| Direct edit | `packages/editor/App.tsx`, possibly one small editor-owned component | Stable in-flow Save / Done / Cancel controls |
| Auxiliary/review surfaces | `packages/editor/App.tsx`, existing Annotation/AI/dialog primitives | Full-stage transient surfaces and one completion path |
| Shared styling | `packages/ui/theme.css` | Touch/viewport tokens only; no second mobile stylesheet |

Files outside this map require a scope explanation. No server, Tailscale,
Pierre/DiffViewer, persistence format, or desktop preference migration is
expected.

## Automated and rendered proof

At minimum:

- pure compact foreground-state transition tests;
- compact arrival tests proving desktop panel state is not written;
- mobile navigator DOM tests for every available tab and destination close;
- folder empty-state navigation test;
- in-flow edit control and unsaved-edit guard tests;
- compact header/action inclusion tests;
- auxiliary mutual-exclusion and document-position restoration tests;
- completion policy tests across Plan, annotate gate, callback, and read-only
  variants;
- production UI CSS, Hook, Review, and OpenCode builds as affected;
- shared typecheck and `git diff --check`;
- responsive preflight at 320×568, 390×844, 430×932, 768×1024,
  820×1180, 1180×820, and a 1440×900 fine-pointer desktop control.

Desktop control evidence must include header height/actions, sidebar geometry,
right-panel geometry, sticky action behavior, direct-edit controls, and saved
preferences before and after a compact session.

## Explicit non-goals

- No multi-block Plan selection or multi-line Code Review selection.
- No changes to Pierre, CodeView, DiffViewer, or Code Review scrolling.
- No fixed/sticky mobile bottom review bar.
- No swipe-to-dismiss or gesture-driven sheet system.
- No broad Settings, search, Ask AI authoring, source-code editor, or raw HTML
  author-page responsiveness pass.
- No payload, caching, reconnect, Tailscale trust, or authentication work.
- No visual-language replacement or parallel mobile component library.
- No change to desktop first-use defaults or saved preferences.

## What the reviewer should expect after Phase 2B

On iPhone, Plan opens as a clean reading page. Files, versions, contents,
messages, annotations, and AI are one explicit tap away but never squeeze the
document. Folder annotation is no longer blocked. Direct editing has stable,
reachable completion controls. The reviewer finishes through one clear Review
surface without a persistent action band covering the artifact. Safari keeps
the page behavior already accepted in Phase 1.

Desktop should look and behave the same unless a separately identified desktop
accessibility defect is intentionally fixed and called out.
