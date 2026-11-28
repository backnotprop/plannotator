# Routines editor: how saving works today (origin/main 0ca32a48f)

All paths are on origin/main. "Editor" is `packages/inbox/scheduled/ScheduledEditor.tsx`.

## Short answer

Yes, the routine is saved, and a refresh does not lose it. It was saved before the switch went on. The first write happened when focus left the name or the prompt while both had words in them. Turning it on was a second write. After that every field saves by itself.

But nothing on screen says so. And there are real cases where typed words are lost (listed below).

## When a routine is written

- **Click "New routine".** Nothing is written. It only opens `#routine=new` (`ScheduledPage.tsx:145`, `app/route.ts:149`). The editor fills a draft in memory: no name, no prompt, every day at 9:00 AM, "Run once when I'm back", the last folder, the last agent (Editor `:106-110`). The prompt box gets focus (`:297`).
- **The first write (create).** It happens on the first save call after the name and the prompt both have words (`:165` returns early otherwise, `:168` creates). A save call comes from:
  - leaving the name field (`:237`) or the prompt field (`:300`). This is on blur. There is no debounce and no save while typing.
  - any pick, at once: the If-missed choice (`:277`), the folder (`:286`), files (`:288`), Runs as (`:302`);
  - a schedule change, once the preview accepts it (`:267-269`);
  - the switch (`:194`, `:244`).
- **Created Off.** The server turns it on only when the window sends `enabled: true` (`packages/server/inbox-scheduled.ts:472-477`). The window sends that only when the person flips the switch on a new routine (`:194` then `:180`). So a new routine is Off. Flipping the switch on a new one creates it and turns it on in one go. That also sets `approved_at` (`inbox-scheduled.ts:478`, `:526`).
- **After create.** The address becomes `#routine=<id>` in place of `new` (`:181`, `ScheduledPage.tsx:131`). The editor is keyed by that id (`ScheduledPage.tsx:122`), so it **remounts** from the saved record.
- **Edits to a saved routine.** Each blur or pick sends only that field (`:159`, `POST /api/inbox/scheduled/:id`, `client.ts:54`). The server needs a name and a prompt with words (`inbox-scheduled.ts:168`).

## What tells the person it was saved

Nothing says "saved". The only signs are indirect:
- the row shows up in the list on the left (`putScheduled`, `:170`);
- the address changes from `#routine=new` to `#routine=<id>`;
- "Run now" stops being dimmed (`disabled={!record}`, `:339`).

For an edit to a saved routine there is no sign at all. A failed write shows one red line at the **end of the scrolling body**, under the prompt and the Runs list (`:327-331`). It is easy to miss with a long prompt. It never retries.

The rest of the Inbox: the main surfaces save by themselves. New message shows "Draft · saved 3:04 PM" (`compose/ComposeDialog.tsx:1279`). A reply's typed words are sent on `pagehide` with `keepalive` (`components/Thread.tsx:2589`, and `ActionChecklist.tsx:535,588`). Explicit Save buttons are only in Settings editors: `PromptsSettings.tsx:192`, `AgentRules.tsx:164`, `cloud/CloudWake.tsx:93`. So autosave is the house model. The editor's own header comment says so: "It saves as you go, as the Board's card does" (`:2-4`).

## What "Run now" does

It is the only button in the foot, and it is the filled primary (`ib-btn ib-pri`, `:339`). It calls `POST /api/inbox/scheduled/:id/run` (`client.ts:57`). The server starts a real agent session at once (`inbox-scheduled.ts:532-544`, `startRun` with `due_at` now). The run uses the person's permission mode, writes the run line in the routine's thread, and counts as Run 1. It works when the routine is Off (`ScheduledTable.tsx` RunButton, `scheduled.css:65` "Run now works while off"). The 15-minute rule never holds it back (`docs/agent-guides/inbox-routines.md`, The clock). While a run is going it becomes "Stop" (`:334-337`). It is dimmed only before the first write.

## When typed work can be lost

