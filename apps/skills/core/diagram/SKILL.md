---
name: diagram
description: Design, create, or revise structured diagrams (.diagram.json) rendered to SVG with @plannotator/diagrams—choosing layouts, visual hierarchy, embedded media, clickable parts, source references, and pinned-feedback revisions.
disable-model-invocation: true
---

# Diagram

Design and author a structured diagram as a `.diagram.json` specification and render it to SVG with `@plannotator/diagrams`. The renderer measures typography, sizes panels, routes connectors, and checks geometry—reporting overlaps, crossings, ports facing away, and label collisions so you can refine the drawing until it renders cleanly.

## 1. Ground the content, then choose your own form

Decide for yourself what viewpoint, composition, level of detail, emphasis, and omissions best answer the reader's request using the primitives below.

- **Start from the library's visual language, and depart only with intent:** `@plannotator/diagrams` ships with tactile architectural defaults—subtle 3D lids, beveled tiles, blueprint mini-graphs, structured cards, dashed boundary groups, and host-adaptive colors—that work well out of the box. Prefer structured visual blocks (`tiles`, `card`, `graph`, `row`, `groups`, `footer`, `steps`) that show components, boundaries, and concrete data at a glance instead of prose paragraphs. Adjust `theme` relief, typography, or custom `tones` only when that choice carries a real distinction or makes the finished drawing clearer to read.
- **Verify real references:** When drawing from an existing codebase or repository, read the actual source, config, or doc files first and cite real symbols, project-relative paths, and 1-based line numbers—never invent them. When drawing from a brief with no repo files, omit file `refs` (or include only real URLs).

## 2. Create or locate the `.diagram.json` file

A top-level `"id"` identifies one logical diagram across its revisions. Never copy a literal example ID across unrelated drawings.

- **New diagram with Plannotator CLI:**
  ```bash
  plannotator diagram new my-diagram
  # or an explicit path ending in .diagram.json:
  plannotator diagram new docs/my-diagram.diagram.json
  ```
  Writes a starter file with a freshly generated UUID top-level `id` and prints its absolute path. Pass a plain name (letters, digits, spaces, `.`, `_`, `-`) to store it in the project's Plannotator diagram folder, or pass an explicit `*.diagram.json` path when a specific location was requested. Keep the generated UUID as the diagram's `"id"`. Never run `plannotator diagram new` on an existing diagram—it fails if the file exists, and replacing `"id"` breaks revision history.
- **New diagram standalone (no Plannotator CLI, or an older Plannotator without `diagram`):**
  Create a UTF-8 `*.diagram.json` file in the requested or working directory and generate a fresh UUID for its top-level `"id"` (for example with `crypto.randomUUID()`).
- **Revising an existing diagram:**
  Edit the existing `.diagram.json` file in place and keep its top-level `"id"` unchanged.

## 3. Renderer vocabulary and capabilities

Validation is strict: **unknown keys anywhere throw a `TypeError`** naming the exact JSON path. Use exact field names: `sub` (not `description`), `status` (not `state`), `tone` (not `color`), and `columns`/`ring`/`panels` + `links` (not `nodes`/`edges`).

### Layouts (choose exactly one)

A diagram combines one outer layout of panels with optional `groups` (enclosing any subset of panels), `links` (connecting any pair of panels or a panel to itself), top-level framing chrome, and `theme` styling. Prefer automatic layouts (`columns` or `ring`) whenever they fit—they handle panel measurement, alignment, and spacing cleanly; use explicit `panels` when custom 2D coordinates are genuinely needed. When the reader needs to trace a directional flow, keep the primary path moving cleanly (typically left-to-right or top-to-bottom) rather than doubling back unnecessarily—reserving rings, deliberate folds, and return paths for subjects that genuinely call for them—and make supporting panels' relationship to the main path clear (through proximity, containment, or a labelled control link when warranted) instead of leaving them ambiguously adrift.

- **`columns`** — Places entries left to right; each entry is a single panel or a vertical stack (`Panel | Panel[]`). Panels stacked in the same column expand to match the widest panel in that column.
  - Controls: `gap` (horizontal spacing between columns, default `72`), `row_gap` (vertical spacing inside a stack, default `28`), `valign` (`"top" | "center" | "bottom"`, default `"center"`—vertical alignment of shorter columns against the tallest).
  - Shape: `{ "columns": [panelA, [panelB1, panelB2], panelC] }`
