## A thread's canvas (prototype)

Every thread of this computer's Inbox can hold one canvas: a real Excalidraw scene that the person draws on and an agent reads and changes. Prototype grade: local threads only, no linked machines, no phone relay, no approval record yet.

### The window

- **Sketch** opens it, from the thread's header and from the reply box's row (`packages/inbox/canvas/CanvasParts.tsx`). The canvas takes the messages' place in the thread's pane, as the Shape board and the Artifacts view do; on a phone it is a screen of its own and Back says Thread.
- The editor is `@excalidraw/excalidraw`, in the lazy `#canvas-board` chunk (`packages/inbox/canvas/CanvasBoard.tsx`, `lazyParts.tsx` `CanvasBoardPart`). It is never warmed with the window's other parts. A person who never presses Sketch loads none of it. Its stylesheet is imported as text and put in the page when the chunk mounts, because the window's one stylesheet is inlined in the page.
- `build/excalidraw-local.ts` makes Excalidraw run from the Inbox alone: its drawing fonts are packed under `/assets/excalidraw/fonts/` (all but Xiaolai, 12 MB), its CDN fallback address is replaced by that folder, its font subsetter and its picture resizer's WebAssembly are taken out (the window ships none).
- The bar under the canvas sends it with a reply. Nothing selected: the whole canvas (`canvas.png`, `canvas.excalidraw`, and one picture per freehand sketch). Something selected: only that (`canvas-selection.png`, `canvas-selection.excalidraw`). The reply goes through the thread's own Send (`Thread.tsx`, the reply part's `files`, `sketch` and `send`); one that cannot go by itself stays in the reply box and the canvas gives way to it.
- Escape belongs to the drawing while a canvas is open. No keyboard shortcut was added.
- Export and import of `.excalidraw` files are Excalidraw's own menu items.

### What the agent reads

- A reply sent from the canvas stores `sketch` on the message (`InboxReplySketch`: `kind`, `rev`, `things`, `reading`), written by the server from the stored scene (`inbox-canvas.ts` `replySketch`), never by the window. `inboxSketchBlock` (`packages/shared/inbox/uploads.ts`) puts it under the person's words for the wake, the CLI and `read_thread`; the body stays the person's words.
- The reading is one line per thing, each opening with an id (`packages/shared/inbox/canvas/reading.ts`). A thing is what a person would point at: a box with its label is one thing, and freehand strokes within 32 px of each other are one `sketch`, described in words (closed loops, lines, which way a curve opens, where in the sketch) and sent as one picture.

### The `canvas` action

One Inbox tool, `canvas` (`packages/server/inbox-canvas.ts`; `plannotator inbox call canvas '<json>'` prints its text):

- `{thread_id}` reads; `in` one frame; `after` the next page of a cut reading.
- `picture: true | <thing> | [things]` writes a PNG and answers its path. A window draws it (`event: canvas-job`); with no window open the last stored picture is cut to the part and the answer says which revision it shows.
- `do: [...]` with `base` changes the canvas, all or nothing (`packages/shared/inbox/canvas/apply.ts`): `add` (box, ellipse, diamond, note, text, frame, mermaid), `connect`, `set`, `move`, `remove`, `frame`, `replace`. Things are named by id or words; a name that fits two things is refused with both. Mermaid text is converted by an open window with Excalidraw's own `mermaid-to-excalidraw`; with no window open the change is refused.
- **An agent never replaces the person's change unseen.** `do` without `base` is refused. A change to a thing someone else changed after `base` is refused whole, with their change shown and the base to send again. Every answer opens with what others changed since that agent's last look (kept per session in `meta.json`).

### Storage

`inbox/canvas/<thread id>/`: `scene.excalidraw` (Excalidraw's JSON, opens anywhere), `meta.json` (revision, each session's last look, the stored picture's place), `log.jsonl` (one line per revision: who changed which things), `picture.png`, `pictures/` (cut for agents). Files, not the event log (`packages/shared/inbox/canvas/store.ts`). A save that changes nothing a reader would see is not a revision.

The window's save is merged element by element (`changes.ts` `mergeSave`): the higher version wins, the person wins a tie, and an element the window does not name is one it never had.

### Not done

Linked machines, the phone relay, cleanup when a thread is deleted, storage accounting, an approval record, a DOM test for the lazy part's failure, undo of an agent's change.
