# v0.19 — Markdown polish & GitHub parity

Bring the in-app reader to parity with what GitHub renders on `README.md`, and tighten the inline prose experience for authors who paste freely from PRs, chat, and notes.

Target ship: end of sprint. Primary owner: @backnotprop. Reviewers: @alice, @bob.

<details>
<summary>Files touched in this ship (click to expand)</summary>

| File | Change |
|---|---|
| `packages/ui/types.ts` | Added `AlertKind`, `'directive'` union member, `alertKind` + `directiveKind` fields |
| `packages/ui/utils/parser.ts` | Alert detection on blockquotes, directive container parsing |
| `packages/ui/utils/slugify.ts` | **new** — `slugifyHeading()` |
| `packages/ui/utils/inlineTransforms.ts` | **new** — `transformPlainText()` |
| `packages/ui/components/InlineMarkdown.tsx` | Bare URL autolink, issue refs, mentions, plain-text transform integration |
| `packages/ui/components/BlockRenderer.tsx` | Heading anchor ids, alert case, directive case |
| `packages/ui/components/blocks/AlertBlock.tsx` | **new** — GitHub-parity alert rendering with Octicons |
| `packages/ui/components/blocks/Callout.tsx` | **new** — shared directive container |
| `packages/ui/theme.css` | Alert + directive color variants (light + dark) |

</details>

---

## Why now

Plannotator's reader is where plans *land* — a plan looks wrong here, it reads wrong everywhere. Authors routinely copy-paste from GitHub Issues (#412, #438), internal docs with smart punctuation, and chat threads full of `:emoji:`. Today those snippets render with straight quotes, literal `:wave:` shortcodes, and unlinked `#123` references. It's rough.

> [!NOTE]
> This is scoped to the **reader** only. We're not touching write-path authoring, draft persistence, or the annotation store. Follow-ups for those live in #501 and #512.

We also heard from @carol that the alert styling looked "AI-templated." That's fair — we shipped the first pass with uppercase titles and heavy background tint. This ship brings it in line with GitHub's actual Primer tokens.

## What's included

Eight additive rendering features, zero breaking changes:

| Feature | Shortcut | Example |
|---|---|---|
| Heading anchors | automatic | `#why-now` scrolls here |
| Bare URL autolinks | automatic | https://github.com/backnotprop/plannotator |
| GitHub alerts | `> [!NOTE]` | see below |
| Directive containers | `:::note` | see below |
| Mentions | `@user` | @backnotprop |
| Issue refs | `#123` | #412 |
| Emoji shortcodes | `:name:` | :rocket: :sparkles: :tada: |
| Smart punctuation | automatic | "it's a feature" → “it’s a feature” |

## Detailed feature backlog

Full picture of everything landing this sprint, follow-ups, and work spilling into v0.20. Expand the popout for sort/filter.

