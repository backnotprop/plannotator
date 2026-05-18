---
name: plannotator-setup-goal
description: Turn an idea or objective into a goal package for /goal. Interviews the user, builds a reviewed fact sheet via Plannotator, then explores the codebase to produce an execution plan.
---

# Setup Goal

Turn an idea into a goal package at `goals/<slug>/` through structured discovery, user interview, and codebase exploration.

## Phases

### 1. Rearticulate

State back what the user wants in your own words. If the conversation already has rich context, summarize it. If the goal is bare or vague, do minimal shallow exploration of the codebase to ground your understanding. Keep it to 2-3 sentences. Wait for the user to confirm or correct before continuing.

### 2. Interview (grill me)

Interview the user such that you can derive every "fact" this goal should produce, & until you reach a complete shared understanding of the desired outcomes. The following questions areas should help you determine facts about the outcome.

- What the feature/change is
- Who it's for
- What problem it solves
- What behavior changes
- What success looks like
- What's in and out of scope (The most important area to determine facts)
- What edge cases to consider
- What constraints or precedent apply

Ask questions **one at a time**, waiting for feedback before continuing. For each question, provide your recommended answer. Use the question/answer tool if available.

**If a question can be answered by exploring the codebase, explore the codebase instead of asking.**

Stop when you feel confident in being able to describe the facts of the goal outcome. Don't pad.

### 3. Fact Sheet

A fact is a simple description of each outcome of a goal. It should be easily testable and verifiable. A fact may describe the function of a specific feature or aspect of a system. A fact may determine specific UI and UX. Again, a fact is literally anything that can be tested and verified in automated or manual testing. Keep fact language simple. In a way, a fact sheet is a design spec, but less verbose & using language the human user can easily visualize & rationalize. 

Create the goal directory and write `goals/<slug>/facts.md` — a flat list of bulleted facts. Each fact is one line. Add a minimal note only when the fact can't be stated clearly on its own.

```bash
mkdir -p goals/<slug>
```

Gate the fact sheet with Plannotator:

```bash
plannotator annotate goals/<slug>/facts.md --gate
```

If denied, revise from feedback and re-gate until approved.

### 4. Plan

Explore the codebase. Discover and validate implementation paths toward each fact. Trace through code, identify files and systems involved, surface risks and unknowns. Refine until you have a confident order of operations.

Write `goals/<slug>/plan.md`:

- Solution approach (brief)
- Ordered steps with the files/systems each touches
- Verification for each step (concrete commands or checks)
- Risks or open questions worth flagging

Gate the plan with Plannotator:

```bash
plannotator annotate goals/<slug>/plan.md --gate
```

If denied, revise from feedback and re-gate until approved.

### 5. Goal Output

Write `goals/<slug>/goal.md`:

- The articulated goal (1-3 sentences)
- Reference to `facts.md` as the shared understanding
- Reference to `plan.md` as the execution plan
- Done condition

Tell the user:

```
Done! Launch a goal with `/goal goals/<slug>/goal.md`
```
