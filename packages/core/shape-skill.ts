/**
 * Shape's agent text, in one place (approval "shape-skill"). Three outputs are
 * built from the pieces below, so they cannot drift apart:
 *
 *   - the Inbox's `/shape` skill (`SHAPE_SKILL`): the thread steps + `SHAPE_GUIDE`.
 *     The Inbox lists it in the reply box's "/" while Settings → Capabilities →
 *     Shape is on; it is human-only: the window pastes this body into the reply
 *     that names it, the way the review skills go (`@plannotator/core/inbox-review`).
 *     With Shape off (or never set) it is not listed, so no agent reads a word of it.
 *   - `plannotator shape --help` (`SHAPE_COMMAND_USAGE` in apps/hook/server/cli.ts):
 *     `SHAPE_HELP_INTRO` + `SHAPE_GUIDE`. The CLI prints it only while Shape is on.
 *   - the `## plannotator shape` section of apps/skills/core/plannotator/SKILL.md
 *     (`SHAPE_SKILL_SECTION`, `SHAPE_SKILL_DESCRIPTION_PHRASE`), written there by
 *     `bun run gen:skills` (scripts/gen-skill-sections.ts) once `shape` is released.
 *
 * The section and the description phrase are the owner's approved words
 * (.product/approved/shape-skill/approval.md): never edit them here alone.
 * The guide and the help intro are DRAFT until the owner approves them word for word.
 *
 * Browser-safe, no dependencies: the server lists it and the window pastes it.
 */

export interface ShapeSkillText {
  name: string;
  description: string;
  body: string;
}

/**
 * How to draw a board and keep it current: the stance, the update loop, the
 * JSON format and the drawing rules. Nothing in it depends on the Inbox, so
 * the `/shape` skill and `plannotator shape --help` both end with it.
 */
export const SHAPE_GUIDE = `## The stance

- Draw the real thing, small. If the work is a dialog, draw the dialog with its real words. If it is a settings row, draw the row. Crop to the part the work is about. Draw an abstract diagram only when the work has no face (a policy, an architecture).
- Few words. Every mark is part of the real thing, a short label touching what it names, or the one accent on the point. No decoration.
- Use the source's own words, names and numbers (the thread, the conversation, the code). Never invent data. If the source contradicts itself and nothing settles it, draw the latest statement and say it is open.
- Commit to a clear reading. A clear picture can be corrected; a vague one cannot.

## Keeping it current

- Before you draw a new version, run \`plannotator shape drawing <id>\`, so the board shows that you are drawing.
- Store the new version with \`plannotator shape update --file <file> --id <id> --base <the version you started from>\`. If someone changed it since, it is refused and prints the latest version: start from that one.
- Keep the same ids (\`data-mark\`, requirement ids, ref numbers) for the same parts in every version. The board redraws only what changed.
- The person points at parts of the board to change or ask about them. Run \`plannotator shape read <id> --notes\` at the start of each turn. It prints the notes that wait for you and marks them as received:
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
`;

/**
 * The start of `plannotator shape --help`: the welcome, how to open the page
 * (or leave the open one be), and the commands. DRAFT: needs the owner's
 * approval word for word.
 */
