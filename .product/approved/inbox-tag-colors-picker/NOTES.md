# Tag colors, round 2: strength is in the color you pick

What the owner said: "can I just choose between subtle and vivid colors? Like, change the color picker", then "shouldn't I be able to choose between muted and vivid by … the two-dimensional color picker … like the traditional one", and "the tag name on the row is fine". So: strength is per tag and lives in the picker. The row keeps the shape that shipped (the whole row tinted, the tag's name as quiet text on the right). There's no filled label and no list-wide switch.

Files (mocks only, made-up data, the default "plannotator" theme):
- `picker.html` / `picker.png`: the main proposal. Light and dark side by side: wide rows, three-line rows with the color list open, a "how a pick becomes this row" strip (muted, mid, very vivid, near black, near white), and a close-up of the color list.
- `picker-alt.html` / `picker-alt.png`: the alternative. Calm and vivid swatch sets, plus today's strip.
- `today.png` (and `today.html`): the same rows and menu as on origin/main, for before/after.
- The scripts that compute every color and number: `/tmp/tag-colors-work2/` (`map.mjs` is the mapping, `check.mjs` the contrast check, `gen2.mjs` the mocks).

## Main: quick swatches and a two-dimensional picker

The color list, top to bottom (the same menu, the same `‹ Highlight rows` swap):
1. **Twelve quick swatches** in two rows of six, each hue used once. The top row is vivid (Red `#ff7e77`, Amber `#d6a20a`, Green `#14cc61`, Teal `#0b9488`, Blue `#047df1`, Violet `#a454d7`). The second row is calm (Orange `#c8875a`, Lime `#8aa35d`, Cyan `#6ccdea`, Indigo `#b1b7fd`, Pink `#eda4cc`, Grey `#97989b`). No group words: the two rows show the difference.
2. Your last three own colors, as today.
3. **The square:** a traditional saturation/brightness square at the current hue. Left to right goes from muted to vivid, top to bottom from light to dark. 216 × 120 px.
4. **The hue strip** (now a pure hue strip, so it matches the square) and the **Hex** field showing the current value.
5. The caption ("Teal: rows tagged Onboarding", or "Custom #3a7bd5: …") and None.

Menu width: six 28 px swatches set it at about 232 px (today it's about 222 px). The square fills that width. On a phone the sheet is full width: the square is 160 px tall and its thumb 28 px, and swatches stay 40 px.

Every pick is stored as `#rrggbb`. The row is derived from it (next section).

## How a pick becomes a row

The pick is read as OKLCH (lightness Lp, chroma Cp, hue h).
- **Hue:** kept.
- **Vividness:** `s = min(1, Cp / 0.2)`. Pick lightness `t = clamp((Lp − 0.35) / 0.6, 0, 1)`.
- **Chroma under 0.03** (black, white, greys): there's no hue to keep, so the row is grey.

| | Light theme | Dark theme |
|---|---|---|
| Row lightness | `0.965 − 0.105·s + 0.03·(t − 0.5)`, held to **0.845–0.97** | `0.255 + 0.05·s + 0.012·(t − 0.5)`, held to **0.245–0.315** |
| Row chroma | `min(0.6·Cp, 0.15)`, then the sRGB gamut at that lightness | `min(0.55·Cp, 0.12)`, then the gamut |
| Hover / selected / selected + hover | lightness −0.015 / −0.03 / −0.042 | lightness +0.01 / +0.02 / +0.028 |

So a vivid pick gives a deeper, more colored row and a muted pick a calm one. In light, the row gets darker as it gets more vivid. In dark, it gets lighter, up to the AA ceiling.

**It's no longer a mix.** Today a row is `color-mix(in oklab, colour 10% / 14%, card)`. A mix ties lightness to chroma, and in dark the blue card cancels warm hues (amber came out grey). Instead, `tintAttrs` computes the two theme colors in JS, as it already does for an own color (`--ib-tint-l` and `--ib-tint-d`). The row uses that color directly, and the three states come from `oklch(from var(--ib-tint) calc(l ± step) c h)`. On other themes the lightness should be read relative to the card: `oklch(from var(--card) calc(l + Δ) C h)`, with Δ = row L − 1.0 (light) or row L − 0.22 (dark). The sidebar's tag rows (TagsSection) use the same fill and steps, so they follow the strength.

**Contrast**, checked over every hue (5° steps) × saturation × brightness (5% steps), all four states, with the theme's own text colors:
- Light: quiet grey text **4.81:1** at worst (pick `#81008c`, selected + hover); body text ≥ 9.82:1.
- Dark: quiet grey text **4.58:1** at worst (pick `#7eff73`, selected + hover); body text ≥ 8.44:1.
- Everything passes AA.

**The honest limit in dark:** a dark row can't rise above lightness 0.315 at rest (0.343 at selected + hover), or the grey text (time, project, preview, tag name) drops under 4.5:1. Dark vivid rows are **deep and saturated (chroma up to 0.12), never bright.** In light, vivid reaches lightness 0.845 and chroma 0.15. Light has a limit too: near white, sRGB can't show a saturated blue, indigo or red. Those vivid rows top out at about chroma 0.06–0.07, while green and amber reach 0.09–0.12. The "How a pick becomes this row" strip in `picker.png` shows it. A very vivid blue pick (`#006aff`) gives `L 0.856 C 0.070` in light (blue can't be more saturated that light in sRGB) and `L 0.303 C 0.120` in dark (held at the cap). Near black and near white both give grey (light 0.946 and 0.97, dark 0.251 and 0.262).

**Difference between the twelve quick swatches' rows** (ΔE in OKLab ×100; today, with 5 colors: light 2.1, dark 2.3):
- Light: closest pair Teal/Cyan 3.8, 0 of 66 pairs under 3.
- Dark: closest pair Teal/Cyan 3.0, 0 pairs under 3.
- Color blindness (Machado 2009): deutan 6/66 pairs under 3 in light, 17/66 in dark. Hue and strength differ together, which helps. The tag's name on every tinted row is the backup, so color is never the only cue.

## New tags, stored colors, older Inboxes

- **New tags** get the next of the twelve quick swatches (still "fewest used first", `inboxNextTagColour`), alternating vivid and calm: Green, Indigo, Amber, Pink, Blue, Lime, Teal, Orange, Violet, Cyan, Red, Grey. All twelve come round before any repeat. The check mark then lands on a swatch, so the person sees what they got. Red is still late. (If the owner would rather every new tag start calm, use the calm version of each hue instead; it's a one-line change.)
- **Storage:** every pick is a `#rrggbb`. That's already a valid stored color, so there's **no schema change**, no new field and no new names.
- **An older linked Inbox** reads those hexes as own colors: it keeps the hue at its own calm 10% / 14% tint. So a vivid tag shows there as a calm tag of the right hue, and Grey shows as Grey. Nothing is invalid or lost.
- **The five stored names keep working.** `green`, `amber`, `red` and `grey` show as the calm version of that hue, and `accent` as calm Indigo, so existing lists don't jump. One click on a top-row swatch makes a tag vivid.
- **Existing own colors** (from today's strip, chroma 0.15) will look stronger than today: light row about `L 0.886 C 0.09`. That's the point of the change, but it's worth telling the owner.

## Keyboard, touch, screen readers (main)

- The square is one focus stop: `role="slider"`, labelled "Color", value text "Saturation 72%, brightness 58%". Left and Right change saturation, Up and Down change brightness, by 1% (PageUp, PageDown, Home and End as on any slider). These are a focused control's own arrow keys, not new shortcuts.
- To move between controls: Up at the square's top edge goes to the last swatch, and Down at its bottom edge goes to the strip. This is today's step-out rule for the strip and the field (`stepOut` in TagColourMenu.tsx). The strip and Hex keep today's keys.
- A move previews on the rows at once. It's kept when it rests (800 ms) or on pointer up, exactly as the strip does today. Escape still drops a preview.
- Touch: pointer events with `touch-action: none` on the square and strip. Drag previews live and lifting keeps. On a phone the square is 160 px tall with a 28 px thumb.
- Screen readers: the caption line stays `aria-live` ("Custom #3a7bd5: rows tagged Onboarding"). Each swatch keeps its name as label and tooltip.
- No 2D picker exists in the repo: `git grep` finds no saturation or color-picker component; Palettes and ThemeChooser only draw swatches. I propose a small in-house square (about 120 lines TSX, 30 lines CSS) and no dependency. `react-colorful` (about 3 kB) would draw it, but its keyboard handling would fight the menu's step-out rule and Base UI's radio group.

## Alternative: calm and vivid swatch sets

The same twelve hues twice, under the menu's quiet group labels "Calm" and "Vivid" (sentence case, `.ib-pm-glabel`). Then the own colors, today's soft hue strip, and the Hex field with its result offered as two small swatches beside it (calm and vivid). It uses the same mapping, storage and contrast as the main proposal: a calm swatch is just a low-chroma hex, a vivid one a high-chroma hex.

How the two pickers differ:
- **Main:** fewer swatches (12) and any strength in between, through the square. It's the familiar control the owner asked for. It's taller (square plus strip), and it's a new control to build and test.
- **Alternative:** two fixed strengths, so it's quicker for "just make it strong" and there's no new control. But it has 24 swatches (four rows, a taller menu), an own color can only be calm or vivid (nothing between), and the group words are new.

## Rough build size

- **Main:** about 450–550 lines with tests.
  - Mapping replaces `ownColour`: about 40 lines.
  - Swatch hexes, legacy-name map, auto order: about 40.
  - CSS fills and state steps replace the color-mix rules: about 30.
  - The square with keys and touch: about 150.
  - Menu wiring: about 40.
  - Tests: an AA test over the pick grid, the auto walk, legacy names, square keys and step-out, older-Inbox reading.
- **Alternative:** about 300–400 lines (no square; two swatch groups and the pair beside Hex).
- Both: no core schema change, both server runtimes untouched (colors are already stored as hex), one PR.
