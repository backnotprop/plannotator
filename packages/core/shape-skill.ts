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
 * The section, the description phrase, the guide and the help are the owner's
 * approved words (.product/approved/shape-skill/approval.md): never edit them
 * here alone.
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

- Draw the thing itself, as you would on a whiteboard for someone new to it: the pieces, where each one lives, and what passes between them. Big pictures, little words, nothing key withheld.
- Each piece: an icon, its name, and a short line or two under it (what it holds or does). Group the pieces by where they run or who owns them, and name each group. Label each arrow with what crosses it.
- Draw things as what they are: a database as a database, a phone as a phone, a product by its real logo. Draw nothing too complex to read at a glance.
- Sharp: straight lines, across or down, through the gaps between pieces, never through words or a piece. An arrow's label sits just above its line, clear of it. One stroke weight, the board's own fonts.
- A few colours, each with one meaning: a soft zone per group, a small chip for a status (new, open, unproven), a red box for what must never happen. About 200 words at most; no paragraphs.
- The Picture says what it is; How it works says how it goes. Steps in order go in How it works, not on the Picture. A flow of pictures and logos is fine when the flow is the idea.
- Paste real images, not boxes that name them. If a screenshot in the folder shows the thing, open it, cut the file down to the part that matters (\`sips -c <h> <w> --cropOffset <y> <x> in.png --out crop.png\`, or any tool), and put it on the Picture beside what it shows, never over it: \`<image href="crop.png" x="…" y="…" width="…" height="…"/>\` (relative to the board file, or absolute; it is copied in). Icons, real logos and drawn things come by name (below). Never make up a logo.
- What you would say aloud goes behind a number: a reference's \`sub\` (one line), and \`images\` only if the picture shows what the line says. \`crop\` picks the part to show: a whole screen is unreadable in a bubble.
- Use the source's own words, names and numbers (the thread, the conversation, the code). Never invent data. If the source contradicts itself and nothing settles it, draw the latest statement and say it is open.
- Commit to a clear reading. A clear picture can be corrected; a vague one cannot.
- Handing the board to a helper or subagent? Give it the strongest model you can choose: the board is only as good as the model that draws it.

## Keeping it current

- Before you draw a new version, run \`plannotator shape drawing <id>\`, so the board shows that you are drawing.
- Store the new version with \`plannotator shape update --file <file> --id <id> --base <the version you started from>\`. If someone changed it since, it is refused and prints the latest version: start from that one.
- Keep the same ids (\`data-mark\`, ref numbers) for the same parts in every version. The board redraws only what changed.
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
    "picture": { "html": "<figure data-step=\\"1\\" data-mark=\\"dialog\\">…</figure>", "css": ".x { … }", "width": 1200, "height": 620, "tall": { "html": "…" } },
    "how": { "html": "<svg viewBox=\\"0 0 1200 420\\">…</svg>", "width": 1200, "height": 420 },
    "know": "It shows **once, after 2 days** of use, and never again [^1]. Nobody who already snoozed sees it."
  },
  "refs": [
    { "n": 1, "kind": "message", "title": "You set it to 2 days", "target": "msg_…" },
    { "n": 2, "kind": "file", "title": "The dialog", "target": "src/SnoozeDialog.tsx", "line": 10 },
    { "n": 3, "kind": "image", "title": "Today's dialog", "target": "shot.png" },
    { "n": 4, "kind": "pr", "title": "#2547", "sub": "Adds the dialog", "target": "https://github.com/owner/repo/pull/2547", "images": [{ "src": "pr.png", "alt": "The PR's page" }] }
  ]
}
\`\`\`

- **title:** the subject in plain words. **claim:** one line: where it stands, and whether anything waits on the person now. **note** (optional): one line about this version.
- **views.picture** (the main view): one screen. HTML and inline SVG. \`width\` and \`height\` make a fixed canvas the board scales to fit. A phone pans it, unless you add \`tall\`: the same parts stacked about 400 px wide.
- **views.how** (How it works, optional): one precise diagram that answers three questions: when it starts, how it is processed, and what it produces. A flow is often not a straight line: where there are optional branches or different paths, draw them, have them meet in the one drawing, and let the person follow or focus on one (the kit's \`pick\` and \`on\`). A straight line is right when the thing really is one. Give every arrow a verb. Use \`width\` and \`height\` for a fixed canvas the board scales to fit.
- **views.changed** (What's changed, optional): when the work changes code, what it now does differently, so the person can check it without reading the diff. Write only what you saw in the code; leave it out when nothing changed. \`items\` (one per change, at most 40), each with an \`id\`, a \`title\` in the person's words, and a \`kind\`: \`behaviour\` (what someone sees or gets) or \`contract\` (a name, type, setting or API) with \`was\` and \`now\` (a line or a list of lines); \`moved\` with \`from\` and \`to\`; \`removed\` with \`was\`; \`check\`, a thing to look at, with a \`note\` that says why. Add \`code: ["src/kettle.ts:42"]\` for where it is, and \`step\` for its step in your Guided Review, if there is one. \`flows\` (optional) follow one call path: \`{ "id": "boil", "title": "Water boils", "start": "The sensor reads 100 °C", "steps": [{ "call": "whistleOnce()", "is": "new", "at": "src/kettle.ts:42" }], "forks": [{ "when": "Lid open", "end": { "now": "No whistle" } }], "end": { "was": "Whistles until lifted", "now": "One whistle" } }\`, where \`is\` is \`new\`, \`gone\`, \`changed\` or \`same\`. \`summary\` (one line) and \`also\` (one line, such as tests) are optional. If you can start subagents, have one write What's changed from the code while you draw, then check that the Picture, How it works and What's changed agree before you update.
- **views.know** (What to know, optional): what the person needs to know that the drawings can't say, in at most two short paragraphs of prose (1,200 characters). Inline Markdown: \`**bold**\`, \`code\`, links, and \`[^n]\` for reference n.
- **views.code** (Code, optional): a Guided Review of the change. Leave it out unless the person asks. The Plannotator Inbox does not show it: there, What's changed opens the thread's own review.
- **refs:** numbered sources; on the Picture, a handful. Any kind can have \`sub\` and \`images\` (\`{ src, alt, crop: [x, y, width, height] }\`, 0 to 1); the bubble shows the first. \`message\` targets a thread message id; \`file\` a path in the project (with \`line\`); \`image\` an image file next to the board's JSON (the store keeps a copy); \`pr\` and \`link\` an https URL.

## Drawing rules

Draw it however you like, by hand or from a one-off script. The board makes it behave (hover, tap, full view, the person's theme, phone) if you keep these.

- \`data-mark="id"\` on each part the person may point at. Keep the id across versions.
- \`data-step="N"\` on parts that should appear together; steps arrive in number order, the order you would explain them aloud.
- \`data-ref="n"\` is the number for reference n: empty (\`<span data-ref="n"></span>\`), the board draws it; around your own (\`<g data-ref="n">…</g>\`), yours is used.
- Colours only through the board's variables: \`var(--ink)\`, \`var(--ink2)\`, \`var(--grey)\`, \`var(--rule)\`, \`var(--paper)\`, \`var(--surface)\`, \`var(--sunk)\`, the accent \`var(--mark)\` (\`var(--mark-soft)\` for a fill), \`var(--alert)\` for what is wrong (\`var(--alert-soft)\`), and for zones \`var(--blue)\`, \`var(--amber)\`, \`var(--green)\` and \`var(--plum)\`, each with a \`-soft\` fill. Then light and dark both work. In SVG: \`class="line"\`, \`"grey"\`, \`"acc"\`, \`"acc-fill"\`, \`"alert"\`, \`"dash"\`, and \`"t-acc"\`, \`"t-grey"\`, \`"t-alert"\`, \`"t-mono"\` for text.
- Icons, logos and drawn things by name; the store draws them:
  - \`<svg data-icon="server" x="…" y="…" width="28" height="28"/>\`: any Lucide icon (lucide.dev), in the ink, or \`style="color:var(--blue)"\`.
  - \`<svg data-logo="stripe" x="…" y="…" width="40" height="40"/>\`: a product's real logo, in its own colours. Simple Icons names: stripe, postgresql, redis, supabase, cloudflare, vercel, google, apple, github, claude… \`shape update\` says when there is none: then its name in words, with an icon.
  - \`<svg data-draw="database" x="…" y="…" width="160" height="120" data-label="Postgres"/>\`: a drawn database, server, phone, laptop, browser, envelope or queue. Its \`data-label\` is written on it, or just under a server, queue or envelope: leave the 30 px under those free.
  - \`data-to="x y"\` on one of them sends it there again and again, as an envelope crossing a wire. It holds still for anyone who turns motion off. Once on a board, where the movement is the point.
- Nothing from outside: no scripts, no event handlers, no \`<style>\` in the HTML (use \`css\`), no external images, fonts or \`url()\`, no iframes, forms or popovers. The store refuses them and says which.
- Links: \`#id\` scrolls inside the drawing; an https link opens in a new tab.
- A phone shows the board narrow. For a wide How it works, add \`"tall": { "html": … }\` with the same parts stacked about 400 px wide.
- \`shape update\` prints \`notes\` when a board will not behave. It stores the board anyway: fix them and update again.
- Optional helpers: \`plannotator shape kit > kit.mjs\` (JavaScript, no dependencies). Its first lines show how.
`;

/**
 * The start of `plannotator shape --help`: the welcome, how to open the page
 * (or leave the open one be), and the commands.
 */
export const SHAPE_HELP_INTRO = [
  "Welcome to Shape. The person wants to see the work the way you see it, so they can say",
  "\"yes, that's it\" or point at the part that is wrong. Draw it as you would on a whiteboard: a JSON file you",
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
  "A shape is a board you draw for the person: a Picture, How it works, What's changed,",
  "What to know and Code, with numbered references. Each update stores a new version of",
  "the whole board.",
  "",
  "(none)   Opens Shape's page in the person's browser, or the one already open, and prints its address.",
  "update   Stores the board in <board.json>. Without --id it makes a new shape and",
  "         prints its id. With --id, --base is the version you drew from; if the shape",
  "         changed since, the update is refused and the latest version is printed.",
  "         Keep the same ids (data-mark, ref numbers) for the same parts, so the",
  "         board redraws only what changed.",
  "read     Prints the latest version (or --version <n>). --notes also prints the notes",
  "         that wait for you (Change it and Ask) and marks them as received.",
  "drawing  Tells the board you are drawing a new version (until it lands, at most 10 minutes).",
  "answer   Answers the person's Ask (its id is in read --notes). Change it notes need",
  "         no answer: draw the change as a new version.",
  "done     Finishes the shape. Do this only when the person says so.",
  "list     Lists the active shapes, newest change first (--all: finished ones too).",
  "open     Opens the Shape page in the person's browser: every board, or one board.",
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

1. Read the whole thread (\`read_thread\`, every message). Note: what the work makes, what is settled, what is open and whose call it is, and what happens next. Then pick the one idea to draw; the rest goes behind numbers or in What to know.
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
