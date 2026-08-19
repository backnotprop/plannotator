# SPIKE: Mobile web compatibility for plan, document, and code review

Date: 2026-08-12
Status: research synthesis, not a product specification
Baseline: `origin/main` / `ef49c701c23b867cec2a5d78343813ba89d2a025` (`v0.27.1`)

Method: dual-agent (A: independent design and usability assessment · B: independent detector and browser-evidence assessment)

## Question

What must Plannotator learn, preserve, remove, and redesign before its existing web surfaces can become excellent touch-first experiences on iPhone and iPad, especially when a session is reached through Tailscale?

This spike deliberately stops before a formal design specification. It establishes a repeatable audit method, a source- and browser-backed inventory, promising product directions, and the decisions that must be made before implementation is specified.

## Executive finding

Tailscale solved reachability, not mobility. It exposes the same single-file React applications that Plannotator serves locally; no alternate mobile renderer or route is selected. The mobile opportunity is therefore a product-shell and interaction-design problem, not a Tailscale rendering problem.

The current surfaces divide into three different levels of readiness:

1. **Plan/document reading is visually responsive but not yet touch-first.** The artifact remains readable and page-level horizontal overflow is controlled. The chrome is dense, most controls are 17–28 px high, touch devices expand every toolstrip label, and annotation/editing completion is vulnerable to Safari viewport and keyboard behavior.
2. **Code review is desktop composition compressed into a narrow viewport.** At 390 px, the default 256 px tree leaves 134 px for Pierre. Opening the fixed 288 px review sidebar leaves 102 px. Hiding the tree and selecting Unified proves the diff can be useful at phone width; the default composition is the failure.
3. **Guided Review is the strongest existing mobile product primitive.** It already turns a changeset into an ordered, narrative reading flow, hides the file tree, stacks chapters on phone widths, and reuses the real Pierre diff. It needs mobile chrome and touch treatment, not conceptual replacement.

The most serious compatibility issue is not visual: multi-file/folder annotation is blocked below `lg`. The folder empty state tells the reviewer to select a file from the sidebar, but both the collapsed sidebar tabs and open sidebar are hidden at those widths.

The recommended research direction is an **artifact-first, one-stage-at-a-time shell**:

- Phone: one primary surface at a time; full-width document or Unified diff; navigation and annotations in sheets; high-stakes actions in a deliberate thumb-reachable review bar.
- iPad portrait/touch: one artifact plus at most one transient companion surface; avoid opening desktop rails based on width alone.
- iPad landscape with pointer/keyboard: retain the strong desktop workspace where the usable center canvas remains large enough.

## Scope and non-goals

### In scope

- Plan review and document annotation, including folder, version, linked-document, raw HTML, direct-edit, and annotation-panel states.
- Code review, including Git status / Tree / Commits, all-files and single-file Pierre diffs, staging/viewed/file comments, right sidebar, and Guided Review.
- iPhone portrait and landscape; iPad portrait and landscape; touch-first and pointer-assisted iPad circumstances.
- Responsive layout, touch targets, gesture/directness, visual noise, hierarchy, typography, safe areas, dynamic viewport, virtual keyboard, accessibility, interruption/recovery, and mobile payload cost.
- How local and Tailscale-published sessions serve the same frontend.

### Out of scope

- Implementing responsive CSS or components.
- Choosing final breakpoints, visual comps, gestures, or navigation labels.
- Changing Pierre integration behavior.
- Modifying Tailscale Serve mappings or testing a live tailnet.
- Claiming physical Mobile Safari, VoiceOver, notch, home-indicator, or keyboard behavior was observed; those require physical-device validation.
- Rebuilding the shared UI. Any eventual implementation must evolve `@plannotator/ui` seams and existing apps.

## Research methodology

This methodology is intended to be reused for later mobile design passes and regression audits.

### 1. Freeze the product baseline

- Fetch and compare `HEAD` with `origin/main` before inspecting behavior.
- Record the exact commit and version in every artifact.
- Exclude throwaway or historical branches unless a specific current behavior points to them.
- Preserve the worktree; this pass makes no product-code changes.

### 2. Map reachability before judging responsiveness

For each user entry point, record:

- invocation and runtime;
- bind address and advertised URL;
- HTML asset served;
- whether the session is local, remote, shared-static, or tailnet-published;
- whether a mobile user can reach the flow at all.

This prevents confusing transport work with responsive behavior.

### 3. Audit journeys, not only screens

Every surface is evaluated across the same journey:

1. Arrive and orient.
2. Find the artifact or changed file.
3. Read and understand.
4. Select or point at evidence.
5. Write, edit, or delete feedback.
6. Review accumulated feedback.
7. Approve, send, dismiss, or recover.
8. Return after interruption or rotation.

For code review, add staging, viewed state, file navigation, diff mode, Guide navigation, and platform/agent destination. For document annotation, add folder/file selection, versions, linked documents, direct edit, and raw HTML.

### 4. Use a device-and-input matrix

Minimum render matrix:

| Class | Reference viewport | Input circumstance | Purpose |
|---|---:|---|---|
| Compact phone portrait | 320×568 | touch | smallest realistic layout pressure |
| Current phone portrait | 390×844 | touch | primary one-handed audit |
| Phone landscape | 844×390 | touch | notch/safe-edge and vertical compression |
| iPad portrait | 768/820/834×1024–1194 | touch | breakpoint and rail pressure |
| iPad landscape | 1180×820 | touch or pointer | multi-pane viability |
| Desktop control | ≥1280 wide | pointer + keyboard | preserve incumbent strengths |

