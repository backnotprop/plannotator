# Hover cards: trigger customizability and first-run announcement

Design for the follow-up to #1461 (token hover cards, Tier 0). Written before
implementation; the implementation follows this document.

## 1. The problem

#1461 shipped hover cards on for everyone, behind one boolean
(`tokenHoverCards`, cookie-only, default `true`). Resting the pointer on a
symbol for 350ms opens a card. That is a good default and a bad only-option:
a reviewer who reads with the pointer parked in the text gets cards they did
not ask for, and their only recourse today is a binary off switch that also
takes away a feature they might want on demand.

The ask is trigger customizability plus a one-time announcement, and above all
a **rational** settings list: the fewest controls that cover real needs.

## 2. Prior art: how VS Code models this

VS Code's hover family, and what each one is actually for:

| Setting | Type | Default | What it buys |
|---|---|---|---|
| `editor.hover.enabled` | boolean | `true` | Kill switch. |
| `editor.hover.delay` | number (ms) | `300` | Dwell before the hover appears. |
| `editor.hover.sticky` | boolean | `true` | Whether the pointer can travel onto the hover without it closing. |
| `editor.hover.above` | boolean | `true` | Placement preference. |
| `editor.gotoLocation.multiple*` | enum x5 | `peek` | What Go-to-Definition does when there are several results. |
| `editor.multiCursorModifier` | enum (`alt` \| `ctrlCmd`) | `alt` | Which modifier means "extra cursor", which in turn decides which one means "go to definition on click". |

Three lessons worth taking:

1. **The modifier is a single global choice, not a per-gesture one.** VS Code
   does not ship a "modifier for definition preview" and a separate "modifier
   for go to definition". `multiCursorModifier` picks one, and the other
   gesture takes what is left. The user never gets to build a conflicting pair.
2. **The trigger and the delay are separate axes and both are real.** Delay is
   the single most-tuned hover setting in VS Code, because "I want hovers but
   they are too eager" is a distinct complaint from "I do not want hovers".
3. **`gotoLocation.*` is the cautionary tale.** Five enums describing what a
   click does when the answer is ambiguous. Almost nobody touches them, they
   are hard to reason about together, and they exist because click behavior was
   made configurable. We should not import that.

VS Code's Cmd/Ctrl+hover definition peek is a fourth relevant behavior, but it
is not a setting there: it is a fixed consequence of `multiCursorModifier`. It
is also why our modifier choice below is not free.

## 3. Our constraints (what is already true, and must stay true)

- **The 350ms dwell IS the current gate.** `DWELL_MS` in
  `packages/review-editor/hooks/useTokenHover.ts:10`. Nothing is requested
  before it elapses; sweeping a diff costs zero ripgrep processes. Any new
  trigger must gate at least as early as this, never later.
- **Cmd/Ctrl+click opens the References panel.** Shipped contract
  (`AllFilesCodeView.handleTokenClick`, `DiffViewer.handleTokenClick`). Not
  negotiable, not configurable.
- **Cmd/Ctrl+hover already has a meaning:** it paints `pn-token-nav` on the
  token, the "this is a navigable target" affordance. The modifier is taken.
- **Alt+click is a quiet alias** into the same References panel, added by
  #1461 and deliberately unadvertised.
- **A plain click is not free.** In `DiffViewer` an unmodified token click
  falls through to `toolbarHostRef.current?.handleTokenClick`, the
  selection/annotation toolbar host. Plain click already means something.
- **Comment-only surfaces and read-only views never get the card.** The
  portable guides.show viewer passes neither hover handler; `AllFilesCodeView`
  and `DiffViewer` treat the props as absent by default. Untouched by this work.
- **The whole feature also rides `canUseLiveWorkspaceActions`.** No live
  workspace (GitButler stack views, and friends) means no cards regardless of
  any setting.
- **Off must mean off at the source.** Today `tokenHoverEnabled === false`
  means the handler props are never passed, so there are no listeners, no
  requests and no card in the React tree. That property is the reason the
  feature is cheap when unwanted, and it survives this change verbatim.

