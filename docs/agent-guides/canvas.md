## The canvas (`packages/canvas`)

Plannotator's own canvas: boxes, notes, text, arrows, frames, groups, pictures, sprites, custom HTML and reference cards on a plain board, with **snapshots** (captures of part of the board) that embed in a plan. It is a package with **no product surface yet**: nothing in the apps imports it. Its only consumer is its own development demo (`bun run --cwd packages/canvas demo`, port 3017). This is separate from Shape (the agent's living board in `guides-and-shared-ui.md`).

The owner's rules for it: any colour on any object, set by a person or an agent; no keyboard shortcuts; no dot grid (a plain ground); an agent hears about changes through a hand-over or comments sent in bulk, not live (the seam is `CanvasStore.since`; neither is built).

### Layers

Each layer imports only the ones above it, and `layers.test.ts` fails on any import that goes the other way: `model` < `events` < `view` < `react` < `snapshot`, with `unfurl` (server-side) importing `model` only. No React in `model/`, `events/` or `view/`, and no document change outside `events/`.

| Folder | What it owns |
|---|---|
| `model/` | The document: plain JSON, typed, versioned (`CANVAS_DOCUMENT_VERSION`, `MIGRATIONS`). `types.ts` (objects, `Snapshot`, `ReferenceTarget`), `codec.ts` (fail-closed `parseDocument` / `checkObject`; unknown fields are dropped), `document.ts` (bounds, arrow geometry, groups), `capture.ts` (taking and comparing a snapshot's capture), `color.ts`, `html-item.ts` (the sandbox contract), `reference.ts`. |
| `events/` | The only way a document changes. `plan.ts` turns a **command** into **events** after checking it; `reduce.ts` applies events and returns their inverse; `store.ts` (`CanvasStore`) commits an **envelope** and tells its listeners. `wire.ts` checks commands and envelopes that arrive as JSON. `sync.ts` is the collaboration seam. |
| `view/` | Pure screen maths: `snapshot-source.ts` (a selection or a region as a snapshot to ask for), `camera.ts`, `spatial-index.ts` (uniform grid), `document-index.ts` (the index kept current from the event stream, one per store), `cull.ts` (render window, level of detail), `hit-test.ts`. |
| `react/` | `CanvasView` (the renderer, read-only) and `CanvasEditor` around it (`gestures.ts`, `editor-state.ts`, `chrome.tsx`, `references.ts`, `plan-drop.ts`, `link-preview.ts`). |
| `snapshot/` | Snapshots: `resolve.ts` (current, behind, detached), `create.ts`, `block.ts` (the Markdown block), `SnapshotFigure`, `frozen.ts`, `CanvasStage` + `transition.ts` (the portal), `picture.ts` (the still fallback), `plan-drop.ts`, `registry.tsx`, `directive.tsx`. |
| `unfurl/` | Link previews, server-side: `address.ts`, `parse.ts`, `fetch.ts`, `route.ts`. |

### Events

`command → planCommand → events → applyEvents → document`, and every commit is an `Envelope` (`id`, `actor`, `origin`, the command, the events). A person's drag and an agent's "add image" are the same commands through the same `dispatch`; the actor is the only difference.

- **Undo and redo** are a property of that: each commit keeps the inverse events, and an undo is an ordinary envelope. Only the local person's commands go on the stack (an agent's or a peer's change is never theirs to undo). Commands sharing a `gesture` id fold into one step. An undo whose objects someone else removed does nothing.
- **Agents** send JSON through `decodeCommand` and receive envelopes from `onCommit`. For a hand-over they keep `store.cursor()` and later ask `store.since(cursor)`. A cursor names the store (`epoch`) as well as the place, because commit numbers start again with every store; a cursor from another store, ahead of this one, or older than the log answers `{ kind: 'resync', document }`, never "nothing changed".
- **Sync** (not built): a backend implements `SyncPort`; `connectSync` wires it. Events replace whole objects, are idempotent and ignore missing objects; envelope ids are unique across peers and a repeat is ignored. Concurrent edits of one object are last-writer-wins by the backend's order. Presence would travel beside the port.
- **Comments** (not built) will anchor with `CanvasAnchor`.

**Untrusted ids and references.** Every `objects` and `snapshots` map has no prototype (`idMap`, `model/document.ts`; made by `createDocument`, the reducer, the codec and `CanvasStore`'s constructor), so `doc.objects[id]` is the stored value or undefined even for `constructor`. An arrow's end sticks to a placed object or to a group the arrow is not inside (`bindingFault`); a group is never inside itself (`groupCycle`). The planner and `parseDocument` refuse anything else, the reducer drops a peer's event that would break it, and `resolveArrow` measures a group by its placed members only, so it cannot recurse whatever a document holds. `hostile.test.ts` covers each door.

Add a new object type in `model/types.ts`, `checkObject`, `PATCH_FIELDS` (`events/plan.ts`), `ObjectView` and `snapshot/picture.ts`; the compiler's exhaustive switches name the rest.

### Renderer

DOM, with one SVG layer for arrows. Reasons are in the header of `react/CanvasView.tsx`: text is the content (the browser shapes, wraps and exposes it), pictures and sandboxed iframes are elements already, and theming is CSS variables. What keeps it fast: the camera is one CSS transform written outside React; only objects in the render window are mounted (`view/cull.ts`); objects are placed with `transform`; zoomed out, CSS draws less (`data-lod`).

Do **not** put `will-change: transform` on `.pcv-world`: measured, a promoted layer is rastered at full scale and 2,000 objects at 12% zoom pan at 10 fps instead of the display rate. Do not set a CSS variable on the root per frame either (every object inherits it and restyles): the zoom goes to `.pcv-overlay` only.

Styles are plain CSS in `canvas.css` under the `pcv-` prefix, so a host needs no Tailwind `@source` for this package. Colours fall back from the host theme's variables.

### Snapshots

A snapshot is a **materialized view**: a capture of part of the canvas taken at one moment (the owner's direction: "like a materialized view … this one time snapshot … somebody should be able to update the materialization"). Editing the canvas afterwards does not change it.

- **What is stored.** `Snapshot` (`model/types.ts`) is `id`, `title`, `source` (a frame by id, a set of objects, or a rectangle) and `capture`: the rectangle and a frozen copy of the objects it showed, back to front. It lives in the canvas document, so a plan's block stays two ids and one snapshot can appear any number of times.
- **Who takes it.** Only the planner, with `captureOf` (`model/capture.ts`): on `add-snapshot`, on `edit-snapshot` with a new source, and on `update-snapshot`. A capture sent with a command is ignored, so a person and an agent make and update snapshots the same way and neither can forge one. The new capture travels in the `snapshot-put` event, so undo, redo and a peer all get it.
- **What it costs.** The document never mutates an object, so a capture holds the canvas's own objects, not copies, until one of them is edited. Fifty snapshots of an unchanged canvas are fifty small arrays. An arrow with an end stuck to something outside the capture gets that end fixed in place (one small copy), and group membership is dropped, so a capture draws by itself. Not done: a shared table for large `data:` pictures, which are written once per capture when the document is saved.
- **Behind.** `snapshotStanding` (`snapshot/resolve.ts`) captures the source again and compares (`capturesEqual`, by reference first). No clock or counter is kept, so it is right across peers and after an undo, and it means exactly "taking it again would look different": for a set of objects, one of them changed or was deleted; for a frame or a region, anything in the rectangle changed, arrived or left. Changing something back makes it `current` again. When the source is gone (the frame, or every chosen object) it is `detached`: the capture is all that is left, it stays, and `update-snapshot` is refused. Only a figure that is drawing asks; `behindSnapshots` answers for a whole plan ("update all": dispatch the updates with one `gesture` id for one undo step).

In a plan it is a directive block, which the existing parser already makes one block (name approved by the owner):

```
:::canvas-snapshot
canvas: parcel-alerts
snapshot: architecture
title: Architecture
![Orders API feeds two queues](architecture.svg)
:::
```

`canvas` and `snapshot` are ids; `title` and the image line are optional. A `title` here is the plan's own caption and wins over the snapshot's name. The image is the fallback: another Markdown viewer shows it, and `SnapshotFigure` shows it when the canvas is not in the `CanvasRegistry`. `snapshotToSvg` makes one from the capture (self-contained, no script, no outside address).

The plan renderer draws the block through the `directiveRenderer` seam of `@plannotator/ui` (`components/blocks/directiveRenderer.ts`; see `packages/ui/README.md`): `createSnapshotDirectiveRenderer` returns the function a host passes to `configurePlannotatorUI`. Neither package imports the other. No product host passes it yet.

**The figure** (`SnapshotFigure`) is `CanvasView` over a small frozen store (`snapshot/frozen.ts`, the twelve most recent kept), so it is text and vector shapes, sharp at any zoom. It has no box of its own and sits on the page's ground, exactly the shape of what it shows and never larger than life. It draws only within 800 px of the screen. Its caption is the snapshot's name, typed in place (`edit-snapshot`); with no name it shows the item count. Behind, the caption adds "Changed on the canvas" and one action, "Update". Naming rule (`defaultSnapshotTitle`): the chosen frame's title; else the title of the one frame everything chosen sits inside; else a single object's own words; else none. Never the first object's words.

**The portal** (`CanvasStage`, `transition.ts`). Clicking a figure mounts the stage, which draws the live canvas clipped to the figure's box with the camera placed so the snapshot's rectangle does not move, then one critically damped spring grows the opening and carries the camera. The plan is never unmounted or scrolled: it stands back a little (`recede`, a host element the stage scales and dims) and is where it was on return. When the snapshot is not current, its capture is drawn over the live canvas on the same camera and dissolves over the first 45% of the motion (`ghostOpacity`), so the person steps through the picture they clicked into the canvas as it is now; going back it forms again, so the opening closes onto what the figure shows. While behind, the open canvas offers "Update snapshot" beside "Back to plan". The spring keeps its velocity when turned round, so closing mid-open is continuous; a person who grabs the board takes the camera at once. Reduced motion: a 140 ms fade, nothing travels.

### Reference cards and link previews

`ReferenceObject` is a card for a web page, one of the person's artifacts, or a place in a plan. What it shows is stored on the object as text and picture addresses. Paste is the way in (`CanvasEditor`: a bare address becomes a web card; `resolvePaste` lets a host claim its own artifact and plan references); an agent adds the same object with `add`.

A web card appears at once with its address and fills in from `linkPreview` (a `LinkPreviewPort`, `model/reference.ts`; the browser side is `routeLinkPreview` in `react/link-preview.ts`). The port is called only for an address a person pasted (`addReference` from the paste handler); an agent's `add` of a web card never causes a fetch, which is how the two are told apart.

`unfurl/fetch.ts` is the real fetcher: Open Graph, Twitter card, title, description, icon; http and https only, five redirects, 6 s, the first 512 KB, a small cache (a failure is not cached), and the bare link whenever a site gives nothing. None of that is shown to the person. Addresses:

- Every host name is resolved (the system resolver by default; `lookup: false` is the explicit opt-out), judged on the address's bytes (`unfurl/address.ts`: IPv4 and IPv6, mapped, NAT64, 6to4, loopback, private, link-local, unique-local, carrier NAT, multicast), and then connected to at the address that was checked (`pin`), on every redirect hop. Under Bun the pin is built in (connect by address, `Host` and TLS server name set); under Node (the Pi server) the host must pass a `pin`, for example an undici agent with `connect.lookup`. Not exercised here: the built-in Bun pin against a real TLS site.
- `allowPrivate` is the host's policy, default false. A local server that one person runs for themselves sets it true, so their own `http://localhost:3000` gets a card; a hosted server leaves it false. With it false, a preview picture or icon that points at a private address is dropped before it reaches a viewer's browser.

`createUnfurlHandler` is a `(Request) => Response`; **only the demo's dev server mounts it** (`demo/vite.config.ts`, with `allowPrivate: true`: while the demo runs, any page in the developer's browser could ask it to GET a loopback address). Making it a product endpoint means mounting it in both the Bun and the Pi server behind the usual guards, a concurrency cap, and a line in the API tables.

### Custom HTML items

`model/html-item.ts` is the contract and the only way `HtmlObject.html` is drawn: an iframe with an empty `sandbox`, a CSP of `default-src 'none'` with inline styles and `data:` pictures, `inert`. No script, no network, no navigation, no access to the page. Do not add a sandbox token or loosen the policy for convenience; a scripted item is an owner decision with its own review.

### Measuring

`bun run --cwd packages/canvas bench` builds the demo, opens it in Chromium and prints each budget with what was measured (`--headed` for a visible window with GPU raster). It is not run in CI. Tests are `*.test.ts` beside the code and run in the unit lanes; `packages/ui/components/blocks/directiveRenderer.seam.test.tsx` is in the DOM list.
