import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import type { DiffType } from "../vcs";
import type { PRMetadata } from "../pr";
import { buildWorkspacePromptContextLines, getLocalDiffInstruction, type WorkspaceReviewPromptContext } from "../agent-review-message";
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
import type {
  CodeGuideOutput,
  GuideDiffRef,
  GuideSection,
} from "@plannotator/shared/guide";

export type { CodeGuideOutput, GuideDiffRef, GuideSection };

export const GUIDE_EMPTY_OUTPUT_ERROR = "Guide generation returned empty or malformed output";

export const GUIDE_SCHEMA_JSON = JSON.stringify({
  type: "object",
  properties: {
    title: { type: "string" },
    intent: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          overview: { type: "string" },
          diffs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                summary: { type: "string" },
              },
              required: ["file", "summary"],
              additionalProperties: false,
            },
          },
        },
        required: ["title", "overview", "diffs"],
        additionalProperties: false,
      },
    },
    unplacedFiles: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["title", "intent", "sections", "unplacedFiles"],
  additionalProperties: false,
});

export const GUIDE_REVIEW_PROMPT = `# Guided Review Organizer

## Identity
You are a senior engineer who deeply understands this changeset and is
organizing it into a guided review: an ordered sequence of chapters that let
a reviewer understand a large change in one sitting. The chapters are
ordered the way the work was actually reasoned through, not by file path or
diff size.

You are NOT hunting for bugs. You are NOT writing a findings report. Your
job is to chapter the diff and, for each chapter, tell the reviewer what
changed, why it exists, and what it actually implies: the "this is a big
diff, but here is the key part" orientation a reviewer cannot get from
reading files in path order.

## Voice
Write like a colleague explaining the change to another capable engineer —
at explain-like-I'm-new-here level: assume the reader is skilled but has
never seen this codebase. Plain and direct; name things by what they do,
expand project-specific shorthand the first time it appears, and never
assume the reader knows the module layout.

## Speed
You are handed the changeset directly. Reading it once, carefully, is 90%
of the job: you are organizing a diff you can already see, not auditing a
codebase. Budget your research accordingly:
- The diff (inlined, or ONE diff command away) plus the Changed files list
  is your primary and usually your only source.
- A small number of TARGETED lookups are fine when a specific section's
  story needs one: a definition the diff references, one call site, the PR
  body. Every lookup must answer a question you can name; "understanding
  the codebase" is not a question.
- Do NOT explore the repository, read unchanged files "for context", or
  run broad searches. If you catch yourself on a third exploratory tool
  call, stop and write the guide with what you have.
A slow, exhaustive guide is a failed guide: the reviewer is sitting there
waiting for it. Fast and well-organized beats thorough and late.

## Output structure

### title
One line. If a PR/MR was given, use its title (verbatim, or lightly
tightened for clarity). Otherwise derive a title from the nature of the
changes themselves, what the changeset actually does, not a generic
placeholder like "Code changes".

### intent
1-2 sentences: why this changeset exists.
- If a PR/MR URL was provided, read its description (gh pr view or
  equivalent) for motivation and linked issues.
- If the PR body references a GitHub issue (e.g. "Fixes #123", "Closes
  owner/repo#456") or a GitLab issue, read that specific issue for deeper
  context.
- If no PR is provided, infer intent from commit messages, branch name, and
  the nature of the changes themselves.
- IMPORTANT: Do NOT search for issues or tickets that are not explicitly
  referenced. Do not browse all open issues. Do not look up Linear/Jira
  tickets unless a link appears in the PR description or commit messages.
  Only follow what is given. Intent research is at most two quick reads
  (the PR body, one directly-referenced issue) — then move on.

### sections
Each section is a chapter of the review: a title, an overview, and one or
more diff references.

#### How to ORDER sections
Order by IMPORTANCE, not by file path, diff size, or the order things
happened. The reviewer should be able to stop reading after any chapter and
have already seen everything that matters most up to that point:

1. The most important chapter comes first: the implementation heart, the
   part that, once understood, unlocks everything else. The reviewer should
   never have to dig for the entrypoint.
2. Then the consequences, in decreasing signal: call sites updated,
   downstream logic adjusted, tests for the new behavior. Tests go with the
   code they exercise unless they are trivial.
3. Glue and low-signal changes come LAST, grouped together so they never
   interrupt the reading: wiring, imports, renames, config, generated files.
   Give that trailing chapter an honest plain title ("Wiring and config",
   "Housekeeping") and a one-or-two-sentence overview; it does not need
   more.

#### How to CHUNK sections
A section is a logical unit of change, not a file and not a folder. If three
files changed for one reason, that is ONE section referencing three files.
If one file has two unrelated changes, split it into two sections. Never
default to one-section-per-file; let the logic of the change decide.

Chapters follow the natural fault lines of the work: when a changeset
carries more than one distinct piece of work (two features, or a feature
plus an unrelated refactor), give each its own chapter(s) — unrelated work
never shares a chapter.

#### Section fields
- **title**: Concept-level, e.g. "Payment localization module". NEVER a
  filename paraphrase like "Changes to payments/locale.ts".
- **overview**: Markdown, 2-6 sentences. Three jobs, in order:
  1. What changed here, concretely.
  2. Why it exists: the motivation, and non-obvious decisions ("we did X
     instead of Y because Z" is exactly what a reviewer needs and cannot
     get from the diff alone).
  3. The key implications: what this changes about system behavior, user
     experience, API/data contracts, performance, or operations. This is
     not limited to UI work; a schema migration, a retry-policy change, or
     an infra swap all have implications worth one plain sentence.
  Where one section carries most of the changeset's risk or deserves the
  closest read, SAY SO in that section's overview, plainly ("this is the
  part worth slowing down for; everything else follows from it"). Use a
  \`> [!IMPORTANT]\` or \`> [!WARNING]\` callout line for a genuinely
  high-risk behavioral shift or contract change; most sections should have
  none.

  Markdown is supported and encouraged where it genuinely sharpens the
  prose, never as decoration:
  - Backticks around every file name, symbol, function, type, config key,
    and CLI flag: \`runGitDiff\`, \`since-base\`, \`PLANNOTATOR_PORT\`.
  - **Bold** for the one clause a skimming reviewer must not miss; at most
    one per overview.
  - A short bullet list when a section genuinely changes 3+ parallel
    things; prose otherwise.
  - A tiny fenced code block (2-5 lines) only when code says it better
    than a sentence, e.g. a new API shape. Never paste diff hunks; the
    diffs render next to the overview already.
- **diffs**: one or more file references. Each has two fields:
  - **file**: the EXACT repo-relative path as it appears in the diff (or in
    the Changed files list, if provided). Copy it, never invent it, never
    abbreviate or normalize it (no leading/trailing slash changes, no case
    changes).
  - **summary**: 1-2 sentences describing the semantic change in THIS file,
    written from the diff hunks you already have. Say what the change does
    ("extracts the staging logic into a tri-state override map"), not where
    it sits ("modifies lines 30-80"). Do NOT open the file, search the
    codebase, or do any per-file investigation to write it. Do not repeat
    the section overview: the overview carries the why and the
    implications; the summary says what this specific file contributes.
    For a trivial change (import bump, rename fallout), one short clause
    is enough.

### unplacedFiles
Always include unplacedFiles. Use an empty array when every changed file is
placed. Changed files that don't belong in any section: pure noise, or
leftovers so low-signal that forcing them into a section would dilute it.
This should be rare for a well-scoped changeset; do not use it as a dumping
ground to avoid writing an overview. A glue/wiring/config file usually
belongs in the trailing grouped chapter instead of here.

## Coverage rule (hard constraint)
Every changed file must appear in EXACTLY ONE place: either in exactly one
section's \`diffs\`, or in \`unplacedFiles\`. Never both. Never twice across
sections. Never omitted entirely. If you are given a "Changed files" list,
treat it as the authoritative file set: every path on that list must be
accounted for.

## Hard constraints
- \`diffs[].file\` must be an exact path from the diff or the changed-files
  list. Never invented, never abbreviated, never re-cased.
- A file appears in exactly one section, or in unplacedFiles. Never twice,
  never neither.
- Typically 2-6 sections. Never more than 10. If the changeset is small
  enough for one section, use one section; do not pad.
- Never use em-dashes (—) anywhere in the output. Use commas, colons,
  semicolons, parentheses, or separate sentences instead.
- No emoji anywhere.
- title: one line.
- intent: 1-2 sentences, not a paragraph.
- Section overview: 2-6 sentences. Do not write an essay; do not write one
  bare clause either.

## Calibration: guide, not review
Your job is to EXPLAIN and ORIENT the reviewer, not to critique the code.
Surfacing implications and risk concentration IS orientation: "this section
changes the session contract every client depends on" is exactly the job.
Hunting for bugs is not; an overview is not a findings list. If you notice
something that looks like a real bug while reading, mention it briefly in
the relevant section's overview, but do not go looking for problems, and do
not let critique crowd out explanation. Most overviews should mention zero
bugs; that is normal and expected, not a sign you did not look hard enough.

## Pipeline
1. Read the full diff (inlined, or ONE diff command: git diff / jj diff)
   and, if provided, the Changed files list.
2. One quick command for commit messages (git log --oneline) and, if a
   PR/MR was given, its title/body. Skip whatever isn't there.
3. OPTIONAL, not a required step: skim CLAUDE.md/AGENTS.md or README.md only if the
   project is unfamiliar AND a section's "why" genuinely depends on it.
4. Identify logical groupings of change, including cross-file groupings.
   These become sections. This is thinking, not tool calls.
5. Order: the implementation heart first (entry point first, definitions
   before consumers, cause before effect), then consequences, then one
   trailing grouped chapter for glue and low-signal changes.
6. Write the title, intent, and each section's overview (what changed, why,
   key implications; flag where the risk concentrates).
7. Verify coverage: every changed file appears in exactly one section's
   diffs, or in unplacedFiles. Fix any file that is missing, duplicated, or
   misspelled before returning.
8. Return structured JSON matching the schema.`;