## 4. The model

**Naming.** The user-facing name is **"Hover cards"** everywhere a reader meets
it: the announcement title, the Settings heading, and the descriptions. Every
internal identifier keeps the `tokenHover*` spelling it shipped with —
`tokenHoverTrigger`, `tokenHoverDelay`, the cookie keys, the hook, the
component and file names, and the `data-token-hover-*` test ids — so the rename
carries no migration churn. "Token" was accurate and unhelpful: it describes
the implementation's unit rather than the thing the reviewer points at, and in
an app full of annotations "token hover card" invites reading it as a kind of
comment card.

**Two settings. Both cookie-only. Nothing else.**

### 4.1 `tokenHoverTrigger` — how cards open

| Value | Label | Meaning |
|---|---|---|
| `hover` (default) | On hover | Rest the pointer on a symbol; the card opens after the dwell. Today's behavior. |
| `modifier` | While holding Cmd (Ctrl on Windows and Linux) | Cards only while the primary modifier is held. With the key up, nothing is armed, nothing is requested, nothing opens. |
| `off` | Off | No handlers, no listeners, no requests, no card. |

This is one control, not a boolean plus an enum. A separate on/off toggle
alongside a mode select creates an unreachable state (`enabled: false,
mode: 'modifier'`) that has to be reasoned about at every read site, and it
puts two controls where the user is answering one question. `off` is a value
of the question, not a switch above it.

**Why Cmd (Ctrl) and not Alt.** Ratified by the maintainer; this replaces an
earlier Alt proposal.

1. **Alt is spoken for, in a way that fires constantly.** Push-to-talk
   dictation is very commonly bound to a held Alt. An Alt-gated card would open
   every time the user starts speaking, with the pointer wherever they left it,
   which is the exact failure this setting exists to prevent.
2. **Cmd+hover is already the gesture.** It is what VS Code does for "tell me
   about this symbol": the navigable-target underline plus a definition peek,
   under one held key. Gating on Cmd rides that muscle memory instead of
   inventing a competing one.
3. **Alt-hold is taken inside Plannotator too.** The plan editor already binds
   a held Alt to the temporary input-method switch
   (`useInputMethodSwitch`, `inputMethod.shortcuts.ts`). One held key meaning
   two different things across two surfaces is a worse story than reusing the
   modifier that already means "tell me about this".

**The old anti-Cmd argument is moot.** It was that Cmd+hover already paints
`pn-token-nav`, so a card on the same gesture would collide with the "this is
clickable" affordance and precede every deliberate Cmd+click. Two things
settled it:

- The underline and the card appearing together under a held Cmd is not a
  collision, it **is** the composite gesture, the same one VS Code ships.
- `handleCodeNavRequest` now dismisses the hover surface on **every**
  References invocation (§6), so a Cmd+click cleanly supersedes an open card
  or a pending dwell instead of stacking with it.

**Why the modifier is not itself a setting.** Offering "Cmd or Alt" is a third
control that buys one keystroke of taste and doubles what every doc sentence
has to describe. VS Code makes exactly one modifier choice for the same reason.

**The stored value stays `modifier`.** The setting names the shape of the gate,
not which key fills it, so the ruling changed labels and one key check and
migrated nothing.

### 4.2 `tokenHoverDelay` — how long the dwell is

| Value | Label |
|---|---|
| `200` | Fast |
| `350` (default) | Default |
| `700` | Relaxed |

**Why this earns a control.** "Hover cards annoy me" is not one complaint, it
is three, with three different remedies:

- *"I never want these"* → `off`.
- *"I want them when I ask, not when I read"* → `modifier`.
- *"I want them, they are just too eager"* → a longer dwell.

The third is not served by either of the first two, and it is the complaint
that a 350ms constant produces most often, because dwell tolerance is a
personal reading-speed property. It is also the one VS Code found worth
shipping (`editor.hover.delay`) after having both an enable flag and a
modifier-gated peek.

**Why three fixed steps and not a slider or a number field.** A slider invites
tuning a value whose perceptible granularity is roughly 150ms; nobody can tell
340 from 360, and offering the precision implies it matters. Three named steps
say what the axis is for and stop.

