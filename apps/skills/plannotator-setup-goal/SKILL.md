---
name: plannotator-setup-goal
description: Create reviewed Codex goal setup packages for long-running /goal work. Use when the user wants to turn an idea, backlog, project mission, or vague objective into durable goal files under a project goals slug folder, with Plannotator review gates for brief, narrative plan with acceptance criteria, verification, blockers, and the final /goal prompt.
---

# Plannotator Setup Goal

## Overview

Create a durable goal package in the current project at `goals/<slug>/` so Codex `/goal` has a clear mission, guardrails, proof of done, and external memory. Use Plannotator as the user review UI: every critical document must be gated with `plannotator annotate <document.md> --gate` and revised until approved.

## Workflow

1. Confirm the working directory is the project root, or use the user-provided project directory.
2. Gather enough context to name the goal, define the intended outcome, identify constraints, find likely project docs, and determine proof of done.
3. Ask focused questions whenever the goal is vague, risky, too broad, missing a finish line, or missing verification. Do not proceed with guessed critical requirements.
4. Create a slug from the goal name and scaffold `goals/<slug>/` with:

   ```bash
   python3 <skill_dir>/scripts/scaffold_goal.py --root . --slug <slug> --title "<goal title>" --objective "<one sentence outcome>"
   ```

5. Draft and refine the critical documents in this order:
   - `brief.md`
   - `plan.md`
   - `verification.md`
   - `blockers.md`
   - `goal-prompt.md`
6. Gate each critical document with Plannotator before moving on:

   ```bash
   plannotator annotate goals/<slug>/<document.md> --gate
   ```

7. If Plannotator returns denial, comments, or markup, treat that as user feedback. Revise the document, then run the same gate again. Continue until approved.
8. After all gates pass, present the final path and the exact `/goal` prompt from `goal-prompt.md`.

## Document Standards

`brief.md` must state the mission, context, constraints, non-goals, ask-before rules, and concise done condition.

`plan.md` is the central reviewed planning artifact. It must read like a clear solution narrative, not just a technical checklist. Include what is being built, why this approach is appropriate, how the solution will work, the main implementation slices, risks, phase boundaries, and acceptance criteria. Every important acceptance item needs observable evidence. For large missions, prefer several sequential goals over one endless goal.

`verification.md` must list exact verification commands and manual checks. Include expected pass conditions and where evidence should be recorded.

`blockers.md` must capture open questions, user-decision points, dangerous operations that require approval, and conditions that should pause the goal.

`goal-prompt.md` must contain the final command the user can paste into Codex. It should reference the goal package files as the durable source of truth, tell Codex to append evidence to `progress.jsonl`, and define when to stop or ask.

`progress.jsonl` is append-only evidence. Do not gate it. During execution, append concrete progress and proof, not summaries of intent.

## Plannotator Rules

Use Plannotator as the review surface, not as a passive preview. The command `plannotator annotate <document.md> --gate` presents the document to the user and captures approval or denial feedback.

Do not skip gates for critical documents. Do not mark a document ready because it seems reasonable. The user must approve it through the gate.

If a document is denied, update the document from the captured feedback and rerun the gate. Keep the loop tight: one document, one review, one revision cycle.

## Goal Prompt Rules

Write the final `/goal` prompt as a compact product brief, not a raw todo dump.

Include:
- outcome
- relevant files
- constraints and non-goals
- plan acceptance criteria and evidence
- verification commands
- ask-before rules
- instruction to use `goals/<slug>/` as the durable plan and append evidence to `progress.jsonl`

Avoid:
- open-ended improvement loops
- mixed unrelated missions
- vague words like "improve" without measurable proof
- instructions to keep working forever
- hidden assumptions that are not written into the files

## Quality Checks

Before finalizing, verify:
- The goal has one clear finish line.
- The plan explains what, why, and how before listing work slices.
- The plan acceptance criteria can be audited from real artifacts.
- Verification commands are concrete.
- Risky actions have ask-before rules.
- The final `/goal` prompt tells Codex where the goal files live.
- All critical documents have passed Plannotator gates.
