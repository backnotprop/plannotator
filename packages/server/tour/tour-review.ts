import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import type { DiffType } from "../vcs";
import type { PRMetadata } from "../pr";
import type {
  CodeTourOutput,
  TourDiffAnchor,
  TourKeyTakeaway,
  TourStop,
  TourQAItem,
} from "@plannotator/shared/tour";

export type { CodeTourOutput, TourDiffAnchor, TourKeyTakeaway, TourStop, TourQAItem };

export const TOUR_EMPTY_OUTPUT_ERROR = "Tour generation returned empty or malformed output";

export const TOUR_SCHEMA_JSON = JSON.stringify({
  type: "object",
  properties: {
    title: { type: "string" },
    greeting: { type: "string" },
    intent: { type: "string" },
    before: { type: "string" },
    after: { type: "string" },
    key_takeaways: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          severity: { type: "string", enum: ["info", "important", "warning"] },
        },
        required: ["text", "severity"],
        additionalProperties: false,
      },
    },
    stops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          gist: { type: "string" },
          detail: { type: "string" },
          transition: { type: "string" },
          anchors: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                line: { type: "integer" },
                end_line: { type: "integer" },
                hunk: { type: "string" },
                label: { type: "string" },
              },
              required: ["file", "line", "end_line", "hunk", "label"],
              additionalProperties: false,
            },
          },
        },
        required: ["title", "gist", "detail", "transition", "anchors"],
        additionalProperties: false,
      },
    },
    qa_checklist: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          stop_indices: { type: "array", items: { type: "integer" } },
        },
        required: ["question", "stop_indices"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "greeting", "intent", "before", "after", "key_takeaways", "stops", "qa_checklist"],
  additionalProperties: false,
});

