import { toRelativePath } from "./path-utils";

/**
 * Cursor CLI Review Agent — prompt, command builder, NDJSON stream reducer,
 * marker-block parser, and finding transformer.
 *
 * Cursor differs from Claude/Codex in exactly one way: its headless CLI
 * (the binary is literally named `agent`) exposes no schema-validation flag
 * (`--json-schema` / `--output-schema` / `structured_output`). Its final task
 * output is prose. That earns strict *parsing* — Cursor is told to emit a
 * marker-delimited JSON block, and we extract the LAST complete block from the
 * reconstructed canonical text. It does NOT earn extra isolation,
 * finding-policing, env scrubbing, or a per-job marker nonce. Cursor inherits
 * process.env like Claude/Codex; its read-only posture comes only from the
 * command flags (`--mode ask` + `--sandbox enabled` + no `--force`).
 *
 * Cursor `stream-json` is decoded with a real line-buffered NDJSON reducer
 * (pipe chunk boundaries are NOT NDJSON record boundaries), producing live log
 * deltas and the canonical assistant/result text used for marker extraction.
 */

// ---------------------------------------------------------------------------
// Static marker — v1 uses a STATIC marker plus last-block selection (no nonce).
// If testing shows the model echoing the marker from the prompt, add a per-job
// nonce then — not before (per approach doc §Structured Output Policy).
// ---------------------------------------------------------------------------

export const CURSOR_MARKER_OPEN = "<plannotator-review-json>";
export const CURSOR_MARKER_CLOSE = "</plannotator-review-json>";

// ---------------------------------------------------------------------------
// Types — mirror ClaudeFinding/ClaudeReviewOutput, plus a freeform summary.
// ---------------------------------------------------------------------------

export type CursorSeverity = "important" | "nit" | "pre_existing";

export interface CursorFinding {
  file: string;
  line: number;
  end_line: number;
  severity: CursorSeverity;
  description: string;
  reasoning: string;
}

export interface CursorReviewSummary {
  correctness: string;
  explanation: string;
  confidence: number;
}

export interface CursorReviewOutput {
  findings: CursorFinding[];
  summary: CursorReviewSummary;
}

const VALID_SEVERITIES: ReadonlySet<string> = new Set([
  "important",
  "nit",
  "pre_existing",
]);

// ---------------------------------------------------------------------------
// Schema validator — hand-rolled (no Ajv): Cursor output is prompt-enforced,
// so validation is the floor that turns prose back into a trusted object.
// ---------------------------------------------------------------------------

/**
 * Validate a parsed object against the Cursor review schema.
 * Returns the typed output, or null if the shape is invalid.
 *
 * Empty findings are valid as long as the JSON itself is valid and carries a
 * valid summary (per approach doc §Structured Output Policy).
 */
export function validateCursorReviewOutput(parsed: unknown): CursorReviewOutput | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.findings)) return null;

  const summary = obj.summary;
  if (!summary || typeof summary !== "object") return null;
  const s = summary as Record<string, unknown>;
  if (typeof s.correctness !== "string") return null;
  if (typeof s.explanation !== "string") return null;
  if (typeof s.confidence !== "number") return null;

  const findings: CursorFinding[] = [];
  for (const raw of obj.findings) {
    if (!raw || typeof raw !== "object") return null;
    const f = raw as Record<string, unknown>;
    if (typeof f.file !== "string") return null;
    if (typeof f.line !== "number") return null;
    if (typeof f.severity !== "string" || !VALID_SEVERITIES.has(f.severity)) return null;
    if (typeof f.description !== "string") return null;

    findings.push({
      file: f.file,
      line: f.line,
      end_line: typeof f.end_line === "number" ? f.end_line : f.line,
      severity: f.severity as CursorSeverity,
      description: f.description,
      reasoning: typeof f.reasoning === "string" ? f.reasoning : "",
    });
  }

  return {
    findings,
    summary: {
      correctness: s.correctness,
      explanation: s.explanation,
      confidence: s.confidence,
    },
  };
}

