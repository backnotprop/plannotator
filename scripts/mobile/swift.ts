/**
 * generated/swift/Wire.swift: the app's wire types, route table and error
 * codes, made from schema/wire.schema.json (schema.ts), door.json (door.ts)
 * and the error codes the door and the window answer.
 *
 *   bun scripts/mobile/swift.ts [--check]
 *
 * Rules that keep an old app reading a newer Inbox (SPEC 2.2):
 *  - every struct keeps the fields it does not know (`unknownFields`) and
 *    writes them back when encoded;
 *  - every enum has `unknown(String)` for a value it does not know;
 *  - a field the TypeScript marks optional, or that may be null, is Optional;
 *  - ids are distinct types (`ThreadID`, `MessageID`, …);
 *  - a route is called through `Door`, so the app cannot name a route the door
 *    does not have, and a write's idempotency key has its place.
 *
 * It reads the schema and door.json as committed (run schema.ts and door.ts
 * first), so the Swift always matches the JSON beside it.
 */
import type { DoorEntry } from './door';
import { contractVersion } from './door';
import { OUT, cli, jsonText, readRepoText, repoFileExists, type Output } from './lib';
import type { Schema } from './schema';

/** The two source files whose error codes the app may meet (read as text: never imported). */
const ERROR_SOURCES = { door: 'packages/server/inbox-devices.ts', window: 'packages/server/inbox.ts' } as const;

/** Ids with a type of their own: by property name anywhere, or by `Type.property`. */
const ID_TYPES: Record<string, string> = {
  thread_id: 'ThreadID',
  message_id: 'MessageID',
  project_id: 'ProjectID',
  upload_id: 'UploadID',
  attachment_id: 'AttachmentID',
  annotation_id: 'AnnotationID',
  'InboxMessageWire.id': 'MessageID',
  'InboxProject.id': 'ProjectID',
  'ProjectFolder.id': 'ProjectID',
  'InboxDevicePublic.id': 'DeviceID',
  'InboxUpload.upload_id': 'UploadID',
};
/** A route parameter's type, by its name in door.json. */
const PARAM_TYPES: Record<string, string> = {
  thread: 'ThreadID', message: 'MessageID', project: 'ProjectID', attachment: 'AttachmentID', upload: 'UploadID', annotation: 'AnnotationID',
};
const ID_NAMES = [...new Set([...Object.values(ID_TYPES), ...Object.values(PARAM_TYPES)])].sort();

const KEYWORDS = new Set([
  'associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import', 'init', 'inout', 'internal', 'let', 'open',
  'operator', 'private', 'precedencegroup', 'protocol', 'public', 'rethrows', 'static', 'struct', 'subscript', 'typealias', 'var', 'break',
  'case', 'catch', 'continue', 'default', 'defer', 'do', 'else', 'fallthrough', 'for', 'guard', 'if', 'in', 'repeat', 'return', 'throw',
  'switch', 'where', 'while', 'Any', 'as', 'false', 'is', 'nil', 'self', 'Self', 'super', 'throws', 'true', 'try', 'Type', 'some', 'any',
]);
const ident = (name: string) => (KEYWORDS.has(name) ? `\`${name}\`` : name);
const lit = (s: string) => JSON.stringify(s);

/** `launch_id` -> `launchId`; `mark-unread` -> `markUnread`; `2fa` -> `_2fa`. */
function camel(raw: string): string {
  const words = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return 'empty';
  const out = words.map((w, i) => (i === 0 ? w[0]!.toLowerCase() + w.slice(1) : w[0]!.toUpperCase() + w.slice(1))).join('');
  return /^[0-9]/.test(out) ? `_${out}` : out;
}
const pascal = (raw: string) => { const c = camel(raw).replace(/^_/, ''); return c[0]!.toUpperCase() + c.slice(1); };

/** A doc comment, one `///` line per sentence group, cut to a readable length. */
function doc(text: unknown, indent: string): string[] {
  if (typeof text !== 'string' || !text) return [];
  const clipped = text.length > 600 ? `${text.slice(0, 597).replace(/\s+\S*$/, '')}…` : text;
  return [`${indent}/// ${clipped.replace(/\s+/g, ' ')}`];
}

