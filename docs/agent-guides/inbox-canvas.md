## A thread's canvas (prototype)

Every thread of this computer's Inbox can hold one canvas: a real Excalidraw scene that the person draws on and an agent reads and changes. Prototype grade: local threads only, no linked machines, no phone relay, no approval record yet.

### The window

- **Sketch** opens it, from the thread's header and from the reply box's row (`packages/inbox/canvas/CanvasParts.tsx`). The canvas takes the whole window, as Excalidraw does on its own site: tools across the top, the style panel at the left edge beside the drawing. A Thread button at its top left goes back. On a phone Excalidraw uses its own compact layout.
- The layer is a `<dialog open>` put on `document.body`. Every Inbox key handler leaves a dialog's keys alone (`shortcuts/guards.ts`), so a letter pressed while drawing is Excalidraw's tool and never the thread's Reply or Archive. Escape belongs to the drawing. No keyboard shortcut was added.
- **Marks.** A thread whose canvas holds something carries a dot on its header's pen button and a small pen in its list row; both take the accent colour when an agent changed the canvas since the person last had it on screen (`GET /api/inbox/canvases`, `canvasApi.ts` marks; opening the canvas reads with `look=1`).
- The editor is `@excalidraw/excalidraw`, in the lazy `#canvas-board` chunk (`CanvasBoard.tsx`, `lazyParts.tsx` `CanvasBoardPart`), never warmed with the window's other parts. Its stylesheet is imported as text and put in the page when the chunk mounts; the layer's own few styles are inline, so the window's stylesheet does not grow.
- `build/excalidraw-local.ts` makes Excalidraw run from the Inbox alone: its drawing fonts are packed under `/assets/excalidraw/fonts/` (all but Xiaolai, 12 MB), its CDN fallback address is replaced by that folder, its font subsetter and its picture resizer's WebAssembly are taken out (the window ships none).
- **The bar** under the canvas sends it with a reply. It starts from the words the reply box held (its saved draft), and words left in it go back to the reply box when the canvas closes. Nothing selected: the whole canvas (`canvas.png`, `canvas.excalidraw`, and one picture per freehand sketch). Something selected: only that. The reply goes through the thread's own Send (`Thread.tsx`, the reply part's `files`, `sketch`, `send`, `replace`).
- **After Send** the canvas says it waits for the agent's change. When one lands, each changed thing gets a wash and a pill says who changed what, with Show and **Undo**. Undo takes back that one change (`POST …/canvas/undo`): what it changed is as it was, what it added is gone, what the person did since stays.
- A drag that starts on a frame's empty inside draws a selection box. Excalidraw would drag the frame; for the length of the press the frame under the pointer is locked and then put back, with no version change (`CanvasBoard.tsx` `overFrame`).
- Export and import of `.excalidraw` files are Excalidraw's own menu items.

### What the agent reads

- A reply sent from the canvas stores `sketch` on the message (`InboxReplySketch`: `kind`, `rev`, `things`, `reading`), written by the server from the stored scene (`inbox-canvas.ts` `replySketch`), never by the window. `inboxSketchBlock` (`packages/shared/inbox/uploads.ts`) puts it under the person's words for the wake, the CLI and `read_thread`; the body stays the person's words.
- The reading is one line per thing, each opening with an id (`packages/shared/inbox/canvas/reading.ts`). A thing is what a person would point at: a box with its label is one thing, and freehand strokes within 32 px of each other are one `sketch`, described in words (closed loops, lines, which way a curve opens, where in the sketch) and sent as one picture.

### The `canvas` action

One Inbox tool, `canvas` (`packages/server/inbox-canvas.ts`; `plannotator inbox call canvas '<json>'` prints its text):

- `{thread_id}` reads; `in` one frame; `after_thing` the next page of a cut reading.
- `picture: true | <thing> | [things]` writes a PNG and answers its path. A window draws it (`event: canvas-job`); with no window open the last stored picture is cut to the part and the answer says which revision it shows.
- `do: [...]` with `base` changes the canvas, all or nothing (`packages/shared/inbox/canvas/apply.ts`): `add` (box, ellipse, diamond, note, text, frame, mermaid), `connect`, `set`, `move`, `remove`, `frame`, `replace`. A thing's whole words name it first, then its whole id (8 characters, as the reading prints it; never the start of one); a name that fits two things is refused with both. Mermaid flowcharts and sequence diagrams are converted by an open window with Excalidraw's own `mermaid-to-excalidraw`; other kinds (class, state, ER) come out of that converter as one flat picture and are refused. With no window open the change is refused.
- A loose name (part of a thing's words, any order, a kind word) is taken only when one thing fits and the answer says how it was read; `set`, `remove` and `replace` take only an id or whole words. New things never land on another thing or on a connector's line, and the answer says what the board decided (which side `near` chose, a frame that grew).
- **An agent never replaces the person's change unseen, by construction.** What each session was shown is kept per thing (`told.json`: element id → the revision at which an answer to that session held the thing's line). A change may overwrite, move, remove, replace or frame a thing only as the session was last shown it: no one else changed it after that. What shows a thing: a reading that prints its line, the opening list of changes, a refusal that lists it, the session's own change, and the person's reply from the canvas (shown to everyone, so "work on this" lands on the first try). What does not: a read that is refused, a list that was cut, the `base` sent, `picture`. A refusal shows the things as they are now and the same change then goes through.
- A call that names no session is remembered by nothing and shares nothing with another such call: its `base` must be the current rev, and it is shown what changed since the base it sent.
- Every answer (errors too) opens with what others changed since that session's last answer, edits and removals before additions; a list too long is cut at a whole revision and ends with the call for the rest. The person's Undo of the session's change is said as that. An answer to a change is at most 40 lines.
- `packages/server/inbox-canvas.test.ts` holds one test per way this rule was once broken.

### Storage

`inbox/canvas/<thread id>/`: `scene.excalidraw` (Excalidraw's JSON without pictures' bytes), `files/<file id>.json` (each picture once, kept for as long as the canvas lives, so a save rewrites kilobytes and a picture deleted and brought back still has its file), `told.json`, `meta.json` (revision, each session's last look, the stored picture's place), `log.jsonl` (one line per revision: who changed which things), `picture.png`, `pictures/` (cut for agents, the newest 24), `undo/<rev>.json` (what each agent revision replaced). Files, not the event log (`packages/shared/inbox/canvas/store.ts`). A save that changes nothing a reader would see is not a revision.

The window's save is merged element by element (`changes.ts` `mergeSave`): the higher version wins, the person wins a tie, and an element the window does not name is one it never had.

A deleted thread's canvas folder is moved to `inbox/canvas/.gone/<thread>-<time>` (`retireCanvas`, on the store's deletion signal), where nothing reads it.

### Not done

A close-page save of a scene over 64 KB (browsers cap what a closing page sends; the save made as the tab is put away, compressed, covers most closes), 
Linked machines (the canvas routes are not on the device door's allowlist, `packages/server/inbox-devices.ts`, and the window's canvas calls do not route by machine; uploads already do), the phone relay, storage accounting and a sweep of `.gone`, an approval record, a DOM test for the lazy part's failure, a line for `canvas` in the agent tool's description (no room with thread steps on).
