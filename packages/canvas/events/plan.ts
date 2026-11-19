/**
 * Command → events. Pure: it reads the document and the command and returns
 * the events that carry it out, or a reason it cannot be done. Every command
 * goes through here whoever sent it, so a person's gesture and an agent's
 * request are held to the same checks.
 */
import { captureOf, capturesEqual } from '../model/capture';
import { checkObject, checkSnapshotInput, LIMITS, type Checked } from '../model/codec';
import { parseColor } from '../model/color';
import { bindingFault, groupCycle, groupMembers, isBoundEnd, resolveArrow } from '../model/document';
import { isValidId } from '../model/ids';
import { keyBetween } from '../model/order-key';
import {
  DEFAULT_SIZES,
  type Actor,
  type ArrowEnd,
  type CanvasDocument,
  type CanvasObject,
  type ObjectId,
  isPlaced,
} from '../model/types';
import { setEvent } from './reduce';
import type { CanvasEvent, Command, ObjectPatch } from './types';

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const done = (events: CanvasEvent[]): Checked<CanvasEvent[]> => ({ ok: true, value: events });

/** The smallest an object may be resized to, in world units. */
export const MIN_OBJECT_SIZE = 16;

/**
 * What `edit` may change on each type. Every name here must also be in `OBJECT_FIELDS` (`model/codec.ts`),
 * or the change it makes would be dropped when applied: `events/store.test.ts` holds the two lists together.
 */
export const PATCH_FIELDS: Readonly<Record<CanvasObject['type'], readonly (keyof ObjectPatch)[]>> = {
  box: ['text', 'detail', 'link', 'style', 'shape', 'lanes'],
  note: ['text', 'link', 'style'],
  text: ['text', 'size', 'link', 'style'],
  frame: ['title', 'link', 'style'],
  image: ['src', 'alt', 'link', 'style'],
  sprite: ['src', 'alt', 'frames', 'fps', 'link', 'style'],
  html: ['html', 'alt', 'link', 'style'],
  chart: ['mark', 'fields', 'rows', 'encode', 'stack', 'flip', 'dash', 'rules', 'title', 'unit', 'link'],
  reference: ['target', 'title', 'description', 'site', 'image', 'icon', 'link', 'style'],
  stamp: ['kind', 'count', 'link'],
  arrow: ['from', 'to', 'label', 'link', 'style', 'routing'],
  group: ['label', 'link'],
};

/** Fields an edit removes when given `null` or an empty string. */
const OPTIONAL_FIELDS = new Set(['count', 'alt', 'link', 'detail', 'label', 'description', 'site', 'image', 'icon', 'style', 'shape', 'lanes', 'routing', 'stack', 'flip', 'dash', 'rules', 'unit']);

/** Add the event that turns `before` into `after`, when they differ. */
function push(events: CanvasEvent[], before: CanvasObject, after: CanvasObject): void {
  const event = setEvent(before, after);
  if (event) events.push(event);
}

function changes(pairs: [CanvasObject, CanvasObject][]): CanvasEvent[] {
  const events: CanvasEvent[] = [];
  for (const [before, after] of pairs) push(events, before, after);
  return events;
}

/** The same object with the default size for what it is, when it came with no width or no height. */
function withDefaultSize(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const object = raw as Record<string, unknown>;
  if (object.w !== undefined && object.h !== undefined) return raw;
  const shaped = `${String(object.type)}:${String(object.shape)}`;
  const size = Object.hasOwn(DEFAULT_SIZES, shaped) ? DEFAULT_SIZES[shaped] : Object.hasOwn(DEFAULT_SIZES, String(object.type)) ? DEFAULT_SIZES[String(object.type)] : undefined;
  return size ? { ...object, w: object.w ?? size.w, h: object.h ?? size.h } : raw;
}

