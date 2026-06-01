# Loose List Items (Issue #704)

This fixture covers the fix for loose list continuation AND potential regressions. Each section says exactly what you should see. If anything looks wrong, the section title tells you what broke.

---

## 1. Loose bullet points (the fix)

You SHOULD see the paragraph and inline code indented under each bullet, aligned with the bold title text — not flush-left as separate paragraphs.

- **Waffles**

  The following method prepares a waffle while enforcing all recommended crispiness checks:

  `BatterMixer.run({ mode: "waffle", temp: 400 })`

- **Pancakes**

  Pancake preparation differs from waffles in several ways: batter is poured sequentially (there's no waffle iron), flip timing needs explicit handling, and the `BubbleStream` must be observed before advancing to the next pancake.

  `GriddleSession.start({ flipDetection: true })`

---

## 2. Loose numbered lists (the fix)

Same as above but with numbers. Each description paragraph SHOULD be indented under its number.

1. **Preheat the griddle**

   Set temperature to 375 and wait for the indicator light. The surface should be evenly heated before proceeding.

2. **Pour the batter**

   Use a quarter-cup measure for consistent sizing. Pour from the center and let it spread naturally.

3. **Watch for bubbles**

   When bubbles form across the surface and the edges look set, flip once. Do not press down on the pancake.

---

## 3. Nested lists inside loose items (the fix)

You SHOULD see "These are the main categories:" indented under the Breakfast bullet. The sub-bullets (Waffles, Pancakes, French toast) should be nested one level deeper than the parent bullet. Same for Lunch.

- **Breakfast items**

  These are the main categories:

  - Waffles
  - Pancakes
  - French toast

- **Lunch items**

  Served after 11am:

  - Sandwiches
  - Salads

---

## 4. Tight lists — NO blank lines (regression check)

These should render exactly as before: simple bullets, each on its own line, no extra spacing. If these look broken or have extra gaps, the tight continuation path regressed.

- First tight item
- Second tight item
- Third tight item

---

## 5. Tight continuation — wrapped lines (regression check)

Each bullet below has a second line that wraps without a blank line gap. You SHOULD see each bullet as a single continuous sentence — the second line joins the first, not as a separate paragraph. If the second line appears detached or as its own bullet, tight continuation is broken.

- This is a list item with a long description
  that continues on the next line without a blank line
- Another item that also wraps
  onto a second line here
- Short item

---

## 6. Single-space tight indent (regression check)

This tests that single-space indentation still works for tight (no blank line) continuation. You SHOULD see one bullet with "Item" followed by "continued" as part of the same text. If "continued" appears as a separate paragraph below the bullet, the tight indent check regressed.

- Item
 continued with single space

---

## 7. Non-indented text after a list (regression check)

The paragraph "This paragraph is not indented" SHOULD appear as a normal standalone paragraph below the bullet — NOT indented under the bullet. If it got absorbed into the bullet, the parser is too greedy.

- A bullet point

This paragraph is not indented so it must not be part of the bullet above.

---

## 8. Heading after a blank line under a list item (regression check)

The heading "This Is A Heading" SHOULD appear as a full-width heading, not as continuation content under the bullet. If the heading is indented under the bullet or missing, block-level element detection is broken.

- A bullet point

### This Is A Heading

---

## 9. Code fence after a list item (regression check)

The code block SHOULD appear as its own standalone code block below the bullet — not as inline text absorbed into the bullet. Code fences are block-level elements and must break list continuation.

- A bullet point

  ```typescript
  const x = 1;
  ```

---

## 10. Horizontal rule after a list item (regression check)

You SHOULD see a bullet, then a visible horizontal line separator below it. The HR must NOT be absorbed into the bullet.

- A bullet point

---

## 11. Blockquote after a list item (regression check)

The blockquote "This is a quote" SHOULD appear as a styled blockquote (with a left border), not as text under the bullet.

- A bullet point

> This is a quote

---

## 12. Table after a list item (regression check)

The table SHOULD render as its own table element below the bullet — not as text inside the bullet.

- A bullet point

| Column A | Column B |
|----------|----------|
| Value 1  | Value 2  |

---

## 13. Multiple blank lines between bullet and continuation (edge case)

You SHOULD see the continuation text indented under the bullet, same as section 1. Multiple blank lines between the bullet and its continuation should still merge.

- A bullet point


  This continuation had two blank lines above it but should still be indented under the bullet.

---

## 14. Checkbox lists (regression check)

Checkboxes SHOULD render with their circle/checkmark icons. Checked items should have strikethrough text. If checkboxes look wrong or the text styling is off, the checkbox rendering regressed.

- [ ] Unchecked task item
- [x] Checked task item with strikethrough
- [ ] Another unchecked item

---

## 15. Mixed loose list with checkboxes (edge case)

The description paragraph SHOULD be indented under the checkbox bullet. The checkbox icon and strikethrough behavior should still work correctly.

- [ ] **Setup step**

  Install all dependencies and configure the environment before proceeding.

- [x] **Already done**

  This step was completed earlier and should show as checked with strikethrough.

---

## 16. Insufficient indent after blank line (regression check)

The text "Barely indented" has only one space of indentation after a blank line. It SHOULD appear as a separate paragraph — NOT absorbed into the bullet. Loose continuation requires 2+ spaces.

- A bullet point

 Barely indented with one space — this must be a standalone paragraph, not under the bullet.
