# Plannotator Planning Overlay

Use the reusable planning framework at `/home/dzack/gitclones/ai/planning/AGENTS.md` as the source of truth for card semantics, hierarchy, layer gates, spec discipline, generated tags, recipes, validation, and hooks.

This file records only Plannotator-specific choices.

## Local Framework Wiring

Plannotator uses the central planning framework instead of carrying local copies of framework logic.

- Canonical framework docs: `/home/dzack/gitclones/ai/planning/AGENTS.md`
- Canonical justfile: `/home/dzack/gitclones/ai/planning/justfile`
- Local recipe shim: `../justfile`
- Local card root: `plans/features`
- Generated DAG: `plans/plan-dag.md`

The planning schemas in `.nimbalyst/trackers/` are symlinks to the central framework schemas:

- `.nimbalyst/trackers/feature.yaml`
- `.nimbalyst/trackers/spec.yaml`
- `.nimbalyst/trackers/plan.yaml`
- `.nimbalyst/trackers/phase.yaml`
- `.nimbalyst/trackers/task.yaml`

Do not replace those symlinks with local schema copies. If the framework schema is wrong, edit `/home/dzack/gitclones/ai/planning/schemas/` and validate Plannotator against the central schemas.

## Local Feature Tree

Current planning cards live under:

```text
plans/features/FEATURE-DAEMON-REFACTOR/
├── FEATURE-DAEMON-REFACTOR.md
├── SPEC-DAEMON-E2E-CERTIFICATION.md
├── decisions/
│   ├── DECISION-D1.md
│   ├── DECISION-D2.md
│   ├── DECISION-D3.md
│   ├── DECISION-D4.md
│   ├── DECISION-D5.md
│   └── DECISION-D6.md
└── plans/
    └── PLAN-NIM-R/
```

`FEATURE-DAEMON-REFACTOR` is the feature container. `PLAN-NIM-R` is the implementation roadmap under that feature. Feature-level decisions live in `decisions/` and block plans, phases, or tasks through `dependsOn`; they are not nested under the plan or phase hierarchy. Phases are siblings under their owning plan; use `dependsOn` for sequencing between phases.

## Validation

Run the local shim from the repo root:

```bash
just validate plans/features .nimbalyst/trackers plans/plan-dag.md
git diff --check -- plans .nimbalyst/trackers justfile
```

The local `justfile` delegates to the central planning justfile. Validation rederives tags, checks schemas, and regenerates `plans/plan-dag.md`.
