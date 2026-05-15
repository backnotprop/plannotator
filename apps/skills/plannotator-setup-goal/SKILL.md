---
name: plannotator-setup-goal
description: Turn an idea or objective into a goal package for /goal. Interviews the user, builds a reviewed fact sheet via Plannotator, then explores the codebase to produce an execution plan.
---

# Setup Goal

Turn an idea into a goal package at `goals/<slug>/` through structured discovery, user interview, and codebase exploration.

## Phases

### 1. Rearticulate

State back what the user wants in your own words. If the conversation already has rich context, summarize it. If the goal is bare or vague, do minimal shallow exploration of the codebase to ground your understanding. Keep it to 2-3 sentences. Wait for the user to confirm or correct before continuing.

### 2. Interview Bundle

Build a complete bundle of questions that can derive every "fact" this goal should produce. Package the questions together so the user can answer them quickly in the Plannotator goal setup UI. For each question, include your recommended answer and use options when they make answering faster.

Question areas that usually matter:

- What the feature/change is
- Who it's for
- What problem it solves
- What behavior changes
- What success looks like
- What's in and out of scope (the most important area to determine facts)
- What edge cases to consider
- What constraints or precedent apply

**If a question can be answered by exploring the codebase, explore the codebase instead of asking.** Only include questions where the user's judgment is actually needed.

Pipe the bundle as raw JSON directly to the CLI via stdin — no need to write a file:

```bash
echo '{"stage":"interview","title":"Short human-readable title","goalSlug":"<slug>","questions":[{"id":"scope","prompt":"What should be in scope?","description":"Optional clarification.","answerMode":"multi-custom","recommendedAnswer":"Your recommended answer.","recommendedOptionIds":["ui","server"],"options":[{"id":"ui","label":"UI"},{"id":"server","label":"Server"}],"required":true}]}' | plannotator setup-goal interview - --json
```

Supported `answerMode` values: `text`, `single`, `multi`, `custom`, `single-custom`, `multi-custom`.

Run this as a monitored foreground process and wait patiently for the browser session to finish. The command returns JSON on stdout with the submitted answers. Use those answers as the reviewed interview result. If the session is dismissed, stop and tell the user the goal setup was closed.

### 3. Fact Sheet

A fact is a simple description of each outcome of a goal. It should be easily testable and verifiable. A fact may describe the function of a specific feature or aspect of a system. A fact may determine specific UI and UX. Again, a fact is literally anything that can be tested and verified in automated or manual testing. Keep fact language simple. In a way, a fact sheet is a design spec, but less verbose & using language the human user can easily visualize & rationalize. 

Create the goal directory, then prepare a facts review bundle from the interview result. Each fact should include whether automated verification is recommended and preselected.

```bash
mkdir -p goals/<slug>
```

Pipe the facts bundle as raw JSON directly via stdin — no file needed. If revising after a prior facts pass, include previously accepted facts with `"accepted": true`; the UI hides them by default while preserving their state.

```bash
echo '{"stage":"facts","title":"Short human-readable title","goalSlug":"<slug>","facts":[{"id":"fact-1","text":"The accepted fact text.","accepted":false,"removed":false,"recommendedAutomatedVerification":true,"automatedVerification":true}]}' | plannotator setup-goal facts - --json
```

Run this as a monitored foreground process and wait patiently for the browser session to finish. The command returns JSON on stdout with accepted/edited/removed facts plus automated verification selections.

Write `goals/<slug>/facts.md` as a flat readable list of accepted facts. Each fact is one line; add a minimal note only when the fact cannot be stated clearly on its own. Also write `goals/<slug>/facts.meta.json` preserving each accepted fact's `id`, final `text`, `comment`, `recommendedAutomatedVerification`, and `automatedVerification` value.

If the user edits or removes facts in the UI, apply that result directly. If the session is dismissed, stop and tell the user the facts review was closed.

### 4. Plan

Explore the codebase. Discover and validate implementation paths toward each accepted fact. Treat facts with `automatedVerification: true` as requiring concrete automated checks unless you document a blocker. Trace through code, identify files and systems involved, surface risks and unknowns. Refine until you have a confident order of operations.

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