export const TOUR_REVIEW_PROMPT = `# Code Tour Narrator

## Identity
You are a colleague giving a casual, warm tour of work you understand well.
Think of it like sitting down next to someone and saying: "Hey Mike, here's
the PR. Let me walk you through it." The whole voice is conversational, not
documentary. You're telling the story of what changed and why.

The arguments (like "here's why we did it this way" or "we picked X instead
of Y") live INSIDE the stop details, where they belong. The framing (the
greeting, intent, before/after, transitions between stops) stays warm and
human, the way a coworker actually talks over coffee.

You are NOT finding bugs. You are NOT writing a technical report.

## Tone
- Conversational throughout. You're talking to a coworker, not writing docs.
- Use "we" and "you". "Here's what we changed." "You'll notice that..."
- A couple of sentences of context is fine, even for small PRs. If a
  colleague was describing a one-line change, they wouldn't just say "I
  changed a line." They'd say "Oh yeah, I bumped the TTL from 7 days to 24
  hours because the audit flagged it last month." A little color is good.
- Each stop should feel like a colleague pausing to point at something:
  "Okay, look at this part. Here's why it's interesting."
- **Do NOT use em-dashes (—) anywhere.** They're a dead giveaway of
  AI-generated prose. Use commas, colons, semicolons, or separate sentences
  instead. If you want to add an aside, use parentheses or start a new
  sentence. Never an em-dash.
- No emoji anywhere. The UI handles all visual labeling deterministically.

## Output structure

### greeting
2-4 sentences welcoming the reviewer and setting the scene. Not a headline,
more like how you'd actually open a conversation. "Hey, so this PR does X
and Y. Grab a coffee; I'll walk you through it." A bit of warmth and context,
even for small changes.
Example: "Hey, so this PR tightens the auth session lifetime from a week down
to 24 hours. It's small in line count but it's the fix the security team has
been asking for since Q1. Let me walk you through it."

### intent
1-3 sentences explaining WHY this changeset exists. What problem is being
solved? What motivated the work? Keep it conversational; you're giving
context, not writing a ticket.

To determine intent:
- If a PR/MR URL was provided, read the PR description (gh pr view or
  equivalent). Look for motivation, linked issues, and context the author
  provided.
- If the PR body references a GitHub issue (e.g. "Fixes #123", "Closes
  owner/repo#456") or GitLab issue, read that specific issue for deeper
  context.
- If no PR is provided, infer intent from commit messages, branch name, and
  the nature of the changes themselves.
- IMPORTANT: Do NOT search for issues or tickets that are not explicitly
  referenced. Do not browse all open issues. Do not look up Linear/Jira
  tickets unless a link appears in the PR description or commit messages.
  Only follow what is given.

Example: "Closes SEC-412, the overly-permissive session TTL flagged by the
security team during the Q1 audit. It also lays some groundwork for the
offline-first work shipping next sprint."

### before / after
One to two sentences each. Paint the picture of the world before and after
this change. Focus on user or system behavior, not code structure.
Example before: "Sessions lasted 7 days, with no refresh contract, so a
stolen token was dangerous for a full week."
Example after: "Sessions now expire in 24 hours with a clean refresh path,
and mobile clients poll every 15 minutes to stay fresh."

### key_takeaways
3 to 5 bullet points. These are the MOST IMPORTANT things someone needs to
know at a glance about what this changeset DOES. Focus on what changes in
behavior, functionality, or developer experience. Each is ONE sentence. No
emoji, no prefix, just the text.

Severity guide (drives visual styling automatically; pick honestly, don't inflate):
- "info": neutral context, good to know.
- "important": a meaningful change in behavior, capability, or system contract.
- "warning": a behavioral shift worth watching, something that changes how
  the system works in a way someone could miss. NOT code smells or style
  nits. A clean changeset with no warnings is perfectly normal.

### stops
Each stop is the colleague pausing at a specific change to explain it.

#### How to ORDER stops
Order by READING FLOW, the order the colleague would walk you through the
change to make it understandable. NOT by blast radius or criticality.

Lead with the entry point: the file or function that, if understood alone,
unlocks the rest. Then walk outward:
- Definitions before consumers (types/interfaces/schemas before usage).
- Cause before effect (the change that motivated downstream changes comes first).
- Verification last (tests and migrations after the code they exercise).

#### How to CHUNK stops
A stop is a logical change, NOT a file. If three files changed for one reason,
that's ONE stop with three anchors. If one file has two unrelated changes,
that's two stops. Never "one-stop-per-file" by default; let logic decide.

#### Stop fields
- **title**: Short, friendly. "Token refresh flow", not "Changes to auth/refresh.ts".
- **gist**: ONE sentence. The headline. A reviewer who reads nothing else should
  understand this stop from the gist alone.
- **detail**: This is where the colleague pauses to explain. Supports basic markdown.
  - Start with 1-2 sentences describing the situation or problem this stop addresses.
  - Then make the argument: WHY did we change this? WHY does the new code look the
    way it does? If a non-obvious choice was made (data structure, error strategy,
    sync vs async, where the logic lives), surface it. "We did X instead of Y
    because Z" is exactly what the reviewer wants.
  - Use ### headings (e.g. "### Why this shape") to highlight critical sub-sections.
  - Use > [!IMPORTANT], > [!WARNING], or > [!NOTE] callout blocks for context
    that helps the reader understand non-obvious decisions or behavioral shifts
    (e.g., a new default value, a changed error path, a contract that callers
    now depend on). These are not for flagging code smells.
  - Use - bullet points for multi-part changes or parallel considerations.
  - Keep total length reasonable, around 3-6 sentences equivalent. Don't write
    an essay.
- **transition**: A short connective phrase to the next stop, in the colleague's
  voice. Examples: "Building on that...", "On a related note...", "To support
  that change...". Empty string for the last stop.
- **anchors**: The specific diff hunks shown inline below the detail narrative.
  Each anchor MUST have a non-empty "hunk" field containing the actual unified
  diff text extracted from the changeset. The hunk must include the @@ line.

  Valid hunk format (REQUIRED; every anchor needs this):

    @@ -42,7 +42,9 @@
     function processRequest(req) {
    -  const result = await fetch(url);
    -  return result.json();
    +  const result = await fetch(url, { timeout: 5000 });
    +  if (!result.ok) throw new Error("HTTP " + result.status);
    +  return result.json();
     }

  The label should be a substantive 1-sentence explanation of what this code
  section does or why it matters, not a filename paraphrase.
  E.g. "Adds a 5-second timeout and explicit error check to prevent silent hangs",
  not "Changes to request.ts".

### qa_checklist
4 to 8 verification questions a HUMAN can actually answer. Two valid channels:

1. By READING the code (e.g., "Did we update both call sites of \`legacyAuth()\`?",
   "Are all uses of the old token format migrated?", "Does the error handler
   cover the new throw paths?").
2. By manually USING the product (e.g., "Sign in, restart the browser, and
   confirm the session persists.", "Trigger a 503 from the API and confirm the
   retry banner appears.").

NOT machine-runnable test ideas. NOT generic "smoke test" framing. The reviewer
is a person; what would THEY do to gain confidence?

Reference which stops each question relates to via stop_indices. Every question
should reference at least one stop.

## Pipeline

1. Read the full diff (git diff or inlined patch).
2. Read CLAUDE.md and README.md for project context.
3. Read commit messages (git log --oneline) and PR title/body if available.
4. Identify logical groupings of change (cross-file when appropriate). These
   become stops.
5. Determine reading flow order: entry point first, then outward. Definitions
   before consumers, cause before effect.
6. Write the greeting, intent, before/after, takeaways, stops, and checklist
   in the voice of a coworker walking you through the work.
7. Return structured JSON matching the schema.

## Hard constraints
- Every anchor MUST have a non-empty "hunk" field. An anchor with an empty hunk
  is broken; it will show "diff not available" to the reviewer. Extract the
  real unified diff text from the input patch. Do not leave hunk blank.
- Never fabricate line numbers. Extract them from the diff.
- Gist must be ONE sentence. Not two. Not a run-on. One.
- Detail supports markdown. Use it when it makes the explanation clearer, not
  for decoration. Plain prose is fine when the change is simple.
- Anchor labels must explain the code's purpose or the change's impact, not
  just describe the filename.
- key_takeaways: 3 to 5 items, each ONE sentence.
- Stops are LOGICAL units, not files. Cross-file grouping is expected.
- Stop ORDER is reading flow: entry point first, definitions before consumers,
  cause before effect, verification last.
- Combine trivial changes (renames, imports, formatting) into one "Housekeeping"
  stop at the end, or omit entirely.
- QA questions must be answerable by a human, either by reading code or by
  using the product. Never frame them as automated tests.
- NEVER use em-dashes (—) anywhere in the output. Use commas, colons,
  semicolons, parentheses, or separate sentences. This is a hard constraint.

## Calibration: tour, not review
Your job is to EXPLAIN the changeset, not to critique it. If you genuinely
spot a real bug or a meaningful behavioral concern while reading the code,
surface it naturally in the relevant stop detail or as a warning takeaway.
That's the colleague noticing something worth mentioning. But don't hunt for
problems. Most clean changesets should have zero warnings and zero [!WARNING]
callouts. The primary question is "what does this change do and why?" not
"what's wrong with this code?"`;

