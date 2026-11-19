## The canvas (`packages/canvas`)

Plannotator's own canvas: boxes, notes, text, arrows, frames, groups, pictures, sprites, custom HTML and reference cards on a plain board, with **snapshots** that embed live in a plan. It is a package with **no product surface yet**: nothing in the apps imports it. Its only consumer is its own development demo (`bun run --cwd packages/canvas demo`, port 3017). This is separate from Shape (the agent's living board in `guides-and-shared-ui.md`).

The owner's rules for it: any colour on any object, set by a person or an agent; no keyboard shortcuts; no dot grid (a plain ground); an agent hears about changes through a hand-over or comments sent in bulk, not live (the seam is `CanvasStore.since`; neither is built).

### Layers

Each layer imports only the ones above it. Keep it that way: no React in `model/`, `events/` or `view/`, and no document change outside `events/`.

| Folder | What it owns |
|---|---|
| `model/` | The document: plain JSON, typed, versioned (`CANVAS_DOCUMENT_VERSION`, `MIGRATIONS`). `types.ts` (objects, `Snapshot`, `ReferenceTarget`), `codec.ts` (fail-closed `parseDocument` / `checkObject`; unknown fields are dropped), `document.ts` (bounds, arrow geometry, groups), `color.ts`, `html-item.ts` (the sandbox contract), `reference.ts`. |
| `events/` | The only way a document changes. `plan.ts` turns a **command** into **events** after checking it; `reduce.ts` applies events and returns their inverse; `store.ts` (`CanvasStore`) commits an **envelope** and tells its listeners. `wire.ts` checks commands and envelopes that arrive as JSON. `sync.ts` is the collaboration seam. |
| `view/` | Pure screen maths: `camera.ts`, `spatial-index.ts` (uniform grid), `document-index.ts` (the index kept current from the event stream, one per store), `cull.ts` (render window, level of detail), `hit-test.ts`. |
| `react/` | `CanvasView` (the renderer, read-only) and `CanvasEditor` around it (`gestures.ts`, `editor-state.ts`, `chrome.tsx`, `references.ts`). |
| `snapshot/` | Snapshots: `resolve.ts`, `create.ts`, `block.ts` (the Markdown block), `SnapshotFigure`, `CanvasStage` + `transition.ts` (the open motion), `picture.ts` (the still fallback), `plan-drop.ts`, `registry.tsx`, `directive.tsx`. |
| `unfurl/` | Link previews: `parse.ts`, `fetch.ts`, `route.ts`. |

### Events

`command → planCommand → events → applyEvents → document`, and every commit is an `Envelope` (`id`, `actor`, `origin`, the command, the events). A person's drag and an agent's "add image" are the same commands through the same `dispatch`; the actor is the only difference.

- **Undo and redo** are a property of that: each commit keeps the inverse events, and an undo is an ordinary envelope. Only the local person's commands go on the stack (an agent's or a peer's change is never theirs to undo). Commands sharing a `gesture` id fold into one step. An undo whose objects someone else removed does nothing.
- **Agents** send JSON through `decodeCommand` and receive envelopes from `onCommit` (or `since(seq)` for a hand-over).
- **Sync** (not built): a backend implements `SyncPort`; `connectSync` wires it. Events replace whole objects, are idempotent and ignore missing objects; envelope ids are unique across peers and a repeat is ignored. Concurrent edits of one object are last-writer-wins by the backend's order. Presence would travel beside the port.
- **Comments** (not built) will anchor with `CanvasAnchor`.

Add a new object type in `model/types.ts`, `checkObject`, `PATCH_FIELDS` (`events/plan.ts`), `ObjectView` and `snapshot/picture.ts`; the compiler's exhaustive switches name the rest.

### Renderer