type Field = { key: string; swift: string; type: string; optional: boolean; nullable: boolean; doc?: string };
type Decl =
  | { kind: 'struct'; name: string; fields: Field[]; doc?: string; source?: string; extra?: string }
  | { kind: 'enum'; name: string; values: string[]; doc?: string; source?: string }
  | { kind: 'oneOf'; name: string; cases: { name: string; type: string }[]; doc?: string; source?: string }
  | { kind: 'alias'; name: string; type: string; doc?: string; source?: string };

class SwiftTypes {
  decls = new Map<string, Decl>();
  /** Per struct, the fields Wire.swift decodes as required (the baseline, below); filled as structs are declared. */
  readonly strict = new Map<string, string[]>();

  constructor(private defs: Record<string, Schema>, private baseline: Record<string, string[]> | null) {}

  private unique(name: string): string {
    let n = name;
    for (let i = 2; this.decls.has(n) || (this.defs[n] !== undefined && n !== name); i++) n = `${name}${i}`;
    return n;
  }

  /** The Swift type for a schema, declaring what it needs under `hint` (a name for a type written in place). */
  typeOf(s: Schema, hint: string, idType?: string): { type: string; nullable: boolean } {
    if (s.$ref) return { type: this.ref(String(s.$ref).replace('#/$defs/', '')), nullable: false };
    const any = s.anyOf as Schema[] | undefined;
    if (any) {
      const rest = any.filter((x) => x.type !== 'null');
      const nullable = rest.length < any.length;
      if (!rest.length) return { type: 'JSONValue', nullable: true };
      if (rest.length === 1) return { type: this.typeOf(rest[0]!, hint, idType).type, nullable };
      return { type: this.union(rest, hint), nullable };
    }
    switch (s.type) {
      case 'string':
        if (s.enum) return { type: this.declareEnum(hint, s.enum as string[], s), nullable: false };
        return { type: idType ?? 'String', nullable: false };
      case 'integer': return { type: 'Int64', nullable: false };
      case 'number': return { type: 'Double', nullable: false };
      case 'boolean': return { type: 'Bool', nullable: false };
      case 'null': return { type: 'JSONValue', nullable: true };
      case 'array': return { type: `[${this.typeOf((s.items as Schema) ?? {}, `${hint}Item`).type}]`, nullable: false };
      case 'object': {
        const props = (s.properties as Record<string, Schema> | undefined) ?? {};
        if (!Object.keys(props).length && s.additionalProperties && s.additionalProperties !== true) {
          return { type: `[String: ${this.typeOf(s.additionalProperties as Schema, `${hint}Value`).type}]`, nullable: false };
        }
        if (!Object.keys(props).length) return { type: '[String: JSONValue]', nullable: false };
        return { type: this.declareStruct(hint, s), nullable: false };
      }
      default: return { type: 'JSONValue', nullable: false };
    }
  }

  ref(name: string): string {
    if (this.decls.has(name)) return name;
    const s = this.defs[name];
    if (!s) throw new Error(`swift.ts: no schema for ${name}`);
    // A def that is an object, an enum or a union gets a declaration of its own name.
    if (s.type === 'object' && s.properties) return this.declareStruct(name, s, true);
    if (s.type === 'string' && s.enum) return this.declareEnum(name, s.enum as string[], s, true);
    if (s.anyOf) {
      const rest = (s.anyOf as Schema[]).filter((x) => x.type !== 'null');
      if (rest.length > 1) return this.union(rest, name, s, true);
    }
    const t = this.typeOf(s, `${name}Value`);
    this.decls.set(name, { kind: 'alias', name, type: t.nullable ? `${t.type}?` : t.type, doc: s.description as string, source: s['x-source'] as string });
    return name;
  }

  declareEnum(hint: string, values: string[], s: Schema, exact = false): string {
    const name = exact ? hint : this.unique(hint);
    this.decls.set(name, { kind: 'enum', name, values: [...values], doc: s.description as string, source: s['x-source'] as string });
    return name;
  }

