/**
 * Guided Review generation, the pure half: the organizer prompt, its JSON
 * output schema, the user message that frames the changeset, and the
 * validator that holds model output to the coverage rule. Browser-safe and
 * zero-dependency, so any host (the Plannotator servers, Pi, or an external
 * app such as Workspaces) generates guides with Plannotator's exact prompt.
 * Moved verbatim from packages/server/guide/guide-review.ts, which
 * re-exports every name; the engine plumbing (commands, output parsing,
 * sessions) stays there.
 */

import type { CodeGuideOutput, GuideDiffRef, GuideSection } from "./guide";
import type { DiffType } from "./diff-type";
import {
  buildWorkspacePromptContextLines,
  getLocalDiffInstruction,
  type WorkspaceReviewPromptContext,
} from "./review-prompt";

/** The PR fields buildGuideUserMessage reads. Structural, so the server's
 *  full `PRMetadata` (GitHub or GitLab) is accepted as-is. */
export interface GuidePromptPRMetadata {
  url: string;
  baseBranch: string;
}

/** Generic structural validation failure (no sections / blank overviews).
 *  onJobComplete deliberately does NOT surface this string on the job card —
 *  the caller substitutes GUIDE_EMPTY_OUTPUT_ERROR — whereas the informative
 *  outside-changeset validation error passes through verbatim. */
export const GUIDE_NO_SECTIONS_ERROR = "No sections survived validation";

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

/**
 * The Guided Review methodology. MIRRORED VERBATIM into the standalone
 * `plannotator-guide` agent skill (github.com/plannotator/guides,
 * skills/plannotator-guide/SKILL.md, section "2. Write the guide"), where only
 * the mechanics differ (the diff is guide.patch, the output is guide.json).
 * When this text changes, update the skill in the same change: a guide made by
 * an agent must follow the same rules as one made in-app.
 */
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
Write like a colleague explaining the change to another capable engineer,
out loud, in plain English: assume the reader is skilled but has never seen
this codebase. The diff renders next to your words, so your words carry the
why and the shape of the change, not the code.
- Short sentences. Twenty-five words is the ceiling and most sentences are
  shorter. One idea per sentence. If you reach for a dash or a semicolon,
  end the sentence instead.
- Plain words. Say file, function, module, request, the server. Not
  artifact, surface, primitive, chain, backbone. Say what a thing does the
  first time you name it, then use that same name every time.
- Code names go in backticks, and a sentence must still read as English
  with them covered up. Two per sentence at most.
- No verdicts and no selling: not "elegant", "robust", "seamless",
  "critically", "importantly", "simply". State the fact.

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
- Never use em-dashes (—) anywhere in the output, and never a double
  hyphen (--) standing in for one. Use commas, colons, or separate
  sentences instead.
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
  prMetadata?: GuidePromptPRMetadata,
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

/**
 * Coerces one raw (untrusted) section from model output into a well-typed
 * `GuideSection`, or drops it entirely. The validator downstream dereferences
 * `section.diffs.length` / `section.overview.trim()` unchecked — a malformed
 * section (wrong field types, missing fields) would otherwise throw there,
 * and for the guide provider that throw is swallowed upstream, leaving a
 * done-looking job that 404s on `/api/guide/:jobId`. Returns null for a
 * section with nothing of value (no title, no overview, no diffs).
 */
export function sanitizeGuideSection(raw: unknown): GuideSection | null {
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
export function sanitizeGuideSections(raw: unknown): GuideSection[] {
  if (!Array.isArray(raw)) return [];
  const out: GuideSection[] = [];
  for (const item of raw) {
    const sanitized = sanitizeGuideSection(item);
    if (sanitized) out.push(sanitized);
  }
  return out;
}

/** Sanitizes the model-provided `unplacedFiles` array to a plain string[]. */
export function sanitizeUnplacedFiles(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string") : [];
}

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
  // Files the model referenced that are not part of the changeset — tracked
  // so a fully-invalidated guide can explain WHY nothing survived (typically
  // the model guided a different commit than the one under review).
  const outsideChangeset = new Set<string>();

  for (const section of sanitizedSections) {
    const originalDiffCount = section.diffs.length;
    const diffs: GuideDiffRef[] = [];
    for (const ref of section.diffs) {
      if (!changedSet.has(ref.file)) {
        // not a real changed file
        outsideChangeset.add(ref.file);
        continue;
      }
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
    // whole diff). Fail closed, same as an unparseable output. When the
    // sections died because their refs named files outside the changeset,
    // say so — that failure is actionable (guide the right commit), unlike
    // genuinely structural emptiness (no sections / blank overviews), which
    // keeps the generic message.
    if (outsideChangeset.size > 0) {
      const examples = [...outsideChangeset].slice(0, 3).join(", ");
      return {
        error:
          `Guide referenced ${outsideChangeset.size} file(s) outside the changeset under review ` +
          `(e.g. ${examples}). To guide a different commit, open it in the Commits panel first, then relaunch.`,
      };
    }
    return { error: GUIDE_NO_SECTIONS_ERROR };
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
