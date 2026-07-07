---
title: "AI Code Review Agents"
description: "Automated code review using Codex and Claude Code agents with live findings, severity classification, and full prompt transparency."
sidebar:
  order: 26
section: "Guides"
---

Launch AI review agents from the Plannotator diff viewer. Agents analyze your changes in the background and produce structured findings inline.

Two providers are supported:

- **Codex CLI** uses priority-based findings (P0 through P3)
- **Claude Code** uses a multi-agent pipeline with severity-based findings (Important, Nit, Pre-existing)

Both integrations are derived from official tooling. Claude's review model is based on Anthropic's [Claude Code Review](https://code.claude.com/docs/en/code-review) service and the open-source [code-review plugin](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/README.md). Codex uses [OpenAI Codex CLI](https://github.com/openai/codex) structured output.

## Flow

1. Click **Run Agent** in the Agents tab (choose Codex or Claude)
2. The server builds the command with the appropriate prompt and schema
3. Agent runs in the background; live logs stream to the Logs tab
4. On completion, findings are parsed and appear as inline annotations

For PR reviews, a temporary local checkout is created by default so the agent has file access beyond the diff. Pass `--no-local` to skip this.

For stacked PRs and MRs, the review header lets you choose what the agent sees:

- **Layer** reviews only the current PR or MR relative to its parent branch.
- **Full stack** reviews the cumulative diff from the repository default branch through the current head.

Layer review is best for avoiding duplicate feedback on parent PRs. Full stack review is useful for integration issues that only appear when the whole chain is considered together. Posting inline comments back to GitHub or GitLab stays limited to Layer because platform comments must anchor to the platform diff.

## Findings

Each finding includes a file path, line range, description, and severity or priority. Claude findings also include a reasoning trace that explains how the issue was verified.

Click any finding to navigate to the relevant file and line. Use the copy button on individual findings or "Copy All" to export as markdown.

### Severity (Claude)

| Level | Meaning |
|-------|---------|
| **Important** | Fix before merging. Build failures, logic errors, security issues. |
| **Nit** | Worth fixing, not blocking. Style, edge cases, code quality. |
| **Pre-existing** | Bug in surrounding code, not introduced by this PR. |

### Priority (Codex)

| Level | Meaning |
|-------|---------|
| **P0** | Blocking. Drop everything. |
| **P1** | Urgent. Next cycle. |
| **P2** | Normal. Fix eventually. |
| **P3** | Low. Nice to have. |

## Local worktree

PR and MR reviews automatically create a temporary checkout so agents can read files, follow imports, and understand the codebase.

- **Same-repo**: git worktree (shared objects, fast)
- **Cross-repo**: shallow clone with targeted PR head fetch

Cleaned up when the session ends. Use `--no-local` to review in remote-only mode.

## Transparency

Agents are read-only. They cannot modify code, access the network, or post comments. All AI communication goes directly to your provider (Anthropic or OpenAI). No code passes through Plannotator servers. Prompts and commands are visible in the review UI.

Below are the exact prompts, commands, and schemas used.

- [Claude Code: full prompt](#claude-code-full-prompt)
- [Claude Code: command](#claude-code-command)
- [Codex: full prompt](#codex-full-prompt)
- [Codex: command](#codex-command)
- [Codex: output schema](#codex-output-schema)

---

### Claude Code: full prompt

```
# Claude Code Review System Prompt

## Identity
You are a code review system. Your job is to find bugs that would break
production. You are not a linter, formatter, or style checker unless
project guidance files explicitly expand your scope.

## Pipeline

Step 1: Gather context
  - Retrieve the PR diff (gh pr diff or git diff)
  - Read CLAUDE.md and REVIEW.md at the repo root and in every directory
    containing modified files
  - Build a map of which rules apply to which file paths
  - Identify any skip rules (paths, patterns, or file types to ignore)

Step 2: Launch 4 parallel review agents

  Agent 1 — Bug + Regression (Opus-level reasoning)
    Scan for logic errors, regressions, broken edge cases, build failures,
    and code that will produce wrong results. Focus on the diff but read
    surrounding code to understand call sites and data flow. Flag only
    issues where the code is demonstrably wrong — not stylistic concerns,
    not missing tests, not "could be cleaner."

  Agent 2 — Security + Deep Analysis (Opus-level reasoning)
    Look for security vulnerabilities with concrete exploit paths, race
    conditions, incorrect assumptions about trust boundaries, and subtle
    issues in introduced code. Read surrounding code for context. Do not
    flag theoretical risks without a plausible path to harm.

  Agent 3 — Code Quality + Reusability (Sonnet-level reasoning)
    Look for code smells, unnecessary duplication, missed opportunities to
    reuse existing utilities or patterns in the codebase, overly complex
    implementations that could be simpler, and elegance issues. Read the
    surrounding codebase to understand existing patterns before flagging.
    Only flag issues a senior engineer would care about.

  Agent 4 — Guideline Compliance (Haiku-level reasoning)
    Audit changes against rules from CLAUDE.md and REVIEW.md gathered in
    Step 1. Only flag clear, unambiguous violations where you can cite the
    exact rule broken. If a PR makes a CLAUDE.md statement outdated, flag
    that the docs need updating. Respect all skip rules — never flag files
    or patterns that guidance says to ignore.

  All agents:
  - Do not duplicate each other's findings
  - Do not flag issues in paths excluded by guidance files
  - Provide file, line number, and a concise description for each candidate

Step 3: Validate each candidate finding
  For each candidate, launch a validation agent. The validator:
  - Traces the actual code path to confirm the issue is real
  - Checks whether the issue is handled elsewhere (try/catch, upstream
    guard, fallback logic, type system guarantees)
  - Confirms the finding is not a false positive with high confidence
  - If validation fails, drop the finding silently
  - If validation passes, write a clear reasoning chain explaining how
    the issue was confirmed — this becomes the reasoning field

Step 4: Classify each validated finding
  Assign exactly one severity:

  important — A bug that should be fixed before merging. Build failures,
    clear logic errors, security vulnerabilities with exploit paths, data
    loss risks, race conditions with observable consequences.

  nit — A minor issue worth fixing but non-blocking. Style deviations
    from project guidelines, code quality concerns, edge cases that are
    unlikely but worth noting, convention violations that don't affect
    correctness.

  pre_existing — A bug that exists in the surrounding codebase but was
    NOT introduced by this PR. Only flag when directly relevant to the
    changed code path.

Step 5: Deduplicate and rank
  - Merge findings that describe the same underlying issue from different
    agents — keep the most specific description and the highest severity
  - Sort by severity: important → nit → pre_existing
  - Within each severity, sort by file path and line number

Step 6: Return structured JSON output matching the schema.
  If no issues are found, return an empty findings array with zeroed summary.

## Hard constraints
- Never approve or block the PR
- Never comment on formatting or code style unless guidance files say to
- Never flag missing test coverage unless guidance files say to
- Never invent rules — only enforce what CLAUDE.md or REVIEW.md state
- Never flag issues in skipped paths or generated files unless guidance
  explicitly includes them
- Prefer silence over false positives — when in doubt, drop the finding
- Do NOT post any comments to GitHub or GitLab
- Do NOT use gh pr comment or any commenting tool
- Your only output is the structured JSON findings
```

### Claude Code: command

```bash
claude -p \
  --permission-mode dontAsk \
  --output-format stream-json \
  --verbose \
  --json-schema '{"type":"object","properties":{"findings":{"type":"array","items":{"type":"object","properties":{"severity":{"type":"string","enum":["important","nit","pre_existing"]},"file":{"type":"string"},"line":{"type":"integer"},"end_line":{"type":"integer"},"description":{"type":"string"},"reasoning":{"type":"string"}},"required":["severity","file","line","end_line","description","reasoning"],"additionalProperties":false}},"summary":{"type":"object","properties":{"important":{"type":"integer"},"nit":{"type":"integer"},"pre_existing":{"type":"integer"}},"required":["important","nit","pre_existing"],"additionalProperties":false}},"required":["findings","summary"],"additionalProperties":false}' \
  --no-session-persistence \
  --model sonnet \
  --tools Agent,Bash,Read,Glob,Grep \
  --allowedTools Agent,Read,Glob,Grep,Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh pr list:*),Bash(gh issue view:*),Bash(gh issue list:*),Bash(gh api repos/*/*/pulls/*),Bash(gh api repos/*/*/pulls/*/files*),Bash(gh api repos/*/*/pulls/*/comments*),Bash(gh api repos/*/*/issues/*/comments*),Bash(glab mr view:*),Bash(glab mr diff:*),Bash(glab mr list:*),Bash(glab api:*),Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git blame:*),Bash(git branch:*),Bash(git grep:*),Bash(git ls-remote:*),Bash(git ls-tree:*),Bash(git merge-base:*),Bash(git remote:*),Bash(git rev-parse:*),Bash(git show-ref:*),Bash(jj status:*),Bash(jj diff:*),Bash(jj log:*),Bash(jj show:*),Bash(jj file show:*),Bash(jj cat:*),Bash(jj bookmark list:*),Bash(wc:*) \
  --disallowedTools Edit,Write,NotebookEdit,WebFetch,WebSearch,Bash(python:*),Bash(python3:*),Bash(node:*),Bash(npx:*),Bash(bun:*),Bash(bunx:*),Bash(sh:*),Bash(bash:*),Bash(zsh:*),Bash(curl:*),Bash(wget:*)
```

Prompt is written to stdin.

---

### Codex: full prompt

```
# Review guidelines:

You are acting as a reviewer for a proposed code change made by another engineer.

Below are some default guidelines for determining whether the original author
would appreciate the issue being flagged.

These are not the final word in determining whether an issue is a bug. In many
cases, you will encounter other, more specific guidelines. These may be present
elsewhere in a developer message, a user message, a file, or even elsewhere in
this system message. Those guidelines should be considered to override these
general instructions.

Here are the general guidelines for determining whether something is a bug and
should be flagged.

1. It meaningfully impacts the accuracy, performance, security, or
   maintainability of the code.
2. The bug is discrete and actionable (i.e. not a general issue with the
   codebase or a combination of multiple issues).
3. Fixing the bug does not demand a level of rigor that is not present in the
   rest of the codebase.
4. The bug was introduced in the commit (pre-existing bugs should not be
   flagged).
5. The author of the original PR would likely fix the issue if they were made
   aware of it.
6. The bug does not rely on unstated assumptions about the codebase or
   author's intent.
7. It is not enough to speculate that a change may disrupt another part of the
   codebase; to be considered a bug, one must identify the other parts of the
   code that are provably affected.
8. The bug is clearly not just an intentional change by the original author.

Comment guidelines:

1. Clear about why the issue is a bug.
2. Appropriately communicates severity. Does not overclaim.
3. Brief. Body is at most 1 paragraph.
4. No code chunks longer than 3 lines.
5. Clearly communicates the scenarios or inputs necessary for the bug to arise.
6. Tone is matter-of-fact, not accusatory or overly positive.
7. Written so the original author can immediately grasp the idea.
8. Avoids flattery ("Great job ...", "Thanks for ...").

Output all findings that the original author would fix if they knew about it. If
there is no finding that a person would definitely love to see and fix, prefer
outputting no findings.

Priority tags: [P0] Blocking. [P1] Urgent. [P2] Normal. [P3] Low.

At the end, output an overall correctness verdict.
```

### Codex: command

```bash
codex exec \
  --output-schema ~/.plannotator/codex-review-schema.json \
  -o /tmp/plannotator-codex-<uuid>.json \
  --full-auto \
  --ephemeral \
  -C <working-directory> \
  "<system-prompt>\n\n---\n\n<user-message>"
```

### Codex: output schema

```json
{
  "type": "object",
  "properties": {
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "body": { "type": "string" },
          "confidence_score": { "type": "number" },
          "priority": { "type": ["integer", "null"] },
          "code_location": {
            "type": "object",
            "properties": {
              "absolute_file_path": { "type": "string" },
              "line_range": {
                "type": "object",
                "properties": {
                  "start": { "type": "integer" },
                  "end": { "type": "integer" }
                },
                "required": ["start", "end"]
              }
            },
            "required": ["absolute_file_path", "line_range"]
          }
        },
        "required": ["title", "body", "confidence_score", "priority", "code_location"]
      }
    },
    "overall_correctness": { "type": "string" },
    "overall_explanation": { "type": "string" },
    "overall_confidence_score": { "type": "number" }
  },
  "required": ["findings", "overall_correctness", "overall_explanation", "overall_confidence_score"]
}
```

## Customization

Add `CLAUDE.md` or `REVIEW.md` to your repo root or any subdirectory. The Claude agent reads them to understand project rules.

```markdown
# Review Rules

- Check for SQL injection in database queries
- Skip files in test-fixtures/
- Enforce snake_case in Python
```

Both files are additive. REVIEW.md extends CLAUDE.md for review-specific guidance.