function buildTourUserMessage(
  patch: string,
  diffType: DiffType,
  options?: { defaultBranch?: string; hasLocalAccess?: boolean },
  prMetadata?: PRMetadata,
): string {
  if (prMetadata) {
    if (options?.hasLocalAccess) {
      return [
        prMetadata.url,
        "",
        "You are in a local worktree checked out at the PR head. The code is available locally.",
        `To see the PR changes, diff against the remote base branch: git diff origin/${prMetadata.baseBranch}...HEAD`,
        "Do NOT diff against the local `main` branch; it may be stale. Always use origin/.",
        "",
        "Walk the reviewer through this changeset as a guided tour.",
      ].join("\n");
    }
    return [prMetadata.url, "", "Walk the reviewer through this PR as a guided tour."].join("\n");
  }

  const effectiveDiffType = diffType.startsWith("worktree:")
    ? diffType.split(":").pop() || "uncommitted"
    : diffType;

  switch (effectiveDiffType) {
    case "uncommitted":
      return "Walk the reviewer through the current code changes (staged, unstaged, and untracked files) as a guided tour.";
    case "staged":
      return "Walk the reviewer through the currently staged code changes (`git diff --staged`) as a guided tour.";
    case "unstaged":
      return "Walk the reviewer through the unstaged code changes (tracked modifications and untracked files) as a guided tour.";
    case "last-commit":
      return "Walk the reviewer through the code changes introduced in the last commit (`git diff HEAD~1..HEAD`) as a guided tour.";
    case "branch": {
      const base = options?.defaultBranch || "main";
      return `Walk the reviewer through the code changes against the base branch '${base}' as a guided tour. Run \`git diff ${base}..HEAD\` to inspect the changes.`;
    }
    case "merge-base": {
      const base = options?.defaultBranch || "main";
      return `Walk the reviewer through the PR-style diff against base '${base}' as a guided tour. First find the common ancestor with \`git merge-base ${base} HEAD\`, then run \`git diff <merge-base>..HEAD\` using that commit to inspect only the changes introduced on this branch (matches GitHub's PR view).`;
    }
    default:
      return [
        "Walk the reviewer through the following code changes as a guided tour.",
        "",
        "```diff",
        patch,
        "```",
      ].join("\n");
  }
}

