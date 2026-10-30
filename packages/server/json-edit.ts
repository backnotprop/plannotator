/**
 * Lossless edits of a plain-JSON file: add or remove ONE member, touching no
 * other byte of the file (inbox-agents.ts, for `~/.cursor/mcp.json` and
 * friends). Re-serializing the whole file would reshape it (compact turned
 * pretty, big integers rounded, `1.0` turned `1`, escapes decoded, numeric
 * keys reordered, a BOM dropped, a duplicate key's block lost), so the edit
 * is textual: the new member goes in after the last one (or as the only one)
 * in the file's own style, and a removal cuts exactly the member and its
 * comma. Anything the scanner cannot place safely (not strict JSON, a
 * duplicate key on the path, the path not an object) is refused with a
 * reason, and the caller tells the person what to add by hand.
 *
 * `{ comments: true }`: the file is JSON with `//` and block comments (Qwen
 * Code's settings.json, read as Qwen reads it: comments stripped, then plain
 * JSON, so no trailing commas). Every comment stays where it is: a new member
 * goes after a comment that ends the last member's line, and a removal cuts
 * the member and one comma, never a comment beside them.
 *
 * Pure.
 */

export interface JsonEditOptions {
  /** The text may hold `//` and block comments (JSONC without trailing commas). */
  comments?: boolean;
}

export type JsonEdit = { ok: true; text: string; changed: boolean } | { ok: false; reason: string };

interface Member {
  key: string;
  /** The opening quote of the key. */
  start: number;
  valueStart: number;
  /** Exclusive. */
  valueEnd: number;
}

interface ObjectSpan {
  open: number;
  /** The closing brace. */
  close: number;
  members: Member[];
}

class ScanError extends Error {}

/** The end of the comment at `i` (exclusive), or `i` when none starts there. */
function commentEnd(t: string, i: number): number {
  if (t[i] !== "/") return i;
  if (t[i + 1] === "/") {
    const nl = t.indexOf("\n", i + 2);
    // A CRLF line's `\r` is the line ending's, not the comment's.
    if (nl === -1) return t.length;
    return t[nl - 1] === "\r" ? nl - 1 : nl;
  }
  if (t[i + 1] === "*") {
    const end = t.indexOf("*/", i + 2);
    if (end === -1) throw new ScanError("unterminated comment");
    return end + 2;
  }
  return i;
}

/**
 * Past whitespace and comments. A strict-JSON text has no comments (it was
 * parsed as plain JSON first), so for it this skips whitespace only.
 */
function skipWs(t: string, i: number): number {
  for (;;) {
    while (i < t.length && (t[i] === " " || t[i] === "\t" || t[i] === "\n" || t[i] === "\r")) i += 1;
    const end = commentEnd(t, i);
    if (end === i) return i;
    i = end;
  }
}

/** Past spaces, tabs and comments that end on this line (a line comment, a block comment with no line break). */
function skipLineTrailer(t: string, i: number): number {
  for (;;) {
    while (i < t.length && (t[i] === " " || t[i] === "\t")) i += 1;
    const end = commentEnd(t, i);
    if (end === i || t.slice(i, end).includes("\n")) return i;
    i = end;
  }
}

/** Only whitespace (no comment). */
function blank(text: string): boolean {
  return /^\s*$/.test(text);
}

/**
 * `t` with every comment outside strings turned into spaces (line breaks
 * kept), as Qwen's `strip-json-comments` reads it; throws on an unterminated
 * block comment.
 */
function stripComments(t: string): string {
  let out = "";
  let i = 0;
  while (i < t.length) {
    if (t[i] === '"') {
      const end = scanString(t, i);
      out += t.slice(i, end);
      i = end;
      continue;
    }
    const end = commentEnd(t, i);
    if (end > i) {
      out += t.slice(i, end).replace(/[^\r\n]/g, " ");
      i = end;
      continue;
    }
    out += t[i];
    i += 1;
  }
  return out;
}

function parseText(t: string, comments: boolean): unknown {
  return JSON.parse(comments ? stripComments(t) : t);
}

function scanString(t: string, i: number): number {
  if (t[i] !== '"') throw new ScanError("expected a string");
  i += 1;
  while (i < t.length) {
    if (t[i] === "\\") i += 2;
    else if (t[i] === '"') return i + 1;
    else i += 1;
  }
  throw new ScanError("unterminated string");
}

