/**
 * A tag's rename, delete and Undo across linked machines, the one path the sidebar's Tags and the Board's Tags dialog
 * both take. A tag is one name on every machine that holds it (threadTags.ts): this Inbox changes its own first (its
 * refusal stops the rest), then each linked machine that holds one of the name and takes tags from here. One asleep
 * holds the change and gets it when it is back; an older one keeps its own tag as it is.
 */
import { inboxInitiativeNameKey } from '@plannotator/core/inbox-types';
import { InboxApiError, InboxHeldError, inboxApi } from './api';
import { restoreInitiatives, type InitiativesRestored } from './board/initiativeUndo';
import { machineTakes, type MachinesModel } from './machines';
import { tagById, tagIdOn, tagNamed, type ListTag } from './threadTags';

export type TagChange = { op: 'rename'; name: string } | { op: 'delete' } | { op: 'restore' };

/** What a change left: a refusal to say (this Inbox's stops the rest; a linked machine's is the first one), or a write held for an asleep machine. */
export interface TagChanged {
  refused: unknown;
  held: InboxHeldError | null;
}

export interface TagsAcross {
  /** One tag per name across the linked machines (the list's `tags`), oldest first. */
  tags: readonly ListTag[];
  /** The refusal a rename to `name` meets: another tag already has that name on some machine. Null when it is free. */
  renameTaken: (tag: ListTag, name: string) => InboxApiError | null;
  change: (tag: ListTag, change: TagChange) => Promise<TagChanged>;
  /** Deleted tags back: this Inbox's copies through `restoreInitiatives` (its Undo's rules), then the linked machines'. */
  restore: (tags: readonly ListTag[]) => Promise<InitiativesRestored & TagChanged>;
  /** This Inbox's id for a tag one of its own cards goes in: its copy, made by name when only a linked machine holds one. */
  here: (id: string | null) => Promise<string | null>;
  /** What a linked machine's card is put in: that machine's id for the tag, else its name, which that machine makes. */
  there: (id: string | null, machine: string) => string | null | { name: string };
}

export function tagsAcross(tags: readonly ListTag[], machines: MachinesModel): TagsAcross {
  // Made here until the list reads them, so a retry puts the card in the same copy.
  const madeHere = new Map<string, string>();
  const change = async (tag: ListTag, change: TagChange): Promise<TagChanged> => {
    let refused: unknown = null;
    let held: InboxHeldError | null = null;
    const own = tagIdOn(tag, null, machines.self);
    if (own) {
      try {
        await inboxApi.changeInitiative(own, change);
      } catch (cause) {
        return { refused: cause, held };
      }
    }
    for (const [machine, id] of Object.entries(tag.machines ?? {})) {
      if (machine === machines.self || !machineTakes({ machine }, machines, 'tags')) continue;
      try {
        await inboxApi.changeInitiative(id, change, machine);
      } catch (cause) {
        if (cause instanceof InboxHeldError) held = cause;
        // A delete that finds it already gone there has nothing left to do.
        else if (!(change.op === 'delete' && cause instanceof InboxApiError && cause.code === 'initiative_not_found')) refused ??= cause;
      }
    }
    return { refused, held };
  };
  return {
    tags,
    renameTaken: (tag, name) => {
      const taken = tagNamed(tags, name);
      return taken && taken.id !== tag.id ? new InboxApiError(409, 'initiative_exists', `There is already a tag named ${taken.name}.`) : null;
    },
    change,
    restore: async (deleted) => {
      const own = deleted.flatMap((tag) => {
        const id = tagIdOn(tag, null, machines.self);
        return id ? [{ ...tag, id }] : [];
      });
      const here = own.length > 0 ? await restoreInitiatives(own) : { restored: [], left: [], line: null };
      const back = new Set(here.restored.map((i) => i.id));
      const left = new Set(here.left.map((i) => i.id));
      let refused: unknown = null;
      let held: InboxHeldError | null = null;
      const restored: ListTag[] = [];
      for (const tag of deleted) {
        // A failed save here keeps it for the next Undo, which tries the linked machines then.
        if (left.has(tag.id)) continue;
        const far = { ...tag, machines: Object.fromEntries(Object.entries(tag.machines ?? {}).filter(([machine]) => machine !== machines.self)) };
        const done = await change(far, { op: 'restore' });
        refused ??= done.refused;
        held ??= done.held;
        if (back.has(tag.id) || (!tagIdOn(tag, null, machines.self) && !done.refused)) restored.push(tag);
      }
      return { restored, left: here.left, line: here.line, refused, held };
    },
    here: async (id) => {
      const tag = id ? tagById(tags, id) : null;
      if (!tag) return id;
      const key = inboxInitiativeNameKey(tag.name);
      const own = tagIdOn(tag, null, machines.self) ?? madeHere.get(key);
      if (own) return own;
      let made: string;
      try {
        made = (await inboxApi.createInitiative(tag.name)).initiative.id;
      } catch (cause) {
        // Made here since the list was read: that copy.
        if (!(cause instanceof InboxApiError && cause.code === 'initiative_exists')) throw cause;
        const { initiatives } = await inboxApi.cards();
        const there = (initiatives ?? []).find((i) => i.deleted_at === null && inboxInitiativeNameKey(i.name) === key);
        if (!there) throw cause;
        made = there.id;
      }
      madeHere.set(key, made);
      return made;
    },
    there: (id, machine) => {
      const tag = id ? tagById(tags, id) : null;
      if (!tag) return id;
      return tagIdOn(tag, machine, machines.self) ?? { name: tag.name };
    },
  };
}
