/**
 * The door for commands and envelopes that arrive as JSON: from an agent,
 * from a peer. Both are untrusted. `decodeCommand` checks a command's shape
 * (the planner then checks its meaning against the document);
 * `decodeEnvelope` checks every event, because a received envelope is
 * applied without planning; `decodeDelivery` reads one as a sync backend
 * hands it over, with the backend's count and the backend's word for who
 * sent it. An envelope going out needs no encoder: it is already plain JSON.
 */
import { OBJECT_FIELDS, checkObject, checkSnapshot, checkSnapshotInput, type Checked } from '../model/codec';
import { isValidId } from '../model/ids';
import type { Actor } from '../model/types';
import type { CanvasEvent, Command, Envelope } from './types';

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isIdList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 20_000 && value.every((id) => typeof id === 'string');

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function decodeActor(value: unknown): Actor | null {
  if (!isRecord(value)) return null;
  if (value.kind !== 'person' && value.kind !== 'agent') return null;
  if (typeof value.id !== 'string' || !value.id || value.id.length > 128) return null;
  return { kind: value.kind, id: value.id };
}

export function decodeCommand(input: unknown): Checked<Command> {
  let raw = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      return fail('not JSON');
    }
  }
  if (!isRecord(raw) || typeof raw.type !== 'string') return fail('a command needs a "type"');
  const c = raw;
  switch (c.type) {
    case 'add':
      if (!Array.isArray(c.objects)) return fail('add needs "objects", a list');
      return { ok: true, value: { type: 'add', objects: c.objects } };
    case 'move':
      if (!isIdList(c.ids) || !isNumber(c.dx) || !isNumber(c.dy)) return fail('move needs "ids", "dx" and "dy"');
      return { ok: true, value: { type: 'move', ids: c.ids, dx: c.dx, dy: c.dy } };
    case 'resize': {
      const r = c.rect;
      if (typeof c.id !== 'string' || !isRecord(r) || !isNumber(r.x) || !isNumber(r.y) || !isNumber(r.w) || !isNumber(r.h)) return fail('resize needs "id" and "rect"');
      return { ok: true, value: { type: 'resize', id: c.id, rect: { x: r.x, y: r.y, w: r.w, h: r.h } } };
    }
    case 'edit':
      if (typeof c.id !== 'string' || !isRecord(c.patch)) return fail('edit needs "id" and "patch"');
      return { ok: true, value: { type: 'edit', id: c.id, patch: c.patch } };
    case 'recolor':
      if (!isIdList(c.ids) || c.color === undefined) return fail('recolor needs "ids" and "color"');
      return { ok: true, value: { type: 'recolor', ids: c.ids, color: c.color as never } };
    case 'delete':
    case 'ungroup':
      if (!isIdList(c.ids)) return fail(`${c.type} needs "ids"`);
      return { ok: true, value: { type: c.type, ids: c.ids } };
    case 'group':
      if (!isValidId(c.id) || !isIdList(c.ids)) return fail('group needs "id" and "ids"');
      if (c.label !== undefined && typeof c.label !== 'string') return fail('label must be text');
      return { ok: true, value: { type: 'group', id: c.id, ids: c.ids, ...(c.label ? { label: c.label } : {}) } };
    case 'reorder':
      if (!isIdList(c.ids) || (c.to !== 'front' && c.to !== 'back')) return fail('reorder needs "ids" and "to": "front" or "back"');
      return { ok: true, value: { type: 'reorder', ids: c.ids, to: c.to } };
    case 'retitle':
      if (typeof c.title !== 'string') return fail('retitle needs "title"');
      return { ok: true, value: { type: 'retitle', title: c.title } };
    case 'add-snapshot': {
      const snapshot = checkSnapshotInput(c.snapshot);
      if (!snapshot.ok) return snapshot;
      return { ok: true, value: { type: 'add-snapshot', snapshot: snapshot.value } };
    }
    case 'edit-snapshot': {
      if (typeof c.id !== 'string') return fail('edit-snapshot needs "id"');
      if (c.title !== undefined && typeof c.title !== 'string') return fail('title must be text');
      let source;
      if (c.source !== undefined) {
        const probe = checkSnapshotInput({ id: 'probe', title: '', source: c.source });
        if (!probe.ok) return fail(probe.error.replace(/^probe: /, ''));
        source = probe.value.source;
      }
      return { ok: true, value: { type: 'edit-snapshot', id: c.id, ...(c.title !== undefined ? { title: c.title } : {}), ...(source ? { source } : {}) } };
    }
    case 'remove-snapshot':
    case 'update-snapshot':
      if (typeof c.id !== 'string') return fail(`${c.type} needs "id"`);
      return { ok: true, value: { type: c.type, id: c.id } };
    default:
      return fail(`unknown command ${JSON.stringify(c.type)}`);
  }
}

