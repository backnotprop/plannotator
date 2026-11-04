/**
 * Shape's agent text (approval "shape-living-board"; DRAFT until the owner
 * approves it word for word): the `/shape` skill the Inbox lists in the
 * reply box's "/" while Settings → Capabilities → Shape is on. It is
 * human-only: the window pastes this body into the reply that names it, the
 * way the review skills go (`@plannotator/core/inbox-review`). With Shape off
 * (or never set) it is not listed, so no agent reads a word of it.
 *
 * Browser-safe, no dependencies: the server lists it and the window pastes it.
 */

export interface ShapeSkillText {
  name: string;
  description: string;
  body: string;
}

const BODY = `# Shape: draw this thread as a living board

DRAFT. The person wants to see the work in this thread the way you see it, so they can say "yes, that's it" or point at the part that is wrong. Draw it as a board: a JSON file you store with \`plannotator shape update\`. The board opens from this thread's header in the Plannotator Inbox. You keep it current: each update is a new version, and the board shows what changed.

## The stance

- Draw the real thing, small. If the work is a dialog, draw the dialog with its real words. If it is a settings row, draw the row. Crop to the part this thread is about. Draw an abstract diagram only when the work has no face (a policy, an architecture).
- Few words. Every mark is part of the real thing, a short label touching what it names, or the one accent on the point. No decoration.
- Use the thread's own words, names and numbers. Never invent data. If the source contradicts itself and nothing settles it, draw the latest statement and say it is open.
- Commit to a clear reading. A clear picture can be corrected; a vague one cannot.

## Steps

1. Read the whole thread (\`read_thread\`, every message). Note: what the work makes, what is settled, what is open and whose call it is, and what happens next.
2. Write the board as JSON (the format is below) in a scratch file, such as \`/tmp/shape-<topic>.json\`.
3. Store it: \`plannotator shape update --file /tmp/shape-<topic>.json --thread <the thread's id: thread_id from read_thread> --through <the latest message id you read>\`. It prints \`{ id, v }\`. Keep the id.
4. If it is refused, fix what it lists and run it again. Each problem names its field.
5. Tell the person in one line that the board is up (v1), in this thread.

## Keeping it current

- Before you draw a new version, run \`plannotator shape drawing <id>\`, so the board shows that you are drawing.
- Store the new version with \`plannotator shape update --file <file> --id <id> --base <the version you started from> --through <latest message id>\`. If someone changed it since, it is refused and prints the latest version: start from that one.
- Keep the same ids (\`data-mark\`, requirement ids, ref numbers) for the same parts in every version. The board redraws only what changed.
- The person points at parts of the board to change or ask about them. Run \`plannotator shape read <id> --notes\` at the start of each turn in this thread. It prints the notes that wait for you and marks them as received:
  - a \`change\` note: draw the change as a new version;
  - an \`ask\` note: answer it with \`plannotator shape answer <id> --re <the note's id> --text '<your answer>'\`, in one or two sentences.
- Run \`plannotator shape done <id>\` only when the person says the work is finished.

## The board's JSON

\`\`\`json
{
  "title": "Snooze: announce it once",
  "claim": "Built. Nothing waits on you.",
  "note": "v2: the dialog now says 2 days.",
  "views": {
    "picture": { "html": "<figure data-step=\\"1\\" data-mark=\\"dialog\\">…</figure>", "css": ".x { … }" },
    "how": { "html": "<svg viewBox=\\"0 0 1200 420\\">…</svg>", "width": 1200, "height": 420 },
    "reqs": {
      "groups": [
        { "id": "when", "label": "When it shows", "items": [
          { "id": "r1", "text": "After **2 days** of use, once ever [^1]", "code": { "path": "src/snooze.ts", "line": 42 } }
        ] }
      ]
    }
  },
  "refs": [
    { "n": 1, "kind": "message", "title": "You set it to 2 days", "target": "msg_…" },
    { "n": 2, "kind": "file", "title": "The dialog", "target": "src/SnoozeDialog.tsx", "line": 10 },
    { "n": 3, "kind": "image", "title": "Today's dialog", "target": "shot.png" },
    { "n": 4, "kind": "pr", "title": "#2547", "target": "https://github.com/owner/repo/pull/2547" }
  ]
}
\`\`\`

- **title:** the subject in plain words. **claim:** one line: where it stands, and whether anything waits on the person now. **note** (optional): one line about this version.
- **views.picture** (the main view): HTML and inline SVG. The real thing, small.
- **views.how** (How it works, optional): one precise diagram that answers three questions: when it starts, how it is processed, and what it produces. Give every arrow a verb. 4 to 8 boxes. Use \`width\` and \`height\` for a fixed canvas the board scales to fit.
- **views.reqs** (Requirements, optional): short lines in groups. Inline Markdown: \`**bold**\`, \`code\`, links, and \`[^n]\` for reference n.
- **views.code** (Code, optional): a Guided Review of the change. Leave it out unless the person asks.
- **refs:** numbered sources. \`message\` targets a thread message id; \`file\` a path in the project (with \`line\`); \`image\` an image file next to the board's JSON (the store keeps a copy); \`pr\` and \`link\` an https URL.

## Drawing rules

- \`data-mark="id"\` on each part the person may point at. Keep the id across versions.
- \`data-step="N"\` on parts that should appear together; steps arrive in number order, the order you would explain them aloud.
- \`<span data-ref="n"></span>\` puts reference bubble n on the drawing.
- Colours only through the board's variables: \`var(--ink)\`, \`var(--ink2)\`, \`var(--grey)\`, \`var(--rule)\`, \`var(--paper)\`, \`var(--surface)\`, \`var(--sunk)\`, and the one accent \`var(--mark)\` (\`var(--mark-soft)\` for a fill). Then light and dark both work. In SVG: \`class="line"\`, \`"grey"\`, \`"acc"\`, \`"acc-fill"\`, \`"dash"\`, and \`"t-acc"\` / \`"t-grey"\` for text.
- Nothing from outside: no scripts, no event handlers, no \`<style>\` in the HTML (use \`css\`), no external images, fonts or \`url()\`, no iframes, forms or popovers. The store refuses them and says which.
- Links: \`#id\` scrolls inside the drawing; an https link opens in a new tab.
- A phone shows the board narrow. For a wide How it works, add \`"tall": { "html": … }\` with the same parts stacked about 400 px wide.

\`plannotator shape --help\` lists every command.
`;

export const SHAPE_SKILL: ShapeSkillText = {
  name: 'shape',
  description: 'Ask the agent to draw this thread as a Shape board it keeps current.',
  body: BODY,
};

/** The Shape skill by name (the "/" list's built-in), or undefined. */
export function shapeSkill(name: string): ShapeSkillText | undefined {
  return name === SHAPE_SKILL.name ? SHAPE_SKILL : undefined;
}
