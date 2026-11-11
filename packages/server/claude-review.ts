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

/** Prompt composition: the system prompt, then the resolved profile's Custom Review Profile section (omitted for builtin:default), then the user review message. */
export function composeClaudeReviewPrompt(
  userMessage: string,
  reviewProfile?: ResolvedReviewProfile,
): string {
  return composeReviewPrompt(CLAUDE_REVIEW_PROMPT, reviewProfile, userMessage);
}

export interface ClaudeJobCommandOptions {
  /** False turns Claude Code's sandbox off for this job only (see `claudeJobIsolationArgs`); callers resolve it, the builders stay env-free. */
  sandbox?: boolean;
}

/** Appended to the system prompt of every Claude agent job: under `--permission-mode dontAsk` a compound shell command is refused as a whole even when every part is allowlisted, and models reach for that shape. */
export const CLAUDE_JOB_SHELL_GUIDANCE =
  "Shell access in this session is limited to an allowlist of read-only commands, " +
  "and anything outside it is refused without a prompt. Run each command on its own " +
  "as one simple invocation: no `&&`, `||`, `;`, pipes, redirects, `$(...)` or shell " +
  "variables. If you need a value from one command (such as a merge-base sha), run it, " +
  "read the output, then pass the literal value to the next command.";

/**
 * Arguments that keep a Claude agent job hermetic and runnable.
 * `--strict-mcp-config` with no `--mcp-config` loads no MCP servers. `--setting-sources user` skips the project/local settings of the directory the job runs in (in PR mode, someone else's checkout).
 * `sandbox: false` is for hosts where Claude Code's sandbox cannot start; it runs commands without OS containment, and managed policy still wins.
 */
export function claudeJobIsolationArgs(opts?: ClaudeJobCommandOptions): string[] {
  return [
    "--setting-sources", "user",
    "--strict-mcp-config",
    "--append-system-prompt", CLAUDE_JOB_SHELL_GUIDANCE,
    ...(opts?.sandbox === false ? ["--settings", JSON.stringify({ sandbox: { enabled: false } })] : []),
  ];
}

/**
 * The Bash commands every Claude agent job may run without a prompt: the read-only commands the job prompts instruct, plus a few read-only lookups they imply.
 * Deliberately absent: `git -C` (prefixes any git subcommand), `git grep` / `git ls-remote` (take an option that runs another program), `gh api` / `glab api` (non-GET), open-ended `git branch` / `git remote`, and the `gh`/`glab` list commands.
 */
export const CLAUDE_JOB_ALLOWED_TOOLS: readonly string[] = [
  "Agent", "Read", "Glob", "Grep",
  // Git (read-only). `git ls-files` lists untracked files for since-base.
  "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)",
  "Bash(git blame:*)", "Bash(git merge-base:*)", "Bash(git rev-parse:*)",
  "Bash(git ls-files:*)", "Bash(git ls-tree:*)",
  "Bash(git branch)", "Bash(git branch --show-current)",
  "Bash(git remote)", "Bash(git remote -v)", "Bash(git remote get-url:*)",
  // JJ (read-only). `jj cat` is the pre-0.19 name of `jj file show`.
  "Bash(jj status:*)", "Bash(jj diff:*)", "Bash(jj log:*)", "Bash(jj show:*)",
  "Bash(jj file show:*)", "Bash(jj cat:*)", "Bash(jj bookmark list:*)",
  "Bash(gh pr view:*)", "Bash(gh pr diff:*)", "Bash(gh issue view:*)",
  "Bash(glab mr view:*)", "Bash(glab mr diff:*)", "Bash(glab issue view:*)",
  "Bash(wc:*)",
];

/**
 * Tools and command shapes every Claude agent job refuses. Deny rules win over allow rules and match past a leading environment assignment.
 * Claude Code matches rule TEXT, so these narrow the model's reach; they are not a containment boundary, the sandbox is.
 */
export const CLAUDE_JOB_DISALLOWED_TOOLS: readonly string[] = [
  "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch",
  "Bash(python:*)", "Bash(python3:*)", "Bash(node:*)", "Bash(npx:*)",
  "Bash(bun:*)", "Bash(bunx:*)", "Bash(sh:*)", "Bash(bash:*)", "Bash(zsh:*)",
  "Bash(curl:*)", "Bash(wget:*)",
  "Bash(git * --out*)", "Bash(git -c *)", "Bash(git --config-env*)",
  "Bash(git * --config-env*)",
  "Bash(git grep *)", "Bash(git ls-remote *)", "Bash(gh api *)", "Bash(glab api *)",
  "Bash(jj --config*)", "Bash(jj * --config*)", "Bash(jj * --tool*)",
  // Plannotator's Inbox MCP server, by name.
  // `--strict-mcp-config` already loads no MCP server; this holds whatever the transport.
  "mcp__plannotator-inbox",
];

export function claudeJobToolArgs(): string[] {
  return [
    "--tools", "Agent,Bash,Read,Glob,Grep",
    "--allowedTools", CLAUDE_JOB_ALLOWED_TOOLS.join(","),
    "--disallowedTools", CLAUDE_JOB_DISALLOWED_TOOLS.join(","),
  ];
}

export interface ClaudeCommandResult {
  command: string[];
  /** Prompt text to write to stdin (Claude reads prompt from stdin, not argv). */
  stdinPrompt: string;
}

/** The prompt goes via stdin, not argv: avoids quoting issues, argv limits and variadic flag conflicts. */
export function buildClaudeCommand(
  prompt: string,
  model: string = "opus",
  effort?: string,
  opts?: ClaudeJobCommandOptions,
): ClaudeCommandResult {
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
      ...claudeJobToolArgs(),
      ...claudeJobIsolationArgs(opts),
    ],
    stdinPrompt: prompt,
  };
}