// ---------------------------------------------------------------------------
// Review prompt — investigation-first methodology tuned for Cursor's agentic
// model, ending with the marker-block output contract (Cursor has no schema
// flag, so the contract IS the prompt). Project-specific rules are NOT baked in
// here: the agent is told to discover and honor repo guidance files at review
// time, so this same prompt works for any repo `plannotator review` is run on.
// ---------------------------------------------------------------------------

export const CURSOR_REVIEW_PROMPT = `# Code Review

## Your role
You are a senior engineer reviewing a code change. Find the bugs a maintainer
would fix before merging — logic errors, regressions, broken edge cases,
security holes with a real exploit path, data-loss risks. You are not a linter
or style checker. Optimize for findings that get resolved, not for volume: a
few real, well-evidenced bugs beat a long list of nits.

## Method — investigate before you report
You have tools. Use them. Do not judge the diff in isolation:
  - Read the full function and module around each change, not just the hunk.
  - Trace call sites and data flow to see how the changed code is actually used.
  - Read any repo guidance and honor it if present: CLAUDE.md, REVIEW.md,
    AGENTS.md, .cursor/rules/*, and .cursor/BUGBOT.md (root and any nested under
    the directories you're reviewing). Treat these as authoritative for this
    repo and respect any skip/ignore rules they define.
  - Before reporting, check whether the issue is already handled elsewhere (a
    guard, try/catch, fallback, type guarantee).
  - Look at sibling code and tests: is the pattern you're flagging used safely
    elsewhere? Is the failure path you fear already covered?

## What to look for
  - Correctness: logic errors, regressions, broken edge cases, off-by-one,
    wrong results, build/type breakage.
  - Robustness: unhandled errors on realistic paths, resource/process leaks,
    races with observable consequences, state left inconsistent on failure.
  - Security (only when the change introduces it): execution of
    user/client-controlled input, trusting unvalidated external or model
    output, weakened trust/read-only guarantees, newly exposed surfaces.
  - Contracts & attribution: wrong file/line/path mapping, scope confusion, or a
    change to one side of a contract (types, API shape, parallel
    implementations) without the matching change on the other side.
  - Clear, citable violations of the repo guidance files above.

## Validate every finding
Confirm each candidate is real by tracing the actual code path. If you can't
show how it triggers, drop it — prefer silence over a false positive. The
confirmation you write becomes the \`reasoning\` field: what triggers it, what
breaks, and why it isn't already handled.

## Severity — report what a maintainer would actually fix
  important — should be fixed before merge: data loss, silent wrong results,
    security with an exploit path, crashes/leaks, contract drift that breaks a
    real consumer, fail-open where it must fail-closed.

  nit — minor and non-blocking: a real but low-impact edge case, missing
    handling on an unlikely path, a robustness gap with an easy workaround.

  pre_existing — a genuine bug in surrounding code NOT introduced by this
    change. Only flag when it directly affects the changed code path.

## Do NOT report
  - Formatting, naming, or style preferences (unless a repo guideline requires).
  - "Consider adding tests" — unless the change adds non-trivial logic with no
    test coverage at all.
  - Hypothetical problems needing exotic conditions with no real code path.
  - Speculative refactors or "this could be cleaner" outside the change's scope.

## Hard constraints
- This is a read-only review. Do NOT modify files.
- Do NOT post any comments to GitHub or GitLab. Do NOT use gh pr comment, glab,
  or any commenting tool.
- Never approve or block the change. Your only output is findings.

## Output contract
Your only machine-readable output is a single marker-delimited JSON block.
Any natural-language commentary you write must come BEFORE the final marker
block. Emit the block exactly once, as the last thing in your response:

${CURSOR_MARKER_OPEN}
{
  "findings": [
    {
      "file": "packages/server/review.ts",
      "line": 123,
      "end_line": 123,
      "severity": "important",
      "description": "The issue...",
      "reasoning": "Why this is a real issue..."
    }
  ],
  "summary": {
    "correctness": "Issues Found",
    "explanation": "One important issue was found.",
    "confidence": 0.85
  }
}
${CURSOR_MARKER_CLOSE}

Schema:
- findings: array of objects, each with
  - file: string (path as shown in the diff)
  - line: integer (start line, post-change numbering)
  - end_line: integer (end line; equal to line for a single line)
  - severity: one of "important", "nit", "pre_existing"
  - description: string (one paragraph) — state the IMPACT (what breaks, for
    whom) and the TRIGGER (when it happens); suggest a minimal fix if obvious
  - reasoning: string (how the issue was confirmed)
- summary: object with
  - correctness: string ("Correct" or "Issues Found")
  - explanation: string (one sentence)
  - confidence: number between 0 and 1

Cite file/line from the new (post-change) code. One finding per distinct bug —
do not stack unrelated issues. If no issues are found, return an empty
"findings" array with a valid summary.`;

