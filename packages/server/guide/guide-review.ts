import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { loadConfig, resolveCursorSandbox } from "../config";
import {
  GUIDE_NO_SECTIONS_ERROR,
  GUIDE_REVIEW_PROMPT,
  GUIDE_SCHEMA_JSON,
  buildGuideUserMessage,
  sanitizeGuideSections,
  validateGuideOutput,
  type GuideChangedFile,
} from "@plannotator/shared/guide-prompt";
import type { DiffType } from "../vcs";
import type { PRMetadata } from "../pr";
import type { WorkspaceReviewPromptContext } from "../agent-review-message";
import {
  MARKER_ENGINES,
  makeMarkerNonce,
  extractMarkerNonce,
  markerOpen,
  markerClose,
  reduceMarkerStream,
  extractLastMarkerBlock,
  buildMarkerCommand,
  type MarkerEngine,
  type MarkerEngineId,
} from "../marker-review";
import { GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS } from "@plannotator/shared/guide";
import type {
  CodeGuideOutput,
  GuideDiffRef,
  GuideSection,
} from "@plannotator/shared/guide";
import type { GuideLaunchReview } from "@plannotator/shared/guide-format";

export type { CodeGuideOutput, GuideDiffRef, GuideSection };

// The prompt, schema, user message and validator moved to
// @plannotator/core/guide-prompt (browser-safe); re-exported so every existing
// importer of this module keeps working unchanged.
export { GUIDE_NO_SECTIONS_ERROR, GUIDE_REVIEW_PROMPT, GUIDE_SCHEMA_JSON, buildGuideUserMessage, validateGuideOutput };
export type { GuideChangedFile, GuidePromptPRMetadata } from "@plannotator/shared/guide-prompt";

export const GUIDE_EMPTY_OUTPUT_ERROR = "Guide generation returned empty or malformed output";

/**
 * The guide methodology, optionally extended with reviewer-supplied extra
 * instructions (#1265): freeform standing preferences ("prefer product
 * vocabulary X", "never invent ticket IDs") APPENDED as a clearly delimited
 * section, never replacing the built-in organizer prompt. Absent or blank
 * instructions return GUIDE_REVIEW_PROMPT itself, byte-identical, so every
 * existing prompt path is unchanged. Text beyond
 * GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS is truncated (hygiene bound on prompt
 * size; the launch UI caps input at the same limit).
 */
export function composeGuideMethodology(extraInstructions?: string): string {
  const trimmed = extraInstructions?.trim();
  if (!trimmed) return GUIDE_REVIEW_PROMPT;
  const bounded = trimmed.length > GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS
    ? trimmed.slice(0, GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS)
    : trimmed;
  // This section precedes the marker output contract in composed prompts,
  // and marker nonce recovery takes the FIRST tag-shaped match in the prompt
  // (extractMarkerNonce). A pasted example tag in the instructions would
  // hijack recovery and fail an otherwise-valid marker run, so tag-shaped
  // sequences are defanged before composition.
  const defanged = bounded.replace(
    /<\/?plannotator-review-json:pn[0-9a-f]{12}>/g,
    "[marker tag removed]",
  );
  return [
    GUIDE_REVIEW_PROMPT,
    "",
    "## Additional reviewer instructions",
    "The reviewer supplied these standing preferences for this guide. Apply",
    "them where they shape vocabulary, emphasis, or ordering judgment. They",
    "refine the methodology above; they never override the coverage rule, the",
    "hard constraints, the research budget, or the output schema.",
    "",
    defanged,
  ].join("\n");
}

export interface GuideClaudeCommandResult {
  command: string[];
  stdinPrompt: string;
}

