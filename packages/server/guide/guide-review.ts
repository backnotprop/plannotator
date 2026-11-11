import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { codexAskAiConfigArgs, readCodexConfigTexts } from "@plannotator/ai/providers/ask-ai-env";
import { loadConfig, resolveClaudeSandbox, resolveCursorSandbox } from "../config";
import { claudeJobIsolationArgs, claudeJobToolArgs, findClaudeStructuredOutput, type ClaudeJobCommandOptions } from "../claude-review";
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
import { getPRPlatformCapabilities, type PRMetadata } from "../pr";
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

export { GUIDE_NO_SECTIONS_ERROR, GUIDE_REVIEW_PROMPT, GUIDE_SCHEMA_JSON, buildGuideUserMessage, validateGuideOutput };
export type { GuideChangedFile, GuidePromptPRMetadata } from "@plannotator/shared/guide-prompt";

export const GUIDE_EMPTY_OUTPUT_ERROR = "Guide generation returned empty or malformed output";

/** The guide methodology, optionally extended with reviewer-supplied extra instructions APPENDED as a delimited section; blank instructions return GUIDE_REVIEW_PROMPT itself. Text beyond GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS is truncated. */
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

export function buildGuideClaudeCommand(
  prompt: string,
  model: string = "sonnet",
  effort?: string,
  opts?: ClaudeJobCommandOptions,
): GuideClaudeCommandResult {
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
      ...claudeJobToolArgs(),
      ...claudeJobIsolationArgs(opts),
    ],
    stdinPrompt: prompt,
  };
}

function guideSchemaPath(): string {
  return join(getPlannotatorDataDir(), "guide-schema.json");
}

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
    // The Inbox MCP server off: Codex hands a stdio MCP server none of the job's env.
    ...codexAskAiConfigArgs(readCodexConfigTexts(cwd)),
    "exec",
    "--output-schema", schemaPath,
    "-o", outputPath,
    "--approve-for-me", "--ephemeral",
    "-C", cwd,
    prompt,
  ];

  return command;
}

/** Output contract appended after the guide methodology for marker engines, in prose plus example since there is no schema flag. The nonce comes from makeMarkerNonce() and is recovered with extractMarkerNonce() at parse time. */
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

export function composeGuideMarkerPrompt(userMessage: string, nonce: string, extraInstructions?: string): string {
  return composeGuideMethodology(extraInstructions) + "\n\n" + buildGuideMarkerOutputContract(nonce) + "\n\n---\n\n" + userMessage;
}

function buildGuideRepairFraming(): string {
  return "The JSON below was produced for the schema that follows but is malformed or structurally invalid. Output ONLY the corrected JSON. Fix structure and syntax; NEVER change the content: titles, overviews, file paths, summaries stay exactly as written unless syntactically impossible. If a required field is missing from the payload (e.g. a diff entry's summary), fill it with an empty string; never invent content.";
}

export function buildGuideRepairPrompt(payload: string): string {
  return [buildGuideRepairFraming(), "", GUIDE_SCHEMA_JSON, "", payload].join("\n");
}

export function composeGuideMarkerRepairPrompt(payload: string, nonce: string): string {
  return buildGuideRepairFraming() + "\n\n" + GUIDE_SCHEMA_JSON + "\n\n" + buildGuideMarkerOutputContract(nonce) + "\n\n---\n\n" + payload;
}

// Mechanical JSON repair: a last-resort text-level fixup for guide payloads that fail JSON.parse. It fixes structure and syntax, never content; pure string logic that must never throw.

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

/** Strips trailing commas WITHOUT touching commas inside string literals: a naive regex would rewrite overview text like `"we removed a, }"`. */
function stripTrailingCommasOutsideStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString && ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') inString = !inString;
  }
  return out;
}

/** Recovers a valid `CodeGuideOutput` from mechanically malformed JSON text: progressively more aggressive fixups, the first that yields a non-empty `sections` array wins. Never throws; returns null when every attempt is exhausted. */
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

  // Closing brackets can create a NEW trailing comma (truncation right after a comma), so strip trailing commas once more now that the structure is closed.
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
 * Parse a marker engine's NDJSON stdout into a raw (untrusted) guide payload: the LAST complete nonce-scoped marker block, JSON.parse, shape-check, mechanical repair on failure.
 * onJobComplete's sanitize + validate is what makes it safe to render.
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
    if (Array.isArray(output.sections) && output.sections.length > 0) {
      return output as unknown as CodeGuideOutput;
    }
  }

  return repairGuideJsonText(block);
}