/**
 * Scan stream-json stdout for the newest `result` event whose `structured_output` passes `accept`.
 * One run can emit several results (background subagents), and trailing ones can be error or empty: those are skipped, and an `is_error: true` result is never used, even with output attached.
 * `onUnparsedLine` sees each non-JSON line newest-first; a non-null return ends the scan.
 */
export function findClaudeStructuredOutput<T>(
  stdout: string,
  accept: (output: unknown) => T | null,
  onUnparsedLine?: (line: string) => T | null,
): T | null {
  if (!stdout.trim()) return null;

  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      const recovered = onUnparsedLine?.(line) ?? null;
      if (recovered !== null) return recovered;
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    const record = event as Record<string, unknown>;
    if (record.type !== 'result' || record.is_error || record.structured_output == null) continue;
    const output = accept(record.structured_output);
    if (output !== null) return output;
  }

  return null;
}

export function parseClaudeStreamOutput(stdout: string): ClaudeReviewOutput | null {
  return findClaudeStructuredOutput(stdout, (output) =>
    output && typeof output === 'object' && Array.isArray((output as { findings?: unknown }).findings)
      ? (output as ClaudeReviewOutput)
      : null,
  );
}

export function transformClaudeFindings(
  findings: ClaudeFinding[],
  source: string,
  cwd?: string,
  pathTransform?: (path: string) => string,
): ReviewAnnotationInput[] {
  return transformSeverityFindings(findings, source, "Claude Code", cwd, pathTransform);
}

export function formatClaudeLogEvent(line: string): string | null {
  try {
    const event = JSON.parse(line);

    if (event.type === 'result') return null;

    if (event.type === 'assistant' && event.message?.content) {
      const parts = Array.isArray(event.message.content) ? event.message.content : [event.message.content];
      const texts = parts
        .filter((p: any) => p.type === 'text' && p.text)
        .map((p: any) => p.text);
      if (texts.length > 0) return texts.join('\n');

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

export const CLAUDE_SHELL_BLOCKED_WARNING =
  "Claude Code refused every shell command this job tried, so it could not inspect the repository with git. " +
  "If your Claude Code settings enable its sandbox and the sandbox cannot start on this machine " +
  "(for example Linux without bubblewrap and socat), set PLANNOTATOR_CLAUDE_SANDBOX=0 or " +
  "{ \"claudeSandbox\": false } in ~/.plannotator/config.json and run the job again.";

function isBashRefusal(content: unknown): boolean {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join(" ")
      : "";
  return /permission to use bash has been denied|sandbox/i.test(text);
}

/** `Bash(<pattern>)` entries of an allow/deny value, as whole-command matchers: `git log:*` and a trailing ` *` mean the prefix followed by nothing or whitespace; `*` elsewhere matches any run of characters; no `*` is an exact command. */
function ruleMatchers(tools: string): RegExp[] {
  const out: RegExp[] = [];
  for (const m of tools.matchAll(/Bash\(([^)]*)\)/g)) {
    let pattern = m[1].trim();
    let prefixForm = false;
    if (pattern.endsWith(":*")) {
      prefixForm = true;
      pattern = pattern.slice(0, -2);
    } else if (pattern.endsWith(" *") && pattern.indexOf("*") === pattern.length - 1) {
      prefixForm = true;
      pattern = pattern.slice(0, -2);
    }
    if (!pattern) continue;
    const body = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    out.push(new RegExp(`^${body}${prefixForm ? "(\\s|$)" : "$"}`));
  }
  return out;
}

/** Whether a command's text is admitted by a job's rules: it matches a `Bash(...)` allow entry and no deny entry. Rule text only; no compound-command splitting or wrapper stripping. */
export function claudeRulesAdmit(command: string, allowedTools: string, disallowedTools = ""): boolean {
  const cmd = command.trim();
  return ruleMatchers(allowedTools).some((re) => re.test(cmd)) && !ruleMatchers(disallowedTools).some((re) => re.test(cmd));
}

/** A command the allowlist admits outright (one plain invocation); `dontAsk` never refuses it unless the shell itself is unavailable. */
function isPlainAllowlistedCommand(command: unknown, allow: RegExp[], deny: RegExp[]): boolean {
  if (typeof command !== "string") return false;
  const cmd = command.trim();
  if (!cmd || /[|&;<>`$\n\\(){}]/.test(cmd)) return false;
  return allow.some((re) => re.test(cmd)) && !deny.some((re) => re.test(cmd));
}

/**
 * Whether a job's shell was blocked outright: at least one refused Bash call was a PLAIN command its own allowlist admits, AND no Bash call succeeded.
 * Refusals of compound commands or commands outside the allowlist never count: `dontAsk` refuses those by design.
 */
export function detectClaudeShellBlocked(stdout: string, allowedTools: string, disallowedTools = ""): boolean {
  const matchers = ruleMatchers(allowedTools);
  if (matchers.length === 0) return false;
  const denyMatchers = ruleMatchers(disallowedTools);
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
    if (isPlainAllowlistedCommand(bashCommands.get(id), matchers, denyMatchers)) return true;
  }
  return false;
}

export function allowedToolsOf(command: readonly string[]): string {
  const i = command.indexOf("--allowedTools");
  return i === -1 ? "" : (command[i + 1] ?? "");
}

export function disallowedToolsOf(command: readonly string[]): string {
  const i = command.indexOf("--disallowedTools");
  return i === -1 ? "" : (command[i + 1] ?? "");
}