Responsive Chromium establishes layout and computed geometry. Physical-device passes must later cover Mobile Safari, `pointer: coarse`, `hover: none`, dynamic browser chrome, software keyboard, selection handles, rotation, VoiceOver, reduced motion, increased contrast, and Tailscale latency.

### 5. Separate evidence from inference

Every finding uses one or more evidence labels:

- **Observed** — reproduced in a rendered viewport.
- **Measured** — DOM rectangle, computed style, payload, or console result.
- **Source-confirmed** — implementation establishes the behavior.
- **Platform risk** — the source conflicts with known mobile browser behavior but still needs physical-device reproduction.
- **Design hypothesis** — a candidate direction to prototype; not a requirement.

Do not upgrade a platform risk or design hypothesis into an observed defect.

### 6. Evaluate through five lenses

1. **Utility:** can the reviewer complete the core task?
2. **Hierarchy/noise:** does chrome outrank the artifact?
3. **Directness:** does touch act on the visible object with immediate, interruptible feedback?
4. **Compatibility/accessibility:** 44×44 targets, 16 px focused text inputs, safe areas, dynamic viewport, non-hover access, semantics, focus, contrast, reduced motion.
5. **Performance/resilience:** initial HTML cost, parse/highlight work, virtualization, loading feedback, reconnection, drafts, and recovery.

The Apple-design lens contributed physical directness, one-stage focus, thumb reach, sheets, interruptibility, and respectful system conventions. The design-engineering lens contributed target sizing, Safari input/viewport rules, input-capability checks, reduced motion, and performance discipline. The critique framework contributed Nielsen, cognitive-load, persona, detector, and evidence-storage checks.

### 7. Score severity and confidence independently

| Priority | Meaning |
|---|---|
| P0 | A supported mobile journey cannot be completed. |
| P1 | Core review or feedback is unusable, unreliable, or dangerously error-prone. |
| P2 | Material friction, noise, accessibility risk, or avoidable inefficiency. |
| P3 | Polish, consistency, or future-proofing issue. |

Confidence is High when rendered evidence and source agree, Medium for source-backed platform risk, and Low for an untested concept or rare circumstance.

### 8. Run two isolated assessments

- Assessment A judges design quality, Nielsen heuristics, cognitive load, emotional journey, and personas without detector output.
- Assessment B runs the deterministic detector once, triages false positives, and gathers browser geometry, computed styles, screenshots, and console evidence without seeing A.
- Synthesis begins only after A is complete, then reconciles B.

This prevents automated pattern warnings from anchoring the design review.

### 9. Apply decision gates before specification

Do not write a formal mobile spec until the product has decided:

- phone intent: deep inspection, triage, or both;
- whether Guide is a default mobile route or an optional route;
- approval/action placement and safeguards;
- width-plus-input adaptation policy;
- minimum supported device/browser matrix;
- acceptable first-load budget over a tailnet;
- how folder and multi-document navigation appears on mobile.

## How the frontend is served

### Build and rendering model

- The plan/document app is `packages/editor/App.tsx`, composed with shared components and tokens from `packages/ui`.
- The review app is `packages/review-editor/App.tsx`, also using `packages/ui`, Dockview, and `@pierre/diffs`.
- Vite and `vite-plugin-singlefile` inline JavaScript, CSS, fonts/assets, and the Pierre highlighting worker into one HTML file per app.
- The Bun servers keep those HTML strings in memory and return them as the SPA response for non-API routes.
- The browser then fetches session data and mutations from same-origin `/api/*` routes. Tailscale does not change this API or rendering contract.

Relevant sources:

- `apps/hook/vite.config.ts`
- `apps/review/vite.config.ts`
- `packages/server/index.ts`
- `packages/server/annotate.ts`
- `packages/server/review.ts`

### Tailscale path

`--tailscale` is supported by the compiled Bun CLI for `review`, `annotate`, `annotate-last`, and `last`.

1. Plannotator forces local mode and binds the Bun server to `127.0.0.1` on a random or configured port.
2. It checks `tailscale serve status --json` and refuses to steal an existing mapping for that port.
3. It runs `tailscale serve --bg --https=<port> http://127.0.0.1:<port>`.
4. Tailscale terminates HTTPS and proxies the exact same local web app and API.
5. Plannotator advertises the tailnet URL and terminal QR code, skips local browser opening, and removes the mapping on normal exit/signals.

The tailnet session is private to permitted peers but has no Plannotator login or per-request authentication. Any peer allowed to reach the host can use the session UI and local API. The annotate agent terminal is therefore disabled by default.

Important journey limit: agent plan hooks do not add `--tailscale` automatically, and the ordinary plan hook command is not a supported `--tailscale` subcommand. A tailnet plan gate currently uses a direct annotation invocation such as `plannotator annotate path/to/plan.md --tailscale --gate`.

The published documentation was checked on 2026-08-12: `https://docs.plannotator.ai/open-source/tailscale`.

### Rendering circumstances matrix

| Circumstance | Frontend | Reachability | Mobile implication |
|---|---|---|---|
| Claude/Gemini plan hook | plan/editor HTML | local browser by default | existing automatic plan flow is not tailnet-published by the flag |
| `annotate --tailscale` | plan/editor HTML in annotate mode | Tailscale Serve HTTPS | primary mobile document/plan path; folder, HTML, versions, edit, and gate variants matter |
| `review --tailscale` | review-editor HTML | Tailscale Serve HTTPS | full code-review workspace reaches phone unchanged |
| SSH/remote mode | same HTML | wide bind / advertised HTTP host | secure-context behavior differs; responsiveness is unchanged |
| shared static link | separate static/shared rendering path | public/share service | not this audit’s primary live-session contract |
| VS Code/Glimpse | same core surfaces in host window | local host integration | not a phone target, but shared UI changes must preserve it |

