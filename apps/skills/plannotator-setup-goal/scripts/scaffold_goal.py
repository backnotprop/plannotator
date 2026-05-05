#!/usr/bin/env python3
"""Scaffold a reviewed Codex goal package under goals/<slug>/."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    slug = re.sub(r"-{2,}", "-", slug)
    return slug or "goal"


def write_file(path: Path, content: str, force: bool) -> None:
    if path.exists() and not force:
        return
    path.write_text(content, encoding="utf-8")


def brief(title: str, objective: str) -> str:
    return f"""# {title}

## Outcome

{objective or "TODO: State the concrete outcome in one or two sentences."}

## Context

- TODO: List the project facts, files, docs, user needs, and constraints Codex must know.

## Constraints

- TODO: List behavior, APIs, data, UX, performance, compatibility, or process rules that must not regress.

## Non-Goals

- TODO: List work that is out of scope for this goal.

## Ask Before

- TODO: List decisions, risky operations, external dependencies, product calls, and destructive changes that require user approval.

## Done Means

- TODO: Summarize the finish line. Detailed acceptance evidence belongs in `acceptance.md`.
"""


def plan(title: str) -> str:
    return f"""# Plan: {title}

## Solution Overview

TODO: Describe what is being built in plain language. Explain the shape of the solution before diving into tasks.

## Why This Approach

TODO: Explain why this direction is appropriate for the project, user goal, constraints, and risk level.

## How It Will Work

TODO: Describe the main moving parts, data flow, user flow, files, APIs, or systems involved. Keep this narrative enough that a reviewer can understand the intended solution.

## Slices

| Slice | Purpose | Main files or systems | Done when | Risks |
| --- | --- | --- | --- | --- |
| 1 | TODO | TODO | TODO | TODO |
| 2 | TODO | TODO | TODO | TODO |

## Sequencing

- TODO: Explain the order of execution and which slices block later slices.

## Phase Boundaries

- TODO: State when this goal should end and a new goal should be created instead of stretching this one.

## Steering Notes

- TODO: Capture taste calls, product preferences, or review checkpoints the user should steer during execution.

## Acceptance Criteria

- [ ] TODO: Requirement with concrete observable evidence.
- [ ] TODO: Requirement with concrete observable evidence.

## Required Evidence

| Requirement | Evidence to inspect | Where evidence is recorded |
| --- | --- | --- |
| TODO | TODO | TODO |

## Completion Audit

Before marking the goal complete, Codex must map every explicit requirement, file, command, check, and deliverable to real evidence. If any item is missing, incomplete, weakly verified, or uncertain, the goal is not complete.
"""


def verification(title: str) -> str:
    return f"""# Verification: {title}

## Commands

| Command | Purpose | Expected pass condition | Evidence location |
| --- | --- | --- | --- |
| TODO | TODO | TODO | TODO |

## Manual Checks

- TODO: Add browser checks, screenshots, release checks, PR checks, or human review steps.

## Evidence Rules

- Record verification results in `progress.jsonl`.
- Include command, status, timestamp, and artifact path when available.
- Do not rely on passing tests unless they cover the requirement being claimed.
"""


def blockers(title: str) -> str:
    return f"""# Blockers: {title}

## Open Questions

- TODO: Questions that must be answered before or during execution.

## Stop And Ask

- TODO: Conditions that should pause the goal and ask the user.

## Dangerous Or High-Risk Actions

- TODO: Destructive changes, migrations, dependency changes, security-sensitive work, billing/auth changes, or external operations requiring approval.

## Known Blockers

- TODO: Current blockers, owners, and next action.
"""


def goal_prompt(slug: str, title: str, objective: str) -> str:
    prompt_objective = objective or f"Complete the reviewed goal package for {title}."
    return f"""# Codex Goal Prompt: {title}

After every critical document in this folder is approved with Plannotator, paste or set this goal:

```text
/goal {prompt_objective}

Use `goals/{slug}/` as the durable source of truth:
- Read `brief.md` for the mission, context, constraints, non-goals, and ask-before rules.
- Follow `plan.md` for the solution overview, implementation slices, risks, and acceptance criteria.
- Run the checks in `verification.md` and record evidence.
- Append concrete progress and proof to `progress.jsonl`.
- Pause and ask the user for anything listed in `blockers.md` or any similarly risky unresolved decision.

Do not mark the goal complete until every acceptance item is backed by real evidence and the required verification has passed or the remaining blocker is explicitly documented for the user.
```
"""


def progress_entry(title: str, objective: str) -> str:
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    entry = {
        "type": "goal_package_created",
        "timestamp": now,
        "title": title,
        "objective": objective,
        "evidence": "Initial scaffold created; critical documents still require Plannotator gate approval.",
    }
    return json.dumps(entry, ensure_ascii=True) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="Project root where goals/ should be created.")
    parser.add_argument("--slug", help="Goal folder name. Defaults to a slugified title.")
    parser.add_argument("--title", required=True, help="Human-readable goal title.")
    parser.add_argument("--objective", default="", help="One-sentence goal outcome.")
    parser.add_argument("--force", action="store_true", help="Overwrite existing scaffold files.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()
    slug = slugify(args.slug or args.title)
    goal_dir = root / "goals" / slug
    goal_dir.mkdir(parents=True, exist_ok=True)

    files = {
        "brief.md": brief(args.title, args.objective),
        "plan.md": plan(args.title),
        "verification.md": verification(args.title),
        "blockers.md": blockers(args.title),
        "goal-prompt.md": goal_prompt(slug, args.title, args.objective),
    }
    for name, content in files.items():
        write_file(goal_dir / name, content, args.force)

    progress_path = goal_dir / "progress.jsonl"
    if not progress_path.exists() or args.force:
        write_file(progress_path, progress_entry(args.title, args.objective), args.force)

    print(goal_dir)
    for name in sorted([*files.keys(), "progress.jsonl"]):
        print(goal_dir / name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
