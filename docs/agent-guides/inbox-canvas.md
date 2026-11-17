## Inbox: the thread canvas

Every thread gets a canvas: a whiteboard beside the conversation. The agent draws on it (wireframes, flows, a picture with notes) by writing a small HTML board; the person moves and resizes what the agent drew, draws, types and pastes pictures, and the agent reads back what they did. The whiteboard is Excalidraw (MIT, `@excalidraw/excalidraw` 0.18). The canvas is its own surface behind its own switch; it does not touch Shape.

Slice 1 is hidden: nothing of it shows, and no agent reads of it, unless config.json `inboxCanvas` is `true`.

### The switch

- config.json `inboxCanvas` (`true` / `false`, unset is off): `canvasOn()` / `setCanvasSwitch()` in `packages/shared/canvas/switch.ts`, read on every request. Config only: no Settings row, no menu item, no help line.
- Off: every `/api/canvas` path is the Inbox's unknown-route `404`; `GET /api/inbox/settings` has no `canvas` key (on, `canvas: { on: true }`); no `event: canvas` frame is sent; the Inbox tool's instructions and `read_thread` are unchanged; `plannotator canvas` answers as an unknown command and `plannotator --help` never names it. A thread shows no button, card or chip, and an address with `&canvas` opens the thread alone.
- `packages/server/canvas-capability.test.ts` and `apps/hook/server/canvas-command.test.ts` hold this.

### The pieces

| Piece | Where | What it does |
| --- | --- | --- |
| Board rules | `packages/core/canvas-board.ts` | Parse and check the agent's board HTML, apply patch lines, keep the person's pins and deletions, the CLI's replies. Browser-safe, no I/O. |
| Scene logic | `packages/core/canvas-scene.ts` | Which parts the person moved, resized, reworded or deleted (`changedParts`, `standingAfter`), and the read-back lines (`readBackLines`). |
| Agent text | `packages/core/canvas-skill.ts` | `CANVAS_HELP`, `CANVAS_GUIDE` (the `--help` text), `CANVAS_INSTRUCTIONS_LINE`, `canvasChangedLine`, `canvasMarksBlock`. |
| Store | `packages/shared/canvas/store.ts` | One folder per thread, versions, the base-rev check, pending layouts, pictures. |
| Routes | `packages/server/canvas-capability.ts` | The capability on the Inbox's seam (`packages/server/inbox-capability.ts`): `/api/canvas`, the settings wire, `event: canvas`, the instruction and `read_thread` lines. Bun only (the Inbox has no Pi server). |
| CLI | `apps/hook/server/canvas-command.ts` | `plannotator canvas`: writes the store directly. |
| Whiteboard | `packages/ui/components/canvas/CanvasBoard.tsx` | Excalidraw under a quiet dock; host-neutral, so a space page can mount it next. |
| Lift | `packages/ui/components/canvas/lift.ts` | Lays the board out in a hidden box and turns it into Excalidraw elements. |
| Window | `packages/inbox/canvas/` | The pane beside the thread, autosave, the background layout, the card, the reply chip. |

### Where the layout runs

Only a browser engine lays HTML out (real fonts, wrapping, flex), so the Inbox window does it, never the server or the CLI.