export interface GuideChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

function buildChangedFilesBlock(changedFiles?: GuideChangedFile[]): string[] {
  if (!changedFiles || changedFiles.length === 0) return [];
  return [
    "",
    "Changed files (plan section placement against this exact file set; diffs[].file must match one of these paths verbatim):",
    ...changedFiles.map((f) => `${f.path} (+${f.additions}/-${f.deletions})`),
  ];
}

export function buildGuideUserMessage(
  patch: string,
  diffType: DiffType,
  options?: { defaultBranch?: string; hasLocalAccess?: boolean; prDiffScope?: string; workspace?: WorkspaceReviewPromptContext },
  prMetadata?: PRMetadata,
  changedFiles?: GuideChangedFile[],
): string {
  const changedFilesBlock = buildChangedFilesBlock(changedFiles);

  if (options?.workspace) {
    return buildWorkspaceGuideUserMessage(patch, options.workspace, changedFilesBlock);
  }

  if (prMetadata) {
    if (options?.prDiffScope === "full-stack") {
      return [
        `Full-stack guided review of ${prMetadata.url}`,
        "",
        "This is a stacked PR. The diff below shows ALL accumulated changes from the repository default branch through this PR's head (not just this PR's own layer).",
        "Organize the complete changeset into a guided review.",
        ...changedFilesBlock,
        "",
        "```diff",
        patch,
        "```",
      ].join("\n");
    }
    if (options?.hasLocalAccess) {
      return [
        prMetadata.url,
        "",
        "You are in a local worktree checked out at the PR head. The code is available locally.",
        `To see the PR changes, diff against the remote base branch: git diff origin/${prMetadata.baseBranch}...HEAD`,
        "Do NOT diff against the local `main` branch; it may be stale. Always use origin/.",
        "",
        "Organize this PR's changeset into a guided review.",
        ...changedFilesBlock,
      ].join("\n");
    }
    return [
      prMetadata.url,
      "",
      "Organize this PR's changeset into a guided review.",
      ...changedFilesBlock,
    ].join("\n");
  }

  const instruction = getLocalDiffInstruction(diffType, options?.defaultBranch);
  if (instruction) {
    return [
      `Organize ${instruction.target} into a guided review. ${instruction.inspect}`,
      ...changedFilesBlock,
    ].join("\n");
  }

  return [
    "Organize the following code changes into a guided review.",
    ...changedFilesBlock,
    "",
    "```diff",
    patch,
    "```",
  ].join("\n");
}

