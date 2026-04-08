# Ordered list edge cases

## 1. Ordered task lists — numbers AND checkboxes

Before the fix: the checkbox branch took precedence and the numeral was dropped, so an ordered task list rendered as an unordered checklist. After the fix: both the numeral and the checkbox render side by side (matching GitHub's `1. [ ]` behavior).

1. [x] Draft the API contract
2. [x] Land the parser changes
3. [ ] Wire up the diff renderer
4. [ ] Ship the PR
5. [ ] Write the changelog

### Unordered task list (baseline — should look the same as before)

- [x] Bullet checkbox one
- [ ] Bullet checkbox two
- [ ] Bullet checkbox three

### Mixed ordered numbers (no checkboxes, regression guard)

1. First step
2. Second step
3. Third step

## 2. Multi-paragraph blockquote — quoted blank line should render as a paragraph break

Before the fix: `\n\n` inside blockquote content collapsed to a single space, so two quoted paragraphs mashed together into one run-on line. After the fix: the blockquote splits on blank-line paragraph breaks and emits multiple `<p>` children.

> This is the first paragraph of a long quote. It discusses
> the contract for `tree.hash(path)` and how the library
> observes file changes via `(size, mtime)`.
>
> This is a second paragraph of the same quote, separated by
> a blank `>` line. It should render as a visually distinct
> paragraph underneath the first one — not mashed into the
> same line.
>
> And here is a third paragraph to really hammer the point
> home. All three should live inside one blockquote box with
> clear paragraph breaks between them.

Some prose between two blockquotes to confirm the blank-line break between quotes still produces two separate boxes.

> A completely separate blockquote (blank line above, not a
> `>` continuation). This is one paragraph that spans
> multiple source lines; it should render as one continuous
> paragraph inside its own box.

> Another completely separate blockquote, also single-paragraph,
> also spanning multiple source lines.

## 3. Numbered list with nested bullets (regression guard for top-level streak)

Top-level numbering should continue across nested unordered children.

1. First ordered step
    - nested bullet
    - another nested bullet
2. Second ordered step
    - nested bullet
3. Third ordered step

## 4. High numerals (double-digit alignment)

Tabular numerals + 1.5rem min-width should keep 9 → 10 from jittering.

1. One
2. Two
3. Three
4. Four
5. Five
6. Six
7. Seven
8. Eight
9. Nine
10. Ten
11. Eleven
12. Twelve

## 5. Ordered list starting at an arbitrary number

5. Five (rendered as 5.)
6. Six (rendered as 6.)
7. Seven (rendered as 7.)

## 6. Single-line blockquote (baseline)

> Just one line. Should still render inside a blockquote box.

## Diff-view test (manual, separate run)

The diff renderer lives in `PlanCleanDiffView` and only appears when a prior
version of the plan is saved. To exercise the diff view specifically:

1. Serve this fixture once through the plan review flow (`plannotator` plan mode
   with a hook invocation), then deny + resubmit a modified copy that changes
   one of the numbered items above.
2. Open the diff view via the `+N/-M` badge.
3. Verify that numbered items in the diff render as `1.`, `2.`, ... and NOT as
   `•` / `◦` / `▪`. Before this fix the diff view silently flattened all
   ordered lists to bullets because `PlanCleanDiffView.SimpleBlockRenderer`
   had its own hardcoded marker logic.