| Area | Feature | Owner | Reviewer | Priority | Status | Effort | Issue | PR | Target | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Reader | Heading anchor ids | @backnotprop | @alice | P0 | Shipped | S | #541 | #597 | v0.19 | `slugifyHeading`, unicode-safe |
| Reader | Bare URL autolinks | @backnotprop | @alice | P0 | Shipped | S | #542 | #597 | v0.19 | Trailing punctuation trimmed |
| Reader | GitHub alerts | @backnotprop | @bob | P0 | Shipped | M | #541 | #597 | v0.19 | Primer tokens, Octicons |
| Reader | Directive containers | @backnotprop | @bob | P1 | Shipped | M | #541 | #597 | v0.19 | Arbitrary kinds |
| Reader | Mentions + issue refs | @backnotprop | @alice | P0 | Shipped | S | #542 | #597 | v0.19 | GitHub-scoped when in repo |
| Reader | Emoji shortcodes | @backnotprop | @alice | P1 | Shipped | S | #542 | #597 | v0.19 | 29 curated codes |
| Reader | Smart punctuation | @backnotprop | @alice | P1 | Shipped | S | #542 | #597 | v0.19 | Code-span safe |
| Reader | HTML blocks (`<details>`) | @backnotprop | @bob | P0 | Shipped | L | #489 | #597 | v0.19 | Sanitized, relative-URL rewrite |
| Reader | Table copy (markdown) | @backnotprop | @alice | P1 | Shipped | S | #562 | #597 | v0.19 | Floating toolbar |
| Reader | Table copy (CSV) | @backnotprop | @alice | P1 | Shipped | S | #562 | #597 | v0.19 | RFC 4180 escaping |
| Reader | Table popout dialog | @backnotprop | @bob | P1 | Shipped | M | #563 | #597 | v0.19 | Radix Dialog, annotation-aware |
| Reader | Table sort/filter | @alice | @backnotprop | P1 | In Progress | M | #564 | — | v0.19 | TanStack Table Phase B |
| Reader | Table column visibility | @alice | @backnotprop | P2 | Planned | S | #565 | — | v0.19 | Phase C |
| Reader | Table row selection | @alice | @backnotprop | P2 | Planned | M | #566 | — | v0.19 | Copy selected as CSV |
| Reader | Footnotes (`[^1]`) | @bob | @backnotprop | P2 | Planned | L | #551 | — | v0.20 | Parser + renderer |
| Reader | Math (`$inline$`) | @bob | @backnotprop | P3 | Backlog | XL | #552 | — | v0.21 | Pulls KaTeX ~280KB |
| Reader | Task-list sync | @carol | @alice | P3 | Backlog | XL | #553 | — | v0.21+ | Two-way issue tracker sync |
| Parser | Alert case-insensitive | @backnotprop | @bob | P1 | Shipped | S | #541 | #597 | v0.19 | `[!note]` works |
| Parser | Directive edge cases | @backnotprop | @bob | P1 | Shipped | S | #541 | #597 | v0.19 | Unterminated absorbs to EOF |
| Infra | UI typecheck wiring | @backnotprop | @alice | P0 | Shipped | S | — | #597 | v0.19 | Root-cause for review finding |
| Infra | Annotation rehydration | @backnotprop | @alice | P1 | Shipped | S | — | #597 | v0.19 | `transformPlainText` fallback |
| Infra | DOMPurify allowlist | @backnotprop | @bob | P1 | Shipped | S | — | #597 | v0.19 | Added `open` attribute |
| UX | Alert styling revamp | @backnotprop | @carol | P0 | Shipped | M | #538 | #597 | v0.19 | GitHub Primer parity |
| UX | Code Tour dialog | @rockneurotiko | @backnotprop | P1 | Shipped | XL | #569 | #569 | v0.18 | Three-page animated walkthrough |
| Docs | Release notes draft | @backnotprop | @alice | P0 | In Progress | S | — | — | v0.19 | Highlights + breaking-ish changes |
| Docs | Blog post — "Reader Parity" | @backnotprop | @alice | P1 | Planned | M | — | — | v0.19 | Demo video + screenshots |
| Docs | Marketing page update | @alice | @backnotprop | P2 | Planned | M | — | — | v0.19 | New feature tiles |

## Rollout plan

:::info
We're landing this behind no flag — the features are additive and render safely against every historical plan. If rendering breaks for any saved plan, that's a parser regression, not a feature toggle issue.
:::

Three PRs, in order:

