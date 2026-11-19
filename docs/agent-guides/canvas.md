## The canvas (`packages/canvas`)

Plannotator's own canvas: boxes, notes, text, lines drawn by hand, arrows, frames, groups, pictures, sprites, custom HTML and reference cards on a plain board, with **snapshots** (captures of part of the board) that embed in a plan. It is a package with **no product surface yet**: nothing in the apps imports it. Its only consumer is its own development demo (`bun run --cwd packages/canvas demo`, port 3017). This is separate from Shape (the agent's living board in `guides-and-shared-ui.md`).

The owner's rules for it: any colour on any object, set by a person or an agent; no keyboard shortcuts; no dot grid (a plain ground); an agent hears about changes through a hand-over or comments sent in bulk, not live (the seam is `CanvasStore.since`; neither is built).

### Layers

Each layer imports only the ones above it, and `layers.test.ts` fails on any import that goes the other way: `model` < `events` < `view` < `react` < `snapshot`, with `unfurl` (server-side) importing `model` only. No React in `model/`, `events/` or `view/`, and no document change outside `events/`.

| Folder | What it owns |
|---|---|
| `model/` | The document: plain JSON, typed, versioned (`CANVAS_DOCUMENT_VERSION`, `MIGRATIONS`). `types.ts` (objects, `Snapshot`, `ReferenceTarget`), `codec.ts` (fail-closed `parseDocument` / `checkObject`; unknown fields are dropped), `document.ts` (bounds, arrow geometry, groups), `capture.ts` (taking and comparing a snapshot's capture), `color.ts`, `ink.ts` (a drawn line: its stored form, and making it from points), `html-item.ts` (the sandbox contract), `reference.ts`. |
| `events/` | The only way a document changes. `plan.ts` turns a **command** into **events** after checking it; `reduce.ts` applies events and returns their inverse; `store.ts` (`CanvasStore`) commits an **envelope** and tells its listeners. `wire.ts` checks commands and envelopes that arrive as JSON. `sync.ts` is the collaboration seam. |
| `view/` | Pure screen maths: `shape-outline.ts` (every box shape's outline), `route.ts` + `routes.ts` + `route-path.ts` (the connector router, and the curve of a curved connector), `ink-path.ts` (a drawn line as a path, pen widths), `rough.ts` (the sketch look), `guides.ts` (alignment while dragging), `snapshot-source.ts` (a selection or a region as a snapshot to ask for), `camera.ts`, `spatial-index.ts` (uniform grid), `document-index.ts` (the index kept current from the event stream, one per store), `cull.ts` (render window, level of detail), `hit-test.ts`. |
| `react/` | `CanvasView` (the renderer, read-only) and `CanvasEditor` around it (`gestures.ts`, `editor-state.ts`, `chrome.tsx` with the selection bar, colour and style popovers, `Minimap.tsx`, `people.tsx`, `references.ts`, `pictures.ts`, `picture-look.ts` (how light a loaded picture is, for what lies over it), `plan-drop.ts`, `link-preview.ts`). |
| `snapshot/` | Snapshots: `resolve.ts` (current, behind, detached), `create.ts`, `block.ts` (the Markdown block), `SnapshotFigure`, `frozen.ts`, `CanvasStage` + `transition.ts` (the portal), `picture.ts` (the still fallback), `plan-drop.ts`, `registry.tsx`, `directive.tsx`. |
| `unfurl/` | Link previews, server-side: `address.ts`, `parse.ts`, `fetch.ts`, `route.ts`. |

### Events

`command → planCommand → events → applyEvents → document`, and every commit is an `Envelope` (`id`, `actor`, `origin`, `gesture`, the command, the events). A person's drag and an agent's "add image" are the same commands through the same `dispatch`; the actor is the only difference (`by` on a new object is always the actor's kind).

- **Events are field-level.** `object-added` and `object-removed` carry or name a whole object; every change to one is `object-set { id, set, unset }` naming only the fields that changed (`setEvent`, `events/reduce.ts`). The planner still builds and checks the whole next object (`checkObject`, `move` included, so nothing it makes fails to save and load), then emits the difference. This was whole-object events until the review; it was changed before any document or log existed because it decides undo, sync and the size of a hand-over.
- **Drawing order is a key on each object** (`z`, `model/order-key.ts`), not a position in a list. A key never ends in `0`, so there is always a key between any two. A reorder is `object-set { z }` on the objects moved, so two people reordering different things at once both keep what they did. `doc.order` is worked out from the keys by the reducer and is not saved. The planner gives a new object a key on top.
- **Undo and redo** are the inverse events, committed as an ordinary envelope. Because they are field-level, undoing a move restores `x` and `y` and leaves alone what an agent or a peer did to the same object since. Only the local person's commands go on the stack. Commands sharing a `gesture` id are one step (a drag; one pick in the colour well). `dispatch(…, { gesture, amend: true })` folds a late change into that gesture's step wherever it now is and leaves redo alone (a link's preview arriving).
- **The log** keeps one entry per gesture (`foldEnvelope`), so a hand-over reads a drag as one `move` with the whole distance.
- **Agents** send JSON through `decodeCommand` and receive envelopes from `onCommit`. For a hand-over they keep `store.cursor()` and later ask `store.since(cursor)`. A cursor names the store (`epoch`) as well as the place, because commit numbers start again with every store; a cursor from another store, ahead of this one, older than the log, or taken in the middle of a gesture answers `{ kind: 'resync', document }`, never "nothing changed".
- **Sync** (seam only; no backend): `SyncPort` + `connectSync` (`events/sync.ts`). The backend's whole job is one order of envelopes, delivered to every peer including the sender. Each store applies them in that order to the document all peers agree on and shows its own unconfirmed changes on top (`CanvasStore.receive`), so peers converge: different fields of one object both survive, the same field ends on the one ordered last. `connectSync` decodes every envelope (`decodeEnvelope`); the reducer checks each changed object (`applyEvents(…, { check: true })`). Presence would travel beside the port.
- **Comments** (not built) will anchor with `CanvasAnchor`.

**Untrusted ids and references.** Every `objects` and `snapshots` map has no prototype (`idMap`, `model/document.ts`; made by `createDocument`, the reducer, the codec and `CanvasStore`'s constructor), so `doc.objects[id]` is the stored value or undefined even for `constructor`. An arrow's end sticks to a placed object or to a group the arrow is not inside (`bindingFault`); a group is never inside itself (`groupCycle`). The planner and `parseDocument` refuse anything else, the reducer drops a peer's event that would break it, and `resolveArrow` measures a group by its placed members only, so it cannot recurse whatever a document holds. `hostile.test.ts` covers each door.

Add a new object type in `model/types.ts`, `checkObject`, `PATCH_FIELDS` (`events/plan.ts`), `ObjectView` and `snapshot/picture.ts`; the compiler's exhaustive switches name the rest. Add a field to a type in `model/types.ts`, `checkObject` and `PATCH_FIELDS`: no event changes.

### The look ("Default")

The owner picked one look (the designer's "Default"): typed shapes and right-angled connectors for the diagram, paper and depth for what people add, and a sketch style on single objects that means "proposed, not decided". The values are closed lists, checked in `checkObject`; an agent never has to set any of them to get a good board.

| Field | Values | Notes |
|---|---|---|
| `shape` (box) | `process` (absent), `decision`, `database`, `document`, `queue`, `actor`, `cloud`, `pill`, `container` | `lanes: string[]` on a container |
| `routing` (arrow) | `elbow` (absent), `straight`, `curve` | `curve`: one arc, see Connectors |
| `size` (text) | `small`, `medium` (absent), `large`, `title`, `display` | 12.5, 15, 22, 40 and 84 units (`TEXT_SIZE_PX`) |
| `face` (text) | `sans` (absent, never stored), `serif`, `mono`, `hand` | no font is bundled |
| `pen` (ink) | `fine`, `marker` (absent, never stored), `highlighter` | 2, 4.5 and 18 units wide (`PEN_WIDTH`) |
| `style.look` | `sketch` | boxes and arrows |
| `style.fill` | `tint`, `solid`, `hachure`, `cross`, `none` | hachure and cross draw in sketch only |
| `style.rough`, `style.seed` | 0, 1, 2; an integer | sketch only; the seed defaults to a hash of the id |
| `style.dash` | `true` | arrows and shape outlines |
| `style.fromSide`, `style.toSide` | `n`, `e`, `s`, `w` | arrows; absent: the sides that face each other |
| `style.labelAt` | 0 to 1 | arrows |
| `style.ends` | `arrow` (absent), `none`, `dot`, `bar`, `bar-arrow` | arrows |
| `stamp` (type) | `kind`: `check`, `thumb`, `ask`; `count` | |
| `by` | `{ kind, id }` | set by the planner from the actor; a host maps it to a face with `PeopleProvider` |

Sizes have defaults per type and shape (`DEFAULT_SIZES`), so `add` may leave `w` and `h` out. A heading (text in the `title` or `display` size) with no size gets a box worked out from its words (`headingSize`, `events/plan.ts`), so `{ type: 'text', text, size: 'display' }` arrives on one line. No migration entry was written for any of this: no saved document exists yet (`MIGRATIONS` is ready for the first).

- **Shapes** (`view/shape-outline.ts`): one function gives each shape's outline as segments. The board draws it as a small inline SVG under the box's own HTML words; the sketch renderer feeds the same segments to the rough generator; the still picture of a snapshot draws them too. A plain `process` box stays a CSS box.
- **Connectors** (`view/route.ts`, `view/routes.ts`): an `elbow` connector is routed at right angles round what is in the way by A* over a sparse grid (a line at each side of every nearby obstacle, grown by a clearance, and at each end's stub), with a cost per bend; the same input gives the same route. Frames and containers hold things and are not obstacles; a boxed-in end still gets the plain line. Each end leaves by the side facing the other (kept across small moves), and connectors sharing a side are spread along it in the order their lines go. `Router` (one per store, `routesFor`) keeps every route and, on a commit, marks stale only the connectors stuck to what changed, those sharing a side with them, and those whose line passes where the object was or is. Stale routes are worked out as they are drawn within `ROUTE_BUDGET_MS` a frame; the rest wait a frame with their last shape. Drawn (`view/route-path.ts`) with rounded elbows, an arc where a later line hops over an earlier one (found among the lines on screen), the label on the line, and typed ends. Far out, connectors are straight lines. The still picture of a snapshot draws connectors straight.
- **Curved connectors** (`curveControl` in `model/document.ts`, `curveRoute` in `view/route-path.ts`): `routing: 'curve'` is one quadratic arc between the two ends, bowing to the left of the way it runs by 16% of its length (90 units at most). The same every time; two connectors between one pair, one each way, part. The label, the ends' angles, the pointer, the arrow's bounds (so culling and captures) and the still picture all use that curve. It is not routed: it goes through whatever lies between, and `fromSide` / `toSide` are ignored. A loop back to the same object keeps the loop's shape. The style popover does not offer it yet (new editor UI): an agent sets it.
- **Sketch** (`view/rough.ts`): strokes and hatching are generated from a seed as path strings and kept by what they were made from (seed, shape, size, fill, roughness), so a move reuses them and a pan or zoom costs nothing. Never an SVG filter. Words in a sketched shape use `--pcv-hand`, the device's own handwriting face: no font is bundled.
- **Surfaces**: notes are paper with a tilt worked out from the note's id and place (not stored) and lift while carried; frames are soft panels with the title on a chip that grows as the board shrinks (a rule in the view's own small stylesheet, rewritten when its step changes; not an inherited custom property, which restyled every object); pictures have captions; faces show who added something.
- **Depth costs frames**, so shadows are drawn only at full detail on a board that is not crowded (`data-crowded`: over 500 mounted objects). Far out with more than 4,000 objects mounted each object is one flat element (`FlatView`) and bare text is not drawn; not below that, because swapping markup as the zoom crosses a detail level costs a long frame. Hatching is dropped a level earlier than text.
- **Words** (`TextObject`): five sizes and four faces, closed lists. `title` and `display` are the words a board is read by from far off: at the lowest detail (`data-lod='far'`), where every other word is hidden, they and frame titles stay drawn, also on a board so crowded that objects are flat patches. Faces are lists of fonts a device is likely to have (`--pcv-serif`, `--pcv-mono`, `--pcv-hand`), so they differ between devices.
- **Lines drawn by hand** (`InkObject`, `model/ink.ts`): `{ type: 'ink', x, y, w, h, points, pen?, color? }`. `points` is x then y for each point, each from 0 to 1 across the object's own box, 2 to 1,000 points (`LIMITS.inkPoints`). So `move` changes `x` and `y`, `resize` changes `w` and `h`, and the points are never rewritten or copied: no new command or event. `strokeFromPoints(points)` makes the stored form from points in board coordinates (it simplifies, bounds its own work and drops what is not a number): it is what a pen tool will call, and what an agent with a line in board coordinates calls. Drawn as one SVG path with smooth joins, cached by the points list (`view/ink-path.ts`). Grabbed along the line, as wide as its pen, so a ring does not take clicks from what it circles; a marquee takes it by its box. Not an obstacle for connectors, no ports, a line (not a patch) on the map. **There is no pen tool yet**: a person can move, resize, recolour and delete a line but cannot draw one.
- **Editor**: alignment guides with the distance between the two things and a soft snap while dragging (`view/guides.ts`); a port at the middle of each side of the selected shape, from which a connector is drawn; the selection's bar (colour, style, group, open, delete, Add to plan) with a colour popover (six named, six more, any colour typed or picked) and a style popover; the map (`Minimap`, its own small canvas, never a layer over the board).

### Renderer

DOM, with one SVG layer for arrows. Reasons are in the header of `react/CanvasView.tsx`: text is the content (the browser shapes, wraps and exposes it), pictures and sandboxed iframes are elements already, and theming is CSS variables. What keeps it fast: the camera is one CSS transform written outside React; only objects in the render window are mounted (`view/cull.ts`); objects are placed with `transform`; zoomed out, CSS draws less (`data-lod`).

Do **not** put `will-change: transform` on `.pcv-world`: measured, a promoted layer is rastered at full scale and 2,000 objects at 12% zoom pan at 10 fps instead of the display rate. Do not set a CSS variable on the root per frame either (every object inherits it and restyles): the zoom goes to `.pcv-overlay` only.

Styles are plain CSS in `canvas.css` under the `pcv-` prefix, so a host needs no Tailwind `@source` for this package. Colours fall back from the host theme's variables.

### Snapshots

A snapshot is a **materialized view**: a capture of part of the canvas taken at one moment (the owner's direction: "like a materialized view … this one time snapshot … somebody should be able to update the materialization"). Editing the canvas afterwards does not change it.

- **What is stored.** `Snapshot` (`model/types.ts`) is `id`, `title`, `source` (a frame by id, a set of objects, or a rectangle) and `capture`: the rectangle and a frozen copy of the objects it showed, back to front. It lives in the canvas document, so a plan's block stays two ids and one snapshot can appear any number of times.
- **Who takes it.** Only the planner, with `captureOf` (`model/capture.ts`): on `add-snapshot`, on `edit-snapshot` with a new source, and on `update-snapshot`. A capture sent with a command is ignored, so a person and an agent make and update snapshots the same way and neither can forge one. The new capture travels in the `snapshot-put` event, so undo, redo and a peer all get it.
- **What it costs.** The document never mutates an object, so a capture holds the canvas's own objects, not copies, until one of them is edited. Fifty snapshots of an unchanged canvas are fifty small arrays. An arrow with an end stuck to something outside the capture gets that end fixed in place (one small copy), and group membership is dropped, so a capture draws by itself. Not done: a shared table for large `data:` pictures, which are written once per capture when the document is saved.
- **Behind.** `snapshotStanding` (`snapshot/resolve.ts`) captures the source again and compares (`capturesEqual`, by reference first). No clock or counter is kept, so it is right across peers and after an undo, and it means exactly "taking it again would look different": for a set of objects, one of them changed or was deleted; for a frame, the frame or anything wholly inside it changed, arrived or left; for a region, anything in the rectangle did. A frame's capture is the frame and what is wholly inside it (a neighbour that overlaps the edge is not drawn in slices), and its rectangle leaves the title strip out, because the caption says the name. Changing something back makes it `current` again. When the source is gone (the frame, or every chosen object) it is `detached`: the capture is all that is left, it stays, and `update-snapshot` is refused. Only a figure that is drawing asks; `behindSnapshots` answers for a whole plan ("update all": dispatch the updates with one `gesture` id for one undo step).

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

**The figure** (`SnapshotFigure`) is `CanvasView` over a small frozen store (`snapshot/frozen.ts`, the twelve most recent kept), so it is text and vector shapes, sharp at any zoom. It has no box of its own and sits on the page's ground, exactly the shape of what it shows and never larger than life. It draws only within 1,400 px of the screen, measured against the pane the plan scrolls in (`scrollRootOf`), not the window. It always draws in full detail: detail is reduced only for a view holding more than 150 objects (`lodFor`, `view/cull.ts`), never because a view is small. Its caption is the snapshot's name, typed in place (`edit-snapshot`); with no name it shows the item count. Behind, the caption adds "Changed on the canvas" and one action, "Update". The open button carries a spoken description made from the capture's words (`describeCapture`). Naming rule: `defaultSnapshotTitle` in `view/snapshot-source.ts`.

**The portal** (`CanvasStage`, `transition.ts`). Clicking a figure mounts the stage, which draws the live canvas clipped to the figure's box with the camera placed so the snapshot's rectangle does not move, then one critically damped spring (about 0.4 s to nine-tenths) grows the opening and carries the camera.

- The plan is never unmounted or scrolled. It stands back with depth: smaller, softer and dimmer, eased early (`recede`, a host element; `recedeAt`), and is exactly where it was on return.
- The opening keeps the figure's corner radius, easing to square as it reaches the window, with a fine line and a soft shadow that fade as it lands (`rimOpacity`).
- The snapshot's capture is always drawn over the live canvas on the same camera and dissolves between 10% and 62% of the way (`ghostOpacity`). It holds only what the figure shows, so the rest of the board arrives around the picture instead of being cut by the opening's edge, and a capture the canvas has moved on from becomes the canvas as it is now with no swap. Going back it forms again, so the opening closes onto what the figure shows.
- While behind, the open canvas offers "Update snapshot" beside "Back to plan".
- It is a dialog: everything else in the body is `inert` while it is open (which is also the focus trap), focus goes to "Back to plan" (first in the Tab order) and returns to the figure, and Escape leaves (first the words being typed, then the canvas).
- The spring keeps its velocity when turned round, so closing mid-open is continuous; a person who grabs the board takes the camera at once (a wheel still spinning from before the click does not count for 150 ms). Reduced motion: a 140 ms fade, nothing travels.

A host should open from a plan that fills its pane. The demo's "Side by side" view exists for dragging a snapshot into the plan; while the stage is open its side pane stands down so one canvas is on screen.

**Keyboard reach, not shortcuts** (the owner's ruling: these are accessibility basics). In an editor, Tab lands on one object, then walks objects in reading order (`view/reading-order.ts`): from an object to its selection bar, from the bar's last control to the next object. Enter on an object starts typing in it, or opens a card; Escape ends typing. No other keys do anything.

### Reference cards and link previews

`ReferenceObject` is a card for a web page, one of the person's artifacts, or a place in a plan. What it shows is stored on the object as text and picture addresses. Paste is the way in (`CanvasEditor`: a bare address becomes a web card; `resolvePaste` lets a host claim its own artifact and plan references); an agent adds the same object with `add`.

A web card appears at once with its address and fills in from `linkPreview` (a `LinkPreviewPort`, `model/reference.ts`; the browser side is `routeLinkPreview` in `react/link-preview.ts`). The port is called only for an address a person pasted (`addReference` from the paste handler); an agent's `add` of a web card never causes a fetch, which is how the two are told apart.

`unfurl/fetch.ts` is the real fetcher: Open Graph, Twitter card, title, description, icon; http and https only, five redirects, 6 s, the first 512 KB, a small cache (a failure is not cached), and the bare link whenever a site gives nothing. None of that is shown to the person. Addresses:

- Every host name is resolved (the system resolver by default; `lookup: false` is the explicit opt-out), judged on the address's bytes (`unfurl/address.ts`: IPv4 and IPv6, mapped, NAT64, 6to4, loopback, private, link-local, unique-local, carrier NAT, multicast), and then connected to at the address that was checked (`pin`), on every redirect hop. Under Bun the pin is built in (connect by address, `Host` and TLS server name set); under Node (the Pi server) the host must pass a `pin`, for example an undici agent with `connect.lookup`. Not exercised here: the built-in Bun pin against a real TLS site.
- `allowPrivate` is the host's policy, default false. A local server that one person runs for themselves sets it true, so their own `http://localhost:3000` gets a card; a hosted server leaves it false. With it false, a preview picture or icon that points at a private address is dropped before it reaches a viewer's browser.

`createUnfurlHandler` is a `(Request) => Response`; **only the demo's dev server mounts it** (`demo/vite.config.ts`, with `allowPrivate: true`: while the demo runs, any page in the developer's browser could ask it to GET a loopback address). Making it a product endpoint means mounting it in both the Bun and the Pi server behind the usual guards, a concurrency cap, and a line in the API tables.

### Pictures and the asset port

A document, an event and a plan's text never hold a picture's bytes: no `data:` URL, no `blob:` URL (`isPictureRef`, `model/assets.ts`; `checkObject` refuses them). An image, a sprite, a card's picture and icon hold a reference: `asset:<name>`, an http(s) address, or a relative path. The host keeps the bytes behind an `AssetPort` (`put(file) → { ref } | { refused }`, `url(ref)`); the name is best a content hash (`asset:sha256-…`), which is how the Inbox already stores attachments. `pictureResolver(assets, other)` is the one function a view needs (`resolveImageSrc`). `createMemoryAssets` (`react/memory-assets.ts`) is the demo's and the tests' port; nothing in the product implements one yet.

Pasting or picking a picture (`react/pictures.ts`): the file is decoded (anything the browser can decode; a kind it cannot show from a file, such as bmp, is redrawn as PNG), handed to the port, and an image object with the reference is added. Each way that can fail shows a line in the editor (`CANVAS_STRINGS.pictureProblems`): no port, over 25 MB, unreadable (tiff and heic where the system cannot decode them), or the host could not save it. Never silently.

The still fallback of a snapshot (`snapshotToSvg`) is stored by the host as a file or an asset and the plan block names that address. Never write the SVG, or a `data:` URL of it, into the plan: a plan is agent context.

Every `<img>` the package draws has `referrerPolicy="no-referrer"`. A relative `src` is a same-origin request chosen by whoever wrote the object, so a product host passes a resolver that confines it to its artifact route.

### Colour

Any object takes a named colour (the canvas's six, which follow the theme) or any CSS colour: hex, a CSS colour name, `rgb()`, `hsl()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`, `color()`. `isCustomColor` (`model/color.ts`) is a closed grammar: nothing that can load, run or end a declaration passes. Any colour stays readable without limiting the choice: `canvas.css` ("Colours") takes the ink for a solid custom fill, and the shade a custom line or text is drawn in on the board, from the colour's own lightness with CSS relative colour syntax (a browser without it draws the colour as chosen).

**A drawn line follows the same rule** (decided when ink was added; the exploration drew a custom ink colour exactly as chosen). On the board, a custom ink colour is the line colour every other custom line gets: kept dark enough on a light board and light enough on a dark one. The reason: the board under a line differs between the two themes, and a black ring must not vanish for the person on the dark theme. The exception is the next paragraph, which is where "exactly as chosen" is right.

**Over a picture** (`react/picture-look.ts`, `data-ground`). Bare text or a drawn line with half or more of its box on a picture, and a connector with both ends on one picture, is read against the picture, which is the same in both themes, not against the board. A custom colour is then drawn exactly as chosen (a yellow highlighter over a screenshot stays yellow). With no colour or a named one, ink and line colours are the light-ground or the dark-ground set (`--pcv-*-l`, `--pcv-*-d`), chosen by how light the picture is under the mark: a 24 by 24 copy of each loaded picture is looked at once, and light means a relative luminance above 0.18, the same line as ink on a solid fill. A connector's label gets a halo to match. A picture from another site that cannot be read back gives no answer: there, named and uncoloured marks follow the board's theme as before. Notes, boxes and stamps carry their own ground and do not change.

**Who added it** (`PersonLabel.color`, `react/people.tsx`). A person's mark is a quiet neutral that follows the theme unless the host's `PeopleProvider` gives that person a colour: any colour `isCustomColor` takes, anything else ignored, drawn exactly with white or black ink by its lightness. No fixed hue is in the stylesheet.

### Custom HTML items

`model/html-item.ts` is the contract and the only way `HtmlObject.html` is drawn (`alt` on the object is its text alternative, since the frame is inert): an iframe with an empty `sandbox`, a CSP of `default-src 'none'` with inline styles and `data:` pictures, `inert`. No script, no network, no navigation, no access to the page. Do not add a sandbox token or loosen the policy for convenience; a scripted item is an owner decision with its own review.

### Worst-case data

`demo/worst.ts` is the regression fixture for input at its limits: the longest words, every script, colours with no contrast or no opacity, pictures that fail, shapes at their smallest and largest. `demo/marks.ts` (`?data=marks`) is the same for words, drawn lines, curves and colour: every size and face, ink on the board and over a pale and a dark picture, custom-colour notes, solid plain boxes, and a crowd of more than 150 objects. Open the demo with `?data=worst` (also `marks`, `empty`, `one`, `huge`, `max`, `stacked`, `far`; add `&view=canvas` or `&view=split`, `&theme=dark`). In `bun run demo` a switch at the bottom of the page changes the set. When a rule below changes, look at this board in both themes before and after.

What holds, and where:

- **What saves, loads.** Removing a group lets go of whatever is still in it (the reducer, so it holds for a peer's change and for an undo). A change names only fields an object can have (`OBJECT_FIELDS`): `__proto__` and the like are dropped at the wire and never assigned. A snapshot's rectangle, asked for or captured, has one bound (`readArea` in `model/codec.ts`, `LIMITS.area`): anywhere objects can be, as large as all of them. `hostile.test.ts` saves and loads a board at its limits.
- **Words that do not fit are cut at the end, with an ellipsis.** A box's title wraps to the lines its box has room for, three at most (`titleLines` sets `--pcv-lines`); its detail is one line; a lane's name is as long as its lane is tall; a frame's title is one line. A box title, a frame title and an arrow label that were cut show all of themselves on hover (`title`), and are whole in the object's accessible name. An arrow label is 40 characters at most and fewer on a short line (`shortLabel`). A card's file name is cut in the middle (`shortName`). Text objects grow to fit when typing ends.
- **Any colour, always readable.** Ink on a solid fill is white or black by the fill's relative luminance against 0.18, where both pass 4.5 to 1 (`--pcv-on-solid` in `canvas.css`); a see-through colour is weighed with the board behind it (`--pcv-ground-y`). Lines and ink are always opaque. A note in a custom colour is that colour exactly; a plain box takes `style.fill` (`solid`, `none`) and `style.dash` like any shape.
- **An arrow from an object to itself is a loop** (`selfLoop` in `model/document.ts`), for the board, the still picture and hit-testing.
- **A figure can always be seen and pressed**: never smaller than `FIGURE_MIN` (`figureBox`), and never at the wordless lowest detail (`wordsAlways` on `CanvasView`), except that a view of more than 4,000 objects is flat patches.
- **A drop never leaves the page.** The editor takes every drop: a picture is added through the asset port, a link becomes a card, anything else gets a line.
- **Pictures.** One with see-through parts gets a light ground on a dark board (looked at once per address; a picture from another site cannot be looked at and is left alone). With reduced motion every picture that could be animated is its first frame, drawn into a canvas. A sprite whose sheet does not load shows its words.
- **An HTML item with more than its box shows** fades out at its foot. The item runs no script, so the fade is CSS tied to a scroll timeline: browsers without `animation-timeline` show no fade.
- **A link being looked up** dims its title until the answer or the timeout (`previewsPending`, not part of the document).
- **"Fit" uses the room a view has** (`fitPadding`, `view/camera.ts`): 72 px above and below, which clears the editor's bars; at the sides a twentieth of the width, 72 px at most and 12 at least. A 1440 px view is as it was; a 390 px phone keeps 20 px a side instead of 72, so a wide board is drawn about 1.4 times as large. A board much wider than a phone is still small when all of it is in view.
- **An empty board** shows one line; **a board wider than the furthest zoom** (5%) shows a mark on each edge with more beyond it, which goes to the nearest thing that way (`EdgeMarkers`).
- **Opening a snapshot of more than 1,500 objects** does not draw the capture a second time over the canvas (`GHOST_MAX_OBJECTS`).

### Known limits

What is known not to hold yet. Read this before putting the canvas in front of anyone.

Measured (headed benchmark, `bun run --cwd packages/canvas bench --headed`):

- Three rows are not met. A figure on screen with nothing drawn yet while scrolling at 12,000 px/s: 1 of 480 frames. Zooming through every level of detail with a third of the shapes sketched: worst frame 58 ms. Panning 10,000 objects with all of them mounted: worst frame 158 ms.
- Opening a snapshot of a 10,000-object board has a 248 ms worst frame.
- A figure of more than 4,000 objects draws flat patches with no words (the one exception to "a figure always has its words").

Not drawn:

- The still picture of a snapshot (`snapshotToSvg`) draws elbow connectors straight (a curve is drawn as its curve), sketched shapes clean, a plain box's solid fill as a tint, and marks over a picture in the board palette (it draws a picture as its words in a box).
- Curved connectors are not routed round anything, ignore `fromSide` and `toSide`, and two between one pair in the same direction lie on each other.
- There is no pen tool and no "curved" choice in the style popover: only an agent (or a fixture) makes a drawn line or a curved connector.
- Marks over a picture from another site that cannot be read back follow the board's theme (custom colours are still exact). A connector with only its label over a picture is not noticed.
- On a board so crowded that objects are flat patches (over 4,000 mounted, far out), drawn lines are still drawn in full.
- The fade at the foot of an HTML item that holds more than its box shows depends on `animation-timeline`: a browser without it shows no fade.

Not checked:

- WebKit, Firefox and phones. Everything was looked at and measured in Chromium on a desktop (a 390 px wide window stands in for a phone).
- The serif, mono and handwriting faces on Windows, Android and Linux: only macOS was looked at.
- `strokeFromPoints` with a real hand on a real pointer: tested with made-up points.
- The TLS pin in `unfurl/fetch.ts` has not been tried against a real site.

For whichever product wires the canvas in:

- **SVG assets must be served sandboxed.** A pasted SVG is stored as it is. Inside `<img>` it is inert; opened by itself (open image in new tab) it would run script in the asset route's origin. The product's `AssetPort` must serve SVG with `Content-Security-Policy: sandbox` (or as an attachment, or redraw it as PNG).
- **Unfurl pinning only holds under Bun**, and only when no `fetch` is passed. Under Node, or with a custom `fetch`, the request goes by name after the check, so a name that answers with a public address when checked and a private one when connected gets past `allowPrivate: false`.
- **Sync** trusts the `actor` and `by` a peer sends, and remembers the last 5,000 envelope ids: a backend must stamp the actor itself and must not redeliver from further back than that.

### Measuring

`bun run --cwd packages/canvas bench` builds the demo, opens it in Chromium and prints each budget with what was measured, as it goes (`--headed` for a visible window with GPU raster: use that run as the evidence; headless numbers are flattered by its software frame clock). It is not run in CI. Budgets are stated at 60 fps whatever the display. Besides frame times it measures what a frame rate cannot show: frames in which a figure is on screen with nothing drawn yet, heap and DOM nodes over scroll passes and over 50 open/close cycles, that the plan is where it was after coming back, a drag on the real pointer path at 100%, a board with pictures, HTML items, cards and long notes, the canvas being edited behind 50 figures, 10,000 objects, and the `will-change` finding above (with and without).

`LIMITS.objects` is 10,000 because that is what has been measured: at 10,000 a pan with the whole board in view still drops frames (every object is mounted at that zoom, each as one flat element), while work at 100% holds. The benchmark also has rows for 2,000 typed shapes with 1,500 routed connectors and for a board where a third of the shapes are sketched.

Tests are `*.test.ts` beside the code and run in the unit lanes; `hostile.test.ts` and `layers.test.ts` sit at the package root. Two are DOM tests listed in `tests/dom-test-list.txt`: `packages/ui/components/blocks/directiveRenderer.seam.test.tsx` and `packages/canvas/snapshot/CanvasStage.dom.test.tsx` (opening a figure and coming back leaves the plan where it was).
