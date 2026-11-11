/**
 * The guide builder's tools, as an MCP server lists them: names, short
 * descriptions and JSON Schemas, from one place, so the VS Code extension's
 * MCP server and (later) the web app's job runner hand agents the same text.
 * The descriptions are the agent's reference: there is no schema dump in the
 * prompt (approved spec "Guided Reviews in VS Code", sections 4.3 and 4.4).
 *
 * Also the prompt pieces that go with the tools: the methodology without the
 * one-shot "keep exploration short" paragraph, and the paragraph on the
 * guide's shape. Browser-safe, no dependencies beyond core.
 */

import { GUIDE_REVIEW_PROMPT } from "./guide-prompt";

export const GUIDE_BUILDER_TOOL_NAMES = [
  "guide_set_header",
  "guide_set_overview",
  "guide_add_chapter",
  "guide_update_chapter",
  "guide_move_chapter",
  "guide_remove_chapter",
  "guide_place_file",
  "guide_move_file",
  "guide_unplace_file",
  "guide_read",
  "guide_finish",
] as const;

export type GuideBuilderToolName = (typeof GUIDE_BUILDER_TOOL_NAMES)[number];

/** A JSON Schema object, as MCP's `inputSchema` takes it. */
export interface GuideBuilderJsonSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface GuideBuilderToolDefinition {
  readonly name: GuideBuilderToolName;
  /** Human title (MCP `title`). */
  readonly title: string;
  readonly description: string;
  readonly inputSchema: GuideBuilderJsonSchema;
  /** MCP tool annotations. */
  readonly annotations: { readonly readOnlyHint: boolean; readonly destructiveHint: boolean; readonly idempotentHint: boolean };
}

const CHAPTER = { type: "string", description: "The chapter's id, like `c2` (from guide_add_chapter or guide_read)." };
const FILE = { type: "string", description: "The file's exact path as the change names it." };
const LINKS =
  "Link into code with markdown links: `[label](code:path#L24)` or `#L24-L40`, `[label](symbol:name)` or `symbol:path#name`, `[label](chapter:2)`.";

const edit = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;

/** A chapter's one diagram (AGENT TEXT: awaits the owner's OK of these words). */
const CHAPTER_DIAGRAM = {
  type: "object",
  description:
    "Optional. One diagram at the top of the chapter, only when a picture explains this chapter better than words. " +
    "Mermaid preferred (flowchart, sequence, state, ER…); it links with `click` lines: `click node \"symbol:name\"`. " +
    "Every link must resolve and the diagram must render; the answer names what does not.",
  properties: {
    kind: { type: "string", enum: ["mermaid", "html"], description: "`mermaid`. (`html` is a sanitized custom picture, capped at 64 KB.)" },
    source: { type: "string", description: "The diagram's source." },
  },
  required: ["kind", "source"],
  additionalProperties: false,
} as const;

