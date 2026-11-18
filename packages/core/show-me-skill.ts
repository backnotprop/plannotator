export interface ShowMeSkillText {
  name: string;
  description: string;
  body: string;
}

const BODY = `# Show me

The person wants to see the subject of this thread, not read about it: big pictures, little words, nothing key left out. If their words with this skill name a focus, show that. Otherwise, for a code change (your work in this thread, a pull request, a branch) show what changed and why; for anything else, show how it works.

## What goes on the page

- One line at the top: what this is and, for a change, whether anything waits on the person.
- Then 3 to 6 pictures, the most important first. Pick what the subject needs:
  - Before and after: the same view in both states, side by side.
  - Flow: the steps in order, each arrow labelled with what crosses it.
  - Data shape: the record or message as it is now, the changed fields marked.
  - Where it can go wrong: each risky place with its file and lines, and what would break.
  - Numbers: a compact table (counts, limits, timings, sizes), figures right-aligned.
- Under each picture, at most two short sentences. Name real things: \`path/file.ts:120-148\`, function and field names, constants with their values. Read every one from the code or the thread; never make up a name, number or line. From a diff, a line number is the new file's, counted from the hunk header (\`@@ -a,b +c,d @@\` starts at c).
- For a change, end with Files: one row per changed file with its + and − and a few words on what it does. Put tests, docs and renames together in one row.
- Plain words. No jargon the person has not used, no metaphors. Write for someone new here.

## The look

Technical and quiet, like a good developer tool's docs:
- \`var(--font-mono)\` for labels, paths, numbers and the small uppercase label over each section; \`var(--font-sans)\` for sentences.
- 1px rules in \`var(--border)\`, dashed to group, a faint grid behind a diagram. Corners square or \`var(--radius)\` at most. No shadows, gradients, glows or emoji.
- \`var(--primary)\` marks what changed. \`var(--destructive)\` only for what can go wrong, \`var(--success)\` for what is now safe, \`var(--warning)\` for what is still open. Everything else is \`var(--foreground)\` and \`var(--muted-foreground)\`.
- Draw with inline SVG and HTML. Use a picture file only when it is a real screenshot of the thing.
- Text in a drawing reads at 11 to 14 px on screen, on a computer and at 390 px wide. Give each SVG \`width:100%\` and a \`max-width\` of its \`viewBox\` width, so it never grows past that. A drawing wider than about 600 px gets a second, stacked version for phones, swapped with \`@media (max-width: 600px)\`. Side by side stacks too.
- Size every box to its longest label: no text runs past its box or under a line.

## The theme

The page takes the person's theme, light or dark, whatever its colours:
- In \`<head>\`: \`<meta name="plannotator-theme" content="host">\` and \`<meta name="plannotator-page" content="show-me">\`.
- Colour only through \`--background\`, \`--foreground\`, \`--card\`, \`--muted\`, \`--muted-foreground\`, \`--primary\`, \`--accent\`, \`--border\`, \`--destructive\`, \`--success\` and \`--warning\`. A tint is \`color-mix(in oklch, var(--primary) 12%, transparent)\`.
- Give each one a value in \`:root\`, dark, and a light set under \`@media (prefers-color-scheme: light)\`, so the file also reads on its own. The Inbox replaces them.
- Let the content set the height: no \`vh\` units and no \`height:100%\` on html or body.

## Send it

1. Write one HTML file, everything inline: CSS and SVG, no scripts, nothing loaded from the web. Save it outside the project, as \`/tmp/show-me-<topic>.html\`.
2. Send it with send_message: \`reply_to\` this message, the file in \`attachments\`, and a body of one sentence saying what the page shows.
3. Do not change code while you make it. If the subject is a change and you cannot find it, say so in one sentence instead.

If the person comments on the page, send the new version of the same file in this thread.
`;

export const SHOW_ME_SKILL: ShowMeSkillText = {
  name: 'show-me',
  description: 'A page of big pictures: what changed and why, or how something works',
  body: BODY,
};

export function showMeSkill(name: string): ShowMeSkillText | undefined {
  return name === SHOW_ME_SKILL.name ? SHOW_ME_SKILL : undefined;
}