## What is already strong

### Plan/document surface

- The artifact has a distinctive editorial identity rather than generic dashboard styling.
- Reader padding contracts at phone width and no document-level horizontal overflow was observed at 390 or 834 px.
- A physical iPhone pass confirmed that the plan itself reads well once the auxiliary sidebar and setup chrome are dismissed.
- Code and tables keep their own horizontal scrolling instead of widening the whole page.
- Annotation comments, draft recovery, version comparison, direct edits, links, attachments, and themed markdown are domain-specific and valuable.
- The plan annotation panel already becomes a fixed full-width overlay below 768 px. This is the best existing pattern for review side surfaces.
- Native mobile text selection has a coarse-pointer `selectionchange` bridge with a debounce in `useAnnotationHighlighter.ts`.
- Reduced-motion handling and colorblind themes exist, though coverage is uneven.

### Code-review surface

- Git status / Tree / Commits and since-base composition are specific to real review work.
- Pierre is integrated once for single-file and virtualized all-files/Guide views; hiding the tree and choosing Unified produced a viable phone-width canvas.
- A physical iPhone pass found the initial Review setup dialog acceptable and Guided Review immediately promising as a mobile comprehension surface.
- The same pass found the “Edit code to suggest” dialog acceptable and the All Files view visually clean, giving later mobile work two concrete compositions to preserve.
- File staging/viewed/comment state and failure recovery are sophisticated and trustworthy.
- The first-run review setup dialog reflowed to a single-column phone layout and retained an obvious completion action.
- iPad landscape at 1180×820 preserved a strong, usable multi-pane review workspace.

### Guided Review

- The takeover makes the changeset comprehensible as chapters instead of demanding file-tree orientation first.
- At phone width, chapters stack into narrative followed by the real diff.
- It uses the same diff, annotations, stage/viewed actions, and virtualized CodeViews rather than producing a disconnected summary.
- Its “core first, glue later” ordering directly reduces mobile cognitive load.

### Resilience

- Draft persistence, approval warnings, recovery from partial platform posts, retry narrowing, and explicit error states are stronger than typical developer tools.
- Progressive disclosure already hides Send Feedback / Post Comments until feedback exists.

## Nielsen heuristic assessment

| Heuristic | Score | Mobile assessment |
|---|---:|---|
| Visibility of system status | 3/4 | Loading, counts, staging, viewed, submission, and recovery states are strong; panels can obscure the artifact those states describe. |
| Match with the real world | 3/4 | Review language is domain-correct; icon-only tools and advanced Git concepts cost recognition on phone. |
| User control and freedom | 3/4 | Panels, cancel paths, drafts, and recovery are thoughtful; mobile escape and panel controls are small. |
| Consistency and standards | 2/4 | Shared visual language is coherent, but plan uses an overlay while review preserves fixed rails; mobile states vary. |
| Error prevention | 3/4 | High-stakes warnings are strong; dense 22–28 px targets around approval/stage/delete increase mis-tap risk. |
| Recognition rather than recall | 2/4 | Phone layouts remove labels and hover explanations exactly when they are most needed. |
| Flexibility and efficiency | 2/4 | Desktop keyboard efficiency is excellent; touch users must first repair the layout by hiding the tree and choosing Unified. |
| Aesthetic and minimalist design | 2/4 | The content is calm after chrome recedes; default mobile chrome competes with it. |
| Error recovery | 3/4 | Recovery is unusually mature; long dialogs and keyboard exposure remain mobile risks. |
| Help and documentation | 2/4 | Guide is visible; plan help is hidden below `sm`, while modes become icon-only. |

Total: **25/40**. Desktop craft is high; mobile utility is materially below it.

## Cognitive-load assessment

Five of eight checks fail clearly on phone:

- **Single focus:** fail — tree, dock, diff, toolbars, and sidebars coexist.
- **Chunking:** mixed — annotation modes are grouped, but too many groups are simultaneously exposed.
- **Grouping:** pass — borders, surfaces, status colors, and panel ownership are generally coherent.
- **Visual hierarchy:** fail — fixed navigation rails can consume more width than the artifact.
- **One thing at a time:** fail — the shell permits tree + split diff + right rail on a phone.
- **Minimal choices:** fail — six annotation modes and many review controls precede the primary task.
- **Working memory:** fail — icon-only actions and hover help require remembered meaning.
- **Progressive disclosure:** mixed — submission actions are progressive, but the workspace shell is not.

## Issue and compatibility inventory

### Critical journey and layout issues