export function buildGuideClaudeCommand(prompt: string, model: string = "sonnet", effort?: string): GuideClaudeCommandResult {
  const allowedTools = [
    "Agent", "Read", "Glob", "Grep",
    "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
    "Bash(git show:*)", "Bash(git blame:*)", "Bash(git branch:*)",
    "Bash(git grep:*)", "Bash(git ls-remote:*)", "Bash(git ls-tree:*)",
    "Bash(git merge-base:*)", "Bash(git remote:*)", "Bash(git rev-parse:*)",
    "Bash(git show-ref:*)", "Bash(git -C:*)",
    "Bash(jj status:*)", "Bash(jj diff:*)", "Bash(jj log:*)",
    "Bash(jj show:*)", "Bash(jj file show:*)", "Bash(jj cat:*)",
    "Bash(jj bookmark list:*)",
    "Bash(gh pr view:*)", "Bash(gh pr diff:*)", "Bash(gh pr list:*)",
    "Bash(gh api repos/*/*/pulls/*)", "Bash(gh api repos/*/*/pulls/*/files*)",
    // The guide prompt follows linked issues (`Fixes #123`, `Closes owner/repo#456`),
    // so the allowlist has to permit the issue-read commands.
    "Bash(gh issue view:*)", "Bash(gh api repos/*/*/issues/*)",
    "Bash(glab mr view:*)", "Bash(glab mr diff:*)",
    "Bash(glab issue view:*)",
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
      "--json-schema", GUIDE_SCHEMA_JSON,
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

/** Materialized schema path under the current data directory. */
function guideSchemaPath(): string {
  return join(getPlannotatorDataDir(), "guide-schema.json");
}

/** Schema paths this process has already refreshed with its own schema. */
const materializedGuideSchemaPaths = new Set<string>();

async function ensureGuideSchemaFile(): Promise<string> {
  const schemaPath = guideSchemaPath();
  // Guarded per resolved path, not per process and not by file existence: a
  // PLANNOTATOR_DATA_DIR change after import materializes the schema in the
  // new location, and a stale file left by an older binary is overwritten
  // once per process so the agent always gets the current schema.
  if (!materializedGuideSchemaPaths.has(schemaPath)) {
    await mkdir(dirname(schemaPath), { recursive: true });
    await writeFile(schemaPath, GUIDE_SCHEMA_JSON);
    materializedGuideSchemaPaths.add(schemaPath);
  }
  return schemaPath;
}

export function generateGuideOutputPath(): string {
  return join(tmpdir(), `plannotator-guide-${crypto.randomUUID()}.json`);
}

export async function buildGuideCodexCommand(options: {
  cwd: string;
  outputPath: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}): Promise<string[]> {
  const { cwd, outputPath, prompt, model, reasoningEffort, fastMode } = options;
  const schemaPath = await ensureGuideSchemaFile();

  const command = [
    "codex",
    // Global flags must precede the "exec" subcommand for the Codex CLI.
    ...(model ? ["-m", model] : []),
    ...(reasoningEffort ? ["-c", `model_reasoning_effort=${reasoningEffort}`] : []),
    ...(fastMode ? ["-c", "service_tier=fast"] : []),
    "exec",
    "--output-schema", schemaPath,
    "-o", outputPath,
    "--approve-for-me", "--ephemeral",
    "-C", cwd,
    prompt,
  ];

  return command;
}

// ---------------------------------------------------------------------------
// Marker-engine (Cursor, OpenCode, Pi) support — same contract style as
// marker-review.ts's composeMarkerReviewPrompt/buildMarkerOutputContract, but
// describing the GUIDE schema instead of the findings/summary review schema.
// None of the three has a schema flag, so the marker-delimited JSON block is
// the only way to get structured output back; the shared nonce/extraction
// primitives (markerOpen/markerClose/reduceMarkerStream/extractLastMarkerBlock)
// are reused verbatim from marker-review.ts rather than reimplemented here.
// ---------------------------------------------------------------------------

/**
 * Output contract appended after the guide methodology for marker engines.
 * Describes the CodeGuideOutput shape (title/intent/sections/unplacedFiles) in
 * prose + example, since there is no schema flag to enforce it. The nonce is
 * generated by the caller with makeMarkerNonce() and recovered at parse time
 * with extractMarkerNonce() (job.prompt) — same discipline as the review path.
 */
export function buildGuideMarkerOutputContract(nonce: string): string {
  return `## Output contract
Your only machine-readable output is a single marker-delimited JSON block
matching the guide schema below. Any natural-language commentary you write
must come BEFORE the final marker block. Emit the block exactly once, as the
last thing in your response. The opening and closing tags carry a session id
(after the colon) — reproduce both tags EXACTLY as shown, including that id,
or your guide will be discarded:

${markerOpen(nonce)}
{
  "title": "Add guided review for marker engines",
  "intent": "Lets Cursor/OpenCode organize a changeset into the same chaptered review Claude/Codex produce.",
  "sections": [
    {
      "title": "Guide marker contract",
      "overview": "Explains what changed here, why it exists, and its key implications, in 2-6 sentences.",
      "diffs": [
        { "file": "packages/server/guide/guide-review.ts", "summary": "Adds the marker output contract so engines without a schema flag return the same guide JSON." }
      ]
    }
  ],
  "unplacedFiles": ["path/to/low-signal-file.ts"]
}
${markerClose(nonce)}

Schema:
- title: string, one line.
- intent: string, 1-2 sentences.
- sections: array of objects, each with
  - title: string — concept-level chapter title, NEVER a filename paraphrase
  - overview: string — markdown, 2-6 sentences: what changed, why it exists,
    and its key implications. Backtick file names/symbols/config keys; bold
    the single key clause; bullets only for 3+ parallel changes; a tiny
    fenced code block only when code says it better than prose
  - diffs: array of objects, each with two fields:
    - file: string — the EXACT repo-relative path as it appears in the diff or
      the Changed files list; never invented, abbreviated, or re-cased
    - summary: string — 1-2 sentences on the semantic change in this file,
      written from the diff hunks alone (no per-file investigation); what the
      change does, not which lines it touches; never a repeat of the overview
- unplacedFiles: array of strings, always present — changed files that don't
  belong in any section; use an empty array when every changed file is placed

Every changed file must appear in EXACTLY ONE place: either in exactly one
section's diffs, or in unplacedFiles. Never both, never twice, never omitted.
If no section fits a file, prefer a trailing grouped glue/wiring/config
chapter over dumping it in unplacedFiles.`;
}

/**
 * Compose a marker engine's guide prompt: the guide methodology (GUIDE_REVIEW_PROMPT,
 * unchanged from the claude/codex paths, plus any reviewer extra instructions
 * via composeGuideMethodology) + the marker output contract (nonce-tagged)
 * + the user message. Mirrors composeMarkerReviewPrompt's shape; guide has no
 * custom-profile concept, so there is no "replace the methodology" branch.
 */
export function composeGuideMarkerPrompt(userMessage: string, nonce: string, extraInstructions?: string): string {
  return composeGuideMethodology(extraInstructions) + "\n\n" + buildGuideMarkerOutputContract(nonce) + "\n\n---\n\n" + userMessage;
}

// ---------------------------------------------------------------------------
// Guide REPAIR prompts — a fundamentally different job than the normal guide
// prompt: the content to process is a previously-captured MALFORMED guide
// payload, not the diff. The model's only task is a mechanical JSON fix
// (structure/syntax), never a content rewrite.
// ---------------------------------------------------------------------------

/** System framing shared verbatim across all three repair engine paths. */
function buildGuideRepairFraming(): string {
  return "The JSON below was produced for the schema that follows but is malformed or structurally invalid. Output ONLY the corrected JSON. Fix structure and syntax; NEVER change the content: titles, overviews, file paths, summaries stay exactly as written unless syntactically impossible. If a required field is missing from the payload (e.g. a diff entry's summary), fill it with an empty string; never invent content.";
}

/** Repair prompt for the schema-enforced engines (Claude --json-schema,
 *  Codex --output-schema): framing + the schema + the malformed payload. */
export function buildGuideRepairPrompt(payload: string): string {
  return [buildGuideRepairFraming(), "", GUIDE_SCHEMA_JSON, "", payload].join("\n");
}

/** Repair prompt for marker engines: same framing + schema, wrapped in the
 *  marker output contract (nonce-tagged) since they have no schema flag —
 *  mirrors composeGuideMarkerPrompt's shape, with the malformed payload as
 *  the trailing content instead of a user message describing a diff. */
export function composeGuideMarkerRepairPrompt(payload: string, nonce: string): string {
  return buildGuideRepairFraming() + "\n\n" + GUIDE_SCHEMA_JSON + "\n\n" + buildGuideMarkerOutputContract(nonce) + "\n\n---\n\n" + payload;
}

// ---------------------------------------------------------------------------
// Mechanical JSON repair — a last-resort text-level fixup applied when a
// guide payload fails JSON.parse (or parses but has no non-empty `sections`
// array). Every failure mode considered here is a MODEL EMISSION problem (a
// truncated response, a stray code fence, a trailing comma), never a content
// problem — repair never rewrites titles/overviews/paths, only structure and
// syntax. Pure string logic; must never throw.
// ---------------------------------------------------------------------------

/** Closes any brackets/braces left open at end-of-text, in the correct
 *  nesting order (LIFO), skipping content inside string literals. A "simple
 *  balance count" per spec: no full JSON grammar, just bracket tracking.
 *  Returns the input unchanged when already balanced. */
function closeUnbalancedGuideBrackets(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if ((ch === "}" || ch === "]") && stack[stack.length - 1] === ch) stack.pop();
  }
  if (stack.length === 0 && !inString) return text;
  // Output truncated mid-string is the single most common truncation shape —
  // terminate the dangling literal before appending the bracket closers, or
  // everything we append lands inside the string and the parse still fails.
  return text + (inString ? '"' : "") + stack.reverse().join("");
}

/** Strips trailing commas (`,` immediately before `}`/`]`) WITHOUT touching
 *  commas inside string literals — a naive regex would rewrite overview text
 *  like `"we removed a, }"`, silently changing content the repair contract
 *  promises to preserve. */
function stripTrailingCommasOutsideStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString && ch === ",") {
      // Look ahead past whitespace: a `}`/`]` next makes this comma trailing.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue; // drop the comma
    }
    out += ch;
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') inString = !inString;
  }
  return out;
}

