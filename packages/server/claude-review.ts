import {
  composeReviewPrompt,
  type ResolvedReviewProfile,
} from "@plannotator/shared/review-profiles";
import {
  transformSeverityFindings,
  type ReviewSeverity,
  type ReviewFinding,
  type ReviewAnnotationInput,
} from "./review-findings";

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

// Claude findings ARE review findings — reuse the one shared shape from
// review-findings.ts rather than keeping a byte-identical copy that can drift.
export type ClaudeSeverity = ReviewSeverity;
export type ClaudeFinding = ReviewFinding;

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
          // Nullable, not omitted: keep every property in `required` so the
          // schema is valid under strict structured-output validators too. A
          // whole-file finding sets line/end_line null; a general finding also
          // sets file null.
          file: { type: ["string", "null"] },
          line: { type: ["integer", "null"] },
          end_line: { type: ["integer", "null"] },
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
  Place each finding by how specific it is: give file and line for a line-level
  issue; give file and set line null for a whole-file issue; set file and line
  null for a general, review-level note. Never invent a line you are unsure of —
  drop to a file or general placement instead of guessing.
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
// Prompt composition
// ---------------------------------------------------------------------------

/**
 * Compose Claude's review prompt: the immutable system prompt, the resolved
 * profile's Custom Review Profile section (omitted for builtin:default), then
 * the user review message. For builtin:default / no profile the output is
 * byte-identical to today's `CLAUDE_REVIEW_PROMPT + "\n\n---\n\n" + userMessage`.
 */
export function composeClaudeReviewPrompt(
  userMessage: string,
  reviewProfile?: ResolvedReviewProfile,
): string {
  return composeReviewPrompt(CLAUDE_REVIEW_PROMPT, reviewProfile, userMessage);
}

// ---------------------------------------------------------------------------
// Command builder
// ---------------------------------------------------------------------------

/** Options shared by every Claude Code agent-job command builder. */
export interface ClaudeJobCommandOptions {
  /** False turns Claude Code's sandbox off for this job only (see
   *  `claudeJobIsolationArgs`). Callers resolve this via
   *  resolveClaudeSandbox() (PLANNOTATOR_CLAUDE_SANDBOX / config.json
   *  `claudeSandbox`); the builders stay env-free. Default: the user's own
   *  Claude Code sandbox setting applies. */
  sandbox?: boolean;
}

/**
 * Appended to the system prompt of every Claude agent job. Jobs run under
 * `--permission-mode dontAsk` with a prefix allowlist, so a compound shell
 * command (`MB=$(git merge-base ...) && git log $MB`) is refused as a whole
 * even when every part is allowlisted, and models reach for exactly that
 * shape (#1627).
 */
export const CLAUDE_JOB_SHELL_GUIDANCE =
  "Shell access in this session is limited to an allowlist of read-only commands, " +
  "and anything outside it is refused without a prompt. Run each command on its own " +
  "as one simple invocation: no `&&`, `||`, `;`, pipes, redirects, `$(...)` or shell " +
  "variables. If you need a value from one command (such as a merge-base sha), run it, " +
  "read the output, then pass the literal value to the next command.";

/**
 * Arguments that keep a Claude agent job hermetic and runnable (#1627):
 *
 * - `--strict-mcp-config` with no `--mcp-config`: loads NO MCP servers, so the
 *   user's own servers (IDE bridges, SaaS connectors) never reach a review
 *   job. The allowlist already refuses them; without this flag the model
 *   still sees them and wanders off to them when Bash fails.
 * - `--append-system-prompt`: the single-command guidance above.
 * - `sandbox: false` → `--settings {"sandbox":{"enabled":false}}`. Where
 *   Claude Code's sandbox cannot start (Linux without bubblewrap/socat,
 *   AppArmor-restricted user namespaces), a command falls back to running
 *   unsandboxed only with permission, which dontAsk refuses, so every Bash
 *   call fails. Opting out runs the job's commands WITHOUT OS containment,
 *   exactly like any user who never enabled Claude's sandbox (Claude Code's
 *   default). `--tools`, the command allowlist and the disallow list are
 *   unchanged, but the allowlist LIMITS what the model can run; it does not
 *   contain it (allowlisted prefixes such as `git -C` or `gh api` accept
 *   arguments that execute or write). `--settings` outranks user/project
 *   settings but not managed policy, so an enterprise-enforced sandbox wins.
 */
export function claudeJobIsolationArgs(opts?: ClaudeJobCommandOptions): string[] {
  return [
    "--strict-mcp-config",
    "--append-system-prompt", CLAUDE_JOB_SHELL_GUIDANCE,
    ...(opts?.sandbox === false ? ["--settings", JSON.stringify({ sandbox: { enabled: false } })] : []),
  ];
}

export interface ClaudeCommandResult {
  command: string[];
  /** Prompt text to write to stdin (Claude reads prompt from stdin, not argv). */
  stdinPrompt: string;
}

/**
 * Build the `claude -p` command. Prompt is passed via stdin, not as a
 * positional arg — avoids quoting issues, argv limits, and variadic flag conflicts.
 */