export const GUIDE_BUILDER_TOOLS: readonly GuideBuilderToolDefinition[] = [
  {
    name: "guide_set_header",
    title: "Set the guide's title and intent",
    description: "Set the guide's title (one line; the PR's title when there is one) and intent (1-2 sentences: why this change exists). Either may be set alone.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "One line." },
        intent: { type: "string", description: "1-2 sentences: why this change exists." },
      },
      additionalProperties: false,
    },
    annotations: { ...edit, idempotentHint: true },
  },
  {
    name: "guide_set_overview",
    title: "Set the overview",
    // The overview no longer offers a diagram (diagrams go in chapters); the builder still reads one an older draft has.
    description: `Set the overview shown above the chapters: a few sentences on how the change fits together. Replaces any earlier overview. ${LINKS}`,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Markdown, a few sentences, with code links." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { ...edit, idempotentHint: true },
  },
  {
    name: "guide_add_chapter",
    title: "Add a chapter",
    description: `Add a chapter: a concept-level title, an overview (markdown, 2-6 sentences: what changed, why, what it implies), and optionally one diagram. Answers the new chapter's id (\`c3\`). At most 10 chapters. ${LINKS}`,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Concept-level, never a file name." },
        overview: { type: "string", description: "Markdown, 2-6 sentences." },
        diagram: CHAPTER_DIAGRAM,
        position: { type: "integer", minimum: 1, description: "1-based place in reading order. Default: last." },
      },
      required: ["title", "overview"],
      additionalProperties: false,
    },
    annotations: edit,
  },
  {
    name: "guide_update_chapter",
    title: "Update a chapter",
    description: "Change a chapter's title, overview or diagram. `diagram: null` removes the diagram.",
    inputSchema: {
      type: "object",
      properties: {
        chapter: CHAPTER,
        title: { type: "string" },
        overview: { type: "string" },
        diagram: { ...CHAPTER_DIAGRAM, type: ["object", "null"] },
      },
      required: ["chapter"],
      additionalProperties: false,
    },
    annotations: { ...edit, idempotentHint: true },
  },
  {
    name: "guide_move_chapter",
    title: "Move a chapter",
    description: "Move a chapter to a new place in reading order. Ids never change. Answers the new order.",
    inputSchema: {
      type: "object",
      properties: {
        chapter: CHAPTER,
        position: { type: "integer", minimum: 1, description: "1-based place in reading order." },
      },
      required: ["chapter", "position"],
      additionalProperties: false,
    },
    annotations: { ...edit, idempotentHint: true },
  },
  {
    name: "guide_remove_chapter",
    title: "Remove a chapter",
    description: "Remove a chapter. Its files go back to not placed.",
    inputSchema: {
      type: "object",
      properties: { chapter: CHAPTER },
      required: ["chapter"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "guide_place_file",
    title: "Place a file in a chapter",
    description:
      "Put a changed file in a chapter with a 1-2 sentence summary of what changed in it. Every changed file goes in exactly one chapter, or is marked with guide_unplace_file. " +
      "Placing a file again in its own chapter replaces its summary. Optional `focus`: the head lines (`{ start, end }`) or hunks (`{ hunk }`, 1-based) that matter most, for big files.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE,
        chapter: CHAPTER,
        summary: { type: "string", description: "1-2 sentences: what this file's change does." },
        focus: {
          type: "array",
          description: "Optional reader hints inside the file's changed lines.",
          items: {
            type: "object",
            properties: {
              start: { type: "integer", minimum: 1, description: "First line on the head." },
              end: { type: "integer", minimum: 1, description: "Last line on the head (default: start)." },
              hunk: { type: "integer", minimum: 1, description: "A hunk of the file's diff, 1-based." },
            },
            additionalProperties: false,
          },
        },
      },
      required: ["file", "chapter", "summary"],
      additionalProperties: false,
    },
    annotations: edit,
  },
  {
    name: "guide_move_file",
    title: "Move a file to another chapter",
    description: "Move a placed file to another chapter. Its summary goes with it.",
    inputSchema: {
      type: "object",
      properties: { file: FILE, chapter: CHAPTER },
      required: ["file", "chapter"],
      additionalProperties: false,
    },
    annotations: { ...edit, idempotentHint: true },
  },
  {
    name: "guide_unplace_file",
    title: "Leave a file out of every chapter",
    description: "Mark a changed file \"Not in a chapter\" on purpose (pure noise). Takes it out of its chapter if it was placed. Rare: glue and config usually belong in a trailing chapter.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE,
        reason: { type: "string", description: "Optional: why it is left out." },
      },
      required: ["file"],
      additionalProperties: false,
    },
    annotations: { ...edit, idempotentHint: true },
  },
  {
    name: "guide_read",
    title: "Read the draft",
    description: "The whole draft in reading order (chapter ids, overviews, files and summaries), plus the changed files not placed yet.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "guide_finish",
    title: "Finish the guide",
    description: "Check the whole guide and save it. Refuses, naming every problem, while a changed file is neither placed nor marked, a chapter has no files, or the title or intent is missing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
];

/** The paragraph on the guide's shape and the builder tools (spec 4.3). */
export const GUIDE_BUILDER_PROMPT_PARAGRAPH =
  "Build the guide with the `guide_*` tools, in any order. A guide has a title, an intent, an optional overview " +
  "(a few sentences, with links like `symbol:name` or `code:path#L12`), and a few chapters in reading order. Each " +
  "chapter has an overview and the files it covers, each with a one-line summary, and may have one Mermaid diagram " +
  "when a picture explains it better than words. Every " +
  "changed file goes in exactly one chapter, or is marked unplaced. Call `guide_read` to see the draft and what is " +
  "left; call `guide_finish` when done.";

/** What a resumed session is told before it starts. */
export const GUIDE_BUILDER_RESUME_PARAGRAPH =
  "A draft of this guide already exists. Continue it: call `guide_read` first, then finish what is left.";

/**
 * Exact passages of `GUIDE_REVIEW_PROMPT` and what the builder prompt says
 * instead. `guide-builder-tools.test.ts` fails when a passage is no longer
 * found (the methodology changed): update the pair, never the source prompt.
 */
