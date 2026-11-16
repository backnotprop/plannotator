# Inbox routines: the editor saves by itself, and says so

- Approved: 2026-11-16 (20:13Z) by the owner, in the Inbox thread "Routines Creation Confusion".
- Artifact: `a.html` / `a.png` (option A), `FACTS.md` (how saving works today and where work is lost), `NOTES.md`.

## The owner's words
- "It's a little confusing creating routine. I guess it just auto-creates. Like, there was no save button or a discard or anything like that. And I wasn't convinced it was saved until I turned it on. Now there's a run now button, but I don't want to run it now because it's not set to run until 7pm."
- Pick: "A · It saves by itself, and says so".
- On the mock: "Yeah, I think the turn on button is a good addition at the bottom. That gives me like the save like feature."

## Approved state
- A quiet status in the panel's header: "Not saved yet", "Saving…", "Saved", "Couldn't save · retrying".
- Saving happens while typing (after a short pause), when a field is left, and when the page closes; a failed save retries and the words stay in the field.
- A half-made new routine (missing a name or a prompt) is kept through a refresh in the browser's session storage; the rule that a routine needs a name and a prompt to exist is unchanged.
- The bottom bar: while a routine is off, the filled button is "Turn on" with "Off, so it won't run on its own."; once on, it shows "On · next run <when>". "Run now" is no longer the filled button: a quiet "Run once now" sits beside it.
- New routines are created off, as today.

## Rejected on the way
- B: an explicit "Create routine" / "Cancel" step (an extra click every time; two ways of working in one panel).
- C: creating an "Untitled routine" at the first keystroke (untitled rows pile up; breaks the name-and-prompt rule).

## With it (small fixes, same change)
- The resize edge's tooltip must not land on a routine's name.
- In the narrow list beside the editor, the Runs column gives its room to the routine's name.

## Out of scope
- Any change to schedules, missed-run handling, or what a run does.

## Addendum 2026-11-16 (as built, PR #3558)
- Words on screen not in the mock:
  - "Not saved · needs a name" / "Not saved · needs a prompt": a saved routine whose name or prompt was emptied. The empty value is never saved.
  - "Couldn't save": a write the Inbox refused. The reason is in the red line under the On switch, and it is not retried.
  - "Not run: your last change isn't saved yet." / "Not turned on: your last change isn't saved yet." in that same line.
- Saving on a routine that is on (ops' decision in review): its typed name and prompt are not saved on the typing pause. They are saved when the field is left, when the panel closes, when the page hides or closes, and before Run once now or a turn. The header says "Not saved yet" until then.
- Run once now is also in the ⋯ menu, as NOTES.md said.
- 2026-11-16 20:38Z: the owner, after trying the build: "Hey, I trust it. Let's ship it." Merge after the review is clean and the browser suite is green.
