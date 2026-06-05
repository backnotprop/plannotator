---
name: plannotator-visual-explainer
disable-model-invocation: true
description: >
  Generate self-contained HTML visualizations with Plannotator theming. Use for implementation
  plans, PR explainers, architecture diagrams, data tables, slide decks, and any visual
  explanation of technical concepts. Plans and PR explainers follow Plannotator's prescriptive
  approach; all other visual content delegates to nicobailon/visual-explainer.
---

# Plannotator Visual Explainer

Three paths depending on content type. Each has its own references and structure.

## Route by content type

**Implementation plan, design doc, or proposal** → Follow the [Plan path](#plan-path). Read `references/design-system.md` and `references/svg-patterns.md`. Prescriptive structure.

**PR explainer, diff review, or code change walkthrough** → Follow the [PR path](#pr-path). Read `references/design-system.md` and `references/pr-components.md`. Prescriptive structure.

**Everything else** (architecture diagrams, data tables, slide decks, project recaps, general visual explanations) → Follow the [Visual explainer path](#visual-explainer-path). Delegates to nicobailon/visual-explainer with Plannotator theme tokens.

## Delivery

Always deliver via Plannotator's annotation UI. Do NOT use `open` or `xdg-open`.

**Plans/proposals** (user should approve/deny):
```bash
plannotator annotate <file> --render-html --gate
```

**Everything else** (informational):
```bash
plannotator annotate <file> --render-html
```

---

## Plan path

For implementation plans, design docs, feature specs, migration guides, and proposals.

**Before generating, read:**
1. `references/design-system.md` — Plannotator theme tokens, typography, component patterns
2. `references/svg-patterns.md` — inline SVG building blocks for architecture diagrams, flowcharts, data flow

**Document structure (in order, pick what fits):**

1. **Header** — eyebrow label (mono, uppercase), title (serif, large), prompt box (the original brief)
2. **Summary strip** — 3-5 stat cards showing key numbers at a glance (components, endpoints, tables, etc.)
3. **Milestones / timeline** — vertical timeline showing phases without time estimates. Phases show sequence and dependencies, not duration.
4. **Architecture / data flow** — inline SVG diagram. Use for 3+ interacting components. Highlighted boxes for new components, dashed arrows for async paths.
5. **Mockups** — build UI mockups in HTML/CSS directly, not as descriptions
6. **Key code** — dark-theme code blocks with syntax highlighting. Only architecturally significant interfaces/schemas — not every function.
7. **Risks & mitigations** — table with severity badges (HIGH/MED/LOW)
8. **Open questions** — callout cards with decision owner ("Decide with: backend team")

Not every plan needs every section. Skip what doesn't serve the content. Never include time estimates, boilerplate sections, or exhaustive file lists.

**Adapt to the task:** Backend → lead with data flow. Frontend → lead with mockups. Refactoring → lead with before/after diagrams. Infrastructure → lead with architecture.

**Quality bar:** The plan answers "what, why, and how" within 30 seconds of reading. Whitespace is a feature — one idea per viewport.

---

## PR path

For PR walkthroughs, diff reviews, code change explainers, and reviewer guides.

**Before generating, read:**
1. `references/design-system.md` — Plannotator theme tokens, typography, component patterns
2. `references/pr-components.md` — diff rendering, review comment bubbles, risk chips, file cards, before/after panels

**Document structure (in order, pick what fits):**

1. **Header** — PR title, meta strip (file count, +/- lines, branch, author)
2. **TL;DR** — bordered card with primary accent left border. 2-3 sentences. Readers who see nothing else should get the gist.
3. **Why** — motivation and before/after comparison (two-column grid)
4. **File tour** — collapsible cards per file. Each has: file path + badge (NEW/MOD/DEL) + line stats, a "why" paragraph, and important diff hunks. High-risk files expanded, safe files collapsed.
5. **Risk map** — visual chips showing which files need careful review vs. which are mechanical. Three tiers: attention (destructive), medium (warning), safe (success).
6. **Where to focus** — numbered callout cards. Each names a file/function and describes the concern.
7. **Test plan** — checkbox-style verification checklist
8. **Rollout** (if applicable) — phased deployment with feature flags

Use Pierre diffs via CDN for syntax-highlighted inline diffs — see `references/pr-components.md` for the pattern.

---

## Visual explainer path

For architecture diagrams, data tables, slide decks, project recaps, comparisons, and any other visual explanation.

**Before generating:**

1. Ensure `visual-explainer` is installed:
   - Check: `~/.claude/skills/visual-explainer/SKILL.md` or `~/.agents/skills/visual-explainer/SKILL.md`
   - If not found: `npx skills add nicobailon/visual-explainer -g --yes`
2. Read visual-explainer's `SKILL.md` (workflow, diagram types, anti-slop rules)
3. Read the relevant visual-explainer references and templates for your content type
4. Read `references/theme-override.md` — Plannotator tokens replacing Nico's palettes

Follow visual-explainer's structure, component classes (`.ve-card`, `.kpi-card`, `.pipeline`), and anti-slop rules. The only override is the color/typography layer — Plannotator tokens instead of Nico's custom palettes.

---

## Design philosophy (all paths)

- **Whitespace is a feature.** Generous padding, large section gaps. If cramped, add space — don't shrink text.
- **One idea per viewport.** Hero section, then diagram, then detail grid — not all crammed together.
- **Show, don't describe.** A timeline shows sequencing. A diagram shows relationships. A code block shows the interface.
- **No time estimates.** Timelines show phases and dependencies. Never attach hour/day estimates.
