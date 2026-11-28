# Plans: editing a plan (decisions)

- Decided: 2026-11-16 by the owner, in the Inbox thread "Plannotator Plans". No mock yet; these are the rules the build follows.

## The owner's words
- "the big thing missing now is like the ability to actually edit the plan."
- "we're going to need to understand our editing experience ... and if we were going to want to keep that versus migrating to something like Tiptap."
- Which editor: "Keep ours (live preview on the Markdown text) and bring it to Plans".
- Pressing Done: "Your edit becomes a new version, marked as yours, and the agent is sent what you changed".
- On an approval staying on an old version: "I don't like this. This feels fucking bad. W people are gonna get lost editing old versions. That doesn't feel good at all."
- Editing a plan you approved yourself: "A · It moves to the new version: "Your approval moved to v4.""

## Rules (the same model as the sister product's pages)
- Only the newest version can be edited. An older version is read-only: read, compare, Restore. Restore makes a new newest version. There is no Edit on an older version.
- Done makes a new version whose author is the person; the agent is sent what changed.
- An approval belongs to the current version only. Any new version clears approvals in the same write, and one line says what happened. History keeps the past fact on its version's row.
- Exception the owner picked: when the new version's only author is the person who approved, their own approval moves to the new version in the same write ("Your approval moved to v4."). Decided on the server from the version's authors. If anyone else's change is in that version, it clears.
- An agent's change after approval always clears it.
- Approving names the version the person was looking at and is refused if the plan has moved on; they are shown the newer version.
- The editor is the shared Markdown editor (live preview on the Markdown text). No Tiptap.

## Not decided yet
- Whole-page editing first, block-at-a-time later (ops' choice unless the owner objects).
- Whether comments move to the new version when their words still match (ops' choice unless the owner objects).
- Any keyboard shortcut for Edit in the Inbox (needs the owner's approval).
- Where a comment on a plan with no thread goes when sent.