function decodeEvent(value: unknown): Checked<CanvasEvent> {
  if (!isRecord(value)) return fail('an event must be a JSON object');
  switch (value.type) {
    case 'object-added': {
      const object = checkObject(value.object);
      if (!object.ok) return object;
      return { ok: true, value: { type: 'object-added', object: object.value } };
    }
    case 'object-set': {
      // The fields are checked against the object they land on, when they are applied (`applyEvents` with `check`).
      if (typeof value.id !== 'string' || !isRecord(value.set)) return fail('object-set needs "id" and "set"');
      const names = Object.keys(value.set);
      if (names.length > 32 || names.includes('id') || names.includes('type')) return fail('object-set may not set that');
      // Only names an object can have are carried on, each copied by name: `__proto__` and any other name
      // that is not a field is dropped here and never reaches an object. `by` is dropped the same way: who
      // added an object is said once, when it is added. Dropped, not refused: the rest of the change is
      // honest, and an envelope refused whole is a change its own sender would never see confirmed.
      const carried = (name: string) => name !== 'by' && OBJECT_FIELDS.has(name);
      const set: Record<string, unknown> = {};
      for (const name of names) if (carried(name)) set[name] = (value.set as Record<string, unknown>)[name];
      const unset = value.unset;
      if (unset !== undefined && (!Array.isArray(unset) || unset.length > 32 || !unset.every((key) => typeof key === 'string' && key.length <= 32))) return fail('unset must be a list of field names');
      const cleared = (unset as string[] | undefined)?.filter(carried);
      return { ok: true, value: { type: 'object-set', id: value.id, set, ...(cleared?.length ? { unset: cleared } : {}) } };
    }
    case 'object-removed':
      if (typeof value.id !== 'string') return fail('object-removed needs "id"');
      return { ok: true, value: { type: 'object-removed', id: value.id } };
    case 'snapshot-put': {
      const snapshot = checkSnapshot(value.snapshot);
      if (!snapshot.ok) return snapshot;
      return { ok: true, value: { type: 'snapshot-put', snapshot: snapshot.value } };
    }
    case 'snapshot-removed':
      if (typeof value.id !== 'string') return fail('snapshot-removed needs "id"');
      return { ok: true, value: { type: 'snapshot-removed', id: value.id } };
    case 'title-set':
      if (typeof value.title !== 'string' || value.title.length > 300) return fail('title-set needs "title"');
      return { ok: true, value: { type: 'title-set', title: value.title } };
    default:
      return fail(`unknown event ${JSON.stringify(value.type)}`);
  }
}

type DecodedEnvelope = Pick<Envelope, 'id' | 'actor' | 'events'> & Pick<Partial<Envelope>, 'gesture'>;

function parsed(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

/** Everything of an envelope but who sent it. */
function decodeBody(raw: unknown): Checked<Omit<DecodedEnvelope, 'actor'>> {
  if (!isRecord(raw)) return fail('an envelope must be a JSON object');
  if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 128) return fail('an envelope needs an "id"');
  if (!Array.isArray(raw.events) || raw.events.length > 50_000) return fail('an envelope needs "events"');
  const events: CanvasEvent[] = [];
  for (const value of raw.events) {
    const event = decodeEvent(value);
    if (!event.ok) return event;
    events.push(event.value);
  }
  const gesture = typeof raw.gesture === 'string' && raw.gesture.length <= 128 ? raw.gesture : undefined;
  return { ok: true, value: { id: raw.id, events, ...(gesture ? { gesture } : {}) } };
}

/**
 * An envelope from somewhere that is believed about who sent it (a
 * hand-over read back, a mirror of one's own store), checked event by event.
 * What `CanvasStore.receive` takes. From a sync backend use `decodeDelivery`.
 */
export function decodeEnvelope(input: unknown): Checked<DecodedEnvelope> {
  const raw = parsed(input);
  if (raw === undefined) return fail('not JSON');
  if (!isRecord(raw)) return fail('an envelope must be a JSON object');
  const actor = decodeActor(raw.actor);
  if (!actor) return fail('an envelope needs an "actor"');
  const body = decodeBody(raw);
  if (!body.ok) return body;
  return { ok: true, value: { ...body.value, actor } };
}

/**
 * One envelope as a sync backend hands it over: `{ stream, order, actor,
 * envelope }` (see `SyncDelivery`). `stream`, `order` and `actor` are the
 * backend's own words; the envelope inside is a peer's and is checked like
 * any other, except that the actor it names for itself is never read.
 *
 * A delivery whose count can be read is a delivery, whatever else is wrong
 * with it: the backend counted it, so every peer must count it too or the
 * next one would look like a gap. When the envelope inside does not pass,
 * or the backend's own stamp is not an actor (a kind this package does not
 * know, an id too long), it comes back with `envelope: null` and `refused`,
 * the reason: to be counted and otherwise ignored.
 */
export function decodeDelivery(input: unknown): Checked<{ stream: string; order: number; envelope: DecodedEnvelope | null; refused?: string }> {
  const raw = parsed(input);
  if (raw === undefined) return fail('not JSON');
  if (!isRecord(raw)) return fail('a delivery must be a JSON object');
  if (typeof raw.stream !== 'string' || !raw.stream || raw.stream.length > 128) return fail('a delivery needs "stream", the name of the backend\'s count');
  if (typeof raw.order !== 'number' || !Number.isSafeInteger(raw.order) || raw.order < 1) return fail('a delivery needs "order", a whole number from 1');
  const counted = { stream: raw.stream, order: raw.order };
  const actor = decodeActor(raw.actor);
  if (!actor) return { ok: true, value: { ...counted, envelope: null, refused: 'the backend\'s "actor" is not a person or an agent with an id of at most 128 characters' } };
  const inner = parsed(raw.envelope);
  const body = inner === undefined ? fail('not JSON') : decodeBody(inner);
  if (!body.ok) return { ok: true, value: { ...counted, envelope: null, refused: body.error } };
  return { ok: true, value: { ...counted, envelope: { ...body.value, actor } } };
}