/**
 * Attempts to recover a valid `CodeGuideOutput` from mechanically-malformed
 * JSON text: progressively more aggressive fixups, JSON.parse retried after
 * each, first one that yields a non-empty `sections` array wins. Never
 * throws; returns null when every attempt is exhausted.
 *
 * Steps: (a) parse as-is, (b) strip a markdown code fence, (c) slice the
 * first `{` to the last `}`, (d) drop trailing commas before `}`/`]`,
 * (e) close brackets left open at end-of-text (truncated output), (f) drop
 * trailing commas once more (bracket-closing in (e) can introduce a fresh
 * one right before the closer it just appended).
 */
export function repairGuideJsonText(text: string): CodeGuideOutput | null {
  if (!text) return null;

  const attempts: string[] = [];
  let current = text.trim();
  attempts.push(current);

  const defenced = current.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  if (defenced !== current) { current = defenced; attempts.push(current); }

  const firstBrace = current.indexOf("{");
  const lastBrace = current.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const sliced = current.slice(firstBrace, lastBrace + 1);
    if (sliced !== current) { current = sliced; attempts.push(current); }
  }

  const noTrailingCommas = stripTrailingCommasOutsideStrings(current);
  if (noTrailingCommas !== current) { current = noTrailingCommas; attempts.push(current); }

  const balanced = closeUnbalancedGuideBrackets(current);
  if (balanced !== current) { current = balanced; attempts.push(current); }

  // Closing brackets (step e, above) can itself create a NEW trailing comma
  // right before the closer it just appended — truncation cut off text
  // immediately after a comma, e.g. `..."file": "a.ts",` with nothing after
  // it, so closeUnbalancedGuideBrackets appends `}]}` directly onto that
  // trailing comma. Running the trailing-comma strip once more, now that
  // the structure is closed, catches that pattern without re-opening any of
  // the earlier (already-tried) attempts.
  const recleaned = stripTrailingCommasOutsideStrings(current);
  if (recleaned !== current) { current = recleaned; attempts.push(current); }

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === "object") {
        const sections = (parsed as Record<string, unknown>).sections;
        if (Array.isArray(sections) && sections.length > 0) {
          return parsed as CodeGuideOutput;
        }
      }
    } catch {
      // Try the next, more-aggressively-fixed candidate.
    }
  }
  return null;
}