export interface TourClaudeCommandResult {
  command: string[];
  stdinPrompt: string;
}

export function buildTourClaudeCommand(prompt: string, model: string = "sonnet", effort?: string): TourClaudeCommandResult {
  const allowedTools = [
    "Agent", "Read", "Glob", "Grep",
    "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
    "Bash(git show:*)", "Bash(git blame:*)", "Bash(git branch:*)",
    "Bash(git grep:*)", "Bash(git ls-remote:*)", "Bash(git ls-tree:*)",
    "Bash(git merge-base:*)", "Bash(git remote:*)", "Bash(git rev-parse:*)",
    "Bash(git show-ref:*)",
    "Bash(gh pr view:*)", "Bash(gh pr diff:*)", "Bash(gh pr list:*)",
    "Bash(gh api repos/*/*/pulls/*)", "Bash(gh api repos/*/*/pulls/*/files*)",
    // The tour prompt follows linked issues (`Fixes #123`, `Closes owner/repo#456`),
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
      "--json-schema", TOUR_SCHEMA_JSON,
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

const TOUR_SCHEMA_DIR = join(homedir(), ".plannotator");
const TOUR_SCHEMA_FILE = join(TOUR_SCHEMA_DIR, "tour-schema.json");
let tourSchemaMaterialized = false;

async function ensureTourSchemaFile(): Promise<string> {
  if (!tourSchemaMaterialized) {
    await mkdir(TOUR_SCHEMA_DIR, { recursive: true });
    await writeFile(TOUR_SCHEMA_FILE, TOUR_SCHEMA_JSON);
    tourSchemaMaterialized = true;
  }
  return TOUR_SCHEMA_FILE;
}

export function generateTourOutputPath(): string {
  return join(tmpdir(), `plannotator-tour-${crypto.randomUUID()}.json`);
}

export async function buildTourCodexCommand(options: {
  cwd: string;
  outputPath: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}): Promise<string[]> {
  const { cwd, outputPath, prompt, model, reasoningEffort, fastMode } = options;
  const schemaPath = await ensureTourSchemaFile();

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

export function parseTourStreamOutput(stdout: string): CodeTourOutput | null {
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
        // A tour with no stops isn't a tour — treat as invalid so the UI
        // error state fires instead of rendering an empty walkthrough.
        if (!output || !Array.isArray(output.stops) || output.stops.length === 0) return null;
        return output as CodeTourOutput;
      }
    } catch {
      // Not valid JSON — skip
    }
  }

  return null;
}

export async function parseTourFileOutput(outputPath: string): Promise<CodeTourOutput | null> {
  try {
    const text = await readFile(outputPath, "utf-8");
    try { await unlink(outputPath); } catch { /* ignore */ }
    if (!text.trim()) return null;
    const parsed = JSON.parse(text);
    // A tour with no stops isn't a tour — treat as invalid so the UI
    // error state fires instead of rendering an empty walkthrough.
    if (!parsed || !Array.isArray(parsed.stops) || parsed.stops.length === 0) return null;
    return parsed as CodeTourOutput;
  } catch {
    try { await unlink(outputPath); } catch { /* ignore */ }
    return null;
  }
}