- **`ring`** — Places ≥2 panels around an ellipse whose radius expands automatically to satisfy `gap`, starting at `start_angle` degrees for `ring[0]` (default `-90`, top) and stepping clockwise around 360°. Optional **`center`** (`Panel[]`) stacks one or more panels centered inside the ellipse.
  - Controls: `start_angle` (degrees, default `-90`), `gap`, `row_gap`.
  - Shape: `{ "ring": [panelA, panelB, panelC], "center": [centerPanel], "start_angle": -90 }`
- **`panels`** — Places ≥1 panels at explicit 2D coordinates; **every** panel must provide numeric `x` and `y`. (`x` and `y` are forbidden in `columns` and `ring`.)
  - Shape: `{ "panels": [{ "id": "a", "title": "A", "x": 0, "y": 0 }, { "id": "b", "title": "B", "x": 320, "y": 140 }] }`

### Top-level framing and metadata

- Required: `title` (string) and one layout (`columns`, `ring`, or `panels`).
- Recommended: `id` (nonempty UUID/string for revision tracking).
- Optional chrome:
  - `subtitle` — secondary line under the title.
  - `tag` — pill badge rendered before the title.
  - `note` — top-right callout box: `{ "title": "...", "lines": ["..."] }` (auto-wrapped).
  - `steps` + `steps_label` — numbered legend strip: `[[1, "Phase one"], [2, "Phase two"]]` (label defaults to `"Steps"`).
  - `legend` — boolean (default `true`); automatically displays only statuses and link kinds actually used in the diagram.
  - `statuses` — central status override map `{ "<panel-or-tile-name-or-id>": "<status>" }` (every key must match an existing panel or tile).
  - `groups`, `links`, `theme`.

### Panels and composable sections

Every panel has `title` (required) and supports:
- Identity & framing: unique `id` (strongly recommended), `sub` (header subtitle and interactive hover summary), `step` (positive integer circle badge), `footer` (bottom metadata strip; supports `\n` and bold `Key: value` prefixes such as ownership, counts, or invariants), `width` (positive minimum width in px), `refs`.
- Visual emphasis:
  - `tone`: `"default"`, `"neutral"`, `"accent"`, `"dark"`, custom key in `theme.tones`, or any 6-digit hex `"#rrggbb"` (header text contrast adjusts automatically). Use tones with discipline: keep most panels `"default"` or `"neutral"` so status fills, tiles, and badges carry the signal, reserving `"accent"`, `"dark"`, or a small set of named `theme.tones` for genuine focal emphasis or a meaningful distinction across parts of the diagram.
  - `status`: `"live"` (default), `"building"`, `"trial"`, `"planned"`, `"retiring"`, or custom key in `theme.statuses`.
- Body content: shorthand `tiles` (with optional `cols` default ≤3 and `label`, both valid only when `tiles` is set) and/or an ordered `sections` array. Prefer structured visual blocks that encode real components, relationships, and concrete examples over walls of prose:
  - **Tile grid:** `["Item A", { "label": "Item B", "sub": "Detail", "status": "trial" }]` or `{ "tiles": [...], "cols": 2, "label": "Heading" }` — beveled 3D tiles for discrete sub-components, inputs, outputs, or capabilities; multiple labelled grids can stack inside one panel, and individual tiles carry their own `status` styling.
  - **Mini node graph:** `{ "graph": { "nodes": { "a": "Start", "b": "End" }, "at": { "a": [0, 0], "b": [1, 0] }, "links": [["a", "b", "optional label"]] } }` — a blueprint-grid sub-diagram inside a panel (`col × 132`, `row × 58`; no self-loops inside `graph`) for internal entities, states, or sub-relationships.
  - **Key-value card:** `{ "card": { "title": "Spec", "intro": "Optional lead-in", "rows": [["Key", "Value"]] } }` — structured table for concrete specimens, record fields, metrics, or contracts.
  - **Side-by-side row:** `{ "row": [section1, section2] }` — arranges any list of sections horizontally across the panel width, nesting any other section forms (including addressable wrappers, graphs, cards, tiles, images, or text).
  - **Embedded image:** `{ "image": { "src": "data:image/png;base64,...", "alt": "Description", "width": 480, "height": 300 } }` — PNG or JPEG base64 data URL (see image helper below).
  - **Addressable section wrapper:** `{ "id": "unique-id", "title": "Readable title", "refs": [...], "content": <any section> }` — wraps any section so readers can click it, inspect `refs`, and pin comments directly to it. Section `id`s must be unique across the whole diagram.
  - **Text:** `"Short note"` or `{ "text": "Short note" }` (auto-wrapped) — use sparingly for a brief caption or caveat when a structured block does not fit; avoid multi-sentence paragraphs inside panels.

