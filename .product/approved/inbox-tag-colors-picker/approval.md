# Inbox tag colors: two-dimensional picker, rows follow the pick

- Approved: 2026-11-16 (18:16Z) by the owner, in the Inbox thread "tags colors".
- Artifact: `picker.html` / `picker.png` (the main proposal), `today.png` (before), `NOTES.md` (mapping, contrast numbers).

## The owner's words
- "need a lot more color option / flexibility. right now they are muted only. creates a lot of overlap vs differentiation"
- "I don't understand why when I'm picking the color, can I just choose between subtle and vivid colors? Like, change the color picker. Isn't that the problem?"
- "shouldn't I be able to choose between muted and vivid by like having ... the two-dimensional color picker? You know, like the traditional one."
- On the tag's name shown on the row: "Tags in the row is fine. I like it."
- "Build this picker?" → "Yes, build it". "What color should a new tag get by itself?" → "Half vivid, half calm, in turn".

## Approved state
- The tag menu's color list: 12 quick swatches (first row vivid, second calm), the person's recent colors, a two-dimensional square (left to right muted to vivid, top to bottom light to dark), the hue strip and the Hex field. No "Subtle"/"Vivid" words.
- The row follows the pick: hue and part of the color strength carried; lightness set per theme and held so row text keeps AA (see NOTES.md). Black, white and greys give a grey row.
- The row keeps its shipped shape: whole row tinted, the tag's name as quiet text on the right. Sidebar tags follow the same colors.
- New tags walk all 12 swatches before repeating, alternating vivid and calm.
- Stored colors unchanged in format (preset names and hex). The five named colors stay calm; accent shows as indigo.

## Rejected on the way
- A list-wide Off / Subtle / Vivid switch (the owner did not understand it; the picker is where strength is chosen).
- A filled color label for the tag's name on the row (not asked for).
- Two swatch sets "Calm" and "Vivid" without a square (kept only as the fallback mock).

## Known and told to the owner
- Dark rows are deep and saturated, never bright. Light rows near white stay softer for blue, indigo and red.
- A custom color picked before this change will look stronger after it.

## Out of scope
- Any change to tag filters, tag names, or the "Show tag colors" switch.
