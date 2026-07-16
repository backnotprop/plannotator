# Custom Reviews

A custom review is an Agent Skill. Point Plannotator at a skill and it runs the
review using that skill's instructions. The skill becomes the review. The
default review instructions are not added, and findings come back the same way.

## Turn one on

You already keep skills in your global folders (`~/.claude/skills`,
`~/.codex/skills`, `~/.agents/skills`). List the ones you want as reviews in
`~/.plannotator/review-skills.json`:

```json
{ "version": 1, "enabled": ["security-review", "api-contracts"] }
```

The names are the skill folder names. Run a code review, pick the skill, run it.
Findings come back the way they do today.

No `review-skills.json`? You get the default review, unchanged.

## How it works

Plannotator reads the skill's `SKILL.md` body at launch and uses it as the
review prompt. The skill defines the review; the default review prompt is
dropped, and the user message is trimmed to the git or PR context the agent
needs to find the changes. The read is live. Edit the skill the normal way and
the next review picks it up. Nothing is copied.

Some skills carry `references/`, `scripts/`, or `assets/`. For those, Plannotator
tells the agent where the skill folder is, and the agent opens those files on
demand from where they already live.

## What counts as a skill

The name is the folder name. The instructions are the `SKILL.md` body with the
leading frontmatter block stripped off. Plannotator does not read the
frontmatter: no `name`, no `description`, no YAML.

Global skills only. A skill checked into a repo is ignored. (A pull request from
a fork could otherwise drop instructions straight into your reviewer.)

## Coming from JSON profiles

The old `~/.plannotator/reviews/*.json` profiles are gone. To move one over: put
its instructions text in a `SKILL.md` under a global skill folder, then add that
skill's name to `~/.plannotator/review-skills.json`.
