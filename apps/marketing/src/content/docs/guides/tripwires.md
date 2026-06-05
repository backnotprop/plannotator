---
title: "Tripwires"
description: "Mark slop-free zones so any change that touches a protected file or symbol surfaces a warning during code review."
sidebar:
  order: 17
section: "Guides"
---

Tripwires let you mark **slop-free zones** — the parts of your codebase that agents and people must not casually touch. When a diff changes one of those files or symbols, Plannotator surfaces an unmissable amber warning during code review. No gates, no modals, no blocking. Just a clear signal that says "be careful, you're in a protected area."

Some code is load-bearing in ways that aren't obvious from the diff: a hand-tuned query, a security check, a migration that already shipped, a config the whole deploy depends on. An agent will happily rewrite any of it with full confidence. Tripwires give that code a perimeter so a careless edit doesn't slip through review unnoticed.

## Configuration

Tripwires live in two layers that are merged together:

- **Global** — a private file that is auto-created the first time you review in a repo and lives at `~/.plannotator/tripwires/<project-key>.json` (under your home `~/.plannotator` data directory, or wherever `PLANNOTATOR_DATA_DIR` points). It is **never committed** — it follows you across machines only if you sync your data directory, and it stays with you across every repo you work in.
- **Repo** (optional) — a committed file at `.plannotator/tripwires.json` in the repo root. This is the team opt-in: anyone who clones the repo gets these rules.

Both layers use the same shape. Each file has one top-level key, `rules`, which is an array. Each rule names the files it protects (`globs`), optionally the symbols within them (`symbols`), and an optional `note` explaining why the zone is protected. The two layers are merged additively — global rules first, then repo rules appended on top — so a repo rule never overrides a global one; both apply.

```json
{
  "rules": [
    {
      "id": "rule-id",
      "globs": ["src/auth/**"],
      "symbols": ["verifyToken", "hashPassword"],
      "note": "Security-critical — changes need a second reviewer."
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | No | Identifier for the rule. Defaults to `rule-<index>` if omitted. |
| `globs` | Yes | One or more repo-relative glob patterns. A rule with no valid globs is dropped. |
| `symbols` | No | Names that narrow the rule to lines mentioning those symbols. Omit to protect every change in the matched files. |
| `note` | No | Message shown on the warning. Defaults to `Touches a slop-free zone`. |

### Config locations

The global file is keyed to the repository, not the folder. Plannotator derives the key from the repo's `origin` remote (so `git@github.com:you/app.git`, `https://github.com/you/app.git`, and an SSH URL with a custom port all resolve to the same project key). Repos with no remote fall back to the repository's shared git directory, so **linked worktrees of the same clone share one global file** rather than each getting their own.

The two layers are merged by concatenation, global first. If a rule in each layer happens to share an `id`, the duplicate is renamed (`my-rule`, `my-rule-2`) so both still apply rather than one silently shadowing the other.

You don't have to create either file by hand. The global file is created empty (`{ "rules": [] }`) the first time you review in a repo, and you can manage both layers from the command line:

```bash
plannotator tripwires list      # show the merged global + repo rules
plannotator tripwires validate  # check both files and report any problems
plannotator tripwires path      # print the path to each layer's file
```

Add rules directly with flags — global by default, or into the repo-committed file with `--repo` (the only time Plannotator ever writes inside your repo, because you asked):

```bash
plannotator tripwires add --glob "src/billing/**" --symbol chargeCard --note "Money path"
plannotator tripwires add --glob "migrations/**" --repo   # team-shared, committed
```

Or describe what you want protected in plain language — from the terminal or inside your agent:

```bash
plannotator tripwires add protect the auth core and token validation
plannotator review --add-tripwire the billing module and anything touching refunds
```

The description form **prints instructions for your agent**: explore the repo, turn the description into concrete globs and symbols, write the rule into the indicated file, then validate and show the result. The command itself never writes files in this mode.

### Example: protect whole files

The simplest tripwire watches a set of files. Any change anywhere in them trips the wire.

```json
{
  "rules": [
    {
      "globs": ["migrations/**", "db/schema.sql"],
      "note": "Schema changes ship to production — review carefully."
    }
  ]
}
```

### Example: protect specific symbols

Add `symbols` to narrow a rule to changes that touch particular functions, constants, or types. Only changes mentioning one of those names within the matched files will trip.

```json
{
  "rules": [
    {
      "globs": ["packages/billing/**"],
      "symbols": ["chargeCard", "PRICE_TABLE", "refund"],
      "note": "Money-touching code — get sign-off before changing."
    }
  ]
}
```

## Glob syntax

Globs are matched against repo-relative paths:

- `*` matches anything within a single path segment (does not cross `/`)
- `**` matches across path segments, including none
- `?` matches a single character
- A leading `**/` also matches files at the repo root, so `**/config.ts` matches both `config.ts` and `src/config.ts`

Examples:

- `src/auth/**` — every file under `src/auth/`
- `**/*.sql` — every `.sql` file anywhere in the repo
- `packages/*/index.ts` — `index.ts` directly inside any package folder

## What trips a wire

The rule is simple: **any change that touches a tripwired file or symbol trips the wire.** That includes:

- **Adding** new lines in a protected file
- **Editing** existing lines
- **Deleting** lines
- **Renaming** a protected file (matched against either the old or new path)

If a rule has `symbols`, only changes that mention one of those names count. If it has no `symbols`, any change in the matched files trips it.

## How hits surface

Tripwires are re-evaluated every time the diff loads — on initial review, on diff-type switches, and on PR switches. When a change trips a wire, you'll see it in three places:

- **Gutter marker** — an amber warning marker on the affected line in the diff, with the rule's note. Click it to jump to the matching entry in the sidebar.
- **Sidebar list** — each hit appears as an amber-accented card with its note and the file it touched. Click a card to jump to the line, or to the file panel for file-scope hits (renames that have no single line to anchor to).
- **File tree** — protected files that were touched show an amber warning glyph next to their name, so you can spot them before opening the diff.

Because tripwires are re-evaluated on every diff and PR switch, a hit you've already seen will reappear after you switch views. This is intended — the warning reflects the current diff, not a dismissible to-do.

## Tripwires are informational only

Tripwires never block anything and they are **never included in the feedback sent back to the agent.** They are a signal for the human reviewer, not an instruction for the agent. When you click **Send Feedback**, only your own annotations are submitted — tripwire warnings are filtered out entirely, and they don't count toward the annotation total that gates submission.

## Non-interactive scan

You don't have to open the review UI to see what would trip. Run:

```bash
plannotator review --tripwires
```

(or `-t`) to print a report instead of opening the browser. The report lists the rules from each layer and a live status section showing which wires the current diff trips. It's handy for a quick check, for scripting, or for letting an agent see the slop-free zones it's about to touch.

## Fail-open behavior

If either tripwires file is missing, empty, or malformed, tripwires simply do nothing for that layer — review proceeds exactly as it would without it. The two layers fail independently: a broken repo file never wipes out your global rules, and a broken global file never wipes out the repo's. A single broken rule never discards its siblings; the valid rules still apply. You can't break code review by writing a bad config.

## PR mode

Tripwires evaluate during PR review as well. Your **global** rules still fire in PR mode — they're keyed to the repository you launched the review from, so the same slop-free zones you've set up locally apply even without a checkout of the PR. The **repo** layer needs a local checkout of the repo, since its config file lives in the working tree; without one, only the global rules fire.