### Boundaries (`groups`)

Group panels that share ownership, lifecycle, trust boundary, or domain inside a dashed container instead of repeating the same qualifier text on separate boxes:
`{ "id": "boundary-id", "label": "Boundary name", "members": ["panel-a", "panel-b"], "sub": "Optional summary", "refs": [...] }`
Full nesting (one group wholly inside another) is supported; partially overlapping groups or enclosing non-member panels is reported as a layout problem. Each group adds ~20 px of outer padding around its members, so leave extra gap when a labelled link crosses between groups.

### Connections and routing (`links`)

Minimal link: `{ "id": "edge-id", "from": "panel-a", "to": "panel-b", "label": "Optional label" }`

- **Explicit `id`:** Give every link an explicit `id`—especially parallel links between the same two panels, so reordering them never swaps pinned comments.
- **`kind`:** `"flow"` (solid, default), `"planned"` (dotted), or a custom key registered in `theme.link_labels`.
- **Ports (`start`, `end`):** `"left" | "right" | "top" | "bottom" | "auto"`. Defaults: `columns` uses `right` → `left`; `ring` and `panels` use `"auto"` (nearest facing side); setting `lane` defaults both ends to that side (`top` or `bottom`) and auto-stacks non-overlapping lanes.
- **Waypoints (mutually exclusive—set at most one per link):** `lane` (`"top" | "bottom"`), `via_x` (number, orthogonal vertical channel), or `via_y` (number, orthogonal horizontal channel). Self-loops (`from === to`) auto-route via a top lane.
- **`cross_ok`:** Boolean (default `false`); suppresses the panel-crossing diagnostic only when a crossing is intentional.
- **`refs`:** Optional file or web link references attached to the connection.

### References (`refs`)

Allowed on panels, addressable sections, groups, and links:
- **File reference:** `{ "kind": "file", "title": "Label", "path": "src/example.ts", "start": 10, "end": 28, "url": "https://..." }` — `path` must be project-relative (no leading `/` or `..`); `start` and `end` are 1-based integers with `end >= start` (omit both for the whole file); `url` is optional `http://`/`https://`.
- **Web link reference:** `{ "kind": "link", "title": "Label", "url": "https://..." }` — `http://` or `https://` only.

### Theme and styling knobs (`theme`)

**Default rule:** Start with `theme` unset—the default palette adapts automatically to Plannotator's light, dark, and custom host themes, and the default geometry (`lid: 9`, `depth: 4`, typography, and padding) is already calibrated as one cohesive visual language. Avoid stripping relief or tweaking sizes out of habit; depart from defaults when your design has a clear reason—for example, defining semantic `theme.tones` to separate distinct realms, dialing `lid`/`depth` lighter for a crisper schematic register, or raising font sizes (`body`, `small`, `tile`) when a wide overview needs stronger legibility at reading size. When customizing, override only the specific keys you need and leave canvas/surface colors (`paper`, `ink`, `panel_fill`, etc.) unset unless a fixed palette is required, so the diagram still adapts to the host theme.

When custom styling or domain semantics are needed, every color must be 6-digit hex (`#rrggbb`):
- **Custom semantic registries** (merged with built-ins):
  - `theme.tones`: `{ "highlight": "#D8ECFF" }`
  - `theme.statuses`: `{ "blocked": { "label": "Blocked", "stroke": "#B42318", "fill": "#FEF0EE", "dash": "dashed" } }` (`dash` is `"dotted" | "dashed" | null`)
  - `theme.link_labels`: `{ "async": "Asynchronous event" }`
- **Surface, text, and chrome colors:** `paper`, `ink`, `muted`, `faint`, `line`, `panel_fill`, `panel_stroke`, `tile_fill`, `tile_stroke`, `header_text`, `header_sub`, `header_text_on_dark`, `header_sub_on_dark`, `group_fill`, `group_stroke`, `note_fill`, `note_stroke`, `tag_color`, `badge_fill` (`#rrggbb | null`), `badge_text` (`#rrggbb | null`), `graph_fill`, `graph_grid`, `graph_line`.
- **Geometry & typography measurements** (nonnegative numbers; defaults shown):
  - 3D relief: `lid` (`9`), `depth` (`4`).
  - Spacing & sizing: `pad` (`12`), `tile_gap` (`8`), `section_gap` (`12`), `tile_h` (`30`), `line_h` (`14.5`), `header_h` (`36`), `header_h_sub` (`50`), `panel_min_w` (`200`), `tile_max_w` (`230`), `radius` (`6`), `col_gap` (`72`), `row_gap` (`28`), `min_gap` (`16`), `margin` (`40`).
  - Font sizes: `title` (`26`), `subtitle` (`13.5`), `legend` (`12`), `panel_title` (`14.5`), `panel_sub` (`11`), `tile` (`12`), `tile_sub` (`10.5`), `body` (`11`), `small` (`10.5`), `min_text` (`10`).