**Why the delay applies in both trigger modes.** It would be defensible to
argue that holding the modifier is already an expression of intent, so
`modifier` mode
should dwell less (or not at all). Rejected: a zero dwell in modifier mode
fires one ripgrep per token swept while the key is down, and a *separate*
implicit dwell for modifier mode is a hidden coupling that cannot be explained
in the Settings row. One constant, one control, one sentence: this is how long
the pointer rests before a card is requested.

The delay control is disabled (visible, inert) when the trigger is `off`, so
the pair reads as one idea with an inapplicable half rather than as two
unrelated rows.

### 4.3 Rejected controls, and why

| Rejected | Argument |
|---|---|
| **Click to open the card** | See §5. It has no free gesture. |
| **A click-mode that overrides the References panel default** | Directly asked about in the brief. It replaces a shipped, documented contract (Cmd+click = References) with a per-browser preference, which means the answer to "what does Cmd+click do in Plannotator" stops being knowable. It also doubles the trigger matrix (3 hover modes x 2 click modes) for a destination the card already reaches: every location line on the card routes into the References panel. There is no user need it serves that the card does not already serve one click later. This is our `gotoLocation.*`. |
| **A separate on/off boolean beside the mode** | Creates an unreachable state, adds a control, answers no new question. `off` is a mode. |
| **A modifier chooser (Cmd vs Alt)** | One keystroke of taste, at the price of doubling every sentence that describes the gate. Alt is also the dictation key (§4.1). |
| **`sticky` / leave-grace toggle** | The 250ms leave grace exists so the card's own reference links are reachable. A user who turns it off cannot click the card. It is a correctness constant, not a taste. |
| **Placement (above/below)** | The card already flips when the viewport would clip it. Nothing left to choose. |
| **Per-language or per-file-size gating** | Speculative. The render threshold (definition, or two or more references) already suppresses the thin answers this would target. |
| **A dwell for *closing*** | Same category as `sticky`. |

## 5. The click-to-open interaction matrix (why it does not earn its place)

The brief asks for proof, so here is the gesture budget on a token in a diff
pane. Each row is a gesture; the column is what already owns it.