// ---------------------------------------------------------------------------
// Command builder
// ---------------------------------------------------------------------------

export interface CursorCommandResult {
  command: string[];
}

/**
 * Build the `agent -p` command. NOTE the binary is `agent`, NOT `cursor`.
 *
 * Read-only posture comes entirely from `--mode ask` + `--sandbox enabled` and
 * the absence of `--force`/`--yolo`. `--trust` is required in headless print
 * mode: without it Cursor stops on an interactive workspace-trust prompt that a
 * background job can never answer. It is safe here because the run is already
 * constrained to read-only ask mode with the sandbox enabled.
 *
 * The prompt is the trailing positional argument — `agent` reads task text from
 * argv (`[prompt...]`), not stdin. `--model` is omitted when the model is
 * `Auto`/empty so Cursor uses its default model selection. `--workspace` is set
 * to the launch cwd when provided, matching the spawn cwd.
 */
export function buildCursorCommand(prompt: string, model?: string, cwd?: string): CursorCommandResult {
  // `auto` is Cursor's default model id — omit --model so the CLI chooses.
  const useModel = !!model && model.toLowerCase() !== "auto";

  return {
    command: [
      "agent",
      "-p",
      "--mode",
      "ask",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--trust",
      ...(cwd ? ["--workspace", cwd] : []),
      "--sandbox",
      "enabled",
      ...(useModel ? ["--model", model] : []),
      // Prompt is the trailing positional arg — agent reads it from argv, not stdin.
      prompt,
    ],
  };
}

// ---------------------------------------------------------------------------
// Model discovery — parse `agent models` output. The spawn is runtime-specific
// (it lives in each server's agent-jobs adapter); this pure parser is shared.
// ---------------------------------------------------------------------------

export interface CursorModel {
  id: string;
  label: string;
}

/**
 * Parse the text output of `agent models` / `agent --list-models` into a model
 * catalog. The CLI prints one model per line as `<id> - <Label>`, wrapped by an
 * "Available models" header and a "Tip: ..." footer. Returns [] when the output
 * carries no model lines (e.g. unauthenticated: "No models available...").
 */
export function parseCursorModelsOutput(stdout: string): CursorModel[] {
  if (!stdout) return [];
  const models: CursorModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    // `id - Label` — id is a single whitespace-free token; the separator is
    // " - " with surrounding spaces (model ids contain hyphens but never " - ").
    const match = /^(\S+)\s+-\s+(.+)$/.exec(line);
    if (!match) continue;
    const id = match[1];
    const label = match[2].trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label });
  }
  return models;
}

// ---------------------------------------------------------------------------
// Stream reduction — line-buffered NDJSON reducer.
// ---------------------------------------------------------------------------

interface CursorStreamEvent {
  type?: string;
  subtype?: string;
  timestamp_ms?: number;
  model_call_id?: string;
  message?: { content?: unknown };
  text?: string;
  [key: string]: unknown;
}

/**
 * A partial-output assistant event is a real new text delta only when
 * `timestamp_ms` is present AND `model_call_id` is absent. All other assistant
 * flushes are duplicate re-emissions (per approach doc §Log Streaming).
 */