export function parseGuideStreamOutput(stdout: string): CodeGuideOutput | null {
  return findClaudeStructuredOutput(
    stdout,
    (output) => {
      const sections = output && typeof output === 'object' ? (output as { sections?: unknown }).sections : undefined;
      return Array.isArray(sections) && sections.length > 0 ? (output as CodeGuideOutput) : null;
    },
    (line) => {
      // Not valid JSON as a whole line: the final schema-constrained result event can be truncated mid-stream; if it still carries structured_output, repair just that value.
      const marker = '"structured_output":';
      const idx = line.indexOf(marker);
      return idx === -1 ? null : repairGuideJsonText(line.slice(idx + marker.length));
    },
  );
}

async function readGuideOutputFile(outputPath: string): Promise<string | null> {
  try {
    return await readFile(outputPath, "utf-8");
  } catch {
    return null;
  } finally {
    try { await unlink(outputPath); } catch { /* ignore */ }
  }
}

function parseGuideOutputText(text: string): CodeGuideOutput | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
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
  changedFiles?: GuideChangedFile[];
  config?: Record<string, unknown>;
  /** Set when this launch is a repair attempt for a failed guide job: buildCommand produces a REPAIR prompt (fix syntax, never content) with low-effort defaults regardless of `config`. */
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
  /** Prompt text stored on the job at launch; read only for Cursor/OpenCode/Pi jobs, to recover the marker nonce. */
  prompt?: string;
}

export interface GuideSessionOnJobCompleteOptions {
  job: GuideSessionJobRef;
  meta: { outputPath?: string; stdout?: string };
  /** Changed files to validate refs against: normally the LAUNCH-time snapshot, so a mid-generation diff/base/PR switch never invalidates a valid guide; the current patch only when no snapshot was available. */
  changedFiles: string[];
  /** The review this guide describes, captured at LAUNCH and recorded whether or not the output validates, so a later repair or export sees the same diff the model was given. */
  launchReview?: GuideLaunchReview;
}

export interface GuideSession {
  guideResults: Map<string, CodeGuideOutput>;
  guideReviewed: Map<string, boolean[]>;
  failedPayloads: Map<string, string>;
  /** The changed-file set (as of LAUNCH time) each job's output was validated against; it outlives the job so a later manual repair validates against the same set the model planned against. */
  launchChangedFiles: Map<string, string[]>;
  /** Launch-time review per job id: in-memory source for exporting a live guide; the persisted copy (guide-store) is authoritative for `saved:` ids and after restart. Bounded to MAX_LAUNCH_REVIEWS since each entry holds a full patch. */
  launchReviews: Map<string, GuideLaunchReview>;
  buildCommand(opts: GuideSessionBuildCommandOptions): Promise<GuideSessionBuildCommandResult>;
  onJobComplete(opts: GuideSessionOnJobCompleteOptions): Promise<{
    summary: GuideSessionJobSummary | null;
    error?: string;
  }>;
  getGuide(jobId: string): (CodeGuideOutput & { reviewed: boolean[] }) | null;
  saveReviewed(jobId: string, reviewed: boolean[]): void;
  getFailedPayload(jobId: string): string | null;
  getLaunchChangedFiles(jobId: string): string[] | null;
  getLaunchReview(jobId: string): GuideLaunchReview | null;
  /** Manually submit corrected guide JSON for a job whose automatic output failed; stores under the same job id, validating against the job's launch-time changed files when recorded. */
  submitManualOutput(jobId: string, payloadText: string, fallbackChangedFiles: string[]): { ok: true; sections: number; files: number } | { error: string };
}

/** Cap on stored failed-payload size, so a looping or verbose engine cannot grow the map unbounded. */
const MAX_FAILED_PAYLOAD_CHARS = 200_000;

const MAX_LAUNCH_REVIEWS = 20;

/** Best-effort: a capture failure must never mask the original parse/validation failure. */
function stashFailedPayload(map: Map<string, string>, jobId: string, candidate: string | undefined): void {
  try {
    if (!candidate) return;
    map.set(jobId, candidate.length > MAX_FAILED_PAYLOAD_CHARS ? candidate.slice(-MAX_FAILED_PAYLOAD_CHARS) : candidate);
  } catch {
    // Best-effort — never let capture failure mask the original failure path.
  }
}

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

