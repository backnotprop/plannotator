import { toRelativePath } from "./path-utils";

/**
 * Claude Code Review Agent — prompt, command builder, and JSONL output parser.
 *
 * Claude has its own review model (severity-based findings with reasoning traces)
 * separate from Codex's priority-based model. The transform layer normalizes
 * both into the shared annotation format.
 *
 * Claude uses --json-schema (inline JSON + Ajv validation with retries) and
 * --output-format stream-json for live JSONL streaming. The final event is
 * type:"result" with structured_output containing validated findings.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClaudeSeverity = "important" | "nit" | "pre_existing";

export interface ClaudeFinding {
  severity: ClaudeSeverity;
  file: string;
  line: number;
  end_line: number;
  description: string;
  reasoning: string;
}

export interface ClaudeReviewOutput {
  findings: ClaudeFinding[];
  summary: {
    important: number;
    nit: number;
    pre_existing: number;
  };
}

// ---------------------------------------------------------------------------
// Schema — Claude's own severity-based model
// ---------------------------------------------------------------------------

export const CLAUDE_REVIEW_SCHEMA_JSON = JSON.stringify({
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["important", "nit", "pre_existing"] },
          file: { type: "string" },
          line: { type: "integer" },
          end_line: { type: "integer" },
          description: { type: "string" },
          reasoning: { type: "string" },
        },
        required: ["severity", "file", "line", "end_line", "description", "reasoning"],
        additionalProperties: false,
      },
    },
    summary: {
      type: "object",
      properties: {
        important: { type: "integer" },
        nit: { type: "integer" },
        pre_existing: { type: "integer" },
      },
      required: ["important", "nit", "pre_existing"],
      additionalProperties: false,
    },
  },
  required: ["findings", "summary"],
  additionalProperties: false,
});

// ---------------------------------------------------------------------------
// Review prompt — converges open-source Claude Code review + remote service
// ---------------------------------------------------------------------------

export const CLAUDE_REVIEW_PROMPT = `# Claude Code Review System Prompt

## Identity
You are a code review system. Your job is to find bugs that would break
production. You are not a linter, formatter, or style checker unless
project guidance files explicitly expand your scope.

## Pipeline

Step 1: Gather context
  - Retrieve the PR diff or local diff (gh pr diff, git diff, or jj diff)
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
    the issue was confirmed — this becomes the \`reasoning\` field

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
- Your only output is the structured JSON findings`;

// ---------------------------------------------------------------------------
// Command builder
// ---------------------------------------------------------------------------

export interface ClaudeCommandResult {
  command: string[];
  /** Prompt text to write to stdin (Claude reads prompt from stdin, not argv). */
  stdinPrompt: string;
}

/**
 * Build the `claude -p` command. Prompt is passed via stdin, not as a
 * positional arg — avoids quoting issues, argv limits, and variadic flag conflicts.
 */
