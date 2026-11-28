# The flows

One file per flow: what the person sees, what they can do and what happens, then numbered checks (`[list-04]`). A test or a UI test names the check it proves (`// proves: list-04`). A flow changes by changing its file first. `scripts/mobile/surface.ts` lists every check in `parity/surface.json`, so a new check needs a ledger row. A new flow file is added to `FLOW_FILES` in `scripts/mobile/flows.ts`.

The window is the truth. Every behaviour here is taken from the product's code, and each check ends with where: ` (path:line)`, or several joined by `; `, repo-relative. `tests/mobile-flows.test.ts` fails when a check has no citation or cites a file or line that does not exist. Where the phone deliberately does something else, the check says `phone differs: <what>, because <reason>`; a check with no window counterpart at all ends with `(phone only)` instead of a path. Never let a check disagree with the window silently. When the window changes, correct the check and its citation.

Three rules hold in every flow:

1. **Same data, same outcome.** A thing done on the phone leaves the Inbox in exactly the state the same thing done in the window would. The phone never has its own idea of a section, a question's state or a delivery line; the computer decides those.
2. **Same words.** Section names, question kinds, delivery lines, run lines and refusals use the window's words. Where the phone needs a line the window has no twin for (asleep, held, paired), the words come from the linked-machine lines the window already uses ("Will send when <computer> is back").
3. **Native parts, not page parts.** Navigation, lists, sheets, the keyboard, menus, undo and notifications are the system's. A web view draws only a document an agent wrote as web content (an HTML page, a live HTML block, a diagram), inside the app's own screen.

Words used below: the **window** is the Inbox in a desktop browser; the **computer** is the machine the Inbox runs on; a **sheet** is a panel that slides up from the bottom; a **cover** is a full-screen panel with Done at the top left.

## Where the phone deliberately differs from the window

| Difference | Why |
|---|---|
| Tabs for Inbox, Agents, Board, Search in place of a sidebar | One thumb press to each of the three questions a person has on a phone |
| An Agents tab | Running work is the second most looked-at thing on a phone; the window spreads it over a sidebar section and a line in each thread |
| The answer sheet, one question per page | A picture question is taller than the screen; a notification leads into the same shape |
| The Board as one lane per page, moved by press and hold | Five columns do not fit 390 points; dragging across pages is unreliable with a thumb |
| Files and guided reviews always full screen | No room for a side pane |
| Voice on the phone itself | No speech key needed on the computer; works while it is asleep |
| Photos by picker, camera and the share sheet | iOS cannot paste a picture into a text field; the share sheet is how things move between apps on a phone |
| Notifications with actions; answers from the lock screen | The window can only notify while a page is open |
| Reading and answering while the computer is asleep | A page cannot keep a copy or hold a write |
| No Open in Terminal, no free layout, no hover, no keyboard shortcuts | They need the computer's screen, pointer or keys |
| Starred threads always as pills above the list | The window's default place for them, the sidebar's Starred section, needs a sidebar |
| A diagram in a sandboxed web view | The app has no diagram renderer of its own; the window draws it into the page |
| Share in a message's ⋯ | The share sheet is how things move between apps on a phone |

Everything else is meant to be the same, and the contract keeps that true.