function isRealAssistantDelta(event: CursorStreamEvent): boolean {
  return event.timestamp_ms !== undefined && event.model_call_id === undefined;
}

/** Pull readable text out of an assistant event's content (string or parts). */
function extractAssistantText(event: CursorStreamEvent): string {
  if (typeof event.text === "string") return event.text;
  const content = event.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type?: string; text?: string } => !!p && typeof p === "object")
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
  }
  return "";
}

export interface CursorStreamReduction {
  /** Canonical assistant/result text — the substrate for marker extraction. */
  canonicalText: string;
  /** Number of NDJSON records that parsed successfully. */
  recordCount: number;
}

/**
 * Reduce a complete Cursor `stream-json` stdout buffer into canonical text.
 *
 * Critically line-buffered: only complete lines (terminated by `\n`) are parsed.
 * A trailing partial line with no newline is treated as complete (the process
 * has exited by the time this runs on the accumulated buffer), but mid-stream
 * chunk boundaries never corrupt a record because we join the whole buffer
 * before splitting on newlines.
 */
export function reduceCursorStreamEvents(stdout: string): CursorStreamReduction {
  let canonicalText = "";
  let recordCount = 0;

  if (!stdout) return { canonicalText, recordCount };

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    let event: CursorStreamEvent;
    try {
      event = JSON.parse(line) as CursorStreamEvent;
    } catch {
      continue; // not a complete/valid NDJSON record — skip
    }
    recordCount++;

    if (event.type === "assistant") {
      // Append real new deltas (timestamp_ms present, model_call_id absent).
      // The no-timestamp branch below intentionally KEEPS the end-of-turn flush
      // — it covers both partial-streaming-disabled output (the full message
      // arrives once) and the enabled-mode final flush, and keeping it is a
      // parse-robustness safety net: it guarantees the marker block is present
      // even if the deltas didn't fully carry it (extractLastMarkerBlock takes
      // the LAST block, so the duplicate is harmless). This is deliberately MORE
      // lenient than formatCursorLogEvent, which drops the flush so live logs
      // don't repeat the whole assistant output. Do not "unify" the two.
      if (event.timestamp_ms !== undefined) {
        if (isRealAssistantDelta(event)) canonicalText += extractAssistantText(event);
      } else if (event.model_call_id === undefined) {
        canonicalText += extractAssistantText(event);
      }
    } else if (event.type === "result") {
      const resultText =
        typeof event.result === "string"
          ? event.result
          : typeof event.text === "string"
            ? event.text
            : "";
      if (resultText) canonicalText += resultText;
    }
  }

  return { canonicalText, recordCount };
}

// ---------------------------------------------------------------------------
// Marker-block parsing — reduce → take the LAST complete marker block → parse →
// schema-validate. Returns null on any failure (caller fails the job).
// ---------------------------------------------------------------------------

/** Extract the content of the LAST complete marker block from canonical text. */
function extractLastMarkerBlock(text: string): string | null {
  let result: string | null = null;
  let searchFrom = 0;

  while (true) {
    const open = text.indexOf(CURSOR_MARKER_OPEN, searchFrom);
    if (open === -1) break;
    const contentStart = open + CURSOR_MARKER_OPEN.length;
    const close = text.indexOf(CURSOR_MARKER_CLOSE, contentStart);
    if (close === -1) break; // no matching close — block is incomplete
    result = text.slice(contentStart, close);
    searchFrom = close + CURSOR_MARKER_CLOSE.length;
  }

  return result;
}

/**
 * Parse Cursor `stream-json` stdout into a validated review output.
 *
 * Pipeline: line-buffered NDJSON reduce → reconstruct canonical text → take the
 * LAST complete marker block → JSON.parse → schema-validate. Returns null on
 * ANY failure (missing marker, malformed JSON, schema mismatch) so the caller
 * can fail the job.
 */