const BUILDER_METHODOLOGY_REWRITES: ReadonlyArray<readonly [string, string]> = [
  [
    "### sections\nEach section is a chapter of the review: a title, an overview, and one or\nmore diff references.",
    "### chapters\nEach chapter of the review has a title, an overview, and the changed files\nit covers: add it with `guide_add_chapter`, then place its files with\n`guide_place_file`.",
  ],
  [
    "A section is a logical unit of change, not a file and not a folder. If three\nfiles changed for one reason, that is ONE section referencing three files.\nIf one file has two unrelated changes, split it into two sections. Never\ndefault to one-section-per-file; let the logic of the change decide.",
    "A chapter is a logical unit of change, not a file and not a folder. If three\nfiles changed for one reason, that is ONE chapter with three files. A file\nbelongs to exactly one chapter, whole: when one file carries two unrelated\nchanges, place it in the chapter of the change that matters most and say\nwhat else it does in its summary. Never default to one-chapter-per-file;\nlet the logic of the change decide.",
  ],
  [
    "- **diffs**: one or more file references. Each has two fields:",
    "- **files**: one or more changed files, each placed with `guide_place_file`:",
  ],
  ["Never paste diff hunks; the\n    diffs render next to the overview already.", "Never paste diff hunks; the\n    diff renders next to the overview already."],
  [
    "### unplacedFiles\nAlways include unplacedFiles. Use an empty array when every changed file is\nplaced. Changed files that don't belong in any section: pure noise, or",
    "### Files in no chapter\nMark with `guide_unplace_file` the changed files that don't belong in any\nchapter: pure noise, or",
  ],
  [
    "either in exactly one\nsection's `diffs`, or in `unplacedFiles`. Never both. Never twice across\nsections.",
    "either in exactly one\nchapter, or marked with `guide_unplace_file`. Never both. Never in two\nchapters.",
  ],
  [
    "- `diffs[].file` must be an exact path from the diff or the changed-files\n  list.",
    "- Every file you place must be an exact path from the diff or the\n  changed-files list.",
  ],
  [
    "- A file appears in exactly one section, or in unplacedFiles. Never twice,\n  never neither.",
    "- A file is in exactly one chapter, or marked with `guide_unplace_file`.\n  Never twice, never neither.",
  ],
  [
    "7. Verify coverage: every changed file appears in exactly one section's\n   diffs, or in unplacedFiles. Fix any file that is missing, duplicated, or\n   misspelled before returning.",
    "7. Verify coverage with `guide_read`: every changed file is in exactly one\n   chapter, or marked with `guide_unplace_file`. Place what is left before\n   finishing.",
  ],
  ["8. Return structured JSON matching the schema.", "8. Call `guide_finish`."],
];

/** Passages of the source prompt the derivation expects; for the drift test. */
export const GUIDE_BUILDER_METHODOLOGY_SOURCE_PASSAGES: readonly string[] = BUILDER_METHODOLOGY_REWRITES.map(([from]) => from);

function deriveBuilderMethodology(prompt: string): string {
  const speedStart = prompt.indexOf("## Speed\n");
  const speedEnd = prompt.indexOf("## Output structure");
  let text = speedStart >= 0 && speedEnd > speedStart ? prompt.slice(0, speedStart) + prompt.slice(speedEnd) : prompt;
  for (const [from, to] of BUILDER_METHODOLOGY_REWRITES) text = text.replace(from, to);
  // What is left says "section" for what the builder calls a chapter.
  return text
    .replace(/\bsections\b/g, "chapters")
    .replace(/\bSections\b/g, "Chapters")
    .replace(/\bsection\b/g, "chapter")
    .replace(/\bSection\b/g, "Chapter");
}

/**
 * The organizer methodology for an agent that reads the change itself and
 * builds the guide with the tools: `GUIDE_REVIEW_PROMPT` (left byte for byte
 * as the in-app jobs send it) without its "Speed" section (the one-shot
 * exploration limit), with the output described as chapters and files placed
 * through the tools instead of JSON `sections`, `diffs` and `unplacedFiles`,
 * and without the rule to split one file across two sections, which the
 * builder (one chapter per file, like format version 1) refuses.
 */
export const GUIDE_BUILDER_METHODOLOGY = deriveBuilderMethodology(GUIDE_REVIEW_PROMPT);

export interface GuideBuilderPromptInput {
  /** What to review: the PR URL, `base..head` (plus "and the uncommitted changes"), or a stack's branches. */
  readonly target: string;
  /** The reader's instructions for this guide, if any. */
  readonly instructions?: string;
  /** True when continuing a saved draft. */
  readonly resume?: boolean;
}

/** The one message that starts a guide session (spec 4.3). */
export function buildGuideBuilderPrompt(input: GuideBuilderPromptInput): string {
  const parts = [
    `Write a guided review of ${input.target.trim()}.`,
    GUIDE_BUILDER_METHODOLOGY,
    `## Building the guide\n${GUIDE_BUILDER_PROMPT_PARAGRAPH}`,
  ];
  if (input.resume) parts.push(GUIDE_BUILDER_RESUME_PARAGRAPH);
  const instructions = input.instructions?.trim();
  if (instructions) parts.push(`## Reviewer instructions\n${instructions}`);
  return parts.join("\n\n");
}