export const SHAPE_HELP_INTRO = [
  "DRAFT: this text is not approved yet.",
  "",
  "Welcome to Shape. The person wants to see the work the way you see it, so they can say",
  "\"yes, that's it\" or point at the part that is wrong. Draw it as a board: a JSON file you",
  "store with `plannotator shape update`. The board opens in their browser. You keep it current:",
  "each update is a new version, and the board shows what changed.",
  "",
  "Start:",
  "1. Write the board as JSON (the format is below) in a scratch file, such as /tmp/shape-<topic>.json.",
  "2. Store it: `plannotator shape update --file /tmp/shape-<topic>.json`. It prints { id, v }. Keep the id.",
  "   If it is refused, fix what it lists and run it again. Each problem names its field.",
  "3. Open it: `plannotator shape open <id>`. The Shape page opens in the person's browser, and the",
  "   command prints its address. Tell the person in one line that the board is up (v1), with the address.",
  "4. A page that is already open shows each new version by itself: do not open it again. Run",
  "   `plannotator shape open` again only when the person closed it or asks for it.",
  "",
  "In a Plannotator Inbox thread, add --thread <the thread's id> to the first update and",
  "--through <the latest message id you read> to every update: the board then opens from the thread too.",
  "",
  "Usage:",
  "  plannotator shape",
  "  plannotator shape update --file <board.json> [--id <shp_id> --base <n>] [--thread <msg_id>] [--through <msg_id>] [--project <folder>]",
  "  plannotator shape read [<shp_id>] [--version <n>] [--notes]",
  "  plannotator shape drawing [<shp_id>]",
  "  plannotator shape answer [<shp_id>] --re <shn_id> --text '<answer>'",
  "  plannotator shape done [<shp_id>]",
  "  plannotator shape list [--all] [--json]",
  "  plannotator shape open [<shp_id>]",
  "  plannotator shape on | off",
  "",
  "A shape is a board you draw for the person: a Picture, How it works, Requirements",
  "and Code, with numbered references. Each update stores a new version of the whole board.",
  "",
  "(none)   Opens the Shape page in the person's browser, every board, and prints its address.",
  "update   Stores the board in <board.json>. Without --id it makes a new shape and",
  "         prints its id. With --id, --base is the version you drew from; if the shape",
  "         changed since, the update is refused and the latest version is printed.",
  "         Keep the same ids (data-mark, requirement ids) for the same parts, so the",
  "         board redraws only what changed.",
  "read     Prints the latest version (or --version <n>). --notes also prints the notes",
  "         that wait for you (Change it and Ask) and marks them as received.",
  "drawing  Tells the board you are drawing a new version (until it lands, at most 10 minutes).",
  "answer   Answers the person's Ask (its id is in read --notes). Change it notes need",
  "         no answer: draw the change as a new version.",
  "done     Finishes the shape. Do this only when the person says so.",
  "list     Lists the active shapes, newest change first (--all: finished ones too).",
  "open     Opens the Shape page in the person's browser: every board, or <shp_id>.",
  "         It prints the page's address.",
  "on, off  Turns Shape on or off: the same switch as the Plannotator Inbox's Settings →",
  "         Capabilities → Shape. Run them only when the person asks.",
  "",
  "Without <shp_id>, read, drawing, answer and done use your session's newest active shape,",
  "else this project's.",
].join("\n");

/**
 * The owner's approved words (approval "shape-skill", 2026-11-04): the
 * description phrase, after "Guided Reviews,", and the section of the
 * plannotator skill. Byte for byte; scripts/gen-skill-sections.ts writes them.
 */
export const SHAPE_SKILL_DESCRIPTION_PHRASE = "Shape boards (a picture of the work the person can point at and correct),";

export const SHAPE_SKILL_SECTION = `## plannotator shape

When the person asks for Shape, a board, or to "shape" a piece of work, run \`plannotator shape --help\` first and follow it. It is the whole guide: how to open Shape in their browser (or bring up the page that is already open), how to draw the board, and how to keep it current. If it says Shape is off, it also says how to turn it on: run that only because the person asked for Shape.
`;

/** The Inbox-only part of `/shape`: the thread it draws, and the thread's ids on each update. */
const THREAD_STEPS = `# Shape: draw this thread as a living board

DRAFT. The person wants to see the work in this thread the way you see it, so they can say "yes, that's it" or point at the part that is wrong. Draw it as a board: a JSON file you store with \`plannotator shape update\`. The board opens from this thread's header in the Plannotator Inbox. You keep it current: each update is a new version, and the board shows what changed.

## Steps

1. Read the whole thread (\`read_thread\`, every message). Note: what the work makes, what is settled, what is open and whose call it is, and what happens next.
2. Write the board as JSON (the format is below) in a scratch file, such as \`/tmp/shape-<topic>.json\`.
3. Store it: \`plannotator shape update --file /tmp/shape-<topic>.json --thread <the thread's id: thread_id from read_thread> --through <the latest message id you read>\`. It prints \`{ id, v }\`. Keep the id.
4. If it is refused, fix what it lists and run it again. Each problem names its field.
5. Tell the person in one line that the board is up (v1), in this thread.

Every later update in this thread also takes \`--through <the latest message id you read>\`.
`;

const BODY = `${THREAD_STEPS}
${SHAPE_GUIDE}
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
