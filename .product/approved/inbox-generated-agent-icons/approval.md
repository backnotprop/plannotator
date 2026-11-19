# Agent icons from the project name

Approved: 2026-11-15 (owner, in the Inbox thread "agent panel project abbr").

## What was approved
- Variant A, the solid tile (`variant-a-solid.html`): a solid squircle in one of eight hues turned from the theme's primary, the project's letters in the page's lightest colour, and the agent's own mark as a small badge on the corner from 20 px up.
- It is one more option in the agent icon dial, second in the inner ring, labelled "From the project name".
- A setting in Settings → Rows beside "Agent icons" (`setting-agent-icons.html`): each agent's own mark, or from the project name.

## Decisions on the way
- Rejected: B (soft tinted circle; fades in dark themes at row size) and C (dither field; busy at 20 px).
- The owner's words: "to be clear I didn't want to remove the agent icons". Each agent's own mark stays the default and stays visible as the corner badge on a generated tile.
- The setting changes only agents with no hand-picked icon; a picked icon stays.
- Two agents in one project share the tile; the corner badge says which agent.
- Letters: first letter of the first and last word, by grapheme; one glyph for scripts that read as one; an emoji only when the name has no letters; no letters at all falls back to the agent's own mark.
- Colour is keyed on the project name, so it matches on every machine; two projects that would draw the same letters in the same hue get different hues.

## Changed after approval (2026-11-16, review of PR #3503)
- Colour: stability won over the collision step. The hue is keyed on the project's own name alone (lowercased, NFC): the part before any " · ". The Inbox adds " · work" only while two folders share a name, and a window adds " · <machine>" for a linked machine's. The rule "two projects that would draw the same letters in the same hue get different hues" is dropped. Why: that step made a tile's colour depend on which other projects were on screen. A colour then moved between machines, when a second folder with the same name appeared, when the list was filtered by machine, and when a project with the same letters appeared and sorted first. A colour that moves on its own is worse than an occasional shared colour. Two projects whose names hash alike may now share a colour; the name beside the tile tells them apart.
- Letters: under 20 px the tile shows one letter (the first). Two letters were 7 px on a 16 px tile. Two letters show from 20 px up.

## Out of scope
- Using project pictures in place of letters.
- Changing the existing letter marks on project rows.
- Any new keyboard shortcut.
