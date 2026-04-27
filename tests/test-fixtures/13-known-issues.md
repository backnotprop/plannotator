# v0.19.1 — known issues from first PR review

Tracking follow-ups from the v0.19 review. Each section below demonstrates a rendering gap in the reader. Some are minor, some are annoying. None are blockers for v0.19.

Scope: every gap here is reproducible by reading this file in the annotate UI.

## 1. Smart punctuation eats CLI flags

Prose that references command-line flags silently turns the two hyphens into an en-dash. Compare these lines — they look the same in source but render differently:

- In prose: run bun --watch to rebuild on change, or npm --help for options.
- In a code span: run `bun --watch` to rebuild on change, or `npm --help` for options.

The first line copy-pastes as broken commands. The second keeps the hyphens literal because code spans skip the transform.

Same symptom with longer flags: `claude-code --model opus-4` works fine in code, but in prose — **claude-code --model opus-4** — renders with an en-dash.

**Impact:** every dev plan that mentions a tool invocation outside of backticks.

## 2. GitHub alerts lose their body when it starts with a list

The most common callout pattern on GitHub is a Note or Warning with a bulleted list inside. Right now the reader breaks that shape — the alert renders as an empty header, and the list items spill out below as separate italic quotes.

> [!NOTE]
> - First install bun: `curl -fsSL https://bun.sh/install | bash`
> - Then clone and run: `bun install && bun run dev`
> - Report issues in #412

> [!WARNING]
> 1. Stop the running server before migrating.
> 2. Back up `~/.plannotator/plans` before running the command.
> 3. Verify the backup before confirming.

> [!TIP]
> Alerts with plain prose still work fine — it's specifically the list / code-fence / heading body that gets split off.

**Impact:** anyone pasting a GitHub README section with a real alert into a plan.

## 3. Mentions and issue refs always point to github.com

The reader links `@alice` and `#42` based on whether the current repo has a slash-shaped name (org/repo). That assumption is fine for GitHub but wrong for GitLab, Bitbucket, Azure DevOps, or self-hosted forges — all of which use the same `group/project` shape.

For a team running Plannotator inside a GitLab repo, every reference like @bob, @carol, or #123, #456 generates a link pointing at `github.com/bob` or `github.com/group/project/issues/123` — wrong destination.

**Impact:** non-GitHub teams see broken links on every mention throughout every plan.

## 4. External links inside raw HTML hijack the review tab

Markdown links open in a new tab automatically. Links inside a raw HTML block don't — clicking them replaces the Plannotator tab with the target page, losing any in-progress annotations.

Example:

<details>
<summary>Reference links from the spec</summary>

See the <a href="https://tanstack.com/table/v8/docs">TanStack docs</a> for sort/filter patterns we mirror, the <a href="https://primer.style/design/foundations/tokens">Primer tokens</a> we aligned alert colors to, and the <a href="https://github.com/anthropics/claude-code">Claude Code repo</a> for agent integration details.

</details>

Click any link above to reproduce — the whole Plannotator session disappears, the back button restores it but any unsaved state is lost.

**Security-adjacent note:** this also opens a tab-nabbing vector if the pasted HTML ever comes from an untrusted source. The opened page gets a live reference back to the Plannotator tab and can redirect it. Scheduled for fix alongside this.

## 5. Headings with identical text share the same anchor id

Both subsections below get the anchor id `#summary`. Click either entry in the sidebar TOC and the page always jumps to the first one. Fragment URLs like `plan.html#summary` do the same.

### Summary

First pass of this section — the one the TOC lands on every time.

### Summary

Second pass of this section — unreachable via hash navigation.

**Impact:** larger plans that repeat structure ("Summary" per chapter, "Risks" per section) silently lose sidebar precision.

## 6. URL autolinks drop a trailing closing paren

Wikipedia URLs famously end in `(disambiguation)` or `(mathematics)`. Our autolink trims trailing punctuation so aggressively that the closing paren gets stripped, leaving a link to a non-existent page.

