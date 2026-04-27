/**
 * Codex Review Agent — prompt, command builder, output parser, and finding transformer.
 *
 * Encapsulates all Codex-specific logic for the AI review agent integration.
 * The review server (review.ts) calls into this module via the agent-jobs callbacks.
 */

import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { appendFile, mkdir, unlink, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { DiffType } from "./vcs";
import type { PRMetadata } from "./pr";
import { toRelativePath } from "./path-utils";

// ---------------------------------------------------------------------------
// Debug log — only active when PLANNOTATOR_DEBUG is set
// ---------------------------------------------------------------------------

const DEBUG_ENABLED = !!process.env.PLANNOTATOR_DEBUG;
const DEBUG_LOG_PATH = join(homedir(), ".plannotator", "codex-review-debug.log");

async function debugLog(label: string, data?: unknown): Promise<void> {
  if (!DEBUG_ENABLED) return;
  try {
    await mkdir(join(homedir(), ".plannotator"), { recursive: true });
    const timestamp = new Date().toISOString();
    const line = data !== undefined
      ? `[${timestamp}] ${label}: ${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n`
      : `[${timestamp}] ${label}\n`;
    await appendFile(DEBUG_LOG_PATH, line);
  } catch { /* never fail the main flow */ }
}

// ---------------------------------------------------------------------------
// Schema — embedded as a string, written to disk on first use.
// Bun's compiled binary uses a virtual FS that external processes (codex)
// can't read, so we materialize the schema to a real file.
// ---------------------------------------------------------------------------

const CODEX_REVIEW_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          confidence_score: { type: "number" },
          priority: { type: ["integer", "null"] },
          code_location: {
            type: "object",
            properties: {
              absolute_file_path: { type: "string" },
              line_range: {
                type: "object",
                properties: {
                  start: { type: "integer" },
                  end: { type: "integer" },
                },
                required: ["start", "end"],
                additionalProperties: false,
              },
            },
            required: ["absolute_file_path", "line_range"],
            additionalProperties: false,
          },
        },
        required: ["title", "body", "confidence_score", "priority", "code_location"],
        additionalProperties: false,
      },
    },
    overall_correctness: { type: "string" },
    overall_explanation: { type: "string" },
    overall_confidence_score: { type: "number" },
  },
  required: ["findings", "overall_correctness", "overall_explanation", "overall_confidence_score"],
  additionalProperties: false,
});

const SCHEMA_DIR = join(homedir(), ".plannotator");
const SCHEMA_FILE = join(SCHEMA_DIR, "codex-review-schema.json");
let schemaMaterialized = false;

/** Ensure the schema file exists on disk and return its path. */
async function ensureSchemaFile(): Promise<string> {
  if (!schemaMaterialized) {
    await mkdir(SCHEMA_DIR, { recursive: true });
    await writeFile(SCHEMA_FILE, CODEX_REVIEW_SCHEMA);
    schemaMaterialized = true;
  }
  return SCHEMA_FILE;
}

export { SCHEMA_FILE as CODEX_REVIEW_SCHEMA_PATH };

// ---------------------------------------------------------------------------
// System prompt — copied verbatim from codex-rs/core/review_prompt.md
// ---------------------------------------------------------------------------