function scanObject(t: string, i: number): ObjectSpan {
  const open = i;
  i = skipWs(t, i + 1);
  const members: Member[] = [];
  if (t[i] === "}") return { open, close: i, members };
  for (;;) {
    const start = i;
    const keyEnd = scanString(t, i);
    const key = JSON.parse(t.slice(start, keyEnd)) as string;
    i = skipWs(t, keyEnd);
    if (t[i] !== ":") throw new ScanError("expected a colon");
    const valueStart = skipWs(t, i + 1);
    const valueEnd = scanValue(t, valueStart);
    members.push({ key, start, valueStart, valueEnd });
    i = skipWs(t, valueEnd);
    if (t[i] === ",") {
      i = skipWs(t, i + 1);
      continue;
    }
    if (t[i] === "}") return { open, close: i, members };
    throw new ScanError("expected a comma or a closing brace");
  }
}

function scanValue(t: string, i: number): number {
  const c = t[i];
  if (c === "{") return scanObject(t, i).close + 1;
  if (c === "[") {
    i = skipWs(t, i + 1);
    if (t[i] === "]") return i + 1;
    for (;;) {
      i = skipWs(t, scanValue(t, i));
      if (t[i] === ",") {
        i = skipWs(t, i + 1);
        continue;
      }
      if (t[i] === "]") return i + 1;
      throw new ScanError("expected a comma or a closing bracket");
    }
  }
  if (c === '"') return scanString(t, i);
  const literal = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(t.slice(i, i + 400));
  if (!literal) throw new ScanError("unexpected character");
  return i + literal[0].length;
}

/** The objects on `path` from the root: [root, root[path[0]], …]; the last may be missing. */
function walk(t: string, start: number, path: readonly string[]): { chain: ObjectSpan[]; missingAt: number | null } | { error: string } {
  if (t[start] !== "{") return { error: "it is not a JSON object" };
  const chain = [scanObject(t, start)];
  for (let depth = 0; depth < path.length; depth += 1) {
    const object = chain[depth]!;
    const named = object.members.filter((m) => m.key === path[depth]);
    if (named.length > 1) return { error: `it has "${path[depth]}" twice` };
    if (named.length === 0) return { chain, missingAt: depth };
    const member = named[0]!;
    if (t[member.valueStart] !== "{") return { error: `its "${path[depth]}" is not an object` };
    chain.push(scanObject(t, member.valueStart));
  }
  return { chain, missingAt: null };
}

/** The whitespace at the start of the line holding `index`. */
function lineIndent(t: string, index: number): string {
  const lineStart = t.lastIndexOf("\n", index - 1) + 1;
  return /^[ \t]*/.exec(t.slice(lineStart))![0];
}

/** The file's indent unit: its first indented line, else two spaces. */
function indentUnit(t: string): string {
  const match = /\n([ \t]+)\S/.exec(t);
  return match ? (match[1]!.includes("\t") ? "\t" : match[1]!) : "  ";
}

/** `value` as JSON whose lines after the first are indented by `indent` (pretty) or on one line (compact), with `nl` line endings. */
function render(value: unknown, pretty: boolean, unit: string, indent: string, nl: string): string {
  if (!pretty) return JSON.stringify(value);
  return JSON.stringify(value, null, unit).replace(/\n/g, `${nl}${indent}`);
}

/** The file's dominant line ending (more CRLF than lone LF: CRLF). */
function newlineOf(t: string): string {
  const crlf = (t.match(/\r\n/g) ?? []).length;
  return crlf > (t.match(/\n/g) ?? []).length - crlf ? "\r\n" : "\n";
}