export function buildClaudeCommand(
  prompt: string,
  model: string = "opus",
  effort?: string,
  opts?: ClaudeJobCommandOptions,
): ClaudeCommandResult {
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
    "Bash(git show-ref:*)", "Bash(git -C:*)",
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
      ...claudeJobIsolationArgs(opts),
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
  pathTransform?: (path: string) => string,
): ReviewAnnotationInput[] {
  // Routing (line / whole-file / general) is shared with the marker engines in
  // review-findings.ts — nothing is dropped; only the author differs.
  return transformSeverityFindings(findings, source, "Claude Code", cwd, pathTransform);
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

// ---------------------------------------------------------------------------
// Blocked-shell detection (#1627)
// ---------------------------------------------------------------------------

/** Job warning shown when a Claude job could not run a single shell command. */
export const CLAUDE_SHELL_BLOCKED_WARNING =
  "Claude Code refused every shell command this job tried, so it could not inspect the repository with git. " +
  "If your Claude Code settings enable its sandbox and the sandbox cannot start on this machine " +
  "(for example Linux without bubblewrap and socat), set PLANNOTATOR_CLAUDE_SANDBOX=0 or " +
  "{ \"claudeSandbox\": false } in ~/.plannotator/config.json and run the job again.";

/** A Bash tool_result that reads as a refusal rather than a command's own failure. */
function isBashRefusal(content: unknown): boolean {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join(" ")
      : "";
  return /permission to use bash has been denied|sandbox/i.test(text);
}

/** `Bash(<pattern>)` entries of an `--allowedTools` value, as matchers for one
 *  whole command: `git log:*` is the prefix `git log` followed by nothing or
 *  whitespace; `*` elsewhere matches any run of characters. */
function allowlistMatchers(allowedTools: string): RegExp[] {
  const out: RegExp[] = [];
  for (const m of allowedTools.matchAll(/Bash\(([^)]*)\)/g)) {
    let pattern = m[1].trim();
    const prefixForm = pattern.endsWith(":*");
    if (prefixForm) pattern = pattern.slice(0, -2);
    if (!pattern) continue;
    const body = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    out.push(new RegExp(`^${body}${prefixForm ? "(\\s|$)" : "$"}`));
  }
  return out;
}

/** A command the job's allowlist admits outright: one invocation with no shell
 *  operators, substitutions, redirects or variables, matching a `Bash(...)`
 *  entry. `dontAsk` never refuses such a command unless the shell itself is
 *  unavailable (the sandbox cannot start and the unsandboxed fallback needs a
 *  permission prompt). */
function isPlainAllowlistedCommand(command: unknown, matchers: RegExp[]): boolean {
  if (typeof command !== "string") return false;
  const cmd = command.trim();
  if (!cmd || /[|&;<>`$\n\\(){}]/.test(cmd)) return false;
  return matchers.some((re) => re.test(cmd));
}

/**
 * Decide from a Claude job's stream-json stdout whether its shell was blocked
 * outright, the #1627 shape. Rule: at least one refused Bash call was a PLAIN
 * command its own allowlist admits (see isPlainAllowlistedCommand; refused
 * means listed in the result event's `permission_denials`, or answered by an
 * error tool_result that reads as a permission/sandbox refusal) AND not one
 * Bash call succeeded.
 *
 * Refusals of compound commands, variables or commands outside the allowlist
 * never count: `dontAsk` refuses those by design and the model's next single
 * command usually works. A plain allowlisted command is only refused when the
 * shell cannot run at all, so one such refusal is the signal; requiring zero
 * successes on top keeps a transient oddity from warning. `allowedTools` is
 * the job's own `--allowedTools` value; without it nothing counts.
 */
export function detectClaudeShellBlocked(stdout: string, allowedTools: string): boolean {
  const matchers = allowlistMatchers(allowedTools);
  if (matchers.length === 0) return false;
  const bashCommands = new Map<string, unknown>();
  const refused = new Set<string>();
  let succeeded = 0;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "tool_use" && block.name === "Bash" && typeof block.id === "string") {
          bashCommands.set(block.id, block.input?.command);
        }
      }
    } else if (event?.type === "user" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type !== "tool_result" || !bashCommands.has(block.tool_use_id)) continue;
        if (block.is_error !== true) succeeded++;
        else if (isBashRefusal(block.content)) refused.add(block.tool_use_id);
      }
    } else if (event?.type === "result" && Array.isArray(event.permission_denials)) {
      for (const d of event.permission_denials) {
        if (d?.tool_name !== "Bash" || typeof d.tool_use_id !== "string") continue;
        refused.add(d.tool_use_id);
        // A denial carries its own input; keep it when the tool_use line was missed.
        if (!bashCommands.has(d.tool_use_id)) bashCommands.set(d.tool_use_id, d.tool_input?.command);
      }
    }
  }
  if (succeeded > 0) return false;
  for (const id of refused) {
    if (isPlainAllowlistedCommand(bashCommands.get(id), matchers)) return true;
  }
  return false;
}

/** The `--allowedTools` value of a spawned command, or "" when absent. */
export function allowedToolsOf(command: readonly string[]): string {
  const i = command.indexOf("--allowedTools");
  return i === -1 ? "" : (command[i + 1] ?? "");
}
