/**
 * The door for commands and envelopes that arrive as JSON: from an agent,
 * from a peer. Both are untrusted. `decodeCommand` checks a command's shape
 * (the planner then checks its meaning against the document);
 * `decodeEnvelope` checks every event, because a received envelope is
 * applied without planning. An envelope going out needs no encoder: it is
 * already plain JSON.
 */
import { checkObject, checkSnapshot, checkSnapshotInput, type Checked } from '../model/codec';
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
      if (value.at !== undefined && !isNumber(value.at)) return fail('at must be a number');
      return { ok: true, value: { type: 'object-added', object: object.value, ...(value.at !== undefined ? { at: value.at } : {}) } };
    }
    case 'object-set': {
      // The fields are checked against the object they land on, when they are applied (`applyEvents` with `check`).
      if (typeof value.id !== 'string' || !isRecord(value.set)) return fail('object-set needs "id" and "set"');
      const names = Object.keys(value.set);
      if (names.length > 32 || names.includes('id') || names.includes('type')) return fail('object-set may not set that');
      const unset = value.unset;
      if (unset !== undefined && (!Array.isArray(unset) || unset.length > 32 || !unset.every((key) => typeof key === 'string' && key.length <= 32))) return fail('unset must be a list of field names');
      return { ok: true, value: { type: 'object-set', id: value.id, set: { ...value.set }, ...(unset?.length ? { unset: unset as string[] } : {}) } };
    }
    case 'object-removed':
      if (typeof value.id !== 'string') return fail('object-removed needs "id"');
      return { ok: true, value: { type: 'object-removed', id: value.id } };
    case 'object-ordered':
      if (typeof value.id !== 'string' || !isNumber(value.at)) return fail('object-ordered needs "id" and "at"');
      return { ok: true, value: { type: 'object-ordered', id: value.id, at: value.at } };
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

/** A peer's envelope, checked event by event. What `CanvasStore.receive` takes. */
export function decodeEnvelope(input: unknown): Checked<Pick<Envelope, 'id' | 'actor' | 'events'> & Pick<Partial<Envelope>, 'gesture'>> {
  let raw = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      return fail('not JSON');
    }
  }
  if (!isRecord(raw)) return fail('an envelope must be a JSON object');
  if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 128) return fail('an envelope needs an "id"');
  const actor = decodeActor(raw.actor);
  if (!actor) return fail('an envelope needs an "actor"');
  if (!Array.isArray(raw.events) || raw.events.length > 50_000) return fail('an envelope needs "events"');
  const events: CanvasEvent[] = [];
  for (const value of raw.events) {
    const event = decodeEvent(value);
    if (!event.ok) return event;
    events.push(event.value);
  }
  const gesture = typeof raw.gesture === 'string' && raw.gesture.length <= 128 ? raw.gesture : undefined;
  return { ok: true, value: { id: raw.id, actor, events, ...(gesture ? { gesture } : {}) } };
}