/** Insert `"key": value` into the object `span`, in its own style. */
function insertMember(t: string, span: ObjectSpan, key: string, value: unknown, unit: string): string {
  const nl = newlineOf(t);
  const keyText = JSON.stringify(key);
  if (span.members.length > 0) {
    const first = span.members[0]!;
    const last = span.members[span.members.length - 1]!;
    const sepText = t.slice(span.open + 1, first.start);
    const colonText = t.slice(scanString(t, first.start), first.valueStart);
    // A comment beside the first key is not copied: its line break and indent (or one space) are.
    let sep = blank(sepText) ? sepText : sepText.includes("\n") ? `${nl}${lineIndent(t, first.start)}` : " ";
    const colon = /^\s*:\s*$/.test(colonText) ? colonText : ": ";
    // A comment that ends the last member's line stays on it: the comma goes before it, the new member after it.
    const after = skipLineTrailer(t, last.valueEnd);
    const trailer = t.slice(last.valueEnd, after);
    if (trailer.includes("//") && !sep.includes("\n")) sep = `${nl}${lineIndent(t, last.start)}`;
    const pretty = sep.includes("\n");
    const indent = pretty ? sep.slice(sep.lastIndexOf("\n") + 1) : "";
    const member = `${keyText}${colon}${render(value, pretty, unit, indent, nl)}`;
    if (blank(trailer)) return `${t.slice(0, last.valueEnd)},${sep}${member}${t.slice(last.valueEnd)}`;
    return `${t.slice(0, last.valueEnd)},${trailer}${sep}${member}${t.slice(after)}`;
  }
  // An empty object: pretty when the file is (it holds a line break), one line otherwise.
  const pretty = t.includes("\n");
  const outer = lineIndent(t, span.open);
  if (!pretty) {
    // One line: a comment inside the empty object stays, after the new member.
    const interior = t.slice(span.open + 1, span.close);
    return `${t.slice(0, span.open + 1)}${keyText}:${JSON.stringify(value)}${blank(interior) ? "" : interior}${t.slice(span.close)}`;
  }
  const inner = outer + unit;
  const member = `${nl}${inner}${keyText}: ${render(value, true, unit, inner, nl)}`;
  const interior = t.slice(span.open + 1, span.close);
  // Comments inside the empty object stay, after the new member.
  if (!blank(interior)) {
    const breakFirst = interior.startsWith("\n") || interior.startsWith("\r") ? "" : nl;
    return `${t.slice(0, span.open + 1)}${member}${breakFirst}${interior}${t.slice(span.close)}`;
  }
  return `${t.slice(0, span.open + 1)}${member}${nl}${outer}${t.slice(span.close)}`;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  }
  return value;
}

function prepare(text: string, comments: boolean): { bom: string; body: string; start: number } | { error: string } {
  const bom = text.charCodeAt(0) === 0xfeff ? "﻿" : "";
  const body = bom ? text.slice(1) : text;
  try {
    parseText(body, comments);
  } catch {
    return { error: notValid(comments) };
  }
  return { bom, body, start: skipWs(body, 0) };
}

function notValid(comments: boolean): string {
  return comments ? "it is not valid JSON" : "it is not plain JSON";
}

/** Where a member's cut starts: back over the spaces before it, and the line break before them when the key starts its line. */
function cutStart(t: string, start: number): number {
  let i = start;
  while (i > 0 && (t[i - 1] === " " || t[i - 1] === "\t")) i -= 1;
  if (t[i - 1] === "\n") return t[i - 2] === "\r" ? i - 2 : i - 1;
  return i;
}

/** The comma after `i`, past whitespace and comments (it must be there). */
function commaAfter(t: string, i: number): number {
  const at = skipWs(t, i);
  if (t[at] !== ",") throw new ScanError("expected a comma");
  return at;
}

