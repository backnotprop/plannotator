/**
 * Reading a document, an object or a snapshot from JSON someone else wrote
 * (a file, a peer, an agent). Fail closed: anything not understood is
 * refused with a reason, never guessed at, and nothing unknown is carried
 * through. What passes here is safe to hand to the renderer.
 */
import { parseColor } from './color';
import { bindingFault, groupCycle, idMap, isBoundEnd } from './document';
import { isFiniteRect } from './geometry';
import { isPictureRef } from './assets';
import { HTML_ITEM_MAX_LENGTH, isWebUrl } from './html-item';
import { isValidId } from './ids';
import {
  ARTIFACT_KINDS,
  CANVAS_DOCUMENT_VERSION,
  type ArrowEnd,
  type ArtifactKind,
  type CanvasDocument,
  type CanvasLink,
  type CanvasObject,
  type ObjectStyle,
  type ReferenceTarget,
  type Snapshot,
  type SnapshotInput,
  type SnapshotSource,
} from './types';

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export const LIMITS = {
  text: 20_000,
  title: 300,
  coordinate: 10_000_000,
  size: 20_000,
  /** As many as have been measured (`bench/run.ts`): at 10,000 a pan with the whole board in view drops frames. */
  objects: 10_000,
  snapshots: 2_000,
  spriteFrames: 512,
  spriteFps: 60,
  styleKeys: 16,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

const isCoordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= LIMITS.coordinate;

const TOKEN_RE = /^[a-z][a-z0-9-]{0,31}$/;
const isToken = (value: unknown): value is string => typeof value === 'string' && TOKEN_RE.test(value);

function readStyle(value: unknown): ObjectStyle | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length > LIMITS.styleKeys) return null;
  const out: ObjectStyle = {};
  for (const key of keys.sort()) {
    const v = value[key];
    if (!isToken(key)) return null;
    if (typeof v === 'string' ? v.length > 64 : typeof v === 'number' ? !Number.isFinite(v) : typeof v !== 'boolean') return null;
    out[key] = v as string | number | boolean;
  }
  return out;
}

function readRect(value: Record<string, unknown>): { x: number; y: number; w: number; h: number } | null {
  const { x, y, w, h } = value;
  if (!isCoordinate(x) || !isCoordinate(y) || typeof w !== 'number' || typeof h !== 'number') return null;
  const r = { x, y, w, h };
  if (!isFiniteRect(r) || w < 1 || h < 1 || w > LIMITS.size || h > LIMITS.size) return null;
  return r;
}

function readEnd(value: unknown): ArrowEnd | null {
  if (!isRecord(value)) return null;
  if ('object' in value) return isValidId(value.object) ? { object: value.object } : null;
  return isCoordinate(value.x) && isCoordinate(value.y) ? { x: value.x, y: value.y } : null;
}

function readLink(value: unknown): CanvasLink | null {
  if (!isRecord(value) || value.kind !== 'plan' || !isText(value.anchor, LIMITS.title) || !value.anchor) return null;
  return { kind: 'plan', anchor: value.anchor };
}

function readTarget(value: unknown): ReferenceTarget | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'web') return isWebUrl(value.url) ? { kind: 'web', url: value.url } : null;
  if (value.kind === 'artifact') {
    if (!isText(value.artifact, 512) || !value.artifact) return null;
    if (!(ARTIFACT_KINDS as readonly unknown[]).includes(value.artifactKind)) return null;
    return { kind: 'artifact', artifact: value.artifact, artifactKind: value.artifactKind as ArtifactKind };
  }
  if (value.kind === 'plan') {
    if (!isText(value.anchor, LIMITS.title)) return null;
    if (value.document !== undefined && !isText(value.document, 512)) return null;
    return { kind: 'plan', anchor: value.anchor, ...(value.document ? { document: value.document } : {}) };
  }
  return null;
}