| ID | Priority | Evidence | Finding | Impact | Direction, not specification |
|---|---|---|---|---|---|
| MOB-001 | P0 | Source-confirmed, High | Folder/multi-file annotation opens the Files sidebar, but `SidebarTabs` and `SidebarContainer` are `hidden lg`; the empty state still says to pick from the sidebar. | The mobile reviewer cannot select a file, so a documented `annotate folder/ --tailscale` journey is blocked. | Introduce a mobile Contents/Files/Versions navigator as a sheet or full-screen route, reachable even from the empty state. |
| MOB-002 | P1 | Physical iPhone + measured + source-confirmed, High | Review opens its desktop multi-pane default composition at phone width with both the tree and file content competing for the screen; a later GitHub-PR pass compounded this by opening PR panels beside the tree. The live device pass described the arrival as extremely messy and effectively inoperable. Closing the files/tree helps, but only after the reviewer repairs the composition. In the measured 390 px composition, a 256 px tree leaves 134 px for the diff. | Code becomes unreadable and the reviewer cannot perform useful review before reconfiguring the shell. | Default phone to one full-width primary surface—Guide or All Files—with navigation transient. This phone presentation override must not replace Tree as the best new-user desktop panel default. |
| MOB-003 | P1 | Physical iPhone + measured + source-confirmed, High | Review’s fixed annotation/AI/agents and GitHub PR panels remain flex siblings. The PR summary is marginally clearer than the rest, but the panels are still cramped; with the tree open they become effectively unusable. The measured 288 px right rail leaves a 102 px diff even after the tree is hidden. | Opening feedback or PR context destroys the artifact context. | Reuse the plan overlay/sheet pattern; never squeeze the phone canvas. |
| MOB-004 | P1 | Observed + measured + source-confirmed, High | In plan direct edit, Wide / Focus / Done are positioned at `-top-5` and clipped by the scroll viewport; only about 8.5 px is exposed at 390×844. | The completion control for a core edit flow is nearly untappable. | Put editing state and completion in stable mobile chrome, independent of the document card’s absolute controls. |

### Touch and direct-manipulation issues

| ID | Priority | Evidence | Finding | Impact | Direction, not specification |
|---|---|---|---|---|---|
| MOB-005 | P1 | Measured, High; shared foundation implemented, physical gate pending | 30/32 visible plan interactives and 46/46 review interactives at 390×844 originally had at least one dimension below 44 px. Both shared button primitives and the shared dialog close control now opt into a coarse-pointer-only 44 px floor without changing fine-pointer geometry; hand-authored surface controls remain inventoried for their owning layout phases. | Shared consumers gain safer touch targets immediately, but dense bespoke Plan and Review toolstrips still need deliberate surface composition instead of indiscriminate expansion. | Physically verify the shared target/press contract on iPhone and hybrid iPad, then migrate hand-authored controls as each owning surface is redesigned. |
| MOB-006 | P1 | Physical iPhone + source-confirmed, High | The live phone pass could select individual diff lines for feedback but found no workable touch gesture for extending or click-dragging a multi-line range. Review’s extra native text-selection bridge also listens only to `mouseup`; toolbar placement tracks only `mousemove` and begins at `(0,0)`. | Mobile feedback is limited to isolated lines even when the finding concerns a code range, and the composer anchor can still fail or misplace. | Preserve reliable tap-to-select, then add an explicit touch range/accumulation model with pointer/touch/selection-change evidence and an anchor derived from selection geometry; test it against Pierre on physical Safari. |
| MOB-007 | P2 | Source-confirmed, High | Split-diff divider is a 9 px pointer target and sidebar resize handles are desktop drag affordances. | Precision dragging is incompatible with touch and can hijack scrolling. | Do not require resizing on phone; make any tablet divider hit region ≥44 px while keeping the visual stroke thin. |
| MOB-008 | P2 | Source-confirmed, High | Stateful plan toolstrip buttons lack `aria-pressed`; many state changes are encoded by color. | Assistive technology and low-vision users cannot reliably infer active mode. | Add state semantics and visible labels in the mobile mode chooser. |
| MOB-009 | P2 | Source-confirmed, High | Several copy/delete/remove actions appear only on group hover; coverage of `@media (hover:none)` is inconsistent. | Touch users can miss or be unable to invoke secondary actions. | Require tap-discoverable menus or coarse-pointer-visible actions for every hover-reveal control. |
| MOB-029 | P1 | Physical iPhone, High | In ordinary Select mode, tapping a paragraph, bullet, or code block did nothing. Dragging text invoked Safari's native Copy / Find Selection menu, which obstructed Plannotator's actions. Pinpoint was the only reliable route to a single-target toolbar and comment composer, and there was still no practical way to accumulate several bullets. | The primary Plan selection model is effectively unavailable on touch; reviewers must discover Pinpoint and still cannot express one comment over a logical multi-item region. | Treat touch selection as a dedicated interaction design problem: preserve Pinpoint's reliable tap target, prototype explicit block/range accumulation, and avoid dependence on native drag selection or click-through beneath Safari's selection menu. |

### Viewport, keyboard, and platform issues