DOM, with one SVG layer for arrows. Reasons are in the header of `react/CanvasView.tsx`: text is the content (the browser shapes, wraps and exposes it), pictures and sandboxed iframes are elements already, and theming is CSS variables. What keeps it fast: the camera is one CSS transform written outside React; only objects in the render window are mounted (`view/cull.ts`); objects are placed with `transform`; zoomed out, CSS draws less (`data-lod`).

Do **not** put `will-change: transform` on `.pcv-world`: measured, a promoted layer is rastered at full scale and 2,000 objects at 12% zoom pan at 10 fps instead of the display rate. Do not set a CSS variable on the root per frame either (every object inherits it and restyles): the zoom goes to `.pcv-overlay` only.

Styles are plain CSS in `canvas.css` under the `pcv-` prefix, so a host needs no Tailwind `@source` for this package. Colours fall back from the host theme's variables.

### Snapshots

A snapshot (`Snapshot` in the canvas document) is a named, live, read-only window: a frame by id, a set of objects, or a rectangle that remembers what was in it. `resolveSnapshot` answers what it shows now and says so when its objects are gone (`partial` with a count, or `gone`).

In a plan it is a directive block, which the existing parser already makes one block:

```
:::canvas-snapshot
canvas: parcel-alerts
snapshot: architecture
title: Architecture
![Orders API feeds two queues](architecture.svg)
:::
```

`canvas` and `snapshot` are ids; `title` and the image line are optional. The image is the fallback: another Markdown viewer shows it, and `SnapshotFigure` shows it when the canvas is not in the `CanvasRegistry`. `snapshotToSvg` makes one (self-contained, no script, no outside address).

The plan renderer draws the block through the `directiveRenderer` seam of `@plannotator/ui` (`components/blocks/directiveRenderer.ts`; see `packages/ui/README.md`): `createSnapshotDirectiveRenderer` returns the function a host passes to `configurePlannotatorUI`. Neither package imports the other. No product host passes it yet.

`SnapshotFigure` is `CanvasView` with a fixed camera. All figures of a canvas share its store and index, and a figure draws only while within 800 px of the screen. Clicking one mounts `CanvasStage`, which draws the canvas clipped to the figure's box with the camera placed so the picture does not move, then springs both to full size. The spring keeps its velocity when turned round, so closing mid-open is continuous; a person who grabs the board takes the camera at once. Reduced motion: a 140 ms fade, nothing travels.

### Reference cards and link previews

`ReferenceObject` is a card for a web page, one of the person's artifacts, or a place in a plan. What it shows is stored on the object as text and picture addresses. Paste is the way in (`CanvasEditor`: a bare address becomes a web card; `resolvePaste` lets a host claim its own artifact and plan references); an agent adds the same object with `add`.

A web card appears at once with its address and fills in from `linkPreview` (a `LinkPreviewPort`). `unfurl/fetch.ts` is the real fetcher: Open Graph, Twitter card, title, description, icon; http and https only, five redirects, 6 s, the first 512 KB, a small cache, no private addresses, and the bare link whenever a site gives nothing. None of that is shown to the person. `createUnfurlHandler` is a `(Request) => Response`; **only the demo's dev server mounts it** (`demo/vite.config.ts`). Making it a product endpoint means mounting it in both the Bun and the Pi server and adding it to the API tables.

### Custom HTML items

`model/html-item.ts` is the contract and the only way `HtmlObject.html` is drawn: an iframe with an empty `sandbox`, a CSP of `default-src 'none'` with inline styles and `data:` pictures, `inert`. No script, no network, no navigation, no access to the page. Do not add a sandbox token or loosen the policy for convenience; a scripted item is an owner decision with its own review.

### Measuring

`bun run --cwd packages/canvas bench` builds the demo, opens it in Chromium and prints each budget with what was measured (`--headed` for a visible window with GPU raster). It is not run in CI. Tests are `*.test.ts` beside the code and run in the unit lanes; `packages/ui/components/blocks/directiveRenderer.seam.test.tsx` is in the DOM list.