1. **Extract inline scanner** (#540) — moves `InlineMarkdown` out of `Viewer.tsx` so the next six features have somewhere clean to land. Pure refactor, no behavior change. Reviewed by @alice.
2. **Block-level features** (#541) — heading anchors, GitHub alerts, directive containers. Adds `slugifyHeading`, detects `[!NOTE]` markers on blockquotes, parses `:::kind` fences. Reviewed by @bob.
3. **Inline features** (#542) — bare URL autolinks, mentions, issue refs, emoji shortcodes, smart punctuation. Adds `inlineTransforms.ts` shared utility. Reviewed by @alice.

Each PR is under 300 lines and ships with tests. Total new test count: +40. Merge order matters — #540 must land first or #541 and #542 will conflict on `Viewer.tsx`.

---

## Feature walkthrough

### Heading anchors

Every heading now gets a deterministic id derived from its text, so URL fragments work: `plan.html#rollout-plan` jumps directly to that section. Inline markdown (bold, italic, code spans) is stripped before slugging, so `**Install** \`bun\`` becomes `install-bun`, not something gnarly.

Unicode letters are preserved — `Café` becomes `café`. See #445 for the rationale (a contributor filed the issue after headings in their French-language plan produced empty ids).

### Bare URL autolinks

A URL in prose now becomes a link without needing `<>` or `[label](url)` wrapping. Paste https://plannotator.ai into a plan and it just works. Trailing sentence punctuation doesn't get swallowed into the URL: "Visit https://github.com/backnotprop/plannotator." keeps the period outside the link, same as GitHub.

URLs inside backticks stay literal — `https://example.com/raw` shows as code. URLs inside explicit `[label](url)` markdown still route through the existing link handler.

### GitHub alerts

Five flavors, matching Primer exactly:

> [!NOTE]
> Useful information that users should know, even when skimming content. Supports **bold**, `code`, and links like [the design doc](https://plannotator.ai/docs/alerts).

> [!TIP]
> Helpful advice. Try running `bun run dev:hook` with a fixture at `tests/test-fixtures/12-gfm-and-inline-extras.md` to see this whole doc render live.

> [!IMPORTANT]
> Key information readers must know. Talk to @backnotprop before cherry-picking this into a point release — there's context in #538 that's not in the PR description.

> [!WARNING]
> Something that needs attention. If you add new alert kinds, update `AlertKind` in `packages/ui/types.ts` AND the icon mapping in `AlertBlock.tsx`. Forgetting the second causes a silent render fallback that only shows on the missing kind.

> [!CAUTION]
> Negative consequences. Never ship a rename of `alertKind` without a shared-payload migration — annotations on older plans use text-search for restoration, so renaming the field silently orphans every alert-block annotation made before the change. See #489 for the migration playbook.

### Directive containers

Same visual family as alerts, but with arbitrary kinds. Useful for plan conventions that don't map cleanly to GitHub's five:

:::tip
Directives shine for project-specific callouts — "deploy notes," "rollback steps," "monitoring checks." No need to shoehorn every concept into `note` / `tip` / `warning`.
:::

:::warning
Multi-paragraph directives work too.

Second paragraph here renders inline with the first. Bulletproof against blank lines inside the fence.
:::

:::danger
Reserve `:::danger` for operations you genuinely cannot undo — production data migrations, destructive cloud resource commands, credential rotations that invalidate existing sessions.
:::

:::success
Use `:::success` for completion markers in post-mortems and runbooks. Matches the green-check convention people already use in chat.
:::

### Mentions and issue refs

Write `@username` and `#123` in prose. When the plan lives inside a GitHub-linked repo, they render as real links to github.com. Otherwise they render as styled text — no broken links, no guessing.

- Thanks @alice for pairing on the scanner extraction in #540.
- @bob, would you take the parser PR (#541)? It touches `packages/ui/utils/parser.ts` which you know best.
- @carol filed #445, #489, and the original alert-styling feedback in #538.
- Full discussion history: #412 → #438 → #489 → #538.

Email addresses don't false-match: ramos@example.com is not a mention. Hex colors don't false-match: `#3b82f6` is still a color, not issue #3. Text inside code spans is always literal.

### Emoji shortcodes

:rocket: for releases, :bug: for bug fixes, :sparkles: for polish, :book: for docs, :tada: for celebration, :construction: for work-in-progress. The usual GitHub set.

Inline in prose — "just finished the review :wave:" — renders as you'd expect. Inside backticks, shortcodes stay literal: `:wave:` shows the text form. Unknown shortcodes pass through untouched, so `:not_a_real_emoji:` doesn't silently eat your colons.

### Smart punctuation

Straight quotes curl based on context: "she said hello" becomes “she said hello”. Apostrophes in contractions — don't, won't, it's, they'd — all curl correctly. Dashes: two hyphens become an en-dash for ranges (pages 3--5), three become an em-dash (like this --- inline break).

Ellipsis: three dots collapse to a proper character... which means author prose reads tighter on every screen size.

Code stays literal. `"don't do this"` inside backticks keeps straight quotes, preserving any shell or regex that ships inside a code span.

---

## Risks and mitigations

> [!WARNING]
> The two real risk vectors we traced during design:
> 
> **Annotation text-restoration drift.** Annotations store `originalText` captured from the rendered DOM. If smart punctuation turns `"hello"` into `“hello”`, old annotations made before this ship won't find themselves on reload — they'll silently disappear. Mitigation: text-search fallback normalizes both straight and curly forms during restoration.
> 
> **Code-span corruption.** Naïve string replacements on `block.content` would curl quotes inside `` `code` `` spans — wrong. Mitigation: all inline transforms run inside `InlineMarkdown`'s plain-text path, which is only reached after code-span regex has already consumed code content.

Neither risk is theoretical — we hit both during prototyping. See #541's PR description for the specific failing test cases and their fixes.

## Non-goals

- **Footnotes.** Not shipping. GitHub's `[^1]` syntax is a separate rabbit hole — tracked in #551.
- **Math rendering.** `$inline$` and `$$block$$` KaTeX support — tracked in #552. Would require pulling in `katex` (~280KB gzipped) which dominates the bundle.
- **Task-list metadata sync.** The existing checkbox rendering stays as-is. Two-way sync with upstream issue trackers is #553.
- **Full HTML passthrough.** We render `<details>` / `<summary>` via the existing raw-HTML block. Arbitrary inline HTML is still escaped by design — we don't want to re-open the XSS surface that sanitization solved in #489.

## Testing

```bash
# Unit tests
bun test packages/ui

# Live render against this fixture
bun run build:hook && \
  bun run --cwd apps/hook server/index.ts annotate \
  tests/test-fixtures/12-gfm-and-inline-extras.md

# Regression check: every plan in test-fixtures/ must still render identically
bun test:regression
```

All 149 existing tests continue to pass. +40 new tests across `slugify.test.ts`, `inlineTransforms.test.ts`, and the blockquote-alert / directive additions in `parser.test.ts`.

<details>
<summary>Expected test output (click to expand)</summary>

```
bun test v1.3.11
✓ parser.test.ts — 92 pass
✓ slugify.test.ts — 10 pass
✓ inlineTransforms.test.ts — 9 pass
✓ sanitizeHtml.test.ts — 7 pass
✓ planDiffEngine.test.ts — 14 pass
✓ sharing.test.ts — 11 pass
✓ diagramLanguages.test.ts — 6 pass

149 pass
0 fail
383 expect() calls
Ran 149 tests across 7 files. [61.00ms]
```

**New test coverage added in this ship:**

- `slugify.test.ts` — 10 cases: plain text, bold stripping, code-span stripping, link label extraction, wiki-link handling, special-character collapse, unicode preservation, empty-input fallback, all-symbol fallback, trailing-hyphen trim.
- `inlineTransforms.test.ts` — 9 cases: known shortcode replacement, unknown shortcode passthrough, multiple shortcodes, ellipsis, em-dash, en-dash, curly quotes, contraction apostrophe, single-quote phrases.
- `parser.test.ts` — 15 new cases covering GitHub alert detection (5 kinds, case-insensitive, marker-only, mid-quote rejection) and directive containers (basic, arbitrary kinds, multi-paragraph, unterminated absorption, spacing tolerance).

</details>
## Open questions

:::question
Should we ship the alert-styling update in a point release (0.18.1) rather than minor (0.19.0)? The visual delta is user-facing and arguably closer to "bug fix" than "feature" — the original styling genuinely didn't match GitHub. @alice, @bob — opinions?
:::

One more: do we want `:::question` as a first-class directive kind with its own color, or is the generic blue enough? See #538 for the discussion. I lean generic — adding colors has a long tail of "add one more" requests.

---

## Sign-off

When this lands, the reader covers:

- :white_check_mark: Every inline markdown pattern GitHub renders
- :white_check_mark: Every block-level pattern GitHub renders (alerts, details/summary, tables, code with syntax highlight)
- :white_check_mark: Directive containers for project-specific callouts
- :white_check_mark: Smart typography for pasted prose
- :construction: Footnotes — next sprint (#551)
- :construction: Math — deferred (#552)

Approve to ship after @alice and @bob sign off.

Ping @backnotprop in #538 with any objections — keeping review open through EOD Friday.
