# In-Page Anchor Navigation Fixture

This fixture exercises `[text](#slug)` links across the full range of
heading shapes the slugger produces — ASCII, Unicode, punctuation runs,
numerics — plus anchors embedded in every block type that threads the
`onNavigateAnchor` callback (paragraphs, list items, blockquotes, alerts,
directives, tables, raw HTML blocks).

Clicking any link below should smooth-scroll to the target heading inside
the sticky scroll viewport. None should trigger the "Shared Plan Could Not
Be Loaded" dialog.

---

## Table of Contents

- [Plain ASCII heading](#plain-ascii-heading)
- [Heading with: colons, commas, and punctuation!](#heading-with-colons-commas-and-punctuation)
- [Heading — With Em Dash](#heading-with-em-dash)
- [Café ☕ résumé](#café-résumé)
- [中文 标题](#中文-标题)
- [Español: año nuevo](#español-año-nuevo)
- [Русский заголовок](#русский-заголовок)
- [123 Numbers-only start](#123-numbers-only-start)
- [UPPERCASE Heading Stays Lower](#uppercase-heading-stays-lower)
- [Heading with `inline code` and **bold**](#heading-with-inline-code-and-bold)
- [Very-Very-Very-Long-Heading-With-Many-Hyphens-To-Stress-The-Slugger](#very-very-very-long-heading-with-many-hyphens-to-stress-the-slugger)
- [Raw HTML heading: `<h2 id="MySection">`](#MySection)
- [Duplicate](#duplicate)
- [Duplicate](#duplicate-1)

---

## Anchors in Different Contexts

Paragraph link: jump to [Café ☕ résumé](#café-résumé).

- List link: jump to [中文 标题](#中文-标题)
- Nested list link:
  - Deep link to [Numbers-only start](#123-numbers-only-start)

> Blockquote link: go to [Español: año nuevo](#español-año-nuevo).

> [!NOTE]
> Alert-block link: go to [Русский заголовок](#русский-заголовок).

> [!WARNING]
> Combined with **bold** and *italic* — link to [UPPERCASE Heading Stays Lower](#uppercase-heading-stays-lower).

:::tip Directive block
Directive-container link to [Heading — With Em Dash](#heading-with-em-dash).
:::

| Target | Link |
|---|---|
| ASCII | [go](#plain-ascii-heading) |
| Punctuation | [go](#heading-with-colons-commas-and-punctuation) |
| Unicode accent | [go](#café-résumé) |
| CJK | [go](#中文-标题) |
| Cyrillic | [go](#русский-заголовок) |
| Numeric start | [go](#123-numbers-only-start) |
| Raw HTML id | [go](#MySection) |
| Duplicate second | [go](#duplicate-1) |

<details>
<summary>Raw HTML block with anchors inside (click to expand)</summary>

Native `<a href="#...">` links inside raw HTML should also route through the
scroll handler, not trigger a native browser jump that misses the scroll
viewport.

<ul>
  <li><a href="#plain-ascii-heading">HTML list → ASCII heading</a></li>
  <li><a href="#café-résumé">HTML list → Unicode heading</a></li>
  <li><a href="#MySection">HTML list → raw HTML id</a></li>
</ul>

</details>

---

## Plain ASCII heading

Should resolve from `#plain-ascii-heading`.

## Heading with: colons, commas, and punctuation!

Runs of non-alphanumerics collapse to single `-`.

## Heading — With Em Dash

Em dashes should not produce double-hyphens.

## Café ☕ résumé

Unicode letters (accents) are preserved by `slugifyHeading`. The coffee
emoji becomes a separator. Expected id: `café-résumé`.

## 中文 标题

CJK characters count as Unicode letters and survive slugging. Expected id:
`中文-标题`.

## Español: año nuevo

Mix of ASCII, colon, and `ñ`. Expected id: `español-año-nuevo`.

## Русский заголовок

Cyrillic letters are preserved. Expected id: `русский-заголовок`.

## 123 Numbers-only start

Heading starts with digits — slugger should not strip the leading number.
Expected id: `123-numbers-only-start`.

## UPPERCASE Heading Stays Lower

Heading text is uppercase; slugger lowercases. Expected id:
`uppercase-heading-stays-lower`.

## Heading with `inline code` and **bold**

Inline markdown is stripped before slugging. Expected id:
`heading-with-inline-code-and-bold`.

## Very-Very-Very-Long-Heading-With-Many-Hyphens-To-Stress-The-Slugger

Consecutive existing hyphens should collapse cleanly. Expected id:
`very-very-very-long-heading-with-many-hyphens-to-stress-the-slugger`.

## <a name="MySection"></a>Raw HTML heading: `<h2 id="MySection">`

Not strictly a markdown heading id — this section uses an inline HTML
anchor so `#MySection` resolves via the native `name="MySection"`
attribute. Exercises the uppercase / non-slugified id path.

## Duplicate

First occurrence — bare slug `duplicate`.

## Duplicate

Second occurrence — deduplicated to `duplicate-1` by `buildHeadingSlugMap`.

---

## Regression checks

- Loading this fixture with `#café-résumé` in the URL should auto-scroll
  without firing the shared-plan error dialog.
- Changing the hash (e.g., clicking links above) should trigger
  `hashchange` and scroll, again without the error dialog.
- Hashes that *do* look like share payloads (long, mixed-case base64url)
  should still route to the share loader — this fixture does not include
  any, so the share path should never fire while testing this file.
