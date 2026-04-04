# Baseline — Nothing Here Should Change

## Headings

### Level 3 heading
#### Level 4 heading

## Simple paragraph

This is a simple paragraph with no special formatting. It should render exactly as before — a single block of text.

## Paragraph with inline formatting

This has **bold**, *italic*, `inline code`, and [a link](https://example.com).

## Simple list

- Item one
- Item two
- Item three

## Nested list (no continuations)

- Parent item
  - Child item
  - Another child
    - Grandchild
- Another parent

## Checkbox list

- [x] Completed task
- [ ] Pending task
- [x] Another done task

## Code block

```typescript
function hello() {
  console.log("world");
}
```

## Blockquote

> This is a blockquote.
> It has multiple lines.

## Table

| Header 1 | Header 2 | Header 3 |
|----------|----------|----------|
| Cell 1   | Cell 2   | Cell 3   |
| Cell 4   | Cell 5   | Cell 6   |

## Horizontal rule

---

## Images and links

This paragraph has a [markdown link](https://example.com) and some `code`.

## Mixed content plan

### 1. Update the parser

- **Remove** the old regex
- **Add** new pattern matching:
  ```ts
  const pattern = /new-regex/;
  ```
- **Test** the changes

### 2. Update the renderer

- Modify `InlineMarkdown` component
- Add `<br>` support
- Run visual tests
