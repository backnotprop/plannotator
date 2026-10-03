---
name: plan
description: Use this skill whenever the user asks to plan, architect, design, outline, or review any non-trivial coding task, refactor, feature, or bugfix before editing code. Trigger proactively on prompts like "plan this", "create an implementation plan", "architect this refactor", "design a roadmap", or "map out the steps first"—even if Plannotator or /plan is not mentioned. Researches the codebase, formulates a technical implementation plan in .agents/plans/<plan-name>.md, and opens Plannotator for user review.
---

# Plannotator Plan

Research codebase architecture, formulate a structured technical implementation plan, and obtain interactive user approval in Plannotator before modifying code.

## When to Activate
Activate this skill automatically whenever:
- The user requests a plan, architecture design, roadmap, or technical specification.
- The task involves multi-file refactoring, architectural tradeoffs, or potential breaking changes.
- The user says "plan this", "how should we build X", "let's map out the steps", or "create an implementation plan".

## Workflow

### 1. Research & Explore
- Read the relevant codebase files, interfaces, and caller spines to verify technical assumptions.
- Identify edge cases, dependencies, and blast radius.

### 2. Formulate the Plan
Draft a structured plan containing:
- **Goal Description**: Objective and architectural rationale.
- **User Review Required**: Breaking changes, tradeoffs, or key decisions.
- **Proposed Changes**: Specific files to modify or create with concrete diff sketches.
- **Verification Plan**: Exact test commands and manual verification checks.

### 3. Submit for Review
- Write the complete plan to `.agents/plans/<plan-name>.md` using `write_to_file` with `Overwrite: true`.
- Plannotator automatically opens the interactive review UI in the user's browser.

### 4. Iterate on Feedback
- If the write is denied, review the user's line annotations and notes returned by the hook.
- Address all feedback directly inside the plan and resubmit the complete file using `write_to_file`.
- Only proceed to implement code changes once the plan write succeeds (approval granted).