/** One object, checked field by field and rebuilt from only the known fields. */
export function checkObject(value: unknown): Checked<CanvasObject> {
  if (!isRecord(value)) return fail('an object must be a JSON object');
  if (!isValidId(value.id)) return fail('id must be 1 to 64 of a-z, 0-9, "-" and "_", starting with a letter or digit');
  const id = value.id;
  const base: { id: string; color?: CanvasObject['color']; group?: string; link?: CanvasLink; by?: 'person' | 'agent'; style?: ObjectStyle } = { id };
  if (value.color !== undefined) {
    const color = parseColor(value.color);
    if (!color) return fail(`${id}: color is not a named colour or a CSS colour`);
    base.color = color;
  }
  if (value.group !== undefined) {
    if (!isValidId(value.group) || value.group === id) return fail(`${id}: group is not a valid id`);
    base.group = value.group;
  }
  if (value.link !== undefined) {
    const link = readLink(value.link);
    if (!link) return fail(`${id}: link is not understood`);
    base.link = link;
  }
  if (value.by !== undefined) {
    if (value.by !== 'person' && value.by !== 'agent') return fail(`${id}: by must be "person" or "agent"`);
    base.by = value.by;
  }
  if (value.style !== undefined) {
    const style = readStyle(value.style);
    if (!style) return fail(`${id}: style must be up to ${LIMITS.styleKeys} named values, each text, a number or true/false`);
    if (Object.keys(style).length) base.style = style;
  }
  for (const key of ['shape', 'routing'] as const) {
    const token = value[key];
    if (token === undefined || token === '') continue;
    if ((key === 'routing') !== (value.type === 'arrow') || value.type === 'group' || !isToken(token)) return fail(`${id}: ${key} is not a name this object can carry`);
    (base as Record<string, unknown>)[key] = token;
  }

  const type = value.type;
  if (type === 'arrow') {
    const from = readEnd(value.from);
    const to = readEnd(value.to);
    if (!from || !to) return fail(`${id}: an arrow needs "from" and "to", each an object id or a point`);
    if (value.label !== undefined && !isText(value.label, LIMITS.title)) return fail(`${id}: label is too long`);
    return { ok: true, value: { ...base, type, from, to, ...(value.label ? { label: value.label as string } : {}) } };
  }
  if (type === 'group') {
    if (value.label !== undefined && !isText(value.label, LIMITS.title)) return fail(`${id}: label is too long`);
    return { ok: true, value: { ...base, type, ...(value.label ? { label: value.label as string } : {}) } };
  }

  const r = readRect(value);
  if (!r) return fail(`${id}: x, y, w and h must be numbers, with w and h from 1 to ${LIMITS.size}`);
  switch (type) {
    case 'box': {
      if (!isText(value.text, LIMITS.text)) return fail(`${id}: text is missing or too long`);
      if (value.detail !== undefined && !isText(value.detail, LIMITS.text)) return fail(`${id}: detail is too long`);
      return { ok: true, value: { ...base, ...r, type, text: value.text, ...(value.detail ? { detail: value.detail as string } : {}) } };
    }
    case 'note':
      if (!isText(value.text, LIMITS.text)) return fail(`${id}: text is missing or too long`);
      return { ok: true, value: { ...base, ...r, type, text: value.text } };
    case 'text': {
      if (!isText(value.text, LIMITS.text)) return fail(`${id}: text is missing or too long`);
      const size = value.size;
      if (size !== undefined && size !== 'small' && size !== 'medium' && size !== 'large') return fail(`${id}: size must be small, medium or large`);
      return { ok: true, value: { ...base, ...r, type, text: value.text, ...(size ? { size } : {}) } };
    }
    case 'frame':
      if (!isText(value.title, LIMITS.title)) return fail(`${id}: title is missing or too long`);
      return { ok: true, value: { ...base, ...r, type, title: value.title } };
    case 'image':
      if (!isPictureRef(value.src)) return fail(`${id}: src must be an asset reference, an http(s) address or a relative path (a picture's bytes are stored by the host, not in the document)`);
      if (!isText(value.alt, LIMITS.title)) return fail(`${id}: alt is missing or too long`);
      return { ok: true, value: { ...base, ...r, type, src: value.src, alt: value.alt } };
    case 'sprite': {
      if (!isPictureRef(value.src)) return fail(`${id}: src must be an asset reference, an http(s) address or a relative path (a picture's bytes are stored by the host, not in the document)`);
      if (!isText(value.alt, LIMITS.title)) return fail(`${id}: alt is missing or too long`);
      const { frames, fps } = value;
      if (typeof frames !== 'number' || !Number.isInteger(frames) || frames < 1 || frames > LIMITS.spriteFrames) return fail(`${id}: frames must be a whole number from 1 to ${LIMITS.spriteFrames}`);
      if (typeof fps !== 'number' || !(fps > 0) || fps > LIMITS.spriteFps) return fail(`${id}: fps must be above 0 and at most ${LIMITS.spriteFps}`);
      return { ok: true, value: { ...base, ...r, type, src: value.src, alt: value.alt, frames, fps } };
    }
    case 'html':
      if (!isText(value.html, HTML_ITEM_MAX_LENGTH)) return fail(`${id}: html is missing or longer than ${HTML_ITEM_MAX_LENGTH} characters`);
      if (value.alt !== undefined && !isText(value.alt, LIMITS.title)) return fail(`${id}: alt is too long`);
      return { ok: true, value: { ...base, ...r, type, html: value.html, ...(value.alt ? { alt: value.alt as string } : {}) } };
    case 'reference': {
      const target = readTarget(value.target);
      if (!target) return fail(`${id}: target must be a web address (http or https), an artifact or a place in a plan`);
      const out: Record<string, unknown> = { ...base, ...r, type, target };
      for (const key of ['title', 'description', 'site'] as const) {
        const text = value[key];
        if (text === undefined || text === '') continue;
        if (!isText(text, key === 'description' ? 600 : LIMITS.title)) return fail(`${id}: ${key} is too long`);
        out[key] = text;
      }
      for (const key of ['image', 'icon'] as const) {
        const src = value[key];
        if (src === undefined || src === '') continue;
        if (!isPictureRef(src)) return fail(`${id}: ${key} must be an asset reference, an http(s) address or a relative path`);
        out[key] = src;
      }
      return { ok: true, value: out as unknown as CanvasObject };
    }
    default:
      return fail(`${id}: unknown object type ${JSON.stringify(type)}`);
  }
}