### Embedding local PNG or JPEG images

Encode local PNG/JPEG assets in a short script rather than pasting base64 by hand, and wrap `{ image }` inside an addressable section's `content` so the visual is clickable, commentable, and can hold `refs`. `width` and `height` are **SVG display pixels** inside the panel (`preserveAspectRatio="xMidYMid meet"`), not raw image pixels—choose `width` for **legibility** (a compact icon needs far less room than a full desktop UI screenshot, where ~480 px wide keeps interface text readable) and scale `height` to match the source aspect ratio to avoid letterboxing. Upsert by section `id` so re-running to refresh an asset preserves the ID and unrelated sections:

```js
import { readFileSync } from "node:fs";

function upsertImageSection(panel, { id, title, filePath, alt, width, height, refs }) {
  const mime = /\.jpe?g$/i.test(filePath) ? "image/jpeg" : "image/png";
  const src = `data:${mime};base64,${readFileSync(filePath).toString("base64")}`;
  const entry = {
    id,
    title,
    ...(refs?.length ? { refs } : {}),
    content: { image: { src, alt, width, height } }
  };
  const sections = (panel.sections ??= []);
  const idx = sections.findIndex(s => typeof s === "object" && s !== null && s.id === id);
  if (idx >= 0) sections[idx] = entry;
  else sections.push(entry);
}
```

### Input limits

- At most **512 addressable parts** total (panels + named sections + groups + top-level links).
- At most **512 mini-graph nodes and links combined** across the drawing.
- At most **128 nonempty link labels** combined across top-level links and mini-graph links.
- Each mini-graph grid may measure at most **8,192 px** per axis (including labels, padding, and any extra width allocated by a sibling panel or row).

## 4. Render, inspect, and repair

Render the `.diagram.json` to a separate `.svg` file and check the exit code:

- **With Plannotator CLI:**
  ```bash
  plannotator diagram render my-diagram.diagram.json -o my-diagram.svg
  ```
- **Standalone (`@plannotator/diagrams` npm package):**
  Use this when Plannotator is not installed or when an older Plannotator install does not yet have the `diagram` subcommand:
  ```bash
  plannotator-diagrams render my-diagram.diagram.json -o my-diagram.svg
  # or when installed locally in a project:
  npm exec -- plannotator-diagrams render my-diagram.diagram.json -o my-diagram.svg
  ```
  If `plannotator-diagrams` is not already available, install it locally without changing project dependencies—either from npm once published, or from a supplied preview tarball:
  ```bash
  npm install --no-save @plannotator/diagrams
  # or with a supplied preview tarball:
  npm install --no-save ./plannotator-diagrams-0.1.0.tgz
  ```
  (Programmatic ESM API in Node, browsers, or workers: `import { renderDiagram } from "@plannotator/diagrams"` → `const { svg, width, height, parts, description, problems } = await renderDiagram(spec)`.)

Arguments must be in the exact order `render <input> -o <output>` (or `--output`), and the output path must differ from the input path. Three outcomes exist:
- **Exit `0`:** valid spec, zero layout problems, SVG written.
- **Exit `1` with layout diagnostics:** valid spec, **the SVG was written** for inspection, and each layout problem was printed to stderr.
- **Exit `1` with invalid JSON, schema/limit error, or bad arguments:** fails before rendering; **no new SVG is written**, and the error is printed to stderr.

To inspect measured panel bounds, group boxes, and link `labelBox` clearances when adjusting placement (with `@plannotator/diagrams` installed locally):

