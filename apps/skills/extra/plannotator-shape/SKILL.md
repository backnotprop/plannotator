---
name: plannotator-shape
disable-model-invocation: true
description: >
  Draw a Shape: a one-screen, self-contained HTML overview of one long thread or piece of work.
  One drawn picture of where it stands, a short paragraph, and a second "How it works" view that
  shows when something happens, how it is processed and what it produces. Use when the person asks
  for a Shape, a big-picture overview, "where are we with this", "catch me up", a recap picture of
  a Plannotator Inbox thread, conversation, PR or project, or a one-page visual summary for a
  teammate who has not read it. Not for slide decks, dashboards, plan documents or code-change
  explainers.
---

# Plannotator Shape

A Shape is the overview section of a one-pager for one thread or piece of work: a title, a one-line claim, one picture, a short paragraph, and a second view, How it works. Two people read it in seconds: the person who was there and is now lost in it, and a teammate who never read it. Draw for the teammate. If it needs a second screen, cut.

The result is **one self-contained HTML file** built on `assets/frame.html`.

## Procedure

1. **Read the whole source.** An Inbox thread: the `plannotator_inbox` tool's `read_thread`, with `before` until the first message and `expand` for messages shown as one line. Read only the source; code, commits and other files stay closed unless the person asks.
2. **Write the fact sheet** (below) as an HTML comment where the frame marks it, before you draw.
3. **Copy `assets/frame.html`** to a new file, such as `shape-<topic>.html` in a scratch folder (not a repository), and fill its marked parts.
4. **Draw the picture:** read `references/draw.md` first.
5. **Draw How it works:** read `references/how-it-works.md` first.
6. **Write the header and the note** (below).
7. **Check, then fix:** read `references/check.md` and do all of it, the fact check and the look.
8. **Deliver** (below).

## The fact sheet

```
SUBJECT   One plain sentence a newcomer understands. No jargon.
CAST      The 3 to 7 real things it is about, each with its state now.
SETTLED   Each decision, and when. Mark the biggest one.
OPEN      Each open question, and whose call it is.
NEXT      What happens next, who does it, whether it waits on anyone now.
DROPPED   What was ruled out, and why, in a few words.
TRAIL     3 to 5 turning points (time + a few words), ending now. After
          each, copy the words of the message that says it.
VOICES    Up to 2 lines (6 words or fewer) that changed the course,
          copied exactly, and who said them.
ONE THING What a reader must notice first: a decision waiting on a person,
          else the work under way.
MECHANISM When it happens, how it is processed, what it produces.
```

Build it from the **latest** messages: something cut at 16:00 may be back by 22:00. If the work is about two things, name both and pick the primary one.

## Header and note

- **Eyebrow:** `Shape · as of <time of the last message, with zone> · <N> messages`.
- **Title:** the subject in plain words. **Claim:** one line, where it stands, saying in the source's own terms whether anything waits on the person now.
- **Note:** one short paragraph (two at most), 50 to 110 words, like the opening of a good Notion page, without bullets or labels: what it is about, where it stands, what is open and whose call, what is next. It adds the why; it never reads the labels aloud.
- Claim, picture, note and How it works agree: no tick or "chosen" on anything an open question still asks about.

## The frame

- Wrap marks that appear together in `<g data-step="N">`; steps draw in number order, the order you would explain aloud.
- Colour only through the classes and variables in the frame's `<style>` (the accent is `--mark`). No hard-coded colours, and no `var(--accent)`: a host's theme owns that name.
- No network: no external fonts, scripts or images. Inline SVG only.
- No How it works view: delete the second `<svg>`; the switch removes itself.
- Viewing: `?theme=light|dark`, `?view=tech`, `?static`. On a phone each view stays 780 px wide and scrolls sideways; you draw one layout.

## Deliver

- **Inbox thread:** `send_message` with `reply_to` the thread's latest message id: two or three lines, the light screenshot in place (`![Shape](/abs/path/shape-light.png)`), and the HTML in `attachments`. It opens beside the thread, sandboxed; the person's comments on it come back in their reply. Not as an `html` fence: a phone shows a fence as code.
- **No Inbox:** `plannotator annotate shape-<topic>.html` (or the `plannotator` tool with that target) serves it at its own local URL, where the person can comment and send feedback. Clicks pin comments there; Esc (Interact) makes the switch clickable.
- Or give the file's path: any browser opens it.