/**
 * Parse a marker engine's NDJSON stdout into a raw (untrusted) guide payload.
 *
 * Pipeline: line-buffered NDJSON reduce → reconstruct canonical text → take the
 * LAST complete marker block (nonce-scoped) → JSON.parse → shape-check
 * (non-empty sections array, mirroring parseGuideStreamOutput/parseGuideFileOutput).
 * Falls back to mechanical repair (repairGuideJsonText) on a parse failure or
 * invalid shape before returning null — the payload is still untrusted at
 * this point either way; onJobComplete's sanitize + validate pipeline
 * (sanitizeGuideSections et al., via validateGuideOutput) is what makes it
 * safe to render.
 */
export function parseGuideMarkerOutput(stdout: string, engine: MarkerEngine, nonce: string): CodeGuideOutput | null {
  if (!stdout || !stdout.trim()) return null;
  if (!nonce) return null; // no expected nonce → cannot trust any block

  const { canonicalText } = reduceMarkerStream(stdout, engine);
  if (!canonicalText) return null;

  const block = extractLastMarkerBlock(canonicalText, markerOpen(nonce), markerClose(nonce));
  if (block === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(block.trim());
  } catch {
    parsed = undefined;
  }

  if (parsed && typeof parsed === "object") {
    const output = parsed as Record<string, unknown>;
    // A guide with no sections isn't a guide — treat as invalid so the UI error
    // state fires instead of rendering an empty screen (same rule as the
    // claude/codex output paths).
    if (Array.isArray(output.sections) && output.sections.length > 0) {
      return output as unknown as CodeGuideOutput;
    }
  }

  // Straight parse failed, or produced an invalid shape — try mechanical
  // repair on the raw block before giving up (see repairGuideJsonText).
  return repairGuideJsonText(block);
}

export function parseGuideStreamOutput(stdout: string): CodeGuideOutput | null {
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
        // A guide with no sections isn't a guide — treat as invalid so the UI
        // error state fires instead of rendering an empty screen.
        if (!output || !Array.isArray(output.sections) || output.sections.length === 0) return null;
        return output as CodeGuideOutput;
      }
    } catch {
      // Not valid JSON as a whole line — this can happen when the final
      // NDJSON line (the schema-constrained result event) is truncated
      // mid-stream. If it still carries the structured_output key, try
      // mechanically repairing just that embedded value before giving up on
      // this line.
      const marker = '"structured_output":';
      const idx = line.indexOf(marker);
      if (idx !== -1) {
        const repaired = repairGuideJsonText(line.slice(idx + marker.length));
        if (repaired) return repaired;
      }
    }
  }

  return null;
}

/** Reads and deletes a Codex `--output-file` JSON payload. Deletion happens
 *  even on read failure (mirrors the original inline try/finally) so a
 *  crashed job never leaves a stray temp file behind. */
async function readGuideOutputFile(outputPath: string): Promise<string | null> {
  try {
    return await readFile(outputPath, "utf-8");
  } catch {
    return null;
  } finally {
    try { await unlink(outputPath); } catch { /* ignore */ }
  }
}

/** Parses guide output text already read from disk/stdout, falling back to
 *  mechanical repair (repairGuideJsonText) on a parse failure or invalid
 *  shape before giving up. Shared by parseGuideFileOutput and
 *  onJobComplete's codex branch (which needs the raw text separately, for
 *  failed-payload capture). */
