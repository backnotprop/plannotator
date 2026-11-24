---
name: diagram
description: Create or revise structured architecture and workflow diagrams (.diagram.json) rendered to SVG with @plannotator/diagrams, including clickable parts, source references, and pinned-feedback revisions.
disable-model-invocation: true
---

# Diagram

Create or revise a structured diagram as a `.diagram.json` specification and render it to SVG with `@plannotator/diagrams`. The renderer handles typography, panel sizing, arrow routing, and layout checks—reporting overlaps, line crossings, ports facing away, and label collisions so you can fix them before handing the drawing back.

## 1. Plan before drawing

- Start with the reader's question and pick the smallest diagram that answers it.
- When documenting an existing codebase or repository, read the actual code, config, or docs first and use real component names, project-relative file paths, and 1-based line numbers—never invent paths or symbols. When drawing a conceptual or proposed system from a user's brief with no repo files, omit file `refs` (or include only real `link` URLs).
- Show one main path plus any key branch, failure, or retry path relevant to the question. Keep labels short; move details into `sub`, `footer`, addressable `sections`, and `refs` instead of packing prose into boxes.

## 2. Create or locate the `.diagram.json` file

- **New diagram with Plannotator CLI:**
  ```bash
  plannotator diagram new checkout-flow
  # or an explicit path ending in .diagram.json:
  plannotator diagram new docs/checkout-flow.diagram.json
  ```
  This writes a starter file with a generated UUID top-level `id` and prints the absolute path. Pass a plain name (letters, digits, spaces, `.`, `_`, `-`) to store it in the project's Plannotator diagram folder, or pass an explicit `*.diagram.json` path when a specific location was requested.
  Never run `plannotator diagram new` on an existing diagram—it fails if the file exists, and replacing the top-level `id` breaks revision history.
- **New diagram standalone (no Plannotator CLI, or an older Plannotator without `diagram`):**
  Create a UTF-8 file such as `checkout-flow.diagram.json` in the requested or working directory with a unique top-level `"id"` (a UUID or stable slug).
- **Revising an existing diagram:**
  Edit the existing `.diagram.json` file in place.

## 3. Write the `.diagram.json` specification

Start from this complete, valid example and adapt it to the system you are documenting:

```json
{
  "id": "checkout-fulfillment",
  "title": "Checkout Fulfillment",
  "subtitle": "Asynchronous order processing with retry and dead-letter replay",
  "steps": [[1, "Accept"], [2, "Queue"], [3, "Fulfill"]],
  "gap": 100,
  "row_gap": 44,
  "columns": [
    {
      "id": "checkout",
      "title": "Checkout API",
      "sub": "Validates cart and returns 202",
      "step": 1,
      "tone": "accent",
      "tiles": ["Validate cart", "Reserve stock"],
      "refs": [
        { "kind": "file", "title": "Checkout route", "path": "src/api/checkout.ts", "start": 18, "end": 54 }
      ]
    },
    {
      "id": "queue",
      "title": "Job Queue",
      "sub": "Durable transactional outbox",
      "step": 2,
      "sections": [
        {
          "id": "retry-policy",
          "title": "Retry policy",
          "content": {
            "card": {
              "title": "Backoff",
              "rows": [["Attempts", "5"], ["Timeout", "30 s"]]
            }
          },
          "refs": [
            { "kind": "file", "title": "Worker config", "path": "src/queue/config.ts", "start": 4, "end": 19 }
          ]
        }
      ]
    },
    [
      {
        "id": "fulfill",
        "title": "Fulfillment Worker",
        "sub": "Charges card and creates shipment",
        "step": 3,
        "footer": "SLO: p99 < 2s"
      },
      {
        "id": "deadletter",
        "title": "Dead-Letter Queue",
        "sub": "Holds failed jobs for replay",
        "status": "planned",
        "tone": "neutral"
      }
    ]
  ],
  "groups": [
    {
      "id": "async-backend",
      "label": "Async processing",
      "sub": "Isolated from HTTP latency",
      "members": ["queue", "fulfill", "deadletter"]
    }
  ],
  "links": [
    { "id": "enqueue", "from": "checkout", "to": "queue", "label": "Enqueue job" },
    { "id": "dispatch", "from": "queue", "to": "fulfill", "label": "Dispatch" },
    { "id": "exhausted", "from": "fulfill", "to": "deadletter", "kind": "planned", "label": "After 5 retries", "start": "bottom", "end": "top" },
    { "id": "replay", "from": "deadletter", "to": "queue", "kind": "planned", "label": "Replay", "lane": "bottom" }
  ]
}
```

### Schema reference and common pitfalls

Validation is strict—**unknown keys anywhere throw an error** naming the JSON path. Use exact field names: `sub` (not `description`), `status` (not `state`), `tone` (not `color`), and `columns`/`ring`/`panels` + `links` (not `nodes`/`edges`).

