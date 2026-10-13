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
 * Pure.
 */

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

function skipWs(t: string, i: number): number {
  while (i < t.length && (t[i] === " " || t[i] === "\t" || t[i] === "\n" || t[i] === "\r")) i += 1;
  return i;
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
    const sep = t.slice(span.open + 1, first.start);
    const colon = t.slice(scanString(t, first.start), first.valueStart);
    const pretty = sep.includes("\n");
    const indent = pretty ? sep.slice(sep.lastIndexOf("\n") + 1) : "";
    const member = `${keyText}${colon}${render(value, pretty, unit, indent, nl)}`;
    return `${t.slice(0, last.valueEnd)},${pretty ? sep : sep || ""}${member}${t.slice(last.valueEnd)}`;
  }
  // An empty object: pretty when the file is (it holds a line break), one line otherwise.
  const pretty = t.includes("\n");
  const outer = lineIndent(t, span.open);
  if (!pretty) return `${t.slice(0, span.open + 1)}${keyText}:${JSON.stringify(value)}${t.slice(span.close)}`;
  const inner = outer + unit;
  return `${t.slice(0, span.open + 1)}${nl}${inner}${keyText}: ${render(value, true, unit, inner, nl)}${nl}${outer}${t.slice(span.close)}`;
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

function prepare(text: string): { bom: string; body: string; start: number } | { error: string } {
  const bom = text.charCodeAt(0) === 0xfeff ? "﻿" : "";
  const body = bom ? text.slice(1) : text;
  try {
    JSON.parse(body);
  } catch {
    return { error: "it is not plain JSON" };
  }
  return { bom, body, start: skipWs(body, 0) };
}

/** `(text with path + key = value)` when `key` is absent at `path`; unchanged when present (any value). */
export function addJsonMember(text: string, path: readonly string[], key: string, value: unknown): JsonEdit {
  if (!text.trim()) {
    let next: unknown = { [key]: value };
    for (const name of [...path].reverse()) next = { [name]: next };
    return { ok: true, text: `${JSON.stringify(next, null, 2)}\n`, changed: true };
  }
  const prep = prepare(text);
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
    return { ok: false, reason: error instanceof ScanError ? "it is not plain JSON" : String(error) };
  }
  // The edit must be exactly the one member: anything else is refused.
  const before = JSON.parse(prep.body) as Record<string, unknown>;
  let parent: Record<string, unknown> = before;
  for (const name of path) {
    parent[name] ??= {};
    parent = parent[name] as Record<string, unknown>;
  }
  parent[key] = value;
  let after: unknown;
  try {
    after = JSON.parse(out);
  } catch {
    return { ok: false, reason: "the edit would not stay plain JSON" };
  }
  if (!sameJson(after, before)) return { ok: false, reason: "the edit would change more than one entry" };
  return { ok: true, text: prep.bom + out, changed: true };
}

/** `text` without `key` at `path`; unchanged when it is not there. */
export function removeJsonMember(text: string, path: readonly string[], key: string): JsonEdit {
  if (!text.trim()) return { ok: true, text, changed: false };
  const prep = prepare(text);
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
    if (target.members.length === 1) out = `${t.slice(0, target.open + 1)}${t.slice(target.close)}`;
    else if (index > 0) out = `${t.slice(0, target.members[index - 1]!.valueEnd)}${t.slice(member.valueEnd)}`;
    else out = `${t.slice(0, member.start)}${t.slice(target.members[1]!.start)}`;
  } catch (error) {
    return { ok: false, reason: error instanceof ScanError ? "it is not plain JSON" : String(error) };
  }
  const before = JSON.parse(prep.body) as Record<string, unknown>;
  let parent: Record<string, unknown> = before;
  for (const name of path) parent = parent[name] as Record<string, unknown>;
  delete parent[key];
  let after: unknown;
  try {
    after = JSON.parse(out);
  } catch {
    return { ok: false, reason: "the edit would not stay plain JSON" };
  }
  if (!sameJson(after, before)) return { ok: false, reason: "the edit would change more than one entry" };
  return { ok: true, text: prep.bom + out, changed: true };
}