/** Newest NDJSON `result` event in Claude stream-json stdout carrying a `structured_output` key, valid or not; for failed-payload capture only, never the trusted parse. Trailing result events of a run with background subagents often carry no output. */
function findLastClaudeResultWithOutput(stdout: string): Record<string, unknown> | null {
  if (!stdout.trim()) return null;
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === "object" && (event as Record<string, unknown>).type === "result"
        && (event as Record<string, unknown>).structured_output !== undefined) {
        return event as Record<string, unknown>;
      }
    } catch {
      // keep scanning backward past malformed lines
    }
  }
  return null;
}

function extractClaudeFailedPayload(stdout: string): string {
  const event = findLastClaudeResultWithOutput(stdout);
  if (event) {
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
      // "sonnet" is a Claude model: do not pass it to Codex or the marker engines when no model is selected; leave theirs blank so each CLI picks its default.
      const model = explicitModel ?? (engine === "claude" ? "sonnet" : "");
      const reasoningEffort = typeof config?.reasoningEffort === "string" && config.reasoningEffort ? config.reasoningEffort : undefined;
      const effort = typeof config?.effort === "string" && config.effort ? config.effort : undefined;
      const fastMode = config?.fastMode === true;

      if (repair) {
        // A repair launch replaces the normal prompt entirely: the malformed payload is the content to fix, not the diff, and low-effort defaults apply.
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

        const { command, stdinPrompt } = buildGuideClaudeCommand(repairPrompt, model, "low", { sandbox: resolveClaudeSandbox(loadConfig()) });
        return { command, stdinPrompt, prompt: repairPrompt, cwd, label: "Guide Repair", captureStdout: true, engine: "claude", model, effort: "low" };
      }

      // Reviewer extra instructions apply only to the normal guide prompt, never to the mechanical repair paths.
      const extraInstructions =
        typeof config?.instructions === "string" && config.instructions.trim().length > 0
          ? config.instructions
          : undefined;

      const promptPRMetadata = prMetadata && !getPRPlatformCapabilities(prMetadata).agentCliAccess
        ? { ...prMetadata, inlineDiff: true }
        : prMetadata;
      const userMessage = buildGuideUserMessage(patch, diffType, options, promptPRMetadata, changedFiles);

      // Marker engines have no schema flag: the marker-delimited JSON block is the only way to get structured output back, with a per-job nonce recovered from job.prompt at parse time. captureStdout is required.
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

      const { command, stdinPrompt } = buildGuideClaudeCommand(prompt, model, effort, { sandbox: resolveClaudeSandbox(loadConfig()) });
      return { command, stdinPrompt, prompt, cwd, label: "Guided Review", captureStdout: true, engine: "claude", model, effort };
    },

    async onJobComplete({ job, meta, changedFiles, launchReview }) {
      // Record the changed-file set this attempt validated against BEFORE parsing, so a later manual repair reuses it.
      launchChangedFiles.set(job.id, changedFiles);
      if (launchReview) {
        launchReviews.delete(job.id);
        launchReviews.set(job.id, launchReview);
        while (launchReviews.size > MAX_LAUNCH_REVIEWS) {
          const oldest = launchReviews.keys().next().value;
          if (oldest === undefined) break;
          launchReviews.delete(oldest);
        }
      }

      let output: CodeGuideOutput | null = null;
      let rawCandidate: string | undefined;

      const markerEngine = MARKER_ENGINES[job.engine as MarkerEngineId];
      if (markerEngine) {
        // Without the per-job nonce embedded in the prompt no block can be trusted, so parsing fails closed.
        const nonce = extractMarkerNonce(job.prompt ?? "");
        output = nonce && meta.stdout ? parseGuideMarkerOutput(meta.stdout, markerEngine, nonce) : null;
        if (meta.stdout) {
          // A valid guide always wins over an earlier transient error; classify a provider failure only after strict marker parsing has failed.
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

      // Fail-closed validation against the current changed-file set: the model is instructed but not trusted.
      const result = validateGuideOutput(output, changedFiles);
      if ("error" in result) {
        console.error(`[guide] ${result.error} for job ${job.id}`);
        stashFailedPayload(failedPayloads, job.id, rawCandidate);
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
        const repaired = repairGuideJsonText(payloadText);
        if (!repaired) {
          return { error: "Not valid JSON after repair attempts" };
        }
        parsed = repaired;
      }

      // Validate against the same changed-file set the job's automatic attempts used, not the patch on screen; the caller-supplied set only if none was recorded.
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