function parseGuideOutputText(text: string): CodeGuideOutput | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    // A guide with no sections isn't a guide — treat as invalid so the UI
    // error state fires instead of rendering an empty screen.
    if (parsed && Array.isArray(parsed.sections) && parsed.sections.length > 0) {
      return parsed as CodeGuideOutput;
    }
  } catch {
    // fall through to mechanical repair
  }
  return repairGuideJsonText(text);
}

export async function parseGuideFileOutput(outputPath: string): Promise<CodeGuideOutput | null> {
  const text = await readGuideOutputFile(outputPath);
  if (text === null) return null;
  return parseGuideOutputText(text);
}

export interface GuideSessionBuildCommandOptions {
  cwd: string;
  patch: string;
  diffType: DiffType;
  options?: { defaultBranch?: string; hasLocalAccess?: boolean; prDiffScope?: string; workspace?: WorkspaceReviewPromptContext };
  prMetadata?: PRMetadata;
  /** Currently-changed file paths + stats, appended to the user message so the
   * model plans section placement against the real file set. */
  changedFiles?: GuideChangedFile[];
  config?: Record<string, unknown>;
  /** Set when this launch is a repair attempt for a previously-failed guide
   *  job — buildCommand produces a REPAIR prompt (fix syntax, never content)
   *  instead of the normal guide-organizing prompt, and forces low-effort
   *  defaults regardless of `config`. */
  repair?: { payload: string };
}

export interface GuideSessionBuildCommandResult {
  command: string[];
  outputPath?: string;
  captureStdout?: boolean;
  stdinPrompt?: string;
  cwd?: string;
  label?: string;
  prompt?: string;
  engine: "claude" | "codex" | MarkerEngineId;
  model: string;
  effort?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  /** Pi's unified reasoning level (marker engines only). */
  thinking?: string;
}

export interface GuideSessionJobSummary {
  correctness: string;
  explanation: string;
  confidence: number;
}

export interface GuideSessionJobRef {
  id: string;
  engine?: string;
  /** Full prompt text stored on the job at launch. Only read for Cursor/OpenCode/
   *  Pi jobs, to recover the per-job marker nonce (extractMarkerNonce) — the
   *  claude/codex paths never touch it. */
  prompt?: string;
}

export interface GuideSessionOnJobCompleteOptions {
  job: GuideSessionJobRef;
  meta: { outputPath?: string; stdout?: string };
  /** Changed files to validate refs against — normally the LAUNCH-time
   * snapshot (agent-jobs.ts's changedFilesSnapshot), the same set the model
   * planned section placement against, so a mid-generation diff/base/PR
   * switch never invalidates an otherwise-valid guide. Only falls back to
   * the current patch when a snapshot wasn't available (defensive). */
  changedFiles: string[];
  /** The review this guide describes, captured at LAUNCH (decision record D6).
   *  Recorded whether or not the output validates, so a later repair or
   *  export sees the same diff the model was given. */
  launchReview?: GuideLaunchReview;
}

export interface GuideSession {
  guideResults: Map<string, CodeGuideOutput>;
  guideReviewed: Map<string, boolean[]>;
  /** Best-effort raw-payload capture keyed by job id, for any guide job that
   *  failed to parse or fully validate — the manual-repair UI reads this via
   *  getFailedPayload rather than the map directly. */
  failedPayloads: Map<string, string>;
  /** The changed-file set (as of LAUNCH time) each job's output was validated
   *  against, recorded in onJobComplete for both the success and failure
   *  paths. Outlives the job itself (unlike agent-jobs.ts's per-job snapshot,
   *  which is cleared at completion) so a later manual repair via
   *  submitManualOutput validates against the SAME set the model planned
   *  section placement against, not whatever patch happens to be on screen
   *  when the reviewer gets around to fixing the JSON. */
  launchChangedFiles: Map<string, string[]>;
  /** Launch-time review per job id (patch + labels + source). In-memory
   *  source of truth for exporting a live guide this session; the persisted
   *  copy (guide-store) is authoritative for `saved:` ids and after restart.
   *  Bounded to the most recent MAX_LAUNCH_REVIEWS jobs — each entry holds a
   *  full patch. */
  launchReviews: Map<string, GuideLaunchReview>;
  buildCommand(opts: GuideSessionBuildCommandOptions): Promise<GuideSessionBuildCommandResult>;
  onJobComplete(opts: GuideSessionOnJobCompleteOptions): Promise<{
    summary: GuideSessionJobSummary | null;
    /** Sanitized provider failure when transport succeeded but the Pi run did
     *  not, or an informative validation failure worth showing verbatim on
     *  the job card (refs outside the changeset under review). */
    error?: string;
  }>;
  getGuide(jobId: string): (CodeGuideOutput & { reviewed: boolean[] }) | null;
  saveReviewed(jobId: string, reviewed: boolean[]): void;
  getFailedPayload(jobId: string): string | null;
  /** The changed-file set (as of LAUNCH time) recorded for a given job id, or
   *  null if none was ever recorded (job unknown, or predates this session).
   *  Used by review.ts to snapshot a REPAIR job's `changedFilesSnapshot` from
   *  the FAILED job's own recorded set, rather than from whatever diff is on
   *  screen at repair time (see the repairOf branch in buildAgentJob). */
  getLaunchChangedFiles(jobId: string): string[] | null;
  /** Launch-time review recorded for a job id, or null. Repairs reuse the
   *  FAILED job's review the same way they reuse its changed-file set. */
  getLaunchReview(jobId: string): GuideLaunchReview | null;
  /** Manually submit corrected guide JSON (mechanical repair -> parse ->
   *  validateGuideOutput) for a job whose automatic output failed. Success
   *  stores under the SAME job id the reviewed state is already keyed to.
   *  Validates against the job's own launchChangedFiles when recorded, else
   *  falls back to `fallbackChangedFiles` (defensive; should not happen in
   *  practice since onJobComplete always records it first). Returns the
   *  placed section/file counts so the caller can flip the job to "done"
   *  with an accurate summary (see review.ts's /submit route). */
  submitManualOutput(jobId: string, payloadText: string, fallbackChangedFiles: string[]): { ok: true; sections: number; files: number } | { error: string };
}