export const CODEX_REVIEW_SYSTEM_PROMPT = `# Review guidelines:

You are acting as a reviewer for a proposed code change made by another engineer.

Below are some default guidelines for determining whether the original author would appreciate the issue being flagged.

These are not the final word in determining whether an issue is a bug. In many cases, you will encounter other, more specific guidelines. These may be present elsewhere in a developer message, a user message, a file, or even elsewhere in this system message.
Those guidelines should be considered to override these general instructions.

Here are the general guidelines for determining whether something is a bug and should be flagged.

1. It meaningfully impacts the accuracy, performance, security, or maintainability of the code.
2. The bug is discrete and actionable (i.e. not a general issue with the codebase or a combination of multiple issues).
3. Fixing the bug does not demand a level of rigor that is not present in the rest of the codebase (e.g. one doesn't need very detailed comments and input validation in a repository of one-off scripts in personal projects)
4. The bug was introduced in the commit (pre-existing bugs should not be flagged).
5. The author of the original PR would likely fix the issue if they were made aware of it.
6. The bug does not rely on unstated assumptions about the codebase or author's intent.
7. It is not enough to speculate that a change may disrupt another part of the codebase, to be considered a bug, one must identify the other parts of the code that are provably affected.
8. The bug is clearly not just an intentional change by the original author.

When flagging a bug, you will also provide an accompanying comment. Once again, these guidelines are not the final word on how to construct a comment -- defer to any subsequent guidelines that you encounter.

1. The comment should be clear about why the issue is a bug.
2. The comment should appropriately communicate the severity of the issue. It should not claim that an issue is more severe than it actually is.
3. The comment should be brief. The body should be at most 1 paragraph. It should not introduce line breaks within the natural language flow unless it is necessary for the code fragment.
4. The comment should not include any chunks of code longer than 3 lines. Any code chunks should be wrapped in markdown inline code tags or a code block.
5. The comment should clearly and explicitly communicate the scenarios, environments, or inputs that are necessary for the bug to arise. The comment should immediately indicate that the issue's severity depends on these factors.
6. The comment's tone should be matter-of-fact and not accusatory or overly positive. It should read as a helpful AI assistant suggestion without sounding too much like a human reviewer.
7. The comment should be written such that the original author can immediately grasp the idea without close reading.
8. The comment should avoid excessive flattery and comments that are not helpful to the original author. The comment should avoid phrasing like "Great job ...", "Thanks for ...".

Below are some more detailed guidelines that you should apply to this specific review.

HOW MANY FINDINGS TO RETURN:

Output all findings that the original author would fix if they knew about it. If there is no finding that a person would definitely love to see and fix, prefer outputting no findings. Do not stop at the first qualifying finding. Continue until you've listed every qualifying finding.

GUIDELINES:

- Ignore trivial style unless it obscures meaning or violates documented standards.
- Use one comment per distinct issue (or a multi-line range if necessary).
- Use \`\`\`suggestion blocks ONLY for concrete replacement code (minimal lines; no commentary inside the block).
- In every \`\`\`suggestion block, preserve the exact leading whitespace of the replaced lines (spaces vs tabs, number of spaces).
- Do NOT introduce or remove outer indentation levels unless that is the actual fix.

The comments will be presented in the code review as inline comments. You should avoid providing unnecessary location details in the comment body. Always keep the line range as short as possible for interpreting the issue. Avoid ranges longer than 5–10 lines; instead, choose the most suitable subrange that pinpoints the problem.

At the beginning of the finding title, tag the bug with priority level. For example "[P1] Un-padding slices along wrong tensor dimensions". [P0] – Drop everything to fix.  Blocking release, operations, or major usage. Only use for universal issues that do not depend on any assumptions about the inputs. · [P1] – Urgent. Should be addressed in the next cycle · [P2] – Normal. To be fixed eventually · [P3] – Low. Nice to have.

Additionally, include a numeric priority field in the JSON output for each finding: set "priority" to 0 for P0, 1 for P1, 2 for P2, or 3 for P3. If a priority cannot be determined, omit the field or use null.

At the end of your findings, output an "overall correctness" verdict of whether or not the patch should be considered "correct".
Correct implies that existing code and tests will not break, and the patch is free of bugs and other blocking issues.
Ignore non-blocking issues such as style, formatting, typos, documentation, and other nits.

FORMATTING GUIDELINES:
The finding description should be one paragraph.`;

// ---------------------------------------------------------------------------
// User message builder
// ---------------------------------------------------------------------------

/** Build the dynamic user message based on review context. */
export function buildCodexReviewUserMessage(
  patch: string,
  diffType: DiffType,
  options?: { defaultBranch?: string; hasLocalAccess?: boolean; prDiffScope?: string },
  prMetadata?: PRMetadata,
): string {
  // PR/MR mode — pass the link, with local context if --local
  if (prMetadata) {
    if (options?.prDiffScope === "full-stack") {
      return [
        `Full-stack review of ${prMetadata.url}`,
        "",
        "This is a stacked PR. The diff below shows ALL accumulated changes from the repository default branch through this PR's head (not just this PR's own layer).",
        "Review the complete diff for issues that span the stack.",
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
        "Do NOT diff against the local `main` branch — it may be stale. Always use origin/.",
      ].join("\n");
    }
    return prMetadata.url;
  }

  // Local mode — Codex has full file/git access
  const effectiveDiffType = diffType.startsWith("worktree:")
    ? diffType.split(":").pop() || "uncommitted"
    : diffType;

  switch (effectiveDiffType) {
    case "uncommitted":
      return "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";

    case "staged":
      return "Review the currently staged code changes (`git diff --staged`) and provide prioritized findings.";

    case "unstaged":
      return "Review the unstaged code changes (tracked modifications and untracked files) and provide prioritized findings.";

    case "last-commit":
      return "Review the code changes introduced in the last commit (`git diff HEAD~1..HEAD`) and provide prioritized findings.";

    case "branch": {
      const base = options?.defaultBranch || "main";
      return `Review the code changes against the base branch '${base}'. Run \`git diff ${base}..HEAD\` to inspect the changes. Provide prioritized, actionable findings.`;
    }

    case "merge-base": {
      const base = options?.defaultBranch || "main";
      return `Review the PR-style diff against base '${base}'. First find the common ancestor with \`git merge-base ${base} HEAD\`, then run \`git diff <merge-base>..HEAD\` using that commit to inspect only the changes introduced on this branch (matches GitHub's PR view). Provide prioritized, actionable findings.`;
    }

    default:
      // p4 or unknown — fall back to generic with inlined diff
      return [
        "Review the following code changes and provide prioritized findings.",
        "",
        "```diff",
        patch,
        "```",
      ].join("\n");
  }
}

