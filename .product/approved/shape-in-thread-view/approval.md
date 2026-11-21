# Shape in the thread view, its panel References only (approval)

- **Given:** 2026-11-16 by the owner, after turning Shape on and opening a board from a thread (relayed by the coordinating agent; PR #3556).
- **Owner's words:**
  1. "shape needs to appear to left of artifacts"
  2. "I no longer like that it takes up the full screen and has a different background color. It should just fit within the thread view."
  3. On "remove the Thread tab": "Yes, remove the Thread tab", and on the board's Chat panel: "The thread panel needs to leave this slide out."
  4. "Ask AI as well. Honestly, it's just the reference panel. That's keep it at that." and "Also Ask AI, I don't think it needs to be here either. It should be integrated into the existing Ask AI."
- **Reading:**
  - The thread header's Pebble sits immediately left of Artifacts in every header.
  - A thread's board draws in the thread's own pane under its header, on the thread's background, in the Artifacts view's place (the messages and reply hidden, not unmounted); a board with no thread keeps the grid's window layer.
  - The board's side panel holds References only, on every board (in a thread, over the grid, in a review, the standalone page): no Thread tab, no Ask tab, no Chat button.
  - Pointing at a part and choosing Ask or Change it stays (the notes `shape read --notes` / `shape answer` carry). Their answers show in that part's comment box, and the whole board's box lists them all.
- **Out of scope here:**
  - How Shape is hidden (`inboxShape`, `heldSwitch`, `PLANNOTATOR_INBOX_PREVIEW=1`): unchanged.
  - Handing a board to the window's existing Ask AI ("It should be integrated into the existing Ask AI"): pending the owner's answer; nothing built for it.

## Comment bubble on a part (2026-11-16)
- **Given:** 2026-11-16 by the owner, answering the coordinating agent's question (PR #3556). The question offered "a speech-bubble mark at the corner of a part you commented on, different from the numbered References bubbles; click it to open that part's questions and answers; it shows a dot when an answer is new."
- **Owner's words:** "Yes, a small comment bubble on the part". Their note: "For reference, this is very similar to how Plannotator works when annotating HTML."
- **Reading:**
  - A part that something was asked or changed on has a small speech bubble at its corner. It has the look of the HTML annotation's placed marker (`html-viewer/bridge-script.ts`). A dragged box over no single part has its bubble at the box's corner.
  - The bubble opens that part's questions and answers: its comment box, or a box to read on a finished board. On a finished board a plain click on a part opens its code, as before. The bubble shows a dot while an answer in it is new; opening a box that shows the answer clears the dot.
