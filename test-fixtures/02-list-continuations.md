# List Continuation Edge Cases

## Simple continuation

- This is a list item that has a continuation
  line that wraps to the next line
- This is a normal single-line item

## Multiple continuation lines

- This item has multiple
  continuation lines that
  all should merge into one bullet
- Next item

## Nested list with continuation

- Top level item
  - Nested item that has a long description
    that continues on the next line
  - Another nested item
- Back to top level

## Deep nesting with continuations

- Level 0
  - Level 1 with continuation
    that wraps here
    - Level 2 item
      - Level 3 with continuation
        that also wraps

## Continuation after blank line (should NOT merge)

- First item

  This should be a separate paragraph, not merged into the list item.

- Second item

## Non-indented line after list (should NOT merge)

- Item one
This is not indented so it should be a new paragraph.
- Item two

## Mixed content after list items

- Item followed by a heading
# This Heading Should Not Merge

- Item followed by a blockquote
> This quote should not merge

- Item followed by a code fence
  ```ts
  const x = 1;
  ```

- Item followed by a table
| A | B |
|---|---|
| 1 | 2 |

- Item followed by a horizontal rule
---