// ---------------------------------------------------------------------------
// Command builder
// ---------------------------------------------------------------------------

export interface CodexCommandOptions {
  cwd: string;
  outputPath: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}

/** Build the `codex exec` argv array. Materializes the schema file on first call. */
export async function buildCodexCommand(options: CodexCommandOptions): Promise<string[]> {
  const { cwd, outputPath, prompt, model, reasoningEffort, fastMode } = options;
  const schemaPath = await ensureSchemaFile();

  const command = [
    "codex",
    ...(model ? ["-m", model] : []),
    ...(reasoningEffort ? ["-c", `model_reasoning_effort=${reasoningEffort}`] : []),
    ...(fastMode ? ["-c", "service_tier=fast"] : []),
    "exec",
    "--output-schema", schemaPath,
    "-o", outputPath,
    "--full-auto",
    "--ephemeral",
    "-C", cwd,
    prompt,
  ];

  debugLog("BUILD_COMMAND", {
    cwd,
    outputPath,
    schemaPath,
    promptLength: prompt.length,
    command: command.map((c, i) => i === command.length - 1 ? `<prompt: ${c.length} chars>` : c),
  });

  return command;
}

/** Generate a unique temp file path for Codex output. */
export function generateOutputPath(): string {
  return join(tmpdir(), `plannotator-codex-${crypto.randomUUID()}.json`);
}

// ---------------------------------------------------------------------------
// Output parsing — matches Codex's native ReviewOutputEvent schema
// ---------------------------------------------------------------------------

export interface CodexCodeLocation {
  absolute_file_path: string;
  line_range: { start: number; end: number };
}

export interface CodexFinding {
  title: string;
  body: string;
  confidence_score: number;
  priority: number | null;
  code_location: CodexCodeLocation;
}

export interface CodexReviewOutput {
  findings: CodexFinding[];
  overall_correctness: string;
  overall_explanation: string;
  overall_confidence_score: number;
}

/** Read and parse the Codex -o output file. Returns null on any failure. */
export async function parseCodexOutput(outputPath: string): Promise<CodexReviewOutput | null> {
  await debugLog("PARSE_OUTPUT_START", { outputPath });

  try {
    if (!existsSync(outputPath)) {
      await debugLog("PARSE_OUTPUT_FILE_MISSING", outputPath);
      return null;
    }

    const text = await readFile(outputPath, "utf-8");

    // Clean up temp file
    try { await unlink(outputPath); } catch { /* ignore */ }

    if (!text.trim()) {
      await debugLog("PARSE_OUTPUT_EMPTY");
      return null;
    }

    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.findings)) {
      await debugLog("PARSE_OUTPUT_INVALID_SHAPE", { hasFindings: !!parsed?.findings });
      return null;
    }

    await debugLog("PARSE_OUTPUT_SUCCESS", {
      findingsCount: parsed.findings.length,
      overall_correctness: parsed.overall_correctness,
      overall_confidence_score: parsed.overall_confidence_score,
    });

    return parsed as CodexReviewOutput;
  } catch (err) {
    await debugLog("PARSE_OUTPUT_ERROR", err instanceof Error ? err.message : String(err));
    // Clean up on error too
    try { await unlink(outputPath); } catch { /* ignore */ }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Finding → external annotation transform
// ---------------------------------------------------------------------------

export interface ReviewAnnotationInput {
  source: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  type: string;
  side: string;
  scope: string;
  text: string;
  author: string;
}

/** Transform review findings (provider-agnostic) into the external annotation format. */
export function transformReviewFindings(
  findings: CodexFinding[],
  source: string,
  cwd?: string,
  author?: string,
): ReviewAnnotationInput[] {
  const annotations = findings
    .filter((f) =>
      f.code_location?.absolute_file_path &&
      typeof f.code_location?.line_range?.start === "number" &&
      typeof f.code_location?.line_range?.end === "number"
    )
    .map((f) => ({
      source,
      filePath: toRelativePath(f.code_location.absolute_file_path, cwd),
      lineStart: f.code_location.line_range.start,
      lineEnd: f.code_location.line_range.end,
      type: "comment",
      side: "new",
      scope: "line",
      text: `${f.title}\n\n${f.body}`.trim(),
      author: author ?? "Review Agent",
    }));

  debugLog("TRANSFORM_FINDINGS", {
    inputCount: findings.length,
    outputCount: annotations.length,
    annotations: annotations.map((a) => ({
      filePath: a.filePath,
      lineStart: a.lineStart,
      lineEnd: a.lineEnd,
      textPreview: a.text.slice(0, 80),
    })),
  });

  return annotations;
}
