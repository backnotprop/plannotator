export interface PictureItSkillText {
  name: string;
  description: string;
  body: string;
}

const BODY = `# Picture it

Use HTML to help me understand what we're discussing. Show me with big pictures and little words, without withholding key details. If my words with this skill name a focus, show that; for a code change, show what changed and why.
Use your own taste, avoid lazy design, and bring in real pictures, icons or visuals only selectively, when they make sense.
When you do use prose: be clear, terse, and avoid jargon. Explain as if I am new here, but no weird metaphors.
Let the pictures carry it: most of the page is drawing, words are labels and a short line where one is needed. Not a report: no tables of facts, no file lists.

## Keep it true

When you name a file, line, function or number, take it from the code or this thread; never make one up. From a diff, a line number is the new file's, counted from the hunk header (\`@@ -a,b +c,d @@\` starts at c).

## Lean technical

Big, clear drawings with a technical look: thin rules in \`var(--border)\`, square corners, \`var(--font-mono)\` for code names, colour only where it means something. No shadows, gradients or emoji.

## Read on a phone

The page must read at 390 px wide. Give each SVG \`width:100%\` and a \`max-width\` of its \`viewBox\` width, keep its text 11 to 14 px on screen, and size every box to its longest label. A drawing wider than about 600 px gets a stacked version for \`@media (max-width: 600px)\`.

## Take my theme

- In \`<head>\`: \`<meta name="plannotator-theme" content="host">\` and \`<meta name="plannotator-page" content="picture-it">\`.
- Colour only through \`--background\`, \`--foreground\`, \`--card\`, \`--muted\`, \`--muted-foreground\`, \`--primary\`, \`--accent\`, \`--border\`, \`--destructive\`, \`--success\` and \`--warning\`; fonts through \`--font-sans\` and \`--font-mono\`.
- Give each a value in \`:root\` (dark) and a light set under \`@media (prefers-color-scheme: light)\`, so the file reads on its own. The Inbox replaces them.
- No \`vh\` units and no \`height:100%\` on html or body.

## Send it

Write one HTML file, everything inline (CSS and SVG, no scripts, nothing from the web), saved in your temp folder as \`picture-it-<topic>.html\`. Send it with send_message: \`reply_to\` this message, the file in \`attachments\`, a one-sentence body. Do not change code while you make it. If I comment on the page, send the new version in this thread.
`;

export const PICTURE_IT_SKILL: PictureItSkillText = {
  name: 'picture-it',
  description: 'A page of big pictures: what changed and why, or how something works',
  body: BODY,
};

export function pictureItSkill(name: string): PictureItSkillText | undefined {
  return name === PICTURE_IT_SKILL.name ? PICTURE_IT_SKILL : undefined;
}