function checkIdList(value: unknown, what: string): Checked<string[]> {
  if (!Array.isArray(value) || value.length > LIMITS.objects) return fail(`${what} must be a list of ids`);
  const seen = new Set<string>();
  for (const id of value) {
    if (!isValidId(id)) return fail(`${what} holds something that is not an id`);
    seen.add(id);
  }
  return { ok: true, value: [...seen] };
}

/** A snapshot as someone asks for it: an id, a title, a source. Anything else on it is ignored. */
export function checkSnapshotInput(value: unknown): Checked<SnapshotInput> {
  if (!isRecord(value)) return fail('a snapshot must be a JSON object');
  if (!isValidId(value.id)) return fail('a snapshot needs a valid id');
  if (!isText(value.title, LIMITS.title)) return fail(`${value.id}: title is missing or too long`);
  const source = value.source;
  if (!isRecord(source)) return fail(`${value.id}: source is missing`);
  let checked: SnapshotSource;
  if (source.kind === 'frame') {
    if (!isValidId(source.frame)) return fail(`${value.id}: source.frame is not an id`);
    checked = { kind: 'frame', frame: source.frame };
  } else if (source.kind === 'objects') {
    const ids = checkIdList(source.objects, `${value.id}: source.objects`);
    if (!ids.ok) return ids;
    if (ids.value.length === 0) return fail(`${value.id}: source.objects is empty`);
    checked = { kind: 'objects', objects: ids.value };
  } else if (source.kind === 'region') {
    const r = isRecord(source.rect) ? readRect(source.rect) : null;
    if (!r) return fail(`${value.id}: source.rect is not a rectangle`);
    checked = { kind: 'region', rect: r };
  } else {
    return fail(`${value.id}: unknown source kind ${JSON.stringify(source.kind)}`);
  }
  return { ok: true, value: { id: value.id, title: value.title, source: checked } };
}

/** A stored snapshot: the input plus its capture, every captured object checked like any other. */
export function checkSnapshot(value: unknown): Checked<Snapshot> {
  const input = checkSnapshotInput(value);
  if (!input.ok) return input;
  const capture = (value as Record<string, unknown>).capture;
  if (!isRecord(capture)) return fail(`${input.value.id}: capture is missing`);
  const rect = isRecord(capture.rect) ? readRect(capture.rect) : null;
  if (!rect) return fail(`${input.value.id}: capture.rect is not a rectangle`);
  if (!Array.isArray(capture.objects) || capture.objects.length > LIMITS.objects) return fail(`${input.value.id}: capture.objects must be a list`);
  const objects: CanvasObject[] = [];
  const seen = new Set<string>();
  for (const raw of capture.objects) {
    const object = checkObject(raw);
    if (!object.ok) return fail(`${input.value.id}: capture: ${object.error}`);
    if (object.value.type === 'group' || seen.has(object.value.id)) return fail(`${input.value.id}: capture holds a group or the same object twice`);
    seen.add(object.value.id);
    objects.push(object.value);
  }
  return { ok: true, value: { ...input.value, capture: { rect, objects } } };
}