export function buildClaudeCommand(prompt: string, model: string = "claude-opus-4-7", effort?: string): ClaudeCommandResult {
  const allowedTools = [
    "Agent", "Read", "Glob", "Grep",
    // GitHub CLI
    "Bash(gh pr view:*)", "Bash(gh pr diff:*)", "Bash(gh pr list:*)",
    "Bash(gh issue view:*)", "Bash(gh issue list:*)",
    "Bash(gh api repos/*/*/pulls/*)", "Bash(gh api repos/*/*/pulls/*/files*)",
    "Bash(gh api repos/*/*/pulls/*/comments*)", "Bash(gh api repos/*/*/issues/*/comments*)",
    // GitLab CLI
    "Bash(glab mr view:*)", "Bash(glab mr diff:*)", "Bash(glab mr list:*)",
    "Bash(glab api:*)",
    // Git (read-only)
    "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
    "Bash(git show:*)", "Bash(git blame:*)", "Bash(git branch:*)",
    "Bash(git grep:*)", "Bash(git ls-remote:*)", "Bash(git ls-tree:*)",
    "Bash(git merge-base:*)", "Bash(git remote:*)", "Bash(git rev-parse:*)",
    "Bash(git show-ref:*)",
    // JJ (read-only)
    "Bash(jj status:*)", "Bash(jj diff:*)", "Bash(jj log:*)",
    "Bash(jj show:*)", "Bash(jj file show:*)", "Bash(jj cat:*)",
    "Bash(jj bookmark list:*)",
    "Bash(wc:*)",
  ].join(",");

  const disallowedTools = [
    "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch",
    "Bash(python:*)", "Bash(python3:*)", "Bash(node:*)", "Bash(npx:*)",
    "Bash(bun:*)", "Bash(bunx:*)", "Bash(sh:*)", "Bash(bash:*)", "Bash(zsh:*)",
    "Bash(curl:*)", "Bash(wget:*)",
  ].join(",");

  return {
    command: [
      "claude", "-p",
      "--permission-mode", "dontAsk",
      "--output-format", "stream-json",
      "--verbose",
      "--json-schema", CLAUDE_REVIEW_SCHEMA_JSON,
      "--no-session-persistence",
      "--model", model,
      ...(effort ? ["--effort", effort] : []),
      "--tools", "Agent,Bash,Read,Glob,Grep",
      "--allowedTools", allowedTools,
      "--disallowedTools", disallowedTools,
    ],
    stdinPrompt: prompt,
  };
}

// ---------------------------------------------------------------------------
// JSONL stream output parser
// ---------------------------------------------------------------------------

/**
 * Parse Claude Code's stream-json output (JSONL).
 * Extracts structured_output from the final type:"result" event.
 */
export function parseClaudeStreamOutput(stdout: string): ClaudeReviewOutput | null {
  if (!stdout.trim()) return null;

  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      const event = JSON.parse(line);

      if (event.type === 'result') {
        if (event.is_error) return null;

        const output = event.structured_output;
        if (!output || !Array.isArray(output.findings)) return null;

        return output as ClaudeReviewOutput;
      }
    } catch {
      // Not valid JSON — skip
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Finding transform — Claude findings → external annotations
// ---------------------------------------------------------------------------

/** Transform Claude findings into the external annotation format. */
export function transformClaudeFindings(
  findings: ClaudeFinding[],
  source: string,
  cwd?: string,
): Array<{
  source: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  type: string;
  side: string;
  scope: string;
  text: string;
  severity: ClaudeSeverity;
  reasoning: string;
  author: string;
}> {
  return findings
    .filter(f => f.file && typeof f.line === "number")
    .map(f => ({
      source,
      filePath: toRelativePath(f.file, cwd),
      lineStart: f.line,
      lineEnd: f.end_line ?? f.line,
      type: "comment",
      side: "new",
      scope: "line",
      text: `[${f.severity}] ${f.description}`,
      severity: f.severity,
      reasoning: f.reasoning,
      author: "Claude Code",
    }));
}

// ---------------------------------------------------------------------------
// Live log formatter
// ---------------------------------------------------------------------------

/**
 * Extract log-worthy content from a JSONL line for the LiveLogViewer.
 * Returns a human-readable string, or null if the line should be skipped.
 */
export function formatClaudeLogEvent(line: string): string | null {
  try {
    const event = JSON.parse(line);

    // Skip the final result event — handled separately
    if (event.type === 'result') return null;

    // Assistant messages (the agent's thinking/responses)
    if (event.type === 'assistant' && event.message?.content) {
      const parts = Array.isArray(event.message.content) ? event.message.content : [event.message.content];
      const texts = parts
        .filter((p: any) => p.type === 'text' && p.text)
        .map((p: any) => p.text);
      if (texts.length > 0) return texts.join('\n');

      // Tool use events (only reached if no text parts found)
      const tools = parts.filter((p: any) => p.type === 'tool_use');
      if (tools.length > 0) {
        return tools.map((t: any) => `[${t.name}] ${typeof t.input === 'string' ? t.input.slice(0, 100) : JSON.stringify(t.input).slice(0, 100)}`).join('\n');
      }
    }

    return null;
  } catch {
    return null;
  }
}