1. **Refresh, close the tab, or quit while the cursor is still in the name or prompt.** Nothing saves on blur, and there is no `pagehide` save here (unlike Thread.tsx). The words since the last time you left the field are gone. On a new routine that never had a create, everything is gone. A refresh on `#routine=new` opens a blank one again.
2. **A new routine missing a name or a prompt.** Nothing is written: not the prompt, not the schedule, not the folder, nothing (`:165`). Leave, refresh, or click another routine, and it is gone, with no sign.
3. **Typing during the create round-trip.** The create is in flight, then the editor remounts on the new id (`ScheduledPage.tsx:122,131`). Words typed in another field in that short window, and not yet in the create, are dropped. Focus is lost too. The window is small, but it is real.
4. **A failed write.** The words stay in the field with a red line far down (`:182-184`, `:327-331`), with no retry. A refresh then loses them.
5. **Clearing the name or the prompt.** An empty value is never sent (`:237`, `:300`). The old text comes back on the next open or refresh, and nothing says so.
6. **Leaving by keyboard or browser Back while the field has focus.** No blur may run before the editor unmounts. This is not certain. It depends on the browser firing blur on removal.

Not lost: closing the panel with ✕ or clicking another row. The mousedown blurs the field first, and the save request finishes after the unmount. On a new routine that has both fields, `onCreated` then runs after the close and **opens the editor again** on its new id (`:181`). That is surprising, but nothing is lost. Switching to another window also blurs the field, so it saves.

## Blank routines

Clicking New routine and leaving writes nothing, so no blank row is left behind. There is nothing to clean up. The cost is case 2 above: a half-made one also vanishes without a word.

## The two small bugs

- **"Drag to resize" over the row.** The Routines page has one resize edge, the sidebar's (`shell/SidebarShell.tsx` SidebarEdge, which passes `onCollapse`, so its tip reads "Click to collapse, drag to resize"). The text "Drag to resize" alone comes only from an edge without a click action: `ListColumnEdge` on the Pulls page (`pulls/PullsPage.tsx:286,363`) or the thread-panel loading list (`App.tsx:5609`). The Routines page does not mount `ListColumnEdge`: its narrow list is a fixed 500px (`scheduled.css:26`). Either way the cause is the same. The edge's tooltip follows the cursor on both axes and opens 14px **below and centred on the pointer**, at z-index 50, after 300ms (`shell/CollapsibleEdge.tsx:79-106`, `inbox.css:2950-2951`). The edge's invisible hit strip reaches 8px into the list (`.ib-handle-hit { left: -8px; right: -8px }`, `inbox.css:2948`). The first row's name starts about 22px in (`.st-lbody` 10px + `.st-srow` 12px, `scheduled.css:27,91`). So a pointer resting near the list's left edge puts the pill on the row's name. `ListColumnEdge.tsx:36-37` also notes that an edge tip can stay drawn after the press. A leftover pill is the likely source if the text was exactly "Drag to resize".
- **The name wraps onto two lines.** The narrow list caps the name column at `fit-content(calc(100% - 286px))` (`scheduled.css:79`). The fixed tracks are Run 24, Runs 40, Last run 112 and ⋯ 40, with gaps and the row padding. In the 500px list (480px inside its padding) that leaves about 194px. "Inbox Usage Data and Feedback" is about 205px at 13.5px / 500, so it takes the second line on purpose (`scheduled.css:96-97`, line-clamp 2). Runs (0) and Last run (empty) take their full width even when they show nothing.

## Approval records

On origin/main, `.product/approved/` holds only `inbox-generated-agent-icons` and `inbox-toolbar-delete`. No routine record is on main. The local untracked checkout has `.product/approved/inbox-routines/approval.md` (PR #3409). It sets three things that the proposals keep:
- the name "Routines" on screen and to agents;
- in the narrow list, the Run button sits right of the name, every row aligned in one column ("alignment not random chaos");
- in the editor, Files sits above the Prompt box.

Words on screen stay "Routines", "routine". Never "Loops".
