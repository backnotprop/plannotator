/**
 * Text Plannotator keeps on a pull or merge request and finds again by a hidden marker (the Inbox's "Post decisions",
 * design brief "export-decisions" step 2): one comment of the person's own whose body starts with a marker line, or one
 * section of the PR's description between a start and an end marker. A later post edits that same text in place; it
 * never adds a second one and never touches anything outside it.
 *
 * Pure (no runtime APIs): the providers (pr-github.ts, pr-gitlab.ts) run the forge calls; the splicing and the room
 * left under a forge's length limit are decided here, once, for both.
 */

/** Where the text goes. `both`: the full text as a comment, and a short section in the description that links to it. */
export type PRMarkedDestination = "comment" | "description" | "both";

/** A comment found again by its first line. `body(room)` renders the text in at most `room` characters (it may shorten itself). */
export interface PRMarkedCommentInput {
  marker: string;
  body: (room: number) => string;
}

/** A description section between `start` and `end`; `body(room)` renders what goes between them. */
export interface PRMarkedSectionInput {
  start: string;
  end: string;
  body: (room: number) => string;
}

export interface PRMarkedResult {
  action: "created" | "updated";
  /** The comment's own link, or the PR's for a description. */
  url: string;
}

/** The text did not fit the forge's limit even in its shortest form: nothing was written. */
export class PRMarkedTooLongError extends Error {
  constructor(readonly limit: number) {
    super(`Too long for the forge (at most ${limit} characters).`);
    this.name = "PRMarkedTooLongError";
  }
}

/** The description changed on the forge while the section was being written: nothing was written. */
export class PRMarkedRaceError extends Error {
  constructor() {
    super("The description changed while posting. Try again.");
    this.name = "PRMarkedRaceError";
  }
}

/** The forge refused the description's edit: the person may read the PR but not edit it (not its author, no write access). */
export class PRMarkedForbiddenError extends Error {
  constructor(readonly detail: string) {
    super(`Not allowed to edit the description: ${detail}`);
    this.name = "PRMarkedForbiddenError";
  }
}

/** A write refused for access (HTTP 403, or 404 on a PR the same account just read). */
export function isAccessRefusal(stderr: string, stdout = ""): boolean {
  return /\bHTTP 40[34]\b|\b40[34] (?:Forbidden|Not Found)\b|must have (?:admin|write|push)|Resource not accessible/i.test(`${stderr}\n${stdout}`);
}

/** The section's start marker is there without its end: nothing is written over text Plannotator can't bound. */
export class PRMarkedBrokenSectionError extends Error {
  constructor() {
    super("The decisions section in the description has lost its end marker. Remove what is left of it, then post again.");
    this.name = "PRMarkedBrokenSectionError";
  }
}

/** The body starts with the marker line (leading blank lines aside, which some forges trim). */
export function startsWithMarker(body: string | null | undefined, marker: string): boolean {
  return typeof body === "string" && body.replace(/^\s+/, "").startsWith(marker);
}

/** Where an existing section is: [start of the start marker, end of the end marker), or null; throws on a start with no end. */
function sectionBounds(text: string, start: string, end: string): [number, number] | null {
  const from = text.indexOf(start);
  if (from < 0) return null;
  const to = text.indexOf(end, from + start.length);
  if (to < 0) throw new PRMarkedBrokenSectionError();
  return [from, to + end.length];
}

/** The section as written: the markers on their own lines around the body. */
function sectionText(input: Pick<PRMarkedSectionInput, "start" | "end">, body: string): string {
  return `${input.start}\n${body.trim()}\n${input.end}`;
}

/**
 * The description with the section put in: in place of the old one (everything before and after it kept byte for
 * byte), or at the end after a blank line (the description kept byte for byte as its prefix). Throws
 * PRMarkedTooLongError when even `body(room)` does not fit `limit`.
 */
export function spliceMarkedSection(description: string, input: PRMarkedSectionInput, limit: number): { text: string; replaced: boolean } {
  const bounds = sectionBounds(description, input.start, input.end);
  const before = bounds ? description.slice(0, bounds[0]) : description;
  const after = bounds ? description.slice(bounds[1]) : "";
  const gap = bounds || before === "" ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const fixed = before.length + gap.length + after.length + input.start.length + input.end.length + 2;
  const room = limit - fixed;
  if (room <= 0) throw new PRMarkedTooLongError(limit);
  const body = input.body(room);
  if (body.trim().length > room) throw new PRMarkedTooLongError(limit);
  return { text: `${before}${gap}${sectionText(input, body)}${after}`, replaced: bounds !== null };
}

/** A comment's whole text: `body(limit)`, refused past the limit. */
export function markedCommentText(input: PRMarkedCommentInput, limit: number): string {
  const body = input.body(limit);
  if (body.length > limit) throw new PRMarkedTooLongError(limit);
  if (!startsWithMarker(body, input.marker)) throw new Error("A marked comment must start with its marker.");
  return body;
}