- An agent's write is stored as a new version with its layout `pending`, and the server sends `event: canvas`.
- Every Inbox window open on this computer, while the switch is on, lays out each pending version in the background, whether or not its canvas is open (`layOutPending` in `packages/inbox/canvas/layout.ts`, run on every `event: canvas` by `canvasFrameArrived` in `frames.ts`; the server sends one as a window's stream starts, so a new or reconnected window looks at once, and a window with the switch off never loads the module). It fetches `GET /api/canvas/pending`, runs the lift, and posts the elements, the warnings and the parts. The first window to answer wins; a later one is refused as stale and drops its answer. The window then draws the version's picture (the message card, `read --png`).
- The server writes `canvases/.windows.json` (how many windows can lay out, and its pid). The CLI waits up to 20 s for the layout only when a window is open, then prints the layout's warnings or `layout: no problems found.`
- No window open: the version is saved, the CLI says `layout: not checked yet` and returns at once, and the layout runs when a window next opens.
- A phone or a linked device never lays out: only a local window gets the frames (`streamInboxCapabilities`).

The lift keeps ids: a part's main element has the agent's id, its other elements `id~…`, and every element carries `customData.part`. A container becomes an Excalidraw group named by its id. A part the person pinned (moved or resized) leaves the flow: a blank box of its laid-out size holds its place, so the pinned size never moves the parts around it, and the part goes where the person left it.

### The store

`<data dir>/canvases/<thread id>/`:

- `canvas.json` (written atomically): the board HTML (the source of truth for the agent's parts), the scene (Excalidraw elements), the person's standing (pins, deletions), the parts the latest layout made, the scene as that layout left it (for read-back), the layout's state and warnings, and `rev`.
- `versions/<n>.json`: every version, the agent's and the person's. A person's saves between two agent versions are one version, rewritten as they draw.
- `files/`: pictures the board names (copied in) and pictures the person pasted. Only PNG, JPEG, GIF and WebP by their bytes (never SVG), at most 10 MB.
- `canvas.png`, `versions/<n>.png`: pictures the window makes.

Every change holds the folder's lock (`packages/shared/store-files.ts`), since the CLI and the server both write. A person's save names the `rev` it started from; a stale one is refused (`409`) and the window reloads.

### The agent's side

`plannotator canvas --thread <id> --file board.html` writes the whole board; `--patch -` applies patch lines from stdin (all or none); `read` lists what the person changed since the agent's latest version, `read --html` prints the board with its ids (deleted parts as comments), `read --png` prints the path of a picture. `--help` prints `CANVAS_HELP` and `CANVAS_GUIDE`.

- The person's pins hold: a patch never moves a pinned part, and a size it sets on one replaces the person's size with a note saying so. A part the person deleted cannot come back by id.
- While on, the Inbox tool's instructions carry `CANVAS_INSTRUCTIONS_LINE`, and `read_thread` adds `canvasChangedLine` while the person has changed the canvas since the agent's latest version.
- Agent text was checked clean-room (a fresh agent with only the text, in a scratch folder, given a real task).

### The window

- The thread header's brush button opens the canvas beside the thread (address `&canvas`); it takes an open file's place and the thread column narrows. Side by side or full screen (`&canvas=full`); on a phone it is a page of its own with a back button.
- Full screen: the floating reply box owns the bottom, so the dock moves to the top centre.
- The dock holds every Excalidraw drawing tool (lock, hand, select, rectangle, diamond, ellipse, arrow, line, pen, text, picture, eraser, frame, laser) and Export as an image. Left out: Excalidraw's menu (open, save, collaboration, its theme switch), the shape library, embeds and links.
- Keys: Excalidraw's one-key tools work only while focus is in the canvas (`handleKeyboardGlobally` off), and the canvas stops key events from reaching the Inbox's shortcuts. No Inbox-wide shortcut is added (`packages/inbox/canvas/canvasKeys.test.tsx`).
- Autosave 500 ms after a change, with the base rev. The canvas follows the Inbox theme (Excalidraw's dark mode).
- A blank canvas opens ready to draw with the pen. When the agent's version lands, the canvas updates in place and one quiet line says "<agent> changed N parts just now", with Show to flash them.
- An agent message that wrote a version carries a preview card (Showing / Open). An older version opens read-only (`&cv=N`) with "Version n of m · Back to now".
- The reply box carries a "Canvas marks N" chip while the person has changed the canvas since the agent's latest version; the marks go into the reply (`canvasMarksBlock`). Removing the chip keeps them out (this browser); once a reply of the person's carries the same marks, the chip is gone on every device.
- Excalidraw loads lazily, only when a canvas opens. Its fonts are packed into the Inbox page (`build/excalidraw-assets.ts`), and its CDN fallback is rewritten to the page's own `/assets/excalidraw/`, so the canvas makes no request off this computer (`build/excalidraw-assets.test.ts`).