  declareStruct(hint: string, s: Schema, exact = false): string {
    const name = exact ? hint : this.unique(hint);
    const decl: Decl = { kind: 'struct', name, fields: [], doc: s.description as string, source: s['x-source'] as string };
    this.decls.set(name, decl); // before the fields: a type may contain itself through an array
    const props = (s.properties as Record<string, Schema>) ?? {};
    const required = new Set((s.required as string[] | undefined) ?? []);
    // A field the TypeScript requires is decoded as required only if it was required when this contract began
    // (or its type is new since): one an older Inbox does not send yet is optional here, so a newer app still reads it.
    const was = this.baseline?.[name];
    const strict = [...required].filter((k) => was === undefined || was.includes(k)).sort();
    this.strict.set(name, strict);
    const used = new Set<string>(['unknownFields']);
    for (const [key, prop] of Object.entries(props)) {
      const idType = ID_TYPES[`${name}.${key}`] ?? ID_TYPES[key];
      const t = this.typeOf(prop, `${name}${pascal(key)}`, idType);
      let swift = camel(key);
      if (KEYWORDS.has(swift)) swift = `${swift}Value`;
      while (used.has(swift)) swift = `${swift}_`;
      used.add(swift);
      decl.fields.push({ key, swift, type: t.type, optional: !strict.includes(key), nullable: t.nullable, doc: prop.description as string });
    }
    return name;
  }

  /** Several shapes in one place: objects merge into one struct; one of each other kind becomes a case. */
  union(parts: Schema[], hint: string, s: Schema = {}, exact = false): string {
    const resolved = parts.map((p) => (p.$ref ? { ...this.defs[String(p.$ref).replace('#/$defs/', '')], $ref: p.$ref } : p));
    const objects = resolved.filter((p) => p.type === 'object' && p.properties);
    const strings = resolved.filter((p) => p.type === 'string');
    if (strings.length === resolved.length) {
      const open = strings.some((p) => !p.enum && p.const === undefined);
      if (open) return 'String';
      const values = [...new Set(strings.flatMap((p) => (p.enum as string[] | undefined) ?? [p.const as string]))].sort();
      return this.declareEnum(hint, values, s, exact);
    }
    const kinds = new Map<string, Schema[]>();
    for (const p of resolved) {
      const k = p.type === 'object' && p.properties ? 'object' : String(p.type ?? 'any');
      kinds.set(k, [...(kinds.get(k) ?? []), p]);
    }
    if (kinds.size === 1 && objects.length) return this.declareStruct(hint, this.merge(objects), exact);
    const name = exact ? hint : this.unique(hint);
    const decl: Decl = { kind: 'oneOf', name, cases: [], doc: s.description as string, source: s['x-source'] as string };
    this.decls.set(name, decl);
    const order = ['object', 'array', 'string', 'number', 'boolean'];
    for (const k of order) {
      const group = kinds.get(k);
      if (!group) continue;
      const one: Schema = k === 'object' ? this.merge(group) : group.length === 1 ? group[0]! : { anyOf: group };
      const t = k === 'object' ? this.declareStruct(`${name}Object`, one) : this.typeOf(one, `${name}${pascal(k)}`).type;
      decl.cases.push({ name: k === 'boolean' ? 'bool' : k, type: t });
    }
    return name;
  }

  /** One object from several: a field required in every one stays required; a field typed two ways is a JSONValue. */
  merge(objects: Schema[]): Schema {
    const properties: Record<string, Schema> = {};
    const seen = new Map<string, number>();
    const requiredIn = new Map<string, number>();
    for (const o of objects) {
      for (const [k, v] of Object.entries(o.properties as Record<string, Schema>)) {
        seen.set(k, (seen.get(k) ?? 0) + 1);
        const prev = properties[k];
        if (!prev) properties[k] = v;
        else if (JSON.stringify(withoutDoc(prev)) !== JSON.stringify(withoutDoc(v))) {
          const consts = [prev, v].every((x) => x.type === 'string' && (x.const !== undefined || x.enum));
          properties[k] = consts
            ? { type: 'string', enum: [...new Set([prev, v].flatMap((x) => (x.enum as string[] | undefined) ?? [x.const as string]))].sort(), description: prev.description }
            : { description: prev.description };
        }
      }
      for (const r of (o.required as string[] | undefined) ?? []) requiredIn.set(r, (requiredIn.get(r) ?? 0) + 1);
    }
    const required = Object.keys(properties).filter((k) => requiredIn.get(k) === objects.length);
    return { type: 'object', properties, required, additionalProperties: true };
  }
}