```bash
node --input-type=module -e 'import { readFileSync } from "node:fs"; import { renderDiagram } from "@plannotator/diagrams"; const { parts } = await renderDiagram(JSON.parse(readFileSync("my-diagram.diagram.json", "utf8"))); console.table(parts.filter(p => p.kind === "panel" || p.kind === "group" || (p.kind === "link" && p.labelBox)).map(p => { const b = p.kind === "link" ? p.labelBox : p; return { kind: p.kind, id: p.id, x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.w.toFixed(1), h: +b.h.toFixed(1) }; }));'
```

Reported `x` and `y` include the renderer's outer canvas translation and `w`/`h` are measured—compare panel edges, group borders, and each link's `labelBox` to calculate exact gaps and verify pill clearance without guessing.

Iterate until exit `0`:
- **Port facing away:** set `"start"` / `"end"` explicitly (e.g. `"bottom"` / `"top"` or `"auto"`) or add `"lane": "top" | "bottom"`.
- **Line crosses a panel:** rearrange columns/stacks, route via `"lane": "top" | "bottom"`, or specify `via_x` / `via_y`.
- **Label sits on a panel, group title, or another line:** increase `gap` or `row_gap`, shorten the label, or move the link to a `lane`.
- **Overlap or panels too close:** separate coordinates in `panels` mode, or adjust `groups` so each group encloses only its own members without partial overlaps.
- **Inner `graph` collision or extent error:** adjust `[col, row]` spacing in `graph.at`, reduce panel/label width, or split self-loops into a panel with a return lane.

**Visual check (exit `0` checks geometry, not communication):** After a clean render, look at the actual rendered picture at its intended reading size (rasterize the `.svg` to PNG if your image viewer needs raster input). Trace the reader's primary paths—and any failure, fallback, or boundary crossings from the request—directly across the image to verify that any directional path reads cleanly without awkward detours or ambiguously adrift panels, that no key hop or boundary was silently dropped, and that critical hops stay visually distinct rather than cramped inside a tiny sub-block. Check focal hierarchy, overall proportions and dead whitespace, panel alignment, tangled line crossings (the renderer checks line-against-panel crossings, not line-against-line crossings), cramped link labels (every label pill should sit on visible line shaft with breathing room from panels, arrowheads, and dashed group borders), whether structured primitives (`tiles`, `card`, `graph`, `groups`) would communicate better than prose, and whether overview text and embedded images remain comfortably legible without zooming in—then do a deliberate polish pass (including targeted font-size, tone, gap, or layout adjustments) if anything feels monotonous, cramped, or hard to trace. If your environment cannot view images, inspect the measured canvas `width`/`height` and bounds table above alongside `renderDiagram(spec).description` to catch lopsided proportions, cramped labels, misaligned placements, or missing paths.

## 5. Revise from pinned feedback

Review feedback identifies parts by kind, title, and id (for example, `Diagram panel API (api)`, `Diagram section Preview (preview)`, `Diagram group Storage (storage)`, `Diagram link Sync (sync)`).

When revising:
1. Edit the existing `.diagram.json` in place.
2. **Preserve the top-level `"id"` and every unchanged part's `"id"`**—even when renaming titles/labels, moving panels across columns or layouts, or reordering parallel links. Retaining part IDs keeps pinned comments anchored. Editing and reattaching the same source file with the same drawing ID groups revisions into one logical diagram.
3. Never reuse a deleted part's `"id"` for a different concept.
4. Re-render until exit `0` before handing back the revision.

## 6. Hand the result back

Interactive source navigation (`refs`), hover summaries, and pinned comments live in the editable `.diagram.json` when opened in Plannotator. The rendered `.svg` is a static image without clickable file anchors—always keep and share the `.diagram.json` alongside any standalone `.svg`.

- **Plannotator Inbox thread:** Reply to the triggering message with `reply_to` set to its message ID and include the `.diagram.json` path in `attachments`. Inbox renders it inline with pan/zoom, clickable `refs`, pinned comments, and Ask AI. For a revision, edit and reattach the same source, keeping its drawing and part IDs.
- **Plannotator Markdown plan or document:** Link the `.diagram.json` file for a live diagram, or paste a ```` ```plannotator-diagram ```` fenced code block containing the JSON for a frozen snapshot.
- **Local interactive review (Plannotator CLI):** Run `plannotator annotate my-diagram.diagram.json` to open the review UI and collect the reader's pinned comments.
- **Standalone / outside Plannotator:** Return paths to both the `.diagram.json` source and the rendered `.svg` (or embed the SVG where requested), along with a concise summary of what the diagram shows and any intentional simplifications. Note to the reader that clickable `refs` live in the `.diagram.json` for Plannotator rather than inside the static `.svg`.