| ID | Priority | Evidence | Finding | Impact | Direction, not specification |
|---|---|---|---|---|---|
| MOB-010 | P1 | Physical iPhone + WebKit-confirmed; Checkpoint 1B passed | Roots follow the observed visual viewport and the primary composers consume shared reactive bounds. Compact coarse-pointer Plan uses the actual document scroller, propagates that viewport through navigation/selection consumers, and allows the document to continue behind Safari's collapsing controls. The compact touch header now scrolls in normal flow and both duplicate sticky Plan action treatments are disabled; desktop keeps all incumbent sticky behavior. The final physical pass confirmed that both Safari chrome regions contract normally, the prior bottom cutoff is gone, the top is no longer obscured by a sticky application edge, and the artifact remains visible beneath the browser's translucent controls. This matches WebKit's documented distinction between body scrolling and nested scrolling ([WebKit #240861](https://bugs.webkit.org/show_bug.cgi?id=240861)) and its solid extension around fixed/sticky edge content ([WebKit #301756](https://bugs.webkit.org/show_bug.cgi?id=301756#c2)). | The Plan reading surface now behaves like an ordinary Mobile Safari page instead of a fixed desktop application viewport. Code Review remains a separate phase because its multi-panel workspace cannot inherit Plan's reading-page composition unchanged. | Preserve the document-scroll/sticky-edge contract during later Plan work; apply an independently designed mobile workspace contract to Code Review. |
| MOB-011 | P1 | Measured platform risk, Medium; primary fix implemented, physical gate pending | `data-pn-mobile-editable` now makes the primary Plan and Code Review authoring inputs compute to 16 px on compact/coarse surfaces without enlarging desktop labels or diff text. Deferred search, Settings, Ask AI, prompts, and source editing remain inventoried. | The primary Safari focus-zoom trigger is removed; unconverted secondary authoring inputs can still destabilize their later flows. | Verify no focus zoom on iPhone/iPad, then adopt the same marker as each deferred surface is implemented. |
| MOB-012 | P2 | Source-confirmed platform risk, Medium; shared contract implemented, physical gate pending | Entry viewports now opt into `viewport-fit=cover`; CSS-owned safe-area variables protect the application stage and the primary portaled comment overlays. Historical secondary fixed panels remain inventoried for their owning phases. | Converted primary paths have one inset owner; unconverted secondary chrome can still overlap landscape notches or the home indicator. | Verify the primary overlays on notched iPhone/iPad hardware, then migrate later bottom-edge surfaces without double-counting root insets. |
| MOB-013 | P2 | Observed + source-confirmed, High | `useIsMobile()` is `<768`; exactly 768 px is desktop. Plan also defaults the right panel open at `window.innerWidth >= 768`. | iPad portrait receives a 288 px empty rail and a squeezed document. | Base composition on available artifact width and input capability, not a single phone/desktop cutoff. |
| MOB-014 | P2 | Source-confirmed, High | Settings is a centered desktop dialog; at 320 px its tab nav is 286 px wide with 585 px scroll content and its identity input is 13 px. | Settings are technically reachable but clipped/discoverability- and zoom-prone. | Treat settings as a mobile route/sheet with explicit section navigation and 16 px inputs. |
| MOB-031 | P1 | Physical iPhone, High; Checkpoint 1B accepted | The primary Plan and Code Review composers use the visible viewport, 16 px compact/coarse editables, non-forcing touch focus, reachable dismiss/submit controls, and draft recovery. Responsive browser checks passed down to 320×568 and a 390×500 keyboard-sized viewport. The physical iPhone pass confirmed legible Plan input, intentional keyboard opening, no Safari focus zoom, successful save, and stable browser-chrome behavior; the user accepted the remaining previously exercised input behaviors without requesting a redundant rerun. | The primary phone composition contract is accepted. A separate physical iPad matrix and secondary authoring surfaces remain unproven and keep their own inventory entries. | Carry the shared editable/viewport contract into each later authoring surface and complete the iPad pass during 1C/final Phase 1 validation. |

### Hierarchy and noise issues

| ID | Priority | Evidence | Finding | Impact | Direction, not specification |
|---|---|---|---|---|---|
| MOB-015 | P2 | Physical iPhone + source-confirmed, High | Touch devices force every full plan toolstrip button to expand its label; wrapping creates a dense band. A second pinned/sticky action strip appears after scrolling and was judged visually overwhelming in the physical-device pass. | The annotation mechanism outranks the document and causes layout churn. | Mobile starts in reading/native-selection mode; move the full mode matrix into a deliberate chooser and keep one contextual action visible. |
| MOB-016 | P2 | Observed + measured, High | Wide / Focus / Edit, diff badge, attachments, global comment, copy, two annotation groups, approval, feedback, annotations, AI, and options cluster at the top of the phone document. | Arrival feels like operating a tool before reading the plan. | Separate reading, annotation, and completion phases; move persistent completion actions to mobile shell chrome. |
| MOB-028 | P1 | Physical iPhone, High | Plan Review arrived with the Ask AI sidebar already open, making an auxiliary task the first visible surface and requiring a manual close before the reviewer could read. | The product hides its core artifact on first contact and makes mobile arrival feel stateful and unpredictable. | Phone Plan Review must arrive reading-first with auxiliary surfaces closed unless the session was explicitly deep-linked into one; opening AI later should be transient and must not overwrite the reviewer’s desktop rail preference. |
| MOB-017 | P2 | Physical iPhone + source-confirmed, High | Review header stacks below 480 px but does not reprioritize the IA; on-device it splits across multiple lines while Dockview tab chrome, Split/Unified/options, per-file controls, and header actions remain concurrent. The result reads as a minified, wrapped desktop toolbar. | The shell “fits” while navigation stays painful and the review task remains cognitively overloaded. | Define a mobile review hierarchy instead of relying on wrapping. |
| MOB-018 | P2 | Observed, High | Approval/feedback live in the top header; there is no thumb-zone progress/action surface. | Long reviews require repeated reach and make the final decision detached from progress. | Prototype a bottom review bar that shows progress/comments and opens a deliberate approval/feedback sheet. |
| MOB-019 | P3 | Source-confirmed, High | Plan help is hidden below `sm`; keyboard shortcut hints remain in menus on touch. | The least familiar state has the least explanation and retains irrelevant desktop cues. | Replace hover/shortcut teaching with contextual, dismissible mobile guidance. |
| MOB-030 | P1 | Physical iPhone, High | Code Review's “Choose your analysis layers” setup surface does not scale to the phone viewport. | A configuration decision interrupts first use with an unreadable or cumbersome desktop composition before review can begin. | First determine whether current defaults can remove it from startup. If a choice is truly required, reduce it to compact vertically stacked options in a viewport-bounded, touch-safe surface and defer explanation to progressive disclosure. |
| MOB-032 | P1 | Physical iPhone GitHub PR review, High | The initial delivery dialog explaining “post to GitHub” versus “send to your local agent” is cut off around half-screen height. | A consequential destination choice is partially unreadable before the reviewer reaches the diff. | Make the destination decision a viewport-bounded mobile sheet or compact vertical choice, with the primary consequence visible without scrolling past a clipped frame. |
| MOB-033 | P2 | Physical iPhone GitHub PR review, High | The PR context renders a Comments block even when the pull request has no comments; alongside the already cramped summary and other PR panels, the empty section adds visible structure without information. | Scarce mobile space is spent on absence, increasing navigation and hierarchy noise. | Omit empty PR sections and reveal them only when populated or explicitly requested. |