/** Cap on stored failed-payload size — keeps a looping/verbose engine from
 *  growing the map unbounded; a manual repair attempt on a >200KB guide
 *  output is unlikely to succeed anyway. */
const MAX_FAILED_PAYLOAD_CHARS = 200_000;

/** Launch reviews retained per session (each holds a full patch). Oldest evicted first. */
const MAX_LAUNCH_REVIEWS = 20;

/** Best-effort capture of a job's raw (unparseable/invalidated) output for
 *  later manual repair. Never throws — a capture failure must never mask the
 *  original parse/validation failure it's trying to preserve evidence of. */
function stashFailedPayload(map: Map<string, string>, jobId: string, candidate: string | undefined): void {
  try {
    if (!candidate) return;
    map.set(jobId, candidate.length > MAX_FAILED_PAYLOAD_CHARS ? candidate.slice(-MAX_FAILED_PAYLOAD_CHARS) : candidate);
  } catch {
    // Best-effort — never let capture failure mask the original failure path.
  }
}

/** Best-effort raw-candidate extraction for a failed marker-engine job: the
 *  marker block if one can be recovered (even a truncated/garbled one), else
 *  the raw stdout tail. Deliberately loose — parseGuideMarkerOutput already
 *  tried the strict path; this just gives the manual-repair UI something to
 *  start from. */
function extractMarkerFailedPayload(engine: MarkerEngine, stdout: string, nonce: string | null): string {
  if (nonce) {
    const { canonicalText } = reduceMarkerStream(stdout, engine);
    if (canonicalText) {
      const block = extractLastMarkerBlock(canonicalText, markerOpen(nonce), markerClose(nonce));
      if (block !== null) return block;
    }
  }
  return stdout;
}

/** Finds the last NDJSON `result` event in Claude stream-json stdout,
 *  regardless of whether it carries a valid structured_output — used only
 *  for failed-payload capture, never for the trusted parse path. */
function findLastClaudeResultEvent(stdout: string): Record<string, unknown> | null {
  if (!stdout.trim()) return null;
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === "object" && (event as Record<string, unknown>).type === "result") {
        return event as Record<string, unknown>;
      }
    } catch {
      // keep scanning backward past malformed lines
    }
  }
  return null;
}

/** Best-effort raw-candidate extraction for a failed Claude-engine job: the
 *  structured_output value if the last result event carried one (even if it
 *  failed shape validation), else the raw stdout tail. */
function extractClaudeFailedPayload(stdout: string): string {
  const event = findLastClaudeResultEvent(stdout);
  if (event && event.structured_output !== undefined) {
    try {
      return JSON.stringify(event.structured_output);
    } catch {
      // fall through to stdout tail
    }
  }
  return stdout;
}