/** The highest order key on the board, or null for an empty one. */
function topKey(doc: CanvasDocument): string | null {
  const last = doc.order[doc.order.length - 1];
  return last ? (doc.objects[last].z ?? null) : null;
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const moveEnd = (end: ArrowEnd, dx: number, dy: number): ArrowEnd =>
  isBoundEnd(end) ? end : { x: end.x + dx, y: end.y + dy };

function uniqueKnown(doc: CanvasDocument, ids: readonly ObjectId[]): ObjectId[] {
  const seen = new Set<ObjectId>();
  for (const id of ids) if (doc.objects[id]) seen.add(id);
  return [...seen];
}

function planAdd(doc: CanvasDocument, objects: readonly unknown[], actor: Actor): Checked<CanvasEvent[]> {
  if (!Array.isArray(objects) || objects.length === 0) return fail('nothing to add');
  if (Object.keys(doc.objects).length + objects.length > LIMITS.objects) return fail(`a canvas holds at most ${LIMITS.objects} objects`);
  const incoming = new Map<ObjectId, CanvasObject>();
  let top = topKey(doc);
  for (const given of objects) {
    const checked = checkObject(withDefaultSize(given));
    if (!checked.ok) return checked;
    const object = checked.value;
    if (doc.objects[object.id] || incoming.has(object.id)) return fail(`${object.id}: that id is already used`);
    // Who added it is who is adding it, and it goes on top, whatever the object says. Only the two fields
    // an actor has: whatever else the host's own object for a person carries is not the document's.
    top = keyBetween(top, null);
    incoming.set(object.id, { ...object, by: { kind: actor.kind, id: actor.id }, z: top });
  }
  const known = (id: ObjectId) => incoming.get(id) ?? doc.objects[id];
  for (const object of incoming.values()) {
    if (object.group && known(object.group)?.type !== 'group') return fail(`${object.id}: group ${object.group} is not a group on this canvas`);
    if (object.group && groupCycle(known, object.id)) return fail(`${object.id}: its groups hold each other`);
    if (object.type === 'arrow') {
      for (const end of [object.from, object.to]) {
        const fault = isBoundEnd(end) ? bindingFault(known, object, end.object) : null;
        if (fault) return fail(`${object.id}: ${fault}`);
      }
    }
  }
  return done([...incoming.values()].map((object) => ({ type: 'object-added', object })));
}

function planDelete(doc: CanvasDocument, ids: readonly ObjectId[]): Checked<CanvasEvent[]> {
  const doomed = new Set<ObjectId>();
  for (const id of uniqueKnown(doc, ids)) {
    doomed.add(id);
    if (doc.objects[id].type === 'group') for (const member of groupMembers(doc, id)) doomed.add(member);
  }
  if (doomed.size === 0) return fail('nothing to delete');
  // A group left with no member goes with them.
  const remaining = new Map<ObjectId, number>();
  for (const object of Object.values(doc.objects)) {
    if (object.group && !doomed.has(object.id)) remaining.set(object.group, (remaining.get(object.group) ?? 0) + 1);
  }
  for (const id of [...doomed]) {
    let group = doc.objects[id].group;
    while (group && doc.objects[group] && !doomed.has(group) && !remaining.get(group)) {
      doomed.add(group);
      const parent: ObjectId | undefined = doc.objects[group].group;
      if (parent) remaining.set(parent, (remaining.get(parent) ?? 1) - 1);
      group = parent;
    }
  }
  const events: CanvasEvent[] = [];
  // An arrow that stays keeps its place: the end that was stuck to a deleted
  // object becomes a free point where it was.
  for (const object of Object.values(doc.objects)) {
    if (object.type !== 'arrow' || doomed.has(object.id)) continue;
    const fromLost = isBoundEnd(object.from) && doomed.has(object.from.object);
    const toLost = isBoundEnd(object.to) && doomed.has(object.to.object);
    if (!fromLost && !toLost) continue;
    const geometry = resolveArrow(doc, object);
    if (!geometry) {
      doomed.add(object.id);
      continue;
    }
    push(events, object, { ...object, from: fromLost ? geometry.from : object.from, to: toLost ? geometry.to : object.to });
  }
  for (const id of doomed) events.push({ type: 'object-removed', id });
  return done(events);
}

function planEdit(doc: CanvasDocument, id: ObjectId, patch: ObjectPatch): Checked<CanvasEvent[]> {
  const object = doc.objects[id];
  if (!object) return fail(`there is no object ${id}`);
  if (!patch || typeof patch !== 'object') return fail('edit needs a patch');
  const allowed = PATCH_FIELDS[object.type];
  const next: Record<string, unknown> = { ...object };
  let touched = false;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!allowed.includes(key as keyof ObjectPatch)) return fail(`${id}: a ${object.type} has no "${key}" to edit`);
    if (value === null || value === '') {
      if (OPTIONAL_FIELDS.has(key)) delete next[key];
      else next[key] = value === null ? undefined : value;
    } else {
      next[key] = value;
    }
    touched = true;
  }
  if (!touched) return fail('edit changes nothing');
  const checked = checkObject(next);
  if (!checked.ok) return checked;
  if (checked.value.type === 'arrow') {
    for (const end of [checked.value.from, checked.value.to]) {
      const fault = isBoundEnd(end) ? bindingFault((other) => doc.objects[other], checked.value, end.object) : null;
      if (fault) return fail(`${id}: ${fault}`);
    }
  }
  return done(changes([[object, checked.value]]));
}

