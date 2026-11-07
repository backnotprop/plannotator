# Drawing the picture

## Find the picture

Ask: **"If a teammate walked in and I had one minute at a whiteboard, what would I draw first?"**

Almost always the CAST: the real things, drawn so a newcomer recognises them, placed so their relations and state are visible. Uniqueness comes from the subject (work about a dialog shows the dialog), not from a new kind of diagram each time.

For example: devices that connect → the devices, linked, each in its state; a screen → the screen, simplified, with what was decided marked on it; a choice → the options side by side, each with its verdict; a number → its measurement before and after, on an honest scale; planned work → the pieces as things: done, under way, next.

**No metaphors** (rockets, lightbulbs, puzzle pieces, rivers, maps) unless the work is about that thing. **No abstract geometry** a newcomer must decode (unlabelled dots, rings, swim lanes, matrices). **No boxes-and-arrows flow** as the picture: that is How it works.

Test: describe the picture to a newcomer in two sentences. If you need "represents" or "each dot is", choose again.

## What it must say

In this order of weight:

1. **Where it stands:** the cast in its current state. Most of the picture.
2. **Settled and open**, marked on the things themselves (state marks, below), never as a separate list. **Draw the biggest settled decision** as the thing looks now that it is decided, with a two-to-four-word caption and a tick.
3. **Next:** a short dashed path, two or three steps, from the thing it is about, saying who does it. The person's step that is not due yet is grey dashed: "later, you: publish the package".
4. **How we got here** (optional): a thin trail of 3 to 5 beats along the bottom, ending at "now" and handing over to the next steps. Leave it out when the history is short or does not change the story.

If the work exists because something is broken or missing, show that small, on the thing itself. If the point is something a person sees or does, **draw that surface**.

**The one thing goes in the accent** with readable content (a question, a real label, a count), never an empty icon. Work under way gets **one** status in plain words; facts that seem to contradict it ("not merged yet") go in the note.

**Lines make claims.** Solid means "exists and works today". Planned, proposed, unbuilt or unverified is dashed. Check every solid line.

## Draw it cleanly

**A clean technical illustration that draws itself**: thin even lines, one accent, real labels. No wobble, hatching, texture, gradients, shadows or hand-drawn fonts.

**Objects.** Build each real thing from 3 to 8 simple shapes plus **one identifying detail**: a phone is a tall rounded rectangle with a speaker bar; a server a flat box with a status light; a dialog a card with a title bar and buttons. Use `.ink` (paper fill) so lines behind are hidden. **Put real content inside**: a terminal its real command, a card its actual buttons, a chart its real numbers. Blank screens and placeholder lines are filler: put something true inside, or make the object smaller. Never invent content: no made-up titles, names or numbers. No emoji, icon fonts or clip-art.

**Draw only what reads at a glance.** Simple shapes carry devices, cards, screens and paths, not anatomy or fine machinery: never hands, fingers, faces, bodies, cursors or keyboards of keys. Show an action with a mark a clean drawing does well: a small ring where something is tapped, an arrow with a verb, two short opposed arrows for a pinch. If you doubt a shape reads, replace it with its label.

**Drawn screens** keep only what was decided: the title, the main message, the buttons people argued about. Unless it is the hero, a screen takes at most a third of the picture.

**Names** a newcomer recognises: "8 pull requests", "the permission card". No PR or ticket numbers, branch names or flags on the picture (How it works may use them). A coined name keeps what it does beside it; an unfamiliar vendor gets two or three words.

**Every mark means something.** A dot, light or badge reads as a state; draw one only if it is one. Of many options, draw the two or three that matter and name the rest in one faint line. Stacked caption lines or callouts on leader lines are a list: put each fact on its thing or in the note.

**Colour.** The accent means "look here first": the one thing, plus one more only if two calls wait on the person equally. Outline a group with it; never fill one.

**Lines and type.** Lines 1.6 to 2 in the viewBox (the hero 2.5), small open chevrons. Names in the sans at 17 to 22; captions in `.cap`. Labels sit beside what they label, never in a legend.

## State marks

| State | Mark |
|---|---|
| Works today | Solid ink. |
| Built, not shipped | Solid ink; what it still lacks goes in the note. |
| Decided, not built | Ink, dashed, small tick. |
| Waiting on a person now | Accent, dashed; the label is the question, ending in "?", with whose call. |
| Open, not urgent / next / later | Grey, dashed. |
| Under way now | Ink with one status word; the accent only if nothing waits on a person. |
| Dropped | Faint grey, struck, with a reason a newcomer understands. |
| Asleep, off, broken | Grey outline with a short word ("off", "fails"). |

A state not listed: say it in two or three words. Do not invent a mark.

## Make it alive

**Show the effect, not the gesture**: life comes from things visibly changing (the diagram bigger after the pinch, a card half into its slot, a stack sliding toward "merged"), not from drawn actors or a legend of glyphs. Then pick the two or three moves this story needs; none is required:

- **One hero, much bigger**, about three times anything else, a little off centre, never equal boxes in a row.
- **Who acts, as a chip:** a rounded chip with a word ("you", "agent") and an arrow with the verb ("merges"). Never a drawn figure.
- **Before and after:** the before small and grey with its real flaw visible, the after as the hero.
- **The past, small:** one or two earlier versions as captioned cards behind the hero (`.lift`: the same shape offset 3 units).
- **One real voice** from VOICES in `.say`, beside what it changed, with who said it.
- **A tint on the hero** (`.acc-fill`); **a path, not a grid** (a gentle arc, curved connectors).

**Vary the slots.** The before-card, side labels, voice and trail are each optional. A ghost on the left, a tinted hero in the middle, labels on the right and a trail below on every Shape is a stamp.

Let the draw order tell the story: the problem, the hero, who acts, the states, next. An artefact the source approved (a mock, a chart) may sit small in the picture, labelled with what it is and when it was approved.

## Words

The picture carries **names and states**; the note carries sentences. Aim for **60 to 100 words on the picture**, all text counted. Count after the first render and cut, in this order: words that repeat the header; captions that restate a shape ("laptop"); second lines on screens; trail beats beyond four and struck items beyond three; qualifiers ("currently", "all"). If a newcomer could no longer name the subject, put one name back.