const withoutDoc = (s: Schema): Schema => { const { description: _d, ...rest } = s; return rest; };

function emitStruct(d: Extract<Decl, { kind: 'struct' }>): string[] {
  const lines: string[] = [...doc(d.doc, ''), ...(d.source ? [`/// From \`${d.source}\`.`] : []), `public struct ${d.name}: Codable, Hashable, Sendable {`];
  for (const f of d.fields) {
    const opt = f.optional || f.nullable;
    lines.push(...doc(f.doc, '  '), `  public var ${ident(f.swift)}: ${f.type}${opt ? '?' : ''}`);
  }
  lines.push('  /// Fields this app does not know: kept, and written back when encoded.', '  public var unknownFields: [String: JSONValue] = [:]', '');
  lines.push(`  static let knownKeys: Set<String> = [${d.fields.map((f) => lit(f.key)).join(', ')}]`, '');
  // Memberwise init (public, so another module can build one).
  const params = d.fields.map((f) => `${ident(f.swift)}: ${f.type}${f.optional || f.nullable ? `? = nil` : ''}`);
  lines.push(`  public init(${[...params, 'unknownFields: [String: JSONValue] = [:]'].join(', ')}) {`);
  for (const f of d.fields) lines.push(`    self.${ident(f.swift)} = ${ident(f.swift)}`);
  lines.push('    self.unknownFields = unknownFields', '  }', '');
  lines.push('  public init(from decoder: Decoder) throws {', '    let c = try decoder.container(keyedBy: WireKey.self)');
  for (const f of d.fields) {
    const call = f.optional || f.nullable ? 'decodeIfPresent' : 'decode';
    lines.push(`    self.${ident(f.swift)} = try c.${call}(${f.type}.self, forKey: WireKey(${lit(f.key)}))`);
  }
  lines.push('    self.unknownFields = try WireKey.rest(of: c, known: Self.knownKeys)', '  }', '');
  lines.push('  public func encode(to encoder: Encoder) throws {', '    var c = encoder.container(keyedBy: WireKey.self)');
  for (const f of d.fields) {
    // Present but null on the wire (required and nullable): written as null. Optional: left out when nil.
    const call = f.optional ? 'encodeIfPresent' : 'encode';
    lines.push(`    try c.${call}(self.${ident(f.swift)}, forKey: WireKey(${lit(f.key)}))`);
  }
  lines.push('    try WireKey.write(unknownFields, to: &c)', '  }', '}');
  return lines;
}

function emitEnum(d: Extract<Decl, { kind: 'enum' }>): string[] {
  const used = new Set<string>(['unknown']);
  const cases = d.values.map((v) => {
    let c = camel(v);
    if (c === 'unknown' || KEYWORDS.has(c)) c = `${c}Value`;
    while (used.has(c)) c = `${c}_`;
    used.add(c);
    return { v, c };
  });
  return [
    ...doc(d.doc, ''), ...(d.source ? [`/// From \`${d.source}\`.`] : []),
    `public enum ${d.name}: Codable, Hashable, Sendable, RawRepresentable {`,
    ...cases.map(({ c }) => `  case ${ident(c)}`),
    '  /// A value this app does not know (a newer Inbox).',
    '  case unknown(String)',
    '',
    `  public static let known: [${d.name}] = [${cases.map(({ c }) => `.${ident(c)}`).join(', ')}]`,
    '',
    '  public init(rawValue: String) {',
    '    switch rawValue {',
    ...cases.map(({ v, c }) => `    case ${lit(v)}: self = .${ident(c)}`),
    '    default: self = .unknown(rawValue)',
    '    }',
    '  }',
    '',
    '  public var rawValue: String {',
    '    switch self {',
    ...cases.map(({ v, c }) => `    case .${ident(c)}: return ${lit(v)}`),
    '    case .unknown(let value): return value',
    '    }',
    '  }',
    '',
    '  public init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }',
    '  public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }',
    '}',
  ];
}