function planGroup(doc: CanvasDocument, groupId: ObjectId, ids: readonly ObjectId[], label: string | undefined, actor: Actor): Checked<CanvasEvent[]> {
  if (!isValidId(groupId)) return fail('the group needs a valid id');
  if (doc.objects[groupId]) return fail(`${groupId}: that id is already used`);
  const members = uniqueKnown(doc, ids).filter((id) => id !== groupId);
  if (members.length < 2) return fail('a group needs at least two objects');
  const group = checkObject({ id: groupId, type: 'group', by: { kind: actor.kind, id: actor.id }, z: keyBetween(topKey(doc), null), ...(label ? { label } : {}) });
  if (!group.ok) return group;
  const events: CanvasEvent[] = [{ type: 'object-added', object: group.value }];
  for (const id of members) push(events, doc.objects[id], { ...doc.objects[id], group: groupId });
  // A group all of whose members have just gone into the new one holds nothing: it goes, and so does a
  // group left holding only that one. (Arrows stuck to it get a free end, as when anything is deleted.)
  const moved = new Set(members);
  const left = new Map<ObjectId, number>();
  for (const object of Object.values(doc.objects)) {
    if (object.group && object.group !== groupId && !moved.has(object.id)) left.set(object.group, (left.get(object.group) ?? 0) + 1);
  }
  const emptied: ObjectId[] = [];
  for (const id of members) {
    let old = doc.objects[id].group;
    while (old && old !== groupId && doc.objects[old] && !emptied.includes(old) && !left.get(old) && !moved.has(old)) {
      emptied.push(old);
      const parent: ObjectId | undefined = doc.objects[old].group;
      if (parent) left.set(parent, (left.get(parent) ?? 1) - 1);
      old = parent;
    }
  }
  if (emptied.length) {
    const gone = new Set(emptied);
    for (const object of Object.values(doc.objects)) {
      if (object.type !== 'arrow') continue;
      const fromLost = isBoundEnd(object.from) && gone.has(object.from.object);
      const toLost = isBoundEnd(object.to) && gone.has(object.to.object);
      if (!fromLost && !toLost) continue;
      const geometry = resolveArrow(doc, object);
      if (geometry) push(events, object, { ...object, from: fromLost ? geometry.from : object.from, to: toLost ? geometry.to : object.to });
      else events.push({ type: 'object-removed', id: object.id });
    }
    for (const id of emptied) events.push({ type: 'object-removed', id });
  }
  return done(events);
}

function planUngroup(doc: CanvasDocument, ids: readonly ObjectId[]): Checked<CanvasEvent[]> {
  const groups = uniqueKnown(doc, ids).filter((id) => doc.objects[id].type === 'group');
  if (groups.length === 0) return fail('nothing to ungroup');
  const dissolved = new Set(groups);
  const events: CanvasEvent[] = [];
  for (const object of Object.values(doc.objects)) {
    if (!object.group || !dissolved.has(object.group) || dissolved.has(object.id)) continue;
    // A member moves up to the nearest group that stays.
    let parent = doc.objects[object.group]?.group;
    while (parent && dissolved.has(parent)) parent = doc.objects[parent]?.group;
    const { group: _old, ...rest } = object;
    push(events, object, (parent ? { ...rest, group: parent } : rest) as CanvasObject);
  }
  for (const id of groups) events.push({ type: 'object-removed', id });
  return done(events);
}