function buildWorkspaceGuideUserMessage(
  patch: string,
  workspace: WorkspaceReviewPromptContext,
  changedFilesBlock: string[],
): string {
  return [
    "Organize the local workspace changes across multiple nested VCS repositories into a guided review.",
    "",
    ...buildWorkspacePromptContextLines(workspace),
    ...changedFilesBlock,
    "",
    "```diff",
    patch,
    "```",
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

const GUIDE_SCHEMA_DIR = getPlannotatorDataDir();
const GUIDE_SCHEMA_FILE = join(GUIDE_SCHEMA_DIR, "guide-schema.json");
let guideSchemaMaterialized = false;

async function ensureGuideSchemaFile(): Promise<string> {
  if (!guideSchemaMaterialized) {
    await mkdir(GUIDE_SCHEMA_DIR, { recursive: true });
    await writeFile(GUIDE_SCHEMA_FILE, GUIDE_SCHEMA_JSON);
    guideSchemaMaterialized = true;
  }
  return GUIDE_SCHEMA_FILE;
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
    "--full-auto", "--ephemeral",
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
 * unchanged from the claude/codex paths) + the marker output contract (nonce-tagged)
 * + the user message. Mirrors composeMarkerReviewPrompt's shape; guide has no
 * custom-profile concept, so there is no "replace the methodology" branch.
 */
export function composeGuideMarkerPrompt(userMessage: string, nonce: string): string {
  return GUIDE_REVIEW_PROMPT + "\n\n" + buildGuideMarkerOutputContract(nonce) + "\n\n---\n\n" + userMessage;
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

/**
 * Coerces one raw (untrusted) section from model output into a well-typed
 * `GuideSection`, or drops it entirely. The validator downstream dereferences
 * `section.diffs.length` / `section.overview.trim()` unchecked — a malformed
 * section (wrong field types, missing fields) would otherwise throw there,
 * and for the guide provider that throw is swallowed upstream, leaving a
 * done-looking job that 404s on `/api/guide/:jobId`. Returns null for a
 * section with nothing of value (no title, no overview, no diffs).
 */
function sanitizeGuideSection(raw: unknown): GuideSection | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const title = typeof s.title === "string" ? s.title : "";
  const overview = typeof s.overview === "string" ? s.overview : "";
  // Map to `{ file, summary? }` only — stray model-emitted fields never reach
  // the client. A missing/non-string/blank summary is simply omitted (the UI
  // renders nothing for it), never a reason to drop the ref or fail the guide.
  const diffs: GuideDiffRef[] = Array.isArray(s.diffs)
    ? s.diffs
        .filter((d): d is Record<string, unknown> & { file: string } => !!d && typeof d === "object" && typeof (d as Record<string, unknown>).file === "string")
        .map((d) => {
          const summary = typeof d.summary === "string" && d.summary.trim().length > 0 ? d.summary : undefined;
          return summary ? { file: d.file, summary } : { file: d.file };
        })
    : [];
  if (title.trim().length === 0 && overview.trim().length === 0 && diffs.length === 0) return null;
  // Every surviving section gets a non-empty title: a diffs-only section
  // (blank title AND overview) used to render as a blank chapter with a
  // "Guide Generated" job around it — no parse failure, so no recovery flow.
  // Keeping the section (titled) beats dropping it: its files were PLACED by
  // the model, so they're not in unplacedFiles and dropping would silently
  // orphan them from the guide's coverage story.
  return { title: title.trim() ? title : "Untitled section", overview, diffs };
}

/** Sanitizes a raw sections array (see `sanitizeGuideSection`). Shared by the
 *  stream (Claude) and file (Codex) output paths and by onJobComplete's
 *  validation, so a malformed section from either engine never reaches an
 *  unchecked `.length` / `.trim()` call. */
function sanitizeGuideSections(raw: unknown): GuideSection[] {
  if (!Array.isArray(raw)) return [];
  const out: GuideSection[] = [];
  for (const item of raw) {
    const sanitized = sanitizeGuideSection(item);
    if (sanitized) out.push(sanitized);
  }
  return out;
}

/** Sanitizes the model-provided `unplacedFiles` array to a plain string[]. */
function sanitizeUnplacedFiles(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string") : [];
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
  buildCommand(opts: GuideSessionBuildCommandOptions): Promise<GuideSessionBuildCommandResult>;
  onJobComplete(opts: GuideSessionOnJobCompleteOptions): Promise<{
    summary: GuideSessionJobSummary | null;
    /** Sanitized provider failure when transport succeeded but the Pi run did not. */
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

/**
 * Shared validation core for guide output: sanitize the raw sections /
 * unplacedFiles, enforce the coverage rule against the CURRENT changed-file
 * set (fail-closed — a ref to a file that isn't part of the changeset is
 * dropped, not rendered as a dangling reference; a file placed twice keeps
 * only its first placement), and coerce title/intent to strings. Pure — used
 * by both onJobComplete (automatic ingestion) and submitManualOutput (manual
 * repair paste), so a malformed model or human-pasted payload is held to
 * exactly the same bar either way.
 */
export function validateGuideOutput(raw: unknown, changedFiles: string[]): { guide: CodeGuideOutput } | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "Malformed guide output (not an object)" };
  }
  const output = raw as Record<string, unknown>;

  const changedSet = new Set(changedFiles);
  const placed = new Set<string>();
  const validatedSections: GuideSection[] = [];
  const sanitizedSections = sanitizeGuideSections(output.sections);

  for (const section of sanitizedSections) {
    const originalDiffCount = section.diffs.length;
    const diffs: GuideDiffRef[] = [];
    for (const ref of section.diffs) {
      if (!changedSet.has(ref.file)) continue; // not a real changed file
      if (placed.has(ref.file)) continue; // duplicate — first placement wins
      placed.add(ref.file);
      diffs.push(ref);
    }

    if (diffs.length === 0) {
      // Keep a zero-diff section ONLY if it was already zero-diff in the
      // model's output (a deliberate prose-only context section) AND has
      // real overview text. A section that LOST all its diffs to
      // validation above is dropped, not kept empty.
      if (originalDiffCount === 0 && section.overview.trim().length > 0) {
        validatedSections.push({ ...section, diffs });
      }
      continue;
    }

    validatedSections.push({ ...section, diffs });
  }

  if (validatedSections.length === 0) {
    // Nothing survived validation — a guide screen with zero sections is
    // useless (it would just be a single "Everything else" bucket for the
    // whole diff). Fail closed, same as an unparseable output.
    return { error: "No sections survived validation" };
  }

  // unplacedFiles = every changed file that never landed in a section,
  // merged with any model-provided unplacedFiles that are real changed files
  // AND not already placed (a file the model lists in both a section and
  // unplacedFiles must not render twice).
  const modelUnplaced = sanitizeUnplacedFiles(output.unplacedFiles).filter((f) => changedSet.has(f) && !placed.has(f));
  const unplacedSet = new Set<string>(modelUnplaced);
  for (const file of changedFiles) {
    if (!placed.has(file)) unplacedSet.add(file);
  }
  const unplacedFiles = [...unplacedSet];

  const guide: CodeGuideOutput = {
    // Marker engines are prompt-enforced only (no schema flag) — a non-string
    // title/intent would otherwise reach the client verbatim and crash
    // GuideView (React child error, or renderInlineMarkdown's .split on a
    // non-string).
    title: typeof output.title === "string" && output.title.trim().length > 0 ? output.title : "Guided review",
    intent: typeof output.intent === "string" ? output.intent : "",
    sections: validatedSections,
    ...(unplacedFiles.length > 0 && { unplacedFiles }),
  };

  return { guide };
}

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

  return {
    guideResults,
    guideReviewed,
    failedPayloads,
    launchChangedFiles,

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
          const { command } = buildMarkerCommand(markerEngine, markerPrompt, model || undefined, cwd, { thinking });
          return { command, prompt: markerPrompt, cwd, label: "Guide Repair", captureStdout: true, engine: markerEngine.id, model, thinking };
        }

        const repairPrompt = buildGuideRepairPrompt(repair.payload);

        if (engine === "codex") {
          const outputPath = generateGuideOutputPath();
          const command = await buildGuideCodexCommand({ cwd, outputPath, prompt: repairPrompt, model: model || undefined, reasoningEffort: "minimal", fastMode: false });
          return { command, outputPath, prompt: repairPrompt, label: "Guide Repair", engine: "codex", model, reasoningEffort: "minimal" };
        }

        const { command, stdinPrompt } = buildGuideClaudeCommand(repairPrompt, model, "low");
        return { command, stdinPrompt, prompt: repairPrompt, cwd, label: "Guide Repair", captureStdout: true, engine: "claude", model, effort: "low" };
      }

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
        const markerPrompt = composeGuideMarkerPrompt(userMessage, nonce);
        const { command } = buildMarkerCommand(markerEngine, markerPrompt, model || undefined, cwd, { thinking });
        return { command, prompt: markerPrompt, cwd, label: "Guided Review", captureStdout: true, engine: markerEngine.id, model, thinking };
      }

      const prompt = GUIDE_REVIEW_PROMPT + "\n\n---\n\n" + userMessage;

      if (engine === "codex") {
        const outputPath = generateGuideOutputPath();
        const command = await buildGuideCodexCommand({ cwd, outputPath, prompt, model: model || undefined, reasoningEffort, fastMode });
        return { command, outputPath, prompt, label: "Guided Review", engine: "codex", model, reasoningEffort, fastMode: fastMode || undefined };
      }

      const { command, stdinPrompt } = buildGuideClaudeCommand(prompt, model, effort);
      return { command, stdinPrompt, prompt, cwd, label: "Guided Review", captureStdout: true, engine: "claude", model, effort };
    },

    async onJobComplete({ job, meta, changedFiles }) {
      // Record the changed-file set this attempt validated against — BEFORE
      // parsing, so both the success and failure paths capture it. A later
      // manual repair (submitManualOutput) reuses this exact set instead of
      // whatever patch happens to be on screen at repair time.
      launchChangedFiles.set(job.id, changedFiles);

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
        return { summary: null };
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
