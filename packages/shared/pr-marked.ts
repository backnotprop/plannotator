export type PRMarkedDestination = "comment" | "description" | "both";

export interface PRMarkedCommentInput {
  marker: string;
  body: (room: number) => string;
}

export interface PRMarkedSectionInput {
  start: string;
  end: string;
  body: (room: number) => string;
}

export interface PRMarkedResult {
  action: "created" | "updated";
  url: string;
}

export class PRMarkedTooLongError extends Error {
  constructor(readonly limit: number) {
    super(`Too long for the forge (at most ${limit} characters).`);
    this.name = "PRMarkedTooLongError";
  }
}

export class PRMarkedRaceError extends Error {
  constructor() {
    super("The description changed while posting. Try again.");
    this.name = "PRMarkedRaceError";
  }
}

export class PRMarkedForbiddenError extends Error {
  constructor(readonly detail: string) {
    super(`Not allowed to edit the description: ${detail}`);
    this.name = "PRMarkedForbiddenError";
  }
}

export function isAccessRefusal(stderr: string, stdout = ""): boolean {
  return /\bHTTP 40[34]\b|\b40[34] (?:Forbidden|Not Found)\b|must have (?:admin|write|push)|Resource not accessible/i.test(`${stderr}\n${stdout}`);
}

export class PRMarkedBrokenSectionError extends Error {
  constructor() {
    super("The decisions section in the description has lost its end marker. Remove what is left of it, then post again.");
    this.name = "PRMarkedBrokenSectionError";
  }
}

export function startsWithMarker(body: string | null | undefined, marker: string): boolean {
  return typeof body === "string" && body.replace(/^\s+/, "").startsWith(marker);
}

function sectionBounds(text: string, start: string, end: string): [number, number] | null {
  const from = text.indexOf(start);
  if (from < 0) return null;
  const to = text.indexOf(end, from + start.length);
  if (to < 0) throw new PRMarkedBrokenSectionError();
  return [from, to + end.length];
}

function sectionText(input: Pick<PRMarkedSectionInput, "start" | "end">, body: string): string {
  return `${input.start}\n${body.trim()}\n${input.end}`;
}

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

export function markedCommentText(input: PRMarkedCommentInput, limit: number): string {
  const body = input.body(limit);
  if (body.length > limit) throw new PRMarkedTooLongError(limit);
  if (!startsWithMarker(body, input.marker)) throw new Error("A marked comment must start with its marker.");
  return body;
}