export function planCommand(doc: CanvasDocument, command: Command, actor: Actor): Checked<CanvasEvent[]> {
  switch (command.type) {
    case 'add':
      return planAdd(doc, command.objects, actor);

    case 'move': {
      if (!isNumber(command.dx) || !isNumber(command.dy)) return fail('move needs dx and dy');
      const ids = uniqueKnown(doc, command.ids ?? []);
      if (ids.length === 0) return fail('nothing to move');
      if (command.dx === 0 && command.dy === 0) return done([]);
      const events: CanvasEvent[] = [];
      for (const id of ids) {
        const object = doc.objects[id];
        let next: CanvasObject | null = null;
        if (isPlaced(object)) next = { ...object, x: object.x + command.dx, y: object.y + command.dy };
        else if (object.type === 'arrow' && (!isBoundEnd(object.from) || !isBoundEnd(object.to))) {
          next = { ...object, from: moveEnd(object.from, command.dx, command.dy), to: moveEnd(object.to, command.dx, command.dy) };
        }
        if (!next) continue;
        // A move is held to the same limits as everything else: what it makes must be an object a saved file may hold.
        const checked = checkObject(next);
        if (!checked.ok) return fail(`${id}: that would move it off the board`);
        push(events, object, next);
      }
      return done(events);
    }

    case 'resize': {
      const object = doc.objects[command.id];
      if (!object) return fail(`there is no object ${command.id}`);
      if (!isPlaced(object)) return fail(`${command.id}: a ${object.type} has no size of its own`);
      const r = command.rect;
      if (!r || !isNumber(r.x) || !isNumber(r.y) || !isNumber(r.w) || !isNumber(r.h)) return fail('resize needs a rectangle');
      const next = { ...object, x: r.x, y: r.y, w: Math.max(MIN_OBJECT_SIZE, r.w), h: Math.max(MIN_OBJECT_SIZE, r.h) };
      const checked = checkObject(next);
      if (!checked.ok) return checked;
      return done(changes([[object, checked.value]]));
    }

    case 'edit':
      return planEdit(doc, command.id, command.patch);

    case 'recolor': {
      const ids = uniqueKnown(doc, command.ids ?? []);
      if (ids.length === 0) return fail('nothing to recolour');
      const color = command.color === null ? null : parseColor(command.color);
      if (command.color !== null && !color) return fail('that is not a named colour or a CSS colour');
      return done(
        changes(
          ids.map((id) => {
            const { color: _old, ...rest } = doc.objects[id];
            return [doc.objects[id], (color ? { ...rest, color } : rest) as CanvasObject];
          }),
        ),
      );
    }

    case 'delete':
      return planDelete(doc, command.ids ?? []);

    case 'group':
      return planGroup(doc, command.id, command.ids ?? [], command.label, actor);

    case 'ungroup':
      return planUngroup(doc, command.ids ?? []);

    case 'reorder': {
      const wanted = new Set(uniqueKnown(doc, command.ids ?? []));
      if (wanted.size === 0) return fail('nothing to reorder');
      if (command.to !== 'front' && command.to !== 'back') return fail('reorder goes to "front" or "back"');
      // Each moved object gets a new key past the far end, keeping their own order among themselves. One
      // field of one object each: two people reordering different things at once both keep what they did.
      const moving = doc.order.filter((id) => wanted.has(id));
      const rest = doc.order.filter((id) => !wanted.has(id));
      const events: CanvasEvent[] = [];
      if (command.to === 'front') {
        let key = rest.length ? (doc.objects[rest[rest.length - 1]].z ?? null) : null;
        for (const id of moving) {
          key = keyBetween(key, null);
          push(events, doc.objects[id], { ...doc.objects[id], z: key });
        }
      } else {
        let key = rest.length ? (doc.objects[rest[0]].z ?? null) : null;
        for (const id of [...moving].reverse()) {
          key = keyBetween(null, key);
          push(events, doc.objects[id], { ...doc.objects[id], z: key });
        }
      }
      return done(events);
    }

    case 'retitle':
      if (typeof command.title !== 'string' || command.title.length > LIMITS.title) return fail('the title is missing or too long');
      return done([{ type: 'title-set', title: command.title }]);

    case 'add-snapshot': {
      const checked = checkSnapshotInput(command.snapshot);
      if (!checked.ok) return checked;
      const input = checked.value;
      if (doc.snapshots[input.id]) return fail(`${input.id}: that snapshot id is already used`);
      if (Object.keys(doc.snapshots).length >= LIMITS.snapshots) return fail(`a canvas holds at most ${LIMITS.snapshots} snapshots`);
      const capture = captureOf(doc, input.source);
      if (!capture) return fail(`${input.id}: there is nothing there to capture`);
      return done([{ type: 'snapshot-put', snapshot: { ...input, capture } }]);
    }

    case 'edit-snapshot': {
      const before = doc.snapshots[command.id];
      if (!before) return fail(`there is no snapshot ${command.id}`);
      const checked = checkSnapshotInput({ id: before.id, title: command.title ?? before.title, source: command.source ?? before.source });
      if (!checked.ok) return checked;
      let capture = before.capture;
      if (command.source) {
        const taken = captureOf(doc, checked.value.source);
        if (!taken) return fail(`${command.id}: there is nothing there to capture`);
        capture = taken;
      }
      if (checked.value.title === before.title && capture === before.capture) return done([]);
      return done([{ type: 'snapshot-put', snapshot: { ...checked.value, capture } }]);
    }

    case 'update-snapshot': {
      const before = doc.snapshots[command.id];
      if (!before) return fail(`there is no snapshot ${command.id}`);
      const capture = captureOf(doc, before.source);
      // What it showed is gone from the canvas: the capture is all that is left of it, so it is kept.
      if (!capture) return fail(`${command.id}: what it showed is no longer on the canvas`);
      if (capturesEqual(capture, before.capture)) return done([]);
      return done([{ type: 'snapshot-put', snapshot: { ...before, capture } }]);
    }

    case 'remove-snapshot':
      if (!doc.snapshots[command.id]) return fail(`there is no snapshot ${command.id}`);
      return done([{ type: 'snapshot-removed', id: command.id }]);

    default:
      return fail(`unknown command ${JSON.stringify((command as { type?: unknown }).type)}`);
  }
}