export function createGuideSession(): GuideSession {
  const guideResults = new Map<string, CodeGuideOutput>();
  const guideReviewed = new Map<string, boolean[]>();
  const failedPayloads = new Map<string, string>();
  const launchChangedFiles = new Map<string, string[]>();
  const launchReviews = new Map<string, GuideLaunchReview>();

  return {
    guideResults,
    guideReviewed,
    failedPayloads,
    launchChangedFiles,
    launchReviews,

    async buildCommand({ cwd, patch, diffType, options, prMetadata, changedFiles, config, repair }) {
      const engine = (typeof config?.engine === "string" ? config.engine : "claude") as "claude" | "codex" | MarkerEngineId;
      const explicitModel = typeof config?.model === "string" && config.model ? config.model : null;
      // "sonnet" is a Claude model, so we must NOT pass it to Codex or the
      // marker engines (Cursor, OpenCode, Pi) when no model is explicitly
      // selected. Leave their model blank and let each CLI's own default pick.
      const model = explicitModel ?? (engine === "claude" ? "sonnet" : "");
      const reasoningEffort = typeof config?.reasoningEffort === "string" && config.reasoningEffort ? config.reasoningEffort : undefined;
      const effort = typeof config?.effort === "string" && config.effort ? config.effort : undefined;
      const fastMode = config?.fastMode === true;

      if (repair) {
        // A repair launch replaces the normal guide-organizing prompt
        // entirely: the payload (a previously-captured malformed guide
        // output) IS the content to fix, not the diff. Force low-effort
        // defaults — this is a mechanical JSON-syntax fix, not a
        // re-analysis, and should be fast and cheap.
        const markerEngine = MARKER_ENGINES[engine as MarkerEngineId];
        if (markerEngine) {
          const thinking = "minimal";
          const nonce = makeMarkerNonce();
          const markerPrompt = composeGuideMarkerRepairPrompt(repair.payload, nonce);
          const { command } = buildMarkerCommand(markerEngine, markerPrompt, model || undefined, cwd, { thinking, cursorSandbox: resolveCursorSandbox(loadConfig()) });
          return { command, prompt: markerPrompt, cwd, label: "Guide Repair", captureStdout: true, engine: markerEngine.id, model, thinking };
        }

        const repairPrompt = buildGuideRepairPrompt(repair.payload);

        if (engine === "codex") {
          const outputPath = generateGuideOutputPath();
          // "low" not "minimal": no current Codex model supports minimal.
          const command = await buildGuideCodexCommand({ cwd, outputPath, prompt: repairPrompt, model: model || undefined, reasoningEffort: "low", fastMode: false });
          return { command, outputPath, prompt: repairPrompt, label: "Guide Repair", engine: "codex", model, reasoningEffort: "low" };
        }

        const { command, stdinPrompt } = buildGuideClaudeCommand(repairPrompt, model, "low");
        return { command, stdinPrompt, prompt: repairPrompt, cwd, label: "Guide Repair", captureStdout: true, engine: "claude", model, effort: "low" };
      }

      // Reviewer-supplied extra instructions (#1265) apply only to the normal
      // guide-organizing prompt. The repair paths above never see them: a
      // repair is a mechanical JSON-syntax fix of previously-captured output,
      // and content preferences have no business influencing it.
      const extraInstructions =
        typeof config?.instructions === "string" && config.instructions.trim().length > 0
          ? config.instructions
          : undefined;

      const userMessage = buildGuideUserMessage(patch, diffType, options, prMetadata, changedFiles);

      // Marker engines (Cursor, OpenCode, Pi) — none has a schema flag, so the
      // guide contract's marker-delimited JSON block (composeGuideMarkerPrompt)
      // is the only way to get structured output back. Mirrors review.ts's
      // marker branch: per-job nonce embedded in the prompt, recovered from
      // job.prompt at parse time in onJobComplete below. captureStdout is
      // required — the marker block comes back on stdout NDJSON.
      const markerEngine = MARKER_ENGINES[engine as MarkerEngineId];
      if (markerEngine) {
        const thinking = typeof config?.thinking === "string" && config.thinking ? config.thinking : undefined;
        const nonce = makeMarkerNonce();
        const markerPrompt = composeGuideMarkerPrompt(userMessage, nonce, extraInstructions);
        const { command } = buildMarkerCommand(markerEngine, markerPrompt, model || undefined, cwd, { thinking, cursorSandbox: resolveCursorSandbox(loadConfig()) });
        return { command, prompt: markerPrompt, cwd, label: "Guided Review", captureStdout: true, engine: markerEngine.id, model, thinking };
      }

      const prompt = composeGuideMethodology(extraInstructions) + "\n\n---\n\n" + userMessage;

      if (engine === "codex") {
        const outputPath = generateGuideOutputPath();
        const command = await buildGuideCodexCommand({ cwd, outputPath, prompt, model: model || undefined, reasoningEffort, fastMode });
        return { command, outputPath, prompt, label: "Guided Review", engine: "codex", model, reasoningEffort, fastMode: fastMode || undefined };
      }

      const { command, stdinPrompt } = buildGuideClaudeCommand(prompt, model, effort);
      return { command, stdinPrompt, prompt, cwd, label: "Guided Review", captureStdout: true, engine: "claude", model, effort };
    },

    async onJobComplete({ job, meta, changedFiles, launchReview }) {
      // Record the changed-file set this attempt validated against — BEFORE
      // parsing, so both the success and failure paths capture it. A later
      // manual repair (submitManualOutput) reuses this exact set instead of
      // whatever patch happens to be on screen at repair time.
      launchChangedFiles.set(job.id, changedFiles);
      if (launchReview) {
        // Same discipline for the review itself; bounded because each entry
        // carries a full patch.
        launchReviews.delete(job.id);
        launchReviews.set(job.id, launchReview);
        while (launchReviews.size > MAX_LAUNCH_REVIEWS) {
          const oldest = launchReviews.keys().next().value;
          if (oldest === undefined) break;
          launchReviews.delete(oldest);
        }
      }

      let output: CodeGuideOutput | null = null;
      // Best-effort raw candidate for failed-payload capture — populated
      // alongside `output` regardless of whether parsing ultimately
      // succeeds, then only stashed below on an actual failure.
      let rawCandidate: string | undefined;

      const markerEngine = MARKER_ENGINES[job.engine as MarkerEngineId];
      if (markerEngine) {
        // Recover the per-job nonce embedded in the prompt; without it no
        // block can be trusted, so parsing fails closed below (same
        // discipline as the review path's marker ingestion).
        const nonce = extractMarkerNonce(job.prompt ?? "");
        output = nonce && meta.stdout ? parseGuideMarkerOutput(meta.stdout, markerEngine, nonce) : null;
        if (meta.stdout) {
          // A valid guide always wins, even if the stream contains an earlier
          // transient error. Only classify the structured provider failure
          // after strict marker parsing has failed.
          if (!output) {
            const { providerError } = reduceMarkerStream(meta.stdout, markerEngine);
            if (providerError) {
              console.error(`[guide] ${markerEngine.author} provider error for job ${job.id}: ${providerError}`);
              return { summary: null, error: providerError };
            }
          }
          rawCandidate = extractMarkerFailedPayload(markerEngine, meta.stdout, nonce);
        }
      } else if (job.engine === "codex" && meta.outputPath) {
        const rawText = await readGuideOutputFile(meta.outputPath);
        output = rawText !== null ? parseGuideOutputText(rawText) : null;
        rawCandidate = rawText ?? undefined;
      } else if (meta.stdout) {
        output = parseGuideStreamOutput(meta.stdout);
        rawCandidate = extractClaudeFailedPayload(meta.stdout);
      }

      if (!output) {
        console.error(`[guide] Failed to parse output for job ${job.id}`);
        stashFailedPayload(failedPayloads, job.id, rawCandidate);
        return { summary: null };
      }

      // Fail-closed validation against the current changed-file set: the
      // model is instructed but not trusted. See validateGuideOutput.
      const result = validateGuideOutput(output, changedFiles);
      if ("error" in result) {
        console.error(`[guide] ${result.error} for job ${job.id}`);
        stashFailedPayload(failedPayloads, job.id, rawCandidate);
        // Surface only the informative outside-changeset explanation on the
        // failure card; the generic structural case keeps the empty-output
        // message the caller substitutes when `error` is absent.
        return result.error === GUIDE_NO_SECTIONS_ERROR
          ? { summary: null }
          : { summary: null, error: result.error };
      }

      guideResults.set(job.id, result.guide);
      failedPayloads.delete(job.id);

      const totalFiles = result.guide.sections.reduce((n, s) => n + s.diffs.length, 0);
      const summary: GuideSessionJobSummary = {
        correctness: "Guide Generated",
        explanation: `${result.guide.sections.length} section${result.guide.sections.length !== 1 ? "s" : ""}, ${totalFiles} file${totalFiles !== 1 ? "s" : ""} placed`,
        confidence: 1.0,
      };
      return { summary };
    },

    getGuide(jobId) {
      const guide = guideResults.get(jobId);
      if (!guide) return null;
      return { ...guide, reviewed: guideReviewed.get(jobId) ?? [] };
    },

    saveReviewed(jobId, reviewed) {
      guideReviewed.set(jobId, reviewed);
    },

    getFailedPayload(jobId) {
      return failedPayloads.get(jobId) ?? null;
    },

    getLaunchChangedFiles(jobId) {
      return launchChangedFiles.get(jobId) ?? null;
    },

    getLaunchReview(jobId) {
      return launchReviews.get(jobId) ?? null;
    },

    submitManualOutput(jobId, payloadText, fallbackChangedFiles) {
      if (!payloadText || !payloadText.trim()) {
        return { error: "Payload is empty" };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(payloadText);
      } catch {
        parsed = undefined;
      }

      const hasSections = !!parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).sections);
      if (!hasSections) {
        // Straight parse failed, or produced something not guide-shaped yet —
        // let mechanical repair take a pass at the raw text either way.
        const repaired = repairGuideJsonText(payloadText);
        if (!repaired) {
          return { error: "Not valid JSON after repair attempts" };
        }
        parsed = repaired;
      }

      // Validate against the SAME changed-file set the job's automatic
      // attempt(s) were validated against (recorded in onJobComplete), not
      // whatever patch happens to be on screen right now — falls back to the
      // caller-supplied set only if nothing was ever recorded for this job.
      const changedFiles = launchChangedFiles.get(jobId) ?? fallbackChangedFiles;
      const result = validateGuideOutput(parsed, changedFiles);
      if ("error" in result) return { error: result.error };

      guideResults.set(jobId, result.guide);
      failedPayloads.delete(jobId);
      const files = result.guide.sections.reduce((n, s) => n + s.diffs.length, 0);
      return { ok: true, sections: result.guide.sections.length, files };
    },
  };
}
