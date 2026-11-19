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
import {
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

const PATCH_FIELDS: Readonly<Record<CanvasObject['type'], readonly (keyof ObjectPatch)[]>> = {
  box: ['text', 'detail', 'link', 'style', 'shape'],
  note: ['text', 'link', 'style', 'shape'],
  text: ['text', 'size', 'link', 'style', 'shape'],
  frame: ['title', 'link', 'style', 'shape'],
  image: ['src', 'alt', 'link', 'style', 'shape'],
  sprite: ['src', 'alt', 'frames', 'fps', 'link', 'style', 'shape'],
  html: ['html', 'link', 'style', 'shape'],
  reference: ['target', 'title', 'description', 'site', 'image', 'icon', 'link', 'style', 'shape'],
  arrow: ['from', 'to', 'label', 'link', 'style', 'routing'],
  group: ['label', 'link'],
};

/** Fields an edit removes when given `null` or an empty string. */
const OPTIONAL_FIELDS = new Set(['link', 'detail', 'label', 'description', 'site', 'image', 'icon', 'style', 'shape', 'routing']);

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
  for (const raw of objects) {
    const checked = checkObject(raw);
    if (!checked.ok) return checked;
    const object = checked.value;
    if (doc.objects[object.id] || incoming.has(object.id)) return fail(`${object.id}: that id is already used`);
    // Who added it is who is adding it, whatever the object says.
    incoming.set(object.id, { ...object, by: actor.kind });
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
  const group = checkObject({ id: groupId, type: 'group', by: actor.kind, ...(label ? { label } : {}) });
  if (!group.ok) return group;
  const events: CanvasEvent[] = [{ type: 'object-added', object: group.value }];
  for (const id of members) push(events, doc.objects[id], { ...doc.objects[id], group: groupId });
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
      // Keep the moved objects in their own relative order.
      const moving = doc.order.filter((id) => wanted.has(id));
      const last = doc.order.length - 1;
      return done(
        command.to === 'front'
          ? moving.map((id) => ({ type: 'object-ordered', id, at: last }))
          : [...moving].reverse().map((id) => ({ type: 'object-ordered', id, at: 0 })),
      );
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