Read about this at https://en.wikipedia.org/wiki/Function_(mathematics) — click it and you land at `Function_(mathematics` with no closing paren, which 404s.

Same thing for https://en.wikipedia.org/wiki/Plan_(drawing). Works fine when wrapped: [the drawing convention](https://en.wikipedia.org/wiki/Plan_(drawing)).

**Impact:** whenever someone links Wikipedia or any URL with balanced parentheses in the path. Less common than the others, but noticeable when it hits.

## 7. Plan diff view loses alert, directive, and details semantics

When the first version of a plan is denied and the author resubmits, the reviewer flips to diff mode to see what changed. Right now the diff renderer falls back to plain text for the three new block types in v0.19 — alerts, directives, and raw HTML blocks — so the reviewer sees structure-less content exactly in the mode where visual cues matter most.

Example of what gets flattened in diff mode:

- `> [!WARNING]` blocks render as a normal italic quote, losing the color and icon
- `:::danger` blocks disappear entirely (no matching case in the diff renderer)
- `<details>` sections render as literal `<details>` / `<summary>` tags

**Impact:** only the deny / resubmit flow. Not ideal, but the diff is still navigable — it just doesn't preserve the new semantic formatting.

## 8. Relative non-document links inside raw HTML fall through

The HTML block rewrites relative image paths (`<img src="./logo.png">`) and relative markdown/html document links (`<a href="./notes.md">`) to route correctly through the server. Other file types fall through without rewriting.

<details>
<summary>Example links that break</summary>

Download the spec as <a href="./docs/spec.pdf">PDF</a>, or grab the raw data as <a href="./data/sample.csv">CSV</a>.

</details>

Both of those resolve against the Plannotator server origin instead of the source file's directory, so they return 404 even when the files exist next to the plan.

**Impact:** unusual — users paste README sections with PDF / data / image links that aren't `.md` or `.html`. Low volume but confusing when it hits.

## 9. Copy-as-markdown corrupts tables with pipes in cells

The table hover toolbar and popout both offer "copy as markdown". When any cell contains a literal `|` (common in tables listing regex patterns, shell commands, or boolean "or"), the copied output is silently wrong — the pipe isn't re-escaped, so the pasted table has extra columns where those pipes were.

Source below (note the `\|` escape keeps the table parsed correctly here):

| Case | Pattern | Notes |
|---|---|---|
| Regex alternation | `cat\|dog` | matches either word |
| Shell pipe | `grep err \| wc -l` | count error lines |
| Boolean | `A \| B` | logical or |

Now hover that table, click copy, paste it into any markdown doc — the "Pattern" column gets split into two columns wherever the `\|` was, shifting every header and cell after it. The table looks fine in the reader; it only goes sideways when copied.

**Impact:** every table that documents regex, shell, or boolean content. Silent corruption on copy — no error, no warning.

---

## Ship plan

| Issue | Category | Target | Notes |
|---|---|---|---|
| 1. CLI flag smartypants | Fix now | v0.19.1 | Narrow `--` rule to digits only |
| 2. Alert + list body | Fix now | v0.19.1 | Merge into alert regardless of block marker |
| 3. Non-GitHub forge support | Fix now | v0.19.1 | Plumb host through `repoInfo` |
| 4. HTML external links | Fix now | v0.19.1 | Force `target` + `rel` in `rewriteRelativeRefs` |
| 5. Duplicate heading anchors | Fix now | v0.19.1 | Dedup counter per doc |
| 6. URL bracket trim | Follow-up | v0.20 | Balanced-paren matching |
| 7. Diff view block variants | Follow-up | v0.20 | Extend `SimpleBlockRenderer` |
| 8. Relative HTML asset links | Follow-up | v0.20 | Rewrite any relative href, not just docs |

Review when ready. @alice for the v0.19.1 scope, @bob for the v0.20 backlog ordering.