/**
 * Migrations from an older saved version to the next, keyed by the version
 * they read. Empty today: version 1 is the first. A new version adds one
 * entry here and bumps `CANVAS_DOCUMENT_VERSION`; old files keep opening.
 */
export const MIGRATIONS: Readonly<Record<number, (doc: Record<string, unknown>) => Record<string, unknown>>> = {};

export function parseDocument(input: unknown): Checked<CanvasDocument> {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      return fail('not JSON');
    }
  }
  if (!isRecord(raw)) return fail('a canvas document must be a JSON object');
  let current = raw;
  const saved = current.version;
  if (typeof saved !== 'number' || !Number.isInteger(saved) || saved < 1) return fail('version is missing');
  let version: number = saved;
  if (version > CANVAS_DOCUMENT_VERSION) return fail(`this canvas was saved by a newer version (${version}); this one reads up to ${CANVAS_DOCUMENT_VERSION}`);
  while (version < CANVAS_DOCUMENT_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate) return fail(`no migration from version ${version}`);
    current = migrate(current);
    version += 1;
  }
  if (!isValidId(current.id)) return fail('the canvas needs a valid id');
  if (!isText(current.title, LIMITS.title)) return fail('title is missing or too long');
  if (!isRecord(current.objects)) return fail('objects is missing');
  const entries = Object.entries(current.objects);
  if (entries.length > LIMITS.objects) return fail(`more than ${LIMITS.objects} objects`);
  const objects = idMap<CanvasObject>();
  for (const [key, value] of entries) {
    const checked = checkObject(value);
    if (!checked.ok) return checked;
    if (checked.value.id !== key) return fail(`object stored under ${JSON.stringify(key)} says its id is ${checked.value.id}`);
    objects[key] = checked.value;
  }
  // Cross references, fail closed: a group that is a group, no group inside
  // itself, an arrow stuck only to what an arrow may be stuck to.
  const lookup = (id: string) => objects[id];
  for (const object of Object.values(objects)) {
    if (object.group && objects[object.group]?.type !== 'group') return fail(`${object.id}: group ${object.group} is not a group on this canvas`);
    if (object.group && groupCycle(lookup, object.id)) return fail(`${object.id}: its groups hold each other`);
    if (object.type !== 'arrow') continue;
    for (const end of [object.from, object.to]) {
      // An end stuck to an object that is not there is not a circle: the
      // arrow cannot be drawn, and readers cope (`resolveArrow`). It can
      // happen honestly, when two people delete and connect at once.
      const fault = isBoundEnd(end) && objects[end.object] ? bindingFault(lookup, object, end.object) : null;
      if (fault) return fail(`${object.id}: ${fault}`);
    }
  }
  if (!Array.isArray(current.order)) return fail('order is missing');
  const order: string[] = [];
  const placed = new Set<string>();
  for (const id of current.order) {
    if (typeof id !== 'string' || !objects[id] || placed.has(id)) return fail('order must list each object once');
    placed.add(id);
    order.push(id);
  }
  if (order.length !== entries.length) return fail('order must list each object once');
  const snapshots = idMap<Snapshot>();
  const rawSnapshots = current.snapshots ?? {};
  if (!isRecord(rawSnapshots) || Object.keys(rawSnapshots).length > LIMITS.snapshots) return fail('snapshots is not understood');
  for (const [key, value] of Object.entries(rawSnapshots)) {
    const checked = checkSnapshot(value);
    if (!checked.ok) return checked;
    if (checked.value.id !== key) return fail(`snapshot stored under ${JSON.stringify(key)} says its id is ${checked.value.id}`);
    snapshots[key] = checked.value;
  }
  return { ok: true, value: { version: CANVAS_DOCUMENT_VERSION, id: current.id, title: current.title, objects, order, snapshots } };
}

/** The same value with every object's keys in alphabetical order. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sorted(value[key]);
  return out;
}

/**
 * The saved form. Objects are written in drawing order, snapshots by id, and
 * every key in a fixed order, so two saves of one document are the same text
 * however the document came to be (a clean diff, a stable hash).
 */
export function serializeDocument(doc: CanvasDocument): string {
  const objects = idMap<unknown>();
  for (const id of doc.order) if (doc.objects[id]) objects[id] = sorted(doc.objects[id]);
  const snapshots = idMap<unknown>();
  for (const id of Object.keys(doc.snapshots).sort()) snapshots[id] = sorted(doc.snapshots[id]);
  return JSON.stringify({ version: doc.version, id: doc.id, title: doc.title, objects, order: doc.order, snapshots });
}