| Gesture | Owner today | Free for a card? |
|---|---|---|
| Pointer down + drag | Text selection, and line-range selection in the diff gutter chain | No. A card-opening click has to be distinguished from the start of a drag, which means deferring to `mouseup` and comparing coordinates, and any threshold you pick is wrong for someone. |
| Plain click (no drag) | `toolbarHostRef.handleTokenClick`: the annotation/selection toolbar host | No. Taking it means either annotating stops working from a token click, or the card and the toolbar both appear and fight for the same anchor rect. |
| Cmd/Ctrl+click | References panel (shipped contract) | No, by rule. |
| Alt+click | References panel (quiet alias, #1461) | Only by breaking the alias. Unrelated to the gate and deliberately left alone. |
| Shift+click | Range selection extension in the surrounding text | No. |
| Double click | Word selection (native) | No. |
| Middle click | Paste on X11, new tab semantics elsewhere | Not usable. |

Every gesture on a token is spoken for. A click-to-open mode can only be built
by evicting a sitting tenant, and the two tenants worth evicting (plain click,
Alt+click) are the annotation toolbar and the References alias. Meanwhile
`modifier` mode already delivers the thing a click mode is wanted for, which is
"cards only when I ask", using a gesture that conflicts with nothing because a
held key is not a click.

**Conclusion: no click mode.** Click behavior is untouched by this work.

## 6. Trigger mechanics

The gate is in the hook, not in the diff views. `useTokenHover` gains an
options argument, `{ mode, delayMs }`; `AllFilesCodeView` and `DiffViewer`
keep their prop signatures byte-identical, which matters because both are
compiled into the portable guides.show viewer.

`off` is still enforced one level up, in `App.tsx`, by not passing the handlers
at all. The hook never sees `off` in practice; the mode it sees is `hover` or
`modifier`. That keeps the zero-footprint property of #1461 exactly as shipped.

**Which key.** `isModKeyHeld` / `modEventKey` in `packages/ui/utils/platform.ts`:
`metaKey` and `Meta` on macOS, `ctrlKey` and `Control` elsewhere. One helper
pair, shared with the labels (`modKeyWord`), so the key the code checks and the
key the copy names can never disagree.

**Gate before the dwell.** In `modifier` mode `onTokenHoverEnter` checks the
tracked held state and returns before arming any timer, setting any state, or
touching the cache. Holding nothing costs one boolean read.

**Modifier pressed while already hovering.** The pointer does not re-enter a
token when a key goes down, so a gate that only reads the enter event would
make the common gesture ("what is this? *holds Cmd*") do nothing. The hook
remembers the last token entered (request + element, one ref, written on every
enter including gated ones) and runs the normal enter path when the key goes
down. Leave clears it.

**Only the key ALONE arms.** The gate's modifier is also the editing modifier,
so any other key going down while it is held (Cmd+C, Cmd+V, Cmd+S) disarms and
takes an open card with it. Without this, a copy performed with the pointer
parked over the diff pops a card mid-copy. This is cheap because the branch
already exists: the keydown handler compares `event.key` to `modEventKey`.

**Modifier released.** Release behaves the way pointer-leave behaves: it starts
the same 250ms grace, so the card can still be reached. One exception: if the
pointer is already inside the card when the key is released, the release is
ignored, because otherwise the card vanishes out from under someone reading it.
`onCardEnter`/`onCardLeave` already bracket that state; one ref records it.

**Typing owns the key.** A keydown whose target is an input, textarea, select
or contenteditable never arms, because the pointer is often parked over the
diff while a comment is being written and cards would pop mid-sentence. This is
belt and braces with the chord rule above.

**Window blur.** On macOS the app switcher is the same key this gate arms on,
so Cmd+Tab is now the COMMON way to leave with the key held. On `blur` the held
flag clears and the card closes.

**Listener cost.** The two key listeners and the blur listener exist only while
the mode is `modifier`. In `hover` mode the pipeline is byte-for-byte what
#1461 shipped, plus a delay constant read from settings.

**Delay.** `DWELL_MS` becomes the hook's `delayMs` option, defaulting to 350 so
every existing call site and test is unchanged. The leave grace, the cache
size, the scroll cancel and the render threshold are untouched.

## 7. Migration

`tokenHoverCards` (boolean, `plannotator-token-hover-cards`) is **replaced**,
not kept alongside. Keeping both would mean two sources for one question.

`tokenHoverTrigger.fromCookie()` reads `plannotator-token-hover-trigger` first.
When that key is absent it reads the legacy boolean:

- `'false'` (an early adopter who turned cards off) → `'off'`.
- `'true'` → `'hover'`.
- absent or unrecognized → `undefined`, so the registry default (`'hover'`)
  applies.

**The mechanism is re-resolution, not one-time seeding.** `configStore`'s
default-seeding write only fires when `fromCookie()` returns `undefined`, and a
migrating read returns `'off'`, so nothing is written on load: the legacy key is
re-read and re-resolved on every page load until the user actually touches the
setting, at which point `toCookie` writes `plannotator-token-hover-trigger` and
that branch wins from then on. Resolution is pure and identical every time, so
the repeated read costs one cookie lookup and can never drift.

Seeding it eagerly (a write inside `fromCookie`) was considered and rejected:
it would put a storage write inside a getter that the registry calls during
`ensureLoaded`, for no behavioral gain over re-resolving.

The legacy value is read, never written, and never deleted: a stale cookie is
inert, and deleting it would make a downgrade to the #1461 build silently
re-enable cards for someone who had turned them off.

Consequence worth stating plainly: **an early adopter who toggled cards off
stays off, and is never shown the announcement** (§8 gates on the resolved
trigger still being the default).

## 8. The announcement dialog

### 8.1 Where it sits in the chain

The review app's one-time chain is: guide intro → look-and-feel → review setup
→ Edit Mode. The new dialog goes **last**, after Edit Mode, so no existing
gate function changes.

Following `editModeAnnouncement.ts` exactly:

- A cookie gate, `plannotator-token-hover-announcement-seen`, holding a version
  string so a future revision can re-show it. Cookie-backed because Plannotator
  runs on random localhost ports.
- A pure `tokenHoverAnnouncementCanShow(state)` predicate, unit-testable, that
  returns false while `isLoading` or while any earlier chain dialog is visible.
  None of the chain dialogs ever stack.
- The pending flag is **latched at mount**, so choosing a trigger inside the
  dialog does not unmount the dialog mid-click.

Two extra conditions on top of the Edit Mode shape:

- **Skipped when the feature cannot run**: `canUseLiveWorkspaceActions` false
  means no cards are possible in this session, so announcing them is noise. It
  is skipped *without consuming the cookie*, mirroring how the guide intro
  skips on an empty diff, so the next real session still shows it.
- **Skipped when the user already has a non-default trigger**, which after §7
  is exactly the early adopter who turned cards off. Telling someone about a
  feature they already declined is the worst version of this dialog. That skip
  *does* consume the cookie: they have expressed the preference the dialog
  exists to collect.

### 8.2 Shape

The repo's big-format announcement shell, matching `EditModeAnnouncementDialog`
and `LookAndFeelAnnouncementDialog`: `max-w-5xl`, a header carrying the badge,
title and description, a `grid-cols-[1.1fr_1fr]` body that collapses to one
column under 820px, and a footer with the Settings pointer and one action.
Portal to `document.body`, `role="dialog"`, `aria-modal`, focus trap and Escape
wired the same way, Escape and the Done button both meaning "accept what the
radio currently says".

**The left column is a TRY-IT**, in the slot where the Edit Mode dialog plays
its recording: a three-line strip of diff whose `withRetry` token is genuinely
hoverable, with a prompt line inviting it. Resting the pointer there opens the
**real** `TokenHoverCard` through the **real** `useTokenHover`, so the reviewer
feels the actual dwell, the leave grace and the modifier gate before
committing to a setting.

Nothing is redrawn. A forked copy of the card's markup, or a second copy of the
dwell logic, would drift from the shipped surface the first time either changed
— which is precisely what an example is supposed to prevent. Three thin seams
carry it instead:

| Seam | Why |
|---|---|
| `useTokenHover({ resolve })` | The only fixture. The default posts to `/api/code-nav/hover`; the try-it returns a hardcoded `CodeNavHoverResponse`, because a demo must not search the reviewer's repository for a symbol they never asked about. |
| `TokenHoverCard({ layerClassName })` | The card portals to `<body>` like every instance, so its host has to be able to put it above the modal it is demonstrated inside (`z-[110]` over the dialog's `z-[100]`). |
| `TokenHoverCard({ inert })` | The try-it has no References panel behind it, so its location buttons lead nowhere and leave the tab order. |

The hovered token wears the same underline treatment the diff pane paints, from
one definition (`tokenHoverStyles.ts`): the shadow-DOM form is serialized into
Pierre's stylesheet as `.pn-token-hover`, the dialog applies the same
declarations as a style object.

**The try-it reads the LIVE setting**, not a prop: flipping the radio to the
hold-modifier option makes the demo behave that way immediately (hold Cmd over
the demo token and the demo card opens), and "Off" makes it do nothing and
closes any open card. That is the honest preview of each choice.

Because it is interactive it is **labeled rather than hidden**: the region
carries `role="group"` and an `aria-label`, the visible prompt line carries the
meaning, and only the mock code lines stay `aria-hidden` (read aloud they are a
wall of invented identifiers).

The right column carries the decision: the three options as a **radio group
that applies immediately** on selection (`configStore.set('tokenHoverTrigger',
value)`), following the WAI-ARIA radiogroup pattern (roving tabindex, arrows
move and wrap), plus the note about click behavior. Dismiss is therefore always
"accept current choice", with no separate confirm, and Escape can never lose a
selection the user made.

### 8.3 Copy (verbatim, no em dashes)

Badge: `New`

Title: `Hover cards`

Description:
> Rest the pointer on a symbol in a diff and Plannotator shows you where it is
> defined, an approximate signature, its doc comment, and a sample of its
> references. Every location on the card opens in the References panel.

Choice group label: `Show cards`

Options:

- `On hover` / `Rest the pointer on a symbol and the card appears. This is the default.`
- `While holding {Cmd|Ctrl}` / `Cards stay out of the way until you hold {Cmd|Ctrl}. Nothing is searched while the key is up.`
- `Off` / `No cards, no listeners, no searches.`

Note under the group:
> {Cmd|Ctrl}+click on a symbol still opens the References panel, whichever option
> you pick. Hover cards need ripgrep and a local checkout, and nothing appears when
> the search comes back empty.

(The modifier word is platform-resolved through `modKeyWord`: `Cmd` on macOS,
`Ctrl` elsewhere.)

Footer left:
> Change this anytime in Settings, in the Editor tab.

Footer button: `Done`

### 8.4 Settings UI

`ReviewDisplayTab` in `packages/ui/components/Settings.tsx` (the tab is labeled
**Editor** in review mode, which is what the dialog footer points at). The existing "Token hover cards" `ToggleSwitch` is
replaced in place by:

- Heading `Hover cards` with the same one-line explanation the toggle carried.
- A `SegmentedControl` for the trigger: `On hover` / `Hold {Cmd|Ctrl}` / `Off`.
- A `SegmentedControl` for the delay: `Fast` / `Default` / `Relaxed`, disabled
  when the trigger is `Off`.

Two rows, one section, same place in the tab.

## 9. What is deliberately not changing

- Cmd/Ctrl+click and Alt+click both still open the References panel. The
  Alt+click alias from #1461 is unrelated to the gate and is left alone.
- The 250ms leave grace, the 30-entry LRU, the snapshot flush, the scroll and
  wheel cancel, the render threshold, and the silent-failure rule.
- Comment-only surfaces, read-only views, and the portable guides.show viewer:
  they pass no hover handlers and gain no props.
- `canUseLiveWorkspaceActions` remains an independent hard gate above the
  setting.
- The server (`POST /api/code-nav/hover`) in either runtime.

## 10. Test plan (critical path only)

Per the repo's testing rules, each of these names a failure it catches.

1. **Modifier gating arms nothing** (`useTokenHover.test.tsx`): in `modifier`
   mode, an enter with Alt up spawns no request no matter how long time
   advances. Catches a regression where the gate moves after the dwell, which
   would restore per-token ripgrep on an idle sweep.
2. **Modifier pressed while hovering opens the card** (same suite): the
   gesture the mode exists for. Catches a gate that only reads the enter event.
3. **Modifier released starts the close** (same suite), and does not when the
   pointer is in the card. Catches a card that cannot be read or one that
   cannot be dismissed.
3b. **A chord opens nothing and closes an open card**: Cmd+C with the pointer
   parked on a token must not pop a card mid-copy.
4. **Delay feeds the dwell** (same suite): a 700 delay spawns nothing at 350.
   Catches the constant being left hardcoded.
5. **Legacy cookie migration** (new `tokenHoverSetting.test.ts`, pure lane):
   `plannotator-token-hover-cards=false` resolves to `off`; `true` and absent
   resolve to `hover`; the new key wins over the legacy one; round-trip through
   `toCookie`/`fromCookie`; unrecognized values fall through to the default.
   Catches silently re-enabling a feature a user turned off.
6. **Announcement once-ness and chain gate** (new
   `tokenHoverAnnouncement.test.ts`, pure lane): needed until marked seen,
   version bump re-shows, and the predicate is false while loading or while any
   earlier chain dialog is visible. Same shape as `editModeAnnouncement.test.ts`.
7. **The dialog's radio applies the setting** (DOM lane): selecting an option
   writes the trigger. Catches a dialog whose choice is decorative.

New DOM-gated files are registered in `.github/workflows/test.yml`'s
`--isolate` lane beside the existing hover tests.
