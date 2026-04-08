# Review comment #7: quoted list regression

This fixture isolates the bug flagged in the latest PR review. Serve it with the
**current** branch state (before any fix) to see the regression, then compare
against what it *should* look like after the fix.

## The bug: quoted ordered list collapses into one run-on line

Before this PR, the parser emitted each `>` line as its own blockquote block, so
the three lines below rendered as three stacked quote boxes, each containing the
text "1. First item" / "2. Second item" / "3. Third item". Imperfect but legible.

After this PR's blockquote-merge fix, the three lines merge into a single
blockquote with content `"1. First item\n2. Second item\n3. Third item"`. The
renderer splits on `\n\n+` (blank-line paragraph breaks) and finds none, so it
emits **one** `<p>` with the entire string. In HTML, `\n` collapses to whitespace,
so the reader sees one run-on line:

> 1. First item
> 2. Second item
> 3. Third item

Expected after fix: three visually distinct lines (either stacked boxes as before,
or — ideally — a proper nested ordered list inside one quote box).

## Same bug, unordered flavor

> - First bullet
> - Second bullet
> - Third bullet

## Same bug, bullet + text

> - Install the dependency
> - Run the migration
> - Deploy to staging

## Same bug, numbered steps with longer content

> 1. Audit the current implementation for any obvious regressions.
> 2. Write a failing test that reproduces the reported issue.
> 3. Land the fix and confirm the test now passes.

## Control case: multi-line wrapped paragraph (this must stay fixed)

This is the case the blockquote-merge fix was added for. It should render as one
quote box with properly wrapped prose — NOT as six stacked boxes.

> This is a long quoted paragraph that spans multiple source lines because the
> author wrapped it at around 80 columns for readability in the markdown source.
> The renderer should treat this as one continuous paragraph with soft wrapping,
> not six stacked blockquote boxes with individual margins between each line.
> The original bug that motivated the blockquote-merge fix was exactly this
> case — the `tree.hash` quote from the Slice 6 plan. Keep it working.

## Control case: multi-paragraph quote (must stay fixed)

> First paragraph of a quote that wraps across
> multiple source lines.
>
> Second paragraph of the same quote, separated
> by a blank `>` line. Should render as a visually
> distinct paragraph under the first one.

## Control case: two separate quotes (must stay as two boxes)

> A quote.

> A completely different quote (blank line between, not `>`-continuation).
