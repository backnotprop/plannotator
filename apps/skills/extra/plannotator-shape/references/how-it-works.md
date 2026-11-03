# How it works (the second view)

Most work has a mechanism. Draw it as the second view behind the switch, never as a strip under the picture: the page must fit one screen. Skip it only when there is no mechanism (pure wording, a plain pick between options), and delete the second `<svg>`.

## When, how, what

Every How it works view answers three questions, whatever its form:

- **When:** what starts it. The event, trigger or moment: "at session start", "a pull request merges", "after two quiet days".
- **How:** how it is processed. The steps, states or parts, and who or what does each.
- **What:** what it produces, drawn as the thing itself with its real content, so the reader sees what it looks like.

For example, for a feature that gives an agent instructions: when the instructions are injected, what they look like (a small card with their real first line), how the agent processes them, and what that produces.

**Test:** point at the place in the drawing that answers each question. If one is missing, add it as a node or a labelled arrow, not a caption.

## Use the form the mechanism has

- **States** (a thing is in one condition, then another): a state machine. Each state a rounded box; each transition an arrow labelled with the event that causes it ("closes it"); the start marked with a dot, end states with a double outline.
- **Steps** (one thing after another): a flow, numbered 1, 2, 3 on the arrows.
- **Parts** (what calls what, where data goes): the cast laid out by where it runs; things with a shape keep it, small; services become boxes.

## Keep it sharp

- 4 to 8 nodes: one row, one loop or two rows. No lanes, no grid of identical boxes.
- 30 to 70 words. Every arrow has a verb or an event. Code names in the mono, only ones the source used.
- The picture's names and state marks: what this work added or changed takes the accent; what was dropped is struck.
- Only the rules the source states. No restrictions it never set (which moves are allowed from where), no gaps filled from the code.
- The same story as the picture, plus the rules the picture cannot show.