### Code, Guide, HTML, and performance issues

| ID | Priority | Evidence | Finding | Impact | Direction, not specification |
|---|---|---|---|---|---|
| MOB-020 | P2 | Physical iPhone + source-confirmed, High | Pierre starts Split on the phone. Switching to Unified helps but still did not produce a polished or comfortably readable diff in the live pass; by contrast, All Files looked clean. | A persisted desktop preference can make every mobile session start unusably, and a mode toggle alone is insufficient to create a good phone composition. | Allow a device/session presentation override without corrupting the reviewer’s desktop preference, then tune the owning full-width diff container rather than changing Pierre’s rendering contract blindly. |
| MOB-021 | P2 | Observed + source-confirmed, High | Guide is strong on phone, but uses fixed `px-10 py-8`; its review/collapse/file actions remain 17–31 px. At `md`, each chapter becomes `440px + diff`, which can squeeze iPad portrait diffs. | The best mobile concept still inherits desktop density and an early two-column breakpoint. | Give Guide responsive content padding and choose stacked/two-column layout from available diff width. |
| MOB-022 | P2 | Source-confirmed, High | HTML annotate renders arbitrary author HTML in a sandbox and intentionally preserves author styling. | Plannotator cannot guarantee the annotated page itself is responsive; controls can be mobile-safe while the artifact is not. | Define host-chrome guarantees, detect/communicate artifact overflow, and provide an escape such as fit/actual-size—not destructive author CSS. |
| MOB-023 | P1 | Measured + source-confirmed, High | Production single-file HTML is ~21.85 MB raw / 6.87 MB gzip-reference for plan and ~17.50 MB raw / 5.60 MB gzip-reference for review. The worker and syntax assets are inlined. SPA responses set only `Content-Type`; wire compression was not verified. | First open over a tailnet can be slow and memory/parse-heavy on mobile; every session starts with the whole surface. | Measure real Tailscale transfer/TTI on devices, set budgets, then investigate compression and mobile-relevant code splitting/asset deferral without breaking standalone delivery. |
| MOB-024 | P2 | Measured, Medium | The review demo logged 66 Pierre parser errors on a clean tablet load while still rendering. | Console noise obscures real remote/mobile failures and may add avoidable work. | Reproduce against production payloads; fix the patch shape or downgrade expected diagnostics. |

### Tailscale and session-boundary issues

| ID | Priority | Evidence | Finding | Impact | Direction, not specification |
|---|---|---|---|---|---|
| MOB-025 | P2 | Source + docs confirmed, High | Tailscale makes the same unauthenticated local API reachable to every permitted tailnet peer. | A mobile link can be opened on shared devices or by broader tailnet groups than intended; review actions are consequential. | Make the trust boundary explicit in mobile onboarding and research optional session confirmation/auth without misrepresenting the current boundary. |
| MOB-026 | P2 | Source + docs confirmed, High | `--tailscale` does not apply to automatic plan hooks; the mobile plan path is a direct annotate gate. | “Review my plan on phone” is not one consistent invocation/mental model today. | Decide whether mobile plan review stays an explicit gate or needs an intentional hook-to-tailnet handoff. |
| MOB-027 | P3 | Source-confirmed, High | Hard kills/reboots can leave a Serve mapping and sessions must remain alive while the reviewer is on another device. | Mobile reviewers are more likely to be interrupted, lock the phone, or return late. | Include reconnect/expired-session/host-ended states in the mobile journey and usability tests. |

## Noise inventory

“Noise” here means a useful desktop control that is overexposed in a touch-first circumstance, not a feature that should be deleted globally.

| Surface | Current exposed noise | Keep visible on phone | Move behind context/sheet/menu | Hide by default |
|---|---|---|---|---|
| Plan header | brand, Send Feedback, Approve, annotations, AI, options | session identity/status; one review action entry | annotations, AI, overflow, destination | desktop labels/shortcuts |
| Plan document top | Select, Pinpoint, Markup, Comment, Redline, Label, help | active contextual action only | full mode chooser and help | duplicate idle toolstrip |
| Plan card | Wide, Focus, Edit, diff, attachments, global comment, copy | edit state when editing; change status when relevant | attachments, copy, view modes | Wide/Focus as persistent micro-links |
| Plan sticky lane | second mode strip + badges | one compact state/action | change history | duplicate six-mode controls |
| Document navigation | Contents, Versions, Files, Messages, Archive | current document and back | one mobile navigator sheet | desktop resize handles |
| Review header | file tree, Guide, repo/branch, destination, feedback/approve, annotations, AI, agents, options | back/context, Guide/current mode, one review action entry | repo/destination/status/side surfaces | keyboard hints |
| Review left rail | Git status / Tree / Commits, diff/worktree/base, search, collapse/view/stage toggles | current file/progress entry | full navigator sheet | fixed rail |
| Dock header | tabs, close, collapse all, Split/Unified, display options | current artifact title | presentation/options | dock-management chrome on phone |
| File header | collapse, status/counts, viewed, stage, comment, actions | filename/status; one comment affordance | viewed/stage/actions | simultaneous icon cluster |
| Right rail | annotations, AI, agents | comment/progress indicator | bottom/full-height sheet | fixed 288 px rail |
| Guide chapter | collapse, reviewed, chips, overview, file controls, full diff chrome | chapter title/progress, narrative, focused diff | file list and file utilities | desktop split controls |
| Optional Vim HUD | command map and reticle | only after explicit touch-compatible enablement | help | default mobile display |