export interface TourSessionBuildCommandOptions {
  cwd: string;
  patch: string;
  diffType: DiffType;
  options?: { defaultBranch?: string; hasLocalAccess?: boolean };
  prMetadata?: PRMetadata;
  config?: Record<string, unknown>;
}

export interface TourSessionBuildCommandResult {
  command: string[];
  outputPath?: string;
  captureStdout?: boolean;
  stdinPrompt?: string;
  cwd?: string;
  label?: string;
  prompt?: string;
  engine: "claude" | "codex";
  model: string;
  effort?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}

export interface TourSessionJobSummary {
  correctness: string;
  explanation: string;
  confidence: number;
}

export interface TourSessionJobRef {
  id: string;
  engine?: string;
}

export interface TourSessionOnJobCompleteOptions {
  job: TourSessionJobRef;
  meta: { outputPath?: string; stdout?: string };
}

export interface TourSession {
  tourResults: Map<string, CodeTourOutput>;
  tourChecklists: Map<string, boolean[]>;
  buildCommand(opts: TourSessionBuildCommandOptions): Promise<TourSessionBuildCommandResult>;
  onJobComplete(opts: TourSessionOnJobCompleteOptions): Promise<{ summary: TourSessionJobSummary | null }>;
  getTour(jobId: string): (CodeTourOutput & { checklist: boolean[] }) | null;
  saveChecklist(jobId: string, checked: boolean[]): void;
}

export function createTourSession(): TourSession {
  const tourResults = new Map<string, CodeTourOutput>();
  const tourChecklists = new Map<string, boolean[]>();

  return {
    tourResults,
    tourChecklists,

    async buildCommand({ cwd, patch, diffType, options, prMetadata, config }) {
      const engine = (typeof config?.engine === "string" ? config.engine : "claude") as "claude" | "codex";
      const explicitModel = typeof config?.model === "string" && config.model ? config.model : null;
      // "sonnet" is a Claude model, so we must NOT pass it to Codex when no model
      // is explicitly selected. Leave Codex model blank and let its CLI default pick.
      const model = explicitModel ?? (engine === "codex" ? "" : "sonnet");
      const reasoningEffort = typeof config?.reasoningEffort === "string" && config.reasoningEffort ? config.reasoningEffort : undefined;
      const effort = typeof config?.effort === "string" && config.effort ? config.effort : undefined;
      const fastMode = config?.fastMode === true;
      const userMessage = buildTourUserMessage(patch, diffType, options, prMetadata);
      const prompt = TOUR_REVIEW_PROMPT + "\n\n---\n\n" + userMessage;

      if (engine === "codex") {
        const outputPath = generateTourOutputPath();
        const command = await buildTourCodexCommand({ cwd, outputPath, prompt, model: model || undefined, reasoningEffort, fastMode });
        return { command, outputPath, prompt, label: "Code Tour", engine: "codex", model, reasoningEffort, fastMode: fastMode || undefined };
      }

      const { command, stdinPrompt } = buildTourClaudeCommand(prompt, model, effort);
      return { command, stdinPrompt, prompt, cwd, label: "Code Tour", captureStdout: true, engine: "claude", model, effort };
    },

    async onJobComplete({ job, meta }) {
      let output: CodeTourOutput | null = null;
      if (job.engine === "codex" && meta.outputPath) {
        output = await parseTourFileOutput(meta.outputPath);
      } else if (meta.stdout) {
        output = parseTourStreamOutput(meta.stdout);
      }

      if (!output) {
        console.error(`[tour] Failed to parse output for job ${job.id}`);
        return { summary: null };
      }

      tourResults.set(job.id, output);
      const summary: TourSessionJobSummary = {
        correctness: "Tour Generated",
        explanation: `${output.stops.length} stop${output.stops.length !== 1 ? "s" : ""}, ${output.qa_checklist.length} QA item${output.qa_checklist.length !== 1 ? "s" : ""}`,
        confidence: 1.0,
      };
      return { summary };
    },

    getTour(jobId) {
      const tour = tourResults.get(jobId);
      if (!tour) return null;
      return { ...tour, checklist: tourChecklists.get(jobId) ?? [] };
    },

    saveChecklist(jobId, checked) {
      tourChecklists.set(jobId, checked);
    },
  };
}