- **Top-level fields:** `title` (required), `id` (required for revision tracking), `subtitle`, `tag`, `note: { title, lines?: string[] }`, `steps: [[1, "Label"], ...]`, `steps_label`, `legend` (boolean, default `true`), `gap`, `row_gap`, `valign` (`"top" | "center" | "bottom"`), `statuses` (map of panel/tile name or id to status), `groups`, `links`, `theme`.
- **Choose exactly one layout:**
  - `columns`: array of panels or vertical panel stacks (`Panel | Panel[]`). Best for left-to-right pipelines and branches.
  - `ring`: array of ≥2 panels in a loop, plus optional `center: Panel[]` and `start_angle` (degrees, default `-90`). Best for cycles or hub-and-spoke topologies.
  - `panels`: array of ≥1 panels where **every** panel sets numeric `x` and `y`. (`x` and `y` are forbidden in `columns` and `ring`.)
- **Panels:** `title` (required), unique `id` (strongly recommended), `sub`, `status` (`"live"` default, `"building"`, `"trial"`, `"planned"`, `"retiring"`), `step` (positive integer), `tone` (`"default"`, `"neutral"`, `"accent"`, `"dark"`, or `#rrggbb`), `width`, `footer` (supports `\n` and `Key: value`), `tiles` (array of `"Label"` or `{ label, sub?, status? }`), `cols` and `label` (only valid when `tiles` is set), `sections`, `refs`.
- **Sections inside `panel.sections`:**
  - Plain text: `"string"` or `{ "text": "..." }`
  - Tiles: `["A", "B"]` or `{ "tiles": [...], "cols": 2, "label": "..." }`
  - Key-value card: `{ "card": { "title": "...", "intro": "...", "rows": [["Key", "Value"]] } }`
  - Side-by-side row: `{ "row": [section1, section2] }`
  - Mini node graph: `{ "graph": { "nodes": { "a": "A", "b": "B" }, "at": { "a": [0, 0], "b": [1, 0] }, "links": [["a", "b", "label?"]] } }` (no self-loops inside `graph`)
  - Embedded image: `{ "image": { "src": "data:image/png;base64,...", "alt": "...", "width": 120, "height": 80 } }` (PNG or JPEG base64 data URL)
  - **Addressable section** (clickable, commentable, and able to hold `refs`): `{ "id": "...", "title": "...", "refs": [...], "content": <section> }`. Section `id`s must be unique across the whole diagram.
- **Groups:** `{ "id": "...", "label": "...", "members": ["panel-id", ...], "sub": "...", "refs": [...] }`. Groups may nest completely inside another group, but must not overlap non-member panels or partially overlap another group.
- **Links:** `{ "id": "...", "from": "<panel-id>", "to": "<panel-id>", "label": "...", "kind": "flow" | "planned", "start": "left|right|top|bottom|auto", "end": "...", "lane": "top" | "bottom", "via_x": N, "via_y": N, "cross_ok": true, "refs": [...] }`.
  - Give every link an explicit `id`—especially parallel links between the same two panels (without authored `id`s, reordering parallel links swaps pinned comments).
  - Use at most **one** of `lane`, `via_x`, or `via_y` per link.
  - In `columns`, ports default to `right` → `left`. Set `start`/`end` (or `"auto"`) for links within the same column, and `lane: "top"` or `"bottom"` for backward or skip-column links. Self-loops (`from === to`) route via a top lane automatically.
- **References (`refs`)** (allowed on panels, addressable sections, groups, and links):
  - File ref: `{ "kind": "file", "title": "...", "path": "src/foo.ts", "start": 10, "end": 25, "url": "https://..." }` — `path` must be project-relative (no leading `/` or `..`); `start` and `end` are 1-based integers with `end >= start` (omit both for the whole file); `url` is optional `http://`/`https://`.
  - Web link ref: `{ "kind": "link", "title": "...", "url": "https://..." }` — `http://` or `https://` only.
- **Theme and colors:** Leave `theme.paper`, `theme.ink`, and default palette colors unset unless fixed colors were explicitly requested—omitting them lets Plannotator adapt the drawing automatically to the reader's light, dark, and custom themes. Any custom color (including `tone`) must be a 6-digit hex string (`#rrggbb`).

### Recipe: embedding a local PNG or JPEG

Generate the base64 data URL from disk in a short script rather than pasting base64 by hand, and wrap `{ "image": ... }` inside an addressable section's `content` so the image is clickable, commentable, and can carry `refs`. `width` and `height` are **display dimensions in SVG pixels** inside the panel (rendered with `preserveAspectRatio="xMidYMid meet"`), not raw image pixels. Choose `width` for **legibility**—a compact badge or icon needs far less room than a full desktop UI screenshot (for example, a 1440×900 interface often needs ~480 px wide so text stays readable)—and scale `height` to match the source aspect ratio to avoid letterboxing. Update any matching section `id` in place so re-running to refresh a screenshot preserves the ID and unrelated sections:

```js
import { readFileSync, writeFileSync } from "node:fs";

// Use data:image/jpeg;base64, for .jpg/.jpeg files
const src = "data:image/png;base64," + readFileSync("docs/checkout-screen.png").toString("base64");

const spec = JSON.parse(readFileSync("checkout-flow.diagram.json", "utf8"));
const sections = (spec.columns[0].sections ??= []);
const entry = {
  id: "checkout-screen",
  title: "Checkout screen",
  refs: [{ kind: "file", title: "Checkout UI", path: "src/ui/Checkout.tsx", start: 1, end: 40 }],
  content: {
    // SVG display size chosen for legibility, matching source aspect ratio (e.g. 1440x900 -> 480x300)
    image: { src, alt: "Checkout screen", width: 480, height: 300 }
  }
};
const idx = sections.findIndex(s => typeof s === "object" && s !== null && s.id === entry.id);
if (idx >= 0) sections[idx] = entry;
else sections.push(entry);
writeFileSync("checkout-flow.diagram.json", JSON.stringify(spec, null, 2) + "\n");
```

Then render and verify with `plannotator diagram render` or `plannotator-diagrams render` (Section 4).

## 4. Render and fix layout problems

Render the `.diagram.json` to a separate `.svg` file and check the exit code:

- **With Plannotator CLI:**
  ```bash
  plannotator diagram render checkout-flow.diagram.json -o checkout-flow.svg
  ```
- **Standalone (`@plannotator/diagrams` npm package):**
  Use this when Plannotator is not installed, or when an older Plannotator binary does not yet have the `diagram` subcommand:
  ```bash
  plannotator-diagrams render checkout-flow.diagram.json -o checkout-flow.svg
  # or when installed locally in a project:
  npm exec -- plannotator-diagrams render checkout-flow.diagram.json -o checkout-flow.svg
  ```
  If `plannotator-diagrams` is not already available, install it locally without modifying project dependencies (either from npm once published, or from a supplied preview tarball):
  ```bash
  npm install --no-save @plannotator/diagrams
  # or with a supplied preview tarball:
  npm install --no-save ./plannotator-diagrams-0.1.0.tgz
  ```
  (Programmatic ESM API in Node, browsers, or workers: `import { renderDiagram } from "@plannotator/diagrams"` → `const { svg, width, height, parts, description, problems } = await renderDiagram(spec)`.)

Arguments must be in the exact order `render <input> -o <output>` (or `--output`), and the output file must not be the same file as the input. Exit behavior distinguishes three outcomes:
- **Exit `0`:** valid spec, zero layout problems, SVG written.
- **Exit `1` with layout diagnostics:** valid spec, **the SVG was written** so you can inspect it, and each layout problem was printed to stderr.
- **Exit `1` with invalid JSON, schema error, or bad arguments:** fails before rendering; **no new SVG is written**, and the error is printed to stderr.

Loop until the render exits `0`:
- **Port facing away:** set `"start"` and `"end"` (e.g. `"bottom"` / `"top"` or `"auto"`) or add `"lane": "top"` / `"bottom"`.
- **Line crosses a panel:** move the panel to another column or stack, route with `"lane": "top"` / `"bottom"`, or use `via_x` / `via_y`.
- **Label sits on a panel, group title, or another line:** increase top-level `gap` or `row_gap`, shorten the label, or move the link to a `lane`.
- **Overlap or panels too close:** separate panels in `panels` mode, or adjust `groups` so each group's members form a clean rectangle without trapping non-members.
- **Inner `graph` collision:** increase `[col, row]` spacing in `graph.at`, or split self-loops into a panel with a return lane.

## 5. Revise from pinned feedback

Review feedback identifies specific parts by kind, title, and id, such as:
- `Diagram panel Fulfillment Worker (fulfill)`
- `Diagram section Retry policy (retry-policy)`
- `Diagram group Async processing (async-backend)`
- `Diagram link Replay (replay)`

When revising:
1. Edit the existing `.diagram.json` in place.
2. **Preserve the top-level `id` and every unchanged part's `id`**—including when renaming a `title` or `label`, moving a panel across columns, or reordering parallel links. Stable IDs keep pinned comments anchored to the right part and group revisions into one diagram in Inbox.
3. Never reuse a deleted part's `id` for a different concept.
4. Re-render until exit `0` before sending the update.

## 6. Hand the result back

Interactive source navigation (`refs`), hover summaries, and pinned comments live in the editable `.diagram.json` when opened in Plannotator. The rendered `.svg` is a static image without clickable file anchors—keep and share the `.diagram.json` alongside any standalone `.svg`.

- **Plannotator Inbox thread:** Reply to the triggering message with `reply_to` set to its message ID and pass the `.diagram.json` path in `attachments`. Inbox renders it inline with pan/zoom, clickable `refs`, pinned comments, and Ask AI, and groups revisions by its top-level `id`.
- **Plannotator Markdown plan or document:** Link the `.diagram.json` file for a live diagram, or paste a ```` ```plannotator-diagram ```` fenced code block containing the JSON for a frozen snapshot.
- **Local interactive review (Plannotator CLI):** Run `plannotator annotate checkout-flow.diagram.json` to open the review UI and collect the reader's pinned feedback.
- **Standalone / outside Plannotator:** Return the paths to both the `.diagram.json` source and the rendered `.svg` (or embed the SVG where requested), along with a brief note explaining what the diagram shows and any intentional simplifications. Note to the reader that clickable `refs` are stored in the `.diagram.json` for Plannotator rather than inside the static `.svg`.