## Candidate mobile product directions

These are hypotheses to prototype, not the specification.

### Direction A: Artifact Stage

The phone contains one stage at a time:

- document;
- diff or Guide chapter;
- navigator;
- annotations/AI;
- submission review.

Sheets replace fixed rails. A sheet is modal in attention but interruptible: swipe or tap to dismiss, state preserved, artifact restored exactly where it was.

### Direction B: Native-selection-first plan annotation

Start in reading mode. The user selects text using system handles; a small anchored action offers Comment, Markup, Redline, or More. Pinpoint becomes an explicit element mode for diagrams/HTML rather than a permanent up-front choice.

This would preserve the sophisticated annotation vocabulary while removing the six-choice band from arrival.

### Direction C: Guide-first phone review

When Guide exists, the phone can open into ordered chapters with progress. When no Guide exists or the reviewer wants raw inspection, fall back to a full-width Unified all-files view.

This is promising because it changes ordering and comprehension, not truth: the real Pierre diff remains in the chapter and all files remain reachable.

Research risk: users may resent generation latency or feel the guide filters too aggressively. The UI must make “all changes” and guide provenance obvious.

### Direction D: Full-width Unified raw review

Phone raw review defaults to:

- tree closed;
- Unified presentation scoped to the mobile session;
- one file/chapter at a time;
- horizontally scrollable code with a clear affordance, optional wrap;
- files/status/commits in a navigator sheet;
- annotations/AI in a sheet;
- stage/viewed/actions in a file action menu.

Desktop preferences should survive unchanged when the user returns to desktop.

### Direction E: Adaptive iPad workspace

Do not classify iPad as desktop solely at 768 px.

- Portrait touch: artifact plus a transient overlay; Guide chapters remain stacked until the diff has a healthy minimum width.
- Landscape touch: optional single persistent navigator, large targets.
- Landscape with pointer/keyboard and sufficient canvas: current multi-pane workspace, with touch-safe fallback retained.

The decision function should consider viewport, available center width, `pointer`, `hover`, keyboard/pointer presence where detectable, and user choice.

### Direction F: Mobile review bar

A bottom safe-area-aware bar could hold:

- review progress / current file;
- comments count;
- primary “Review” or “Send” entry;
- a separated approval action that opens confirmation/summary rather than approving on first tap.

This makes the completion model reachable without placing a destructive or high-stakes action beside dense navigation icons.

## Suggested prototype sequence

Prototype learning in this order; do not start with visual polish.

1. **Journey unblock:** mobile file/document navigator for folder annotate.
2. **Review composition:** tree closed + Unified + review sidebar sheet at 390 px.
3. **Plan hierarchy:** reading-first selection and a mobile review bar.
4. **Guide adaptation:** responsive padding, touch targets, stacked iPad portrait threshold.
5. **Keyboard/viewport hardening:** `dvh`, `visualViewport`, 16 px inputs, safe areas.
6. **Physical-device interaction:** Pierre selection, native document selection, sheets, rotation, VoiceOver.
7. **Performance:** real tailnet transfer, parse/highlight, warm return, and interruption.

Each prototype should be tested with a realistic long plan, 50+ changed files, a large split diff, a generated Guide, a folder session, a raw HTML artifact, existing annotations, and a partial submission recovery state.

## Physical-device test plan before specification

### Devices

- Small iPhone supported by current Safari.
- Current 6.1-inch-class iPhone with notch/Dynamic Island.
- Large iPhone.
- 11-inch iPad portrait/landscape, touch only.
- iPad with trackpad/keyboard.

### Settings and conditions

- Light/dark/system/colorblind themes.
- Text size / browser page zoom at 100% and 200% layout stress.
- VoiceOver and keyboard navigation.
- Reduce Motion, Increase Contrast, and reduced transparency if supported.
- Tailscale Wi-Fi, cellular handoff, device lock, tab background/restore, host exit, stale URL.
- Software keyboard open while editing a long comment and while confirming submission.
- Rotate with a composer, sheet, or selected diff range open.

### Core tasks

- Open from QR and identify session trust/context.
- Read and approve a plan with no comments.
- Select text, comment, edit comment, inspect feedback, and send.
- Direct-edit a document and finish/cancel safely.
- Select a file from a folder and switch files with unsent feedback.
- Review a changeset through Guide, then verify an unplaced file.
- Review raw changes without Guide, comment on a line range, stage/view, and approve.
- Recover after keyboard, rotation, connection interruption, and partial platform submission.

## Performance research

Measured production build artifacts at the baseline:

| Surface | Raw single HTML | gzip reference | Brotli reference |
|---|---:|---:|---:|
| Plan/document | 21,848,875 bytes | 6,868,745 bytes | 6,055,565 bytes at quality 8 |
| Code review | 17,503,379 bytes | 5,596,476 bytes | 4,635,466 bytes at quality 11 |

