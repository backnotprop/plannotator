# Routines editor: three ways to make saving clear

The facts are in `FACTS.md`. Mocks: `a.html`, `b.html`, `c.html`. Each has a screenshot (`a.png`, `b.png`, `c.png`), 1500px wide, dark on top and light below. Each shows three states: creating a new routine, just after an edit, and idle and saved.

## Common ground for all three

- **Autosave stays.** The Inbox's main surfaces save by themselves: New message drafts, reply drafts, Board cards, and this editor. Explicit Save buttons appear only in Settings text editors. A Save button here would add a step and a way to lose work ("I forgot to press Save").
- **Save while typing, not only on blur.** Add a short pause (about 600ms). Also save on `pagehide` / `visibilitychange` with `keepalive`, as `Thread.tsx:2589` already does for reply words. With this, a refresh no longer loses the last words.
- **No remount on create.** Today the editor is keyed by its id and remounts when `new` becomes `sch_…` (`ScheduledPage.tsx:122,131`). Keep the same instance, so focus and words typed during the create are kept.
- **Retry a failed write.** On failure, show it where the save status is (not at the end of the body) and retry with a short backoff. The words stay in the field.
- **Run now is no longer the filled primary.** It becomes "Run once now", a plain bordered button. It is also in the ⋯ menu. I avoided "Test run now": it is a real run. It counts as Run 1, starts a real agent in the person's permission mode, and replies in the thread. "Test" would promise something it does not do.
- **Off is the default for a new routine**, as today. The filled button in the foot is the step the person came for: **Turn on**, while it is Off. The header switch stays. The foot button is the same action, placed where a person looks for "what do I do now".
- No confirmations, no warnings, no new keyboard shortcuts. Sentence case. No left-border accents, outline row highlights or inset wells.

## A · Autosave made visible

What it means: the editor works as it does today. A quiet status sits in the header: "Not saved yet", "Saving…", "Saved" (with a check), or "Couldn't save · retrying". The foot gives the next step: **Turn on** (filled) while Off. When On, it shows "On · next run today at 7:00 PM" and a quiet **Run once now**.

- **Pros:** the smallest change, and client only (no server change). *(As built, PR #3558: one small server change. The window's create keeps its `idempotency_key` on the record, so a retried, reloaded or restored create makes one routine.)* It answers all three complaints: "is it saved", "the main button is something I don't want", and "will a refresh lose it". It matches New message's "Draft · saved 3:04 PM". The create rule (a name and a prompt) stays as approved.
- **Cons:** a new routine still is not written until it has both a name and a prompt. "Not saved yet" says so honestly, but a half-made one still disappears on refresh unless we add the small local hold below. It adds one more word in the header.
- **Build:** small. Mostly `ScheduledEditor.tsx` (typing pause, pagehide save, status state, retry, foot swap, no remount), plus `ScheduledPage.tsx` (key), `client.ts` (a `keepalive` option) and about 10 lines of `scheduled.css`. Tests for refresh, failure and remount. Bun only, as all Routines routes are.
- **Refresh mid-edit:** a saved routine keeps every word (the pagehide save). A new one with a name and a prompt keeps every word. A new one missing either is lost, **unless** we keep the unsaved new one in `sessionStorage` for `#routine=new` (about 20 lines). I recommend that. Then a refresh on `#routine=new` brings it back.

## B · Explicit create step

What it means: "New routine" opens the same panel as a draft. The foot has **Cancel** and **Create routine**. If the switch was flipped first, the button reads **Create and turn on**. Nothing is written until Create. After that it autosaves exactly as in A.

- **Pros:** creation is unmistakable, the first time and every time. There is a clear moment of "now it exists". Nothing half-made ever reaches the list.
- **Cons:** an extra press on every new routine. Two models in one panel: a form that needs Create, then a page that saves itself. People will then look for Save after creation too. Forgetting Create loses the work, unless the draft is held locally (needed, and part of the cost). Cancel either throws words away with no question, which loses work, or keeps them, which makes it just Close. It also differs from how an agent makes a routine (the `routine` tool's create has no such step).
- **Build:** medium. Everything in A, plus the draft state, a local draft store that survives a refresh, the Create and Cancel foot and its labels, and what Cancel does with a draft. More tests.
- **Refresh mid-edit:** before Create, kept only if the local draft store is built. After Create, as in A.

## C · Kept from the first word (my pick for "never lose a word")

What it means: the first word typed in any field makes the routine on the server. It is Off and named "Untitled routine" until it has a name. There is no create rule to meet. Nothing goes in the header. The foot line, where people look for Save, says where it stands: "Kept as you type · Off" with **Turn on**, then "Saving…", then "Saved · next run today at 7:00 PM" with a quiet **Run once now**. A failure reads "Couldn't save · retrying" in the same place.

- **Pros:** after the first key there is no case at all where words are lost. Saved state and next run are one sentence in one place. The row shows up in the list at once, so the person sees it exists.
- **Cons:** it needs a server change. An Off routine may have an empty prompt, and turning it on or running it with an empty prompt is refused. "Untitled routine" rows can pile up when someone starts and walks away. Fix: delete it silently when it is closed with nothing typed in the prompt. It changes the approved rule "made once it has a name and a prompt", so it needs a new approval.
- **Build:** medium. A's client work, plus `packages/server/inbox-scheduled.ts` (empty-prompt Off rule, the refusals, the default name, the walk-away delete), plus docs in `inbox-routines.md` and tests. Bun only.
- **Refresh mid-edit:** nothing is lost after the first character. The pagehide save covers the last pause.

## Recommendation

A, plus the `sessionStorage` hold for an unsaved new routine. It needs no server change, keeps the approved create rule, and closes every loss case in `FACTS.md` except a hard server failure, which it now shows and retries. Consider C if the owner wants the "Untitled routine as soon as you type" feel.

## The two small bugs (separate, small)

1. **Resize tooltip over the row's name.** The edge tip follows the cursor and opens below it, centred, over whatever is next to the edge (`shell/CollapsibleEdge.tsx:79-106`). Fix in `CollapsibleEdge`:
   - `trackCursorAxis="y"`, and a `side` toward the panel the edge resizes (the sidebar's edge puts its pill over the sidebar, never over the list);
   - raise the open delay from 300ms to about 600ms, so a pointer passing through on its way to a row does not open it;
   - close the tip when its edge unmounts (as `ListColumnEdge.tsx:39-44` already does on click), so no pill is left behind across a page change.

   About five lines, with no new words.
2. **The name wraps in the narrow list.** The narrow list beside the editor reserves fixed room for Runs and Last run even when they are 0 or empty. That caps the name at about 194px (`scheduled.css:79`). Fix in `scheduled.css`, beside the editor only: hide the Runs column (the editor lists the runs, and the phone layout already drops it, `scheduled.css:205`) and give its 50px to the name.

   ```css
   .st-list-split .st-short { grid-template-columns: [name] fit-content(calc(100% - 236px)) [btn] 24px [space] minmax(0, 1fr) [last] 112px [more] 40px [end]; }
   .st-list-split .st-scols > .st-count { display: none; }
   ```

   The name then gets about 244px, and "Inbox Usage Data and Feedback" fits on one line. The Run button stays right of the name, every row in one column, as approved. Longer names still take a second line, then truncate.