function emitOneOf(d: Extract<Decl, { kind: 'oneOf' }>): string[] {
  return [
    ...doc(d.doc, ''), ...(d.source ? [`/// From \`${d.source}\`.`] : []),
    '/// One of several shapes; `other` keeps a shape this app does not know.',
    `public enum ${d.name}: Codable, Hashable, Sendable {`,
    ...d.cases.map((c) => `  case ${ident(c.name)}(${c.type})`),
    '  case other(JSONValue)',
    '',
    '  public init(from decoder: Decoder) throws {',
    ...d.cases.map((c) => `    if let value = try? ${c.type}(from: decoder) { self = .${ident(c.name)}(value); return }`),
    '    self = .other(try JSONValue(from: decoder))',
    '  }',
    '',
    '  public func encode(to encoder: Encoder) throws {',
    '    switch self {',
    ...d.cases.map((c) => `    case .${ident(c.name)}(let value): try value.encode(to: encoder)`),
    '    case .other(let value): try value.encode(to: encoder)',
    '    }',
    '  }',
    '}',
  ];
}

/** The error codes in a source file: the door's `refuse(<status>, "<code>"`, the window's ERROR_STATUS table. */
export function errorCodes(): { code: string; status: number }[] {
  const out = new Map<string, number>();
  const door = readRepoText(ERROR_SOURCES.door);
  for (const m of door.matchAll(/refuse\((\d{3}), "([a-z0-9_]+)"/g)) out.set(m[2]!, Number(m[1]));
  const window = readRepoText(ERROR_SOURCES.window);
  const start = window.indexOf('const ERROR_STATUS: Record<string, number> = {');
  if (start < 0) throw new Error(`swift.ts: no ERROR_STATUS table in ${ERROR_SOURCES.window}`);
  const body = window.slice(start, window.indexOf('\n};', start));
  for (const m of body.matchAll(/^\s+([a-z0-9_]+): (\d{3}),/gm)) if (!out.has(m[1]!)) out.set(m[1]!, Number(m[2]));
  return [...out.entries()].map(([code, status]) => ({ code, status })).sort((a, b) => (a.code < b.code ? -1 : 1));
}

const PRELUDE = `// GENERATED by scripts/mobile/swift.ts from apps/mobile/contract/schema/wire.schema.json,
// apps/mobile/contract/door.json and the door's and the window's error codes. Do not edit:
// change the product's TypeScript (or scripts/mobile/door-shapes.ts) and run the generators
// (docs/agent-guides/mobile.md).

import Foundation

/// The contract this file was made from (apps/mobile/contract/VERSION).
public let wireContract = __CONTRACT__

// MARK: - JSON values and coding

/// Any JSON value: a field whose shape the contract leaves open, and the fields a struct does not know.
public enum JSONValue: Codable, Hashable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let v = try? c.decode(Bool.self) { self = .bool(v) }
    else if let v = try? c.decode(Double.self) { self = .number(v) }
    else if let v = try? c.decode(String.self) { self = .string(v) }
    else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
    else { self = .object(try c.decode([String: JSONValue].self)) }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .string(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .object(let v): try c.encode(v)
    }
  }
}

/// A JSON object's key, by name.
public struct WireKey: CodingKey, Hashable, Sendable {
  public let stringValue: String
  public var intValue: Int? { nil }
  public init(_ name: String) { stringValue = name }
  public init?(stringValue: String) { self.stringValue = stringValue }
  public init?(intValue: Int) { nil }

  /// Every field of the object not in \`known\`.
  static func rest(of c: KeyedDecodingContainer<WireKey>, known: Set<String>) throws -> [String: JSONValue] {
    var out: [String: JSONValue] = [:]
    for key in c.allKeys where !known.contains(key.stringValue) {
      out[key.stringValue] = try c.decode(JSONValue.self, forKey: key)
    }
    return out
  }

  static func write(_ fields: [String: JSONValue], to c: inout KeyedEncodingContainer<WireKey>) throws {
    for (name, value) in fields { try c.encode(value, forKey: WireKey(name)) }
  }
}

// MARK: - Ids
`;

function idDecl(name: string): string[] {
  return [
    `public struct ${name}: RawRepresentable, Codable, Hashable, Sendable, CustomStringConvertible {`,
    '  public let rawValue: String',
    '  public init(rawValue: String) { self.rawValue = rawValue }',
    '  public init(_ rawValue: String) { self.rawValue = rawValue }',
    '  public var description: String { rawValue }',
    '  public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }',
    '  public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }',
    '}',
  ];
}

function emitDoor(routes: DoorEntry[]): string[] {
  const enumOf = (name: string, values: string[]) => [
    `public enum ${name}: String, Hashable, Sendable {`, ...values.map((v) => `  case ${ident(camel(v.toLowerCase()))} = ${lit(v)}`), '}',
  ];
  const lines: string[] = [
    '// MARK: - The door (apps/mobile/contract/door.json)', '',
    ...enumOf('DoorMethod', ['GET', 'POST']), '',
    '/// Who may call a route: a paired phone (and a linked computer), or a linked computer only.',
    ...enumOf('DoorGrant', ['phone', 'machine']), '',
    '/// `read`: a GET. `hold`: a write that may wait offline and be sent later. `now`: sent now or never. `bytes`: a file as the body.',
    ...enumOf('DoorKind', ['read', 'hold', 'now', 'bytes']), '',
    '/// Where a write\'s idempotency key goes.',
    ...enumOf('DoorKeyPlace', ['body', 'query']), '',
    ...enumOf('DoorAnswer', ['json', 'bytes', 'stream']), '',
    '/// One route of the door, as door.json gives it.',
    'public struct DoorRoute: Hashable, Sendable {',
    '  /// `POST threads/:id/seen`: what `health.door.routes` lists for it, so the app offers a route only when it is listed.',
    '  public let name: String',
    '  public let method: DoorMethod',
    '  /// Relative to `Door.prefix`, parameters in braces.',
    '  public let path: String',
    '  public let grant: DoorGrant',
    '  /// False only for pairing, which takes no token.',
    '  public let needsToken: Bool',
    '  public let kind: DoorKind',
    '  public let key: DoorKeyPlace?',
    '  public let answer: DoorAnswer',
    '  /// Honours `Range` and `If-Range`.',
    '  public let range: Bool',
    '  /// The relay carries it as a sealed command.',
    '  public let relay: Bool',
    '}', '',
    '/// A route with its parameters filled in.',
    'public struct DoorRequest: Hashable, Sendable {',
    '  public let route: DoorRoute',
    '  /// Relative to `Door.prefix`, parameters percent-encoded.',
    '  public let path: String',
    '}', '',
    '/// Every route of the door.',
    'public enum DoorRoutes {',
  ];
  for (const r of routes) {
    lines.push(
      `  /// \`${r.name}\`${r.window ? `: the window's \`${r.window}\`` : ''}.`,
      `  public static let ${ident(r.call)} = DoorRoute(name: ${lit(r.name)}, method: .${r.method.toLowerCase()}, path: ${lit(r.path)}, grant: .${r.grant}, needsToken: ${r.auth === 'token'}, kind: .${r.kind}, key: ${r.key ? `.${r.key}` : 'nil'}, answer: .${r.answer}, range: ${r.range}, relay: ${r.relay})`,
    );
  }
  lines.push(`  public static let all: [DoorRoute] = [${routes.map((r) => ident(r.call)).join(', ')}]`, '}', '');
  lines.push(
    '/// The door\'s routes as requests: `Door.postThreadSeen(thread: id)`.',
    'public enum Door {',
    `  public static let prefix = "/api/inbox/device/"`,
    '',
    '  /// One path segment, percent-encoded (a slash too).',
    '  static func segment(_ value: String) -> String {',
    '    var allowed = CharacterSet.urlPathAllowed',
    '    allowed.remove(charactersIn: "/")',
    '    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value',
    '  }',
    '',
    '  /// The rest of a path: its slashes kept.',
    '  static func rest(_ value: String) -> String {',
    '    value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value',
    '  }',
    '',
  );
  for (const r of routes) {
    const args = r.params.map((p) => `${ident(p)}: ${PARAM_TYPES[p] ?? 'String'}`).join(', ');
    let expr = lit(r.path);
    if (r.params.length) {
      expr = r.path.replace(/\{(\w+)\}/g, (_, p: string) => {
        const value = PARAM_TYPES[p] ? `${ident(p)}.rawValue` : ident(p);
        return `\\(${p === 'path' ? 'rest' : 'segment'}(${value}))`;
      });
      expr = `"${expr}"`;
    }
    lines.push(`  public static func ${ident(r.call)}(${args}) -> DoorRequest { DoorRequest(route: DoorRoutes.${ident(r.call)}, path: ${expr}) }`);
  }
  lines.push('}');
  return lines;
}

function emitErrors(codes: { code: string; status: number }[]): string[] {
  const values = codes.map((c) => c.code);
  const lines = emitEnum({ kind: 'enum', name: 'WireErrorCode', values, doc: 'A refusal\'s `code` (act on it, never on the words): the door\'s own and every code the window answers.' });
  lines.push(
    '',
    'extension WireErrorCode {',
    '  /// The HTTP status the Inbox answers with this code (a code it does not list answers 400).',
    '  public static let statusOf: [String: Int] = [',
    ...codes.map((c) => `    ${lit(c.code)}: ${c.status},`),
    '  ]',
    '}',
  );
  return lines;
}

type Baseline = { about: string; contract: number; required: Record<string, string[]> };

/** The committed baseline, when it belongs to this contract; a new contract number starts a new one. */
function readBaseline(): Record<string, string[]> | null {
  if (!repoFileExists(OUT.required)) return null;
  const baseline = JSON.parse(readRepoText(OUT.required)) as Baseline;
  return baseline.contract === contractVersion() ? baseline.required : null;
}

export function buildSwift(): { swift: string; baseline: Baseline } {
  const schema = JSON.parse(readRepoText(OUT.schema)) as { $defs: Record<string, Schema> };
  const door = JSON.parse(readRepoText(OUT.door)) as { routes: DoorEntry[] };
  const types = new SwiftTypes(schema.$defs, readBaseline());
  for (const name of Object.keys(schema.$defs)) types.ref(name);
  const decls = [...types.decls.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  const out: string[] = [PRELUDE.replace('__CONTRACT__', String(contractVersion()))];
  for (const id of ID_NAMES) out.push(idDecl(id).join('\n'), '');
  out.push('// MARK: - Wire types (apps/mobile/contract/schema/wire.schema.json)', '');
  for (const d of decls) {
    const body = d.kind === 'struct' ? emitStruct(d) : d.kind === 'enum' ? emitEnum(d) : d.kind === 'oneOf' ? emitOneOf(d)
      : [...doc(d.doc, ''), `public typealias ${d.name} = ${d.type}`];
    out.push(body.join('\n'), '');
  }
  out.push('// MARK: - Error codes', '', emitErrors(errorCodes()).join('\n'), '');
  out.push(emitDoor(door.routes).join('\n'), '');
  const required = Object.fromEntries([...types.strict.entries()].filter(([, keys]) => keys.length).sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    swift: out.join('\n'),
    baseline: {
      about: 'GENERATED by scripts/mobile/swift.ts. Per struct, the fields Wire.swift decodes as required: those required when this contract number began. A field required later is optional in Wire.swift, so a newer app reads an older Inbox. Starts again when VERSION rises.',
      contract: contractVersion(),
      required,
    },
  };
}

export function generateSwift(): Output[] {
  const { swift, baseline } = buildSwift();
  return [{ path: OUT.swift, text: swift }, { path: OUT.required, text: jsonText(baseline) }];
}

if (import.meta.main) cli('swift', generateSwift);