These are file-compression references, not measured Tailscale wire bytes. Source responses explicitly set `Content-Type` but not content encoding or caching. The next pass must capture real response headers, transferred bytes, HTML parse time, React hydration/mount, worker startup, first highlighted diff, memory, and interaction readiness on devices.

Useful existing performance architecture:

- review all-files and Guide use virtualized/bounded mounted Pierre CodeViews;
- highlighting uses an inlined worker pool and theme synchronization;
- Guide preserves lightweight file shells while evicting distant CodeViews.

Risks:

- a single HTML response delays all app code behind one transfer and parse;
- plan includes substantial editor/renderer capability even for simple reading;
- review includes Pierre/Shiki/worker capability even before the user chooses Guide or a file;
- syntax/highlight work and large diffs can contend with touch/scroll on mobile hardware;
- no service-worker/offline return path is part of the current session model.

## Detector result

The deterministic Impeccable detector ran once over 25 narrowed source/style targets. It returned 13 `side-tab` warnings and one `codex-grid-background` advisory. Source triage found no mobile issue among them:

- eight reticle-corner borders;
- three semantic plan-diff gutters;
- two review diagnostic/AI borders;
- one optional document grid advisory.

The detector therefore did not find the important mobile defects. Rendered geometry and source tracing were materially more useful. Mutable browser overlay injection was blocked by the browser’s URL security policy, so no visual detector overlay was shown.

## Open questions and decision gates

### Product intent

1. Is phone code review expected to support deep inspection, or optimized triage/comment/approve with an escape to raw detail?
2. Should a completed Guide become the default phone entry, a recommended card, or remain a manual mode?
3. Is automatic plan-hook tailnet handoff a product requirement, or is an explicit annotate gate acceptable?

### Interaction

4. Can native selection plus a contextual action replace the permanent six-mode plan strip on phone?
5. Should approval live in a bottom review bar, and what confirmation separates it from ordinary navigation?
6. Which desktop controls must remain one tap away for expert iPad users?

### Adaptation

7. Should iPad composition be based on minimum artifact width plus pointer capability rather than named breakpoints?
8. Should mobile presentation overrides be session/device-local so Split/tree preferences remain untouched on desktop?

### Trust and performance

9. What is the acceptable first-open and resume time over a real tailnet?
10. Does a tailnet session need an optional per-session confirmation or authentication layer beyond tailnet ACLs?
11. What happens in the UI when the host ends the session while the phone tab remains open?

### Validation

12. Which physical devices and Safari versions are the supported floor?
13. What telemetry, if any, can measure surface, device class, Guide use, completion, and abandonment without collecting review content?

## Run notes and limitations

- `HEAD` and `origin/main` were both verified at `ef49c701c23b867cec2a5d78343813ba89d2a025` before the audit.
- Local Vite demos exercised the same React/CSS assets served by live sessions. No Tailscale mapping was created or changed.
- Rendered viewports included 390×844 phone, 768/820/834 px iPad portrait, and 1180×820 iPad landscape. Compact 320 px evidence covered Settings; the browser’s per-tab viewport control limited some cross-tab compact-plan repetition.
- The browser was Chromium and reported fine pointer/hover. Coarse-pointer rules, Mobile Safari, keyboard, safe areas, VoiceOver, and real tailnet latency remain physical-device work.
- Conditional Vim HUD evidence was not treated as a clean-install default.
- Browser screenshots and raw detector output were retained only as temporary run evidence and are not dependencies of this dossier.
- No product code was edited. Production builds created ignored `dist` outputs for size measurement.

## Primary source map

### Serving and Tailscale

- `apps/hook/server/index.ts`
- `packages/server/index.ts`
- `packages/server/annotate.ts`
- `packages/server/review.ts`
- `packages/server/remote.ts`
- `packages/server/tailscale-serve.ts`
- `packages/shared/tailscale.ts`
- `apps/hook/vite.config.ts`
- `apps/review/vite.config.ts`

### Plan/document

- `packages/editor/App.tsx`
- `packages/editor/components/AppHeader.tsx`
- `packages/ui/components/AnnotationToolstrip.tsx`
- `packages/ui/components/AnnotationPanel.tsx`
- `packages/ui/components/CommentPopover.tsx`
- `packages/ui/components/Viewer.tsx`
- `packages/ui/hooks/useAnnotationHighlighter.ts`
- `packages/ui/hooks/useIsMobile.ts`
- `packages/ui/components/sidebar/SidebarContainer.tsx`
- `packages/ui/components/sidebar/SidebarTabs.tsx`
- `packages/ui/components/html-viewer/HtmlViewer.tsx`

### Code review, Pierre, and Guide

- `packages/review-editor/App.tsx`
- `packages/review-editor/components/DiffViewer.tsx`
- `packages/review-editor/components/AllFilesCodeView.tsx`
- `packages/review-editor/components/FileTree.tsx`
- `packages/review-editor/components/SectionsPanel.tsx`
- `packages/review-editor/components/ReviewSidebar.tsx`
- `packages/review-editor/hooks/useAnnotationToolbar.ts`
- `packages/review-editor/components/guide/GuideScreen.tsx`
- `packages/review-editor/components/guide/GuideView.tsx`
- `packages/review-editor/components/guide/GuideSectionCard.tsx`
- `packages/review-editor/components/guide/GuideViewportManager.tsx`
- `packages/review-editor/index.css`
- `packages/ui/config/settings.ts`