export function parseCursorStreamOutput(stdout: string): CursorReviewOutput | null {
  if (!stdout || !stdout.trim()) return null;

  const { canonicalText } = reduceCursorStreamEvents(stdout);
  if (!canonicalText) return null;

  const block = extractLastMarkerBlock(canonicalText);
  if (block === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(block.trim());
  } catch {
    return null;
  }

  return validateCursorReviewOutput(parsed);
}

// ---------------------------------------------------------------------------
// Live log formatter — maps one NDJSON event to a readable log line.
// ---------------------------------------------------------------------------

/**
 * Format one Cursor `stream-json` line for the LiveLogViewer.
 * Returns a human-readable string, or null if the line should be skipped.
 *
 * Mirrors formatClaudeLogEvent. Applies the same partial-output dedup rule as
 * the reducer: an assistant delta is shown only when `timestamp_ms` is present
 * and `model_call_id` is absent.
 */
export function formatCursorLogEvent(line: string): string | null {
  let event: CursorStreamEvent;
  try {
    event = JSON.parse(line) as CursorStreamEvent;
  } catch {
    return null;
  }

  switch (event.type) {
    case "system": {
      if (event.subtype === "init") {
        const model = typeof event.model === "string" ? event.model : undefined;
        const sessionId = typeof event.session_id === "string" ? event.session_id : undefined;
        const bits = ["[init]"];
        if (model) bits.push(`model=${model}`);
        if (sessionId) bits.push(`session=${sessionId}`);
        return bits.join(" ");
      }
      return null;
    }
    case "assistant": {
      // We always launch with --stream-partial-output, so the only assistant
      // events worth showing live are real new deltas (timestamp_ms present,
      // model_call_id absent). Everything else repeats already-streamed text:
      // pre-tool-call duplicate flushes (model_call_id present) and the final
      // buffered flush at end of turn (no timestamp_ms). Skip both.
      if (!isRealAssistantDelta(event)) return null;
      const text = extractAssistantText(event);
      return text ? text : null;
    }
    case "tool_call": {
      const name = typeof event.name === "string" ? event.name : "tool";
      if (event.subtype === "completed") {
        return `[${name}] completed`;
      }
      // started (or unspecified) — show concise args, never full file contents.
      const args =
        typeof event.args === "string"
          ? event.args.slice(0, 100)
          : event.args !== undefined
            ? JSON.stringify(event.args).slice(0, 100)
            : "";
      return `[${name}] ${args}`.trimEnd();
    }
    case "result": {
      const duration =
        typeof event.duration_ms === "number" ? `${event.duration_ms}ms` : undefined;
      const requestId = typeof event.request_id === "string" ? event.request_id : undefined;
      const bits = ["[result]"];
      if (duration) bits.push(duration);
      if (requestId) bits.push(`request=${requestId}`);
      return bits.length > 1 ? bits.join(" ") : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Finding transform — Cursor findings → external annotations.
// Identical shape to transformClaudeFindings, with author "Cursor".
// ---------------------------------------------------------------------------

export interface CursorReviewAnnotationInput {
  source: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  type: string;
  side: string;
  scope: string;
  text: string;
  severity: CursorSeverity;
  reasoning: string;
  author: string;
}

/** Transform Cursor findings into the external annotation format. */
export function transformCursorFindings(
  findings: CursorFinding[],
  source: string,
  cwd?: string,
  pathTransform?: (path: string) => string,
): CursorReviewAnnotationInput[] {
  return findings
    .filter((f) => f.file && typeof f.line === "number")
    .map((f) => ({
      source,
      filePath: pathTransform
        ? pathTransform(toRelativePath(f.file, cwd))
        : toRelativePath(f.file, cwd),
      lineStart: f.line,
      lineEnd: f.end_line ?? f.line,
      type: "comment",
      side: "new",
      scope: "line",
      text: `[${f.severity}] ${f.description}`,
      severity: f.severity,
      reasoning: f.reasoning,
      author: "Cursor",
    }));
}