/** `(text with path + key = value)` when `key` is absent at `path`; unchanged when present (any value). */
export function addJsonMember(text: string, path: readonly string[], key: string, value: unknown, options: JsonEditOptions = {}): JsonEdit {
  const comments = options.comments === true;
  if (!text.trim()) {
    let next: unknown = { [key]: value };
    for (const name of [...path].reverse()) next = { [name]: next };
    return { ok: true, text: `${JSON.stringify(next, null, 2)}\n`, changed: true };
  }
  const prep = prepare(text, comments);
  if ("error" in prep) return { ok: false, reason: prep.error };
  let out: string;
  try {
    const found = walk(prep.body, prep.start, path);
    if ("error" in found) return { ok: false, reason: found.error };
    const unit = indentUnit(prep.body);
    // The scan works on the file as it is: every byte outside the new member stays, line endings included.
    const lf = prep.body;
    const scanned = found;
    if (scanned.missingAt === null) {
      const target = scanned.chain[scanned.chain.length - 1]!;
      const named = target.members.filter((m) => m.key === key);
      if (named.length > 1) return { ok: false, reason: `it has "${key}" twice` };
      if (named.length === 1) return { ok: true, text, changed: false };
      out = insertMember(lf, target, key, value, unit);
    } else {
      let nested: unknown = { [key]: value };
      for (const name of [...path.slice(scanned.missingAt + 1)].reverse()) nested = { [name]: nested };
      out = insertMember(lf, scanned.chain[scanned.missingAt]!, path[scanned.missingAt]!, nested, unit);
    }
  } catch (error) {
    return { ok: false, reason: error instanceof ScanError ? notValid(comments) : String(error) };
  }
  // The edit must be exactly the one member: anything else is refused.
  const before = parseText(prep.body, comments) as Record<string, unknown>;
  let parent: Record<string, unknown> = before;
  for (const name of path) {
    parent[name] ??= {};
    parent = parent[name] as Record<string, unknown>;
  }
  parent[key] = value;
  let after: unknown;
  try {
    after = parseText(out, comments);
  } catch {
    return { ok: false, reason: comments ? "the edit would not stay valid JSON" : "the edit would not stay plain JSON" };
  }
  if (!sameJson(after, before)) return { ok: false, reason: "the edit would change more than one entry" };
  return { ok: true, text: prep.bom + out, changed: true };
}

/** `text` without `key` at `path`; unchanged when it is not there. */
export function removeJsonMember(text: string, path: readonly string[], key: string, options: JsonEditOptions = {}): JsonEdit {
  const comments = options.comments === true;
  if (!text.trim()) return { ok: true, text, changed: false };
  const prep = prepare(text, comments);
  if ("error" in prep) return { ok: false, reason: prep.error };
  let out: string;
  try {
    const found = walk(prep.body, prep.start, path);
    if ("error" in found) return { ok: false, reason: found.error };
    if (found.missingAt !== null) return { ok: true, text, changed: false };
    const target = found.chain[found.chain.length - 1]!;
    const index = target.members.findIndex((m) => m.key === key);
    if (index === -1) return { ok: true, text, changed: false };
    if (target.members.filter((m) => m.key === key).length > 1) return { ok: false, reason: `it has "${key}" twice` };
    const member = target.members[index]!;
    const t = prep.body;
    // The cut: the member and its comma, with the whitespace between them.
    const [from, to] =
      target.members.length === 1
        ? [target.open + 1, target.close]
        : index > 0
          ? [target.members[index - 1]!.valueEnd, member.valueEnd]
          : [member.start, target.members[1]!.start];
    const beside = t.slice(from, member.start) + t.slice(member.valueEnd, Math.max(member.valueEnd, to));
    if (/^[\s,]*$/.test(beside)) out = `${t.slice(0, from)}${t.slice(to)}`;
    else {
      // A comment beside the member stays: only the member (from its line's start) and one comma go.
      const start = cutStart(t, member.start);
      if (target.members.length === 1) out = `${t.slice(0, start)}${t.slice(member.valueEnd)}`;
      else if (index > 0) {
        const comma = commaAfter(t, target.members[index - 1]!.valueEnd);
        out = `${t.slice(0, comma)}${t.slice(comma + 1, start)}${t.slice(member.valueEnd)}`;
      } else {
        const comma = commaAfter(t, member.valueEnd);
        out = `${t.slice(0, start)}${t.slice(member.valueEnd, comma)}${t.slice(comma + 1)}`;
      }
    }
  } catch (error) {
    return { ok: false, reason: error instanceof ScanError ? notValid(comments) : String(error) };
  }
  const before = parseText(prep.body, comments) as Record<string, unknown>;
  let parent: Record<string, unknown> = before;
  for (const name of path) parent = parent[name] as Record<string, unknown>;
  delete parent[key];
  let after: unknown;
  try {
    after = parseText(out, comments);
  } catch {
    return { ok: false, reason: comments ? "the edit would not stay valid JSON" : "the edit would not stay plain JSON" };
  }
  if (!sameJson(after, before)) return { ok: false, reason: "the edit would change more than one entry" };
  return { ok: true, text: prep.bom + out, changed: true };
}
