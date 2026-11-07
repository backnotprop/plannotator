// The marks a change puts on a drawing: which parts and lines it adds, changes
// or removes, the number each changed part carries, and its line counts. The
// layout reads them for the model it lays out (a changed model is its own
// object, so its layouts are kept apart from the plain drawing's).
import type { SystemModel } from '../format/types.ts';

/** What a change did to a part or a line. */
export type ChangeIs = 'added' | 'changed' | 'removed';

export type ChangeMarks = {
  /** Part id to its mark: what the change did, its number in the change (1 up), and its line counts ("frame.ts · +532"). */
  parts: Record<string, { is: ChangeIs; n: number; lines: string | null }>;
  /** Line id to what the change did to it. */
  flows: Record<string, ChangeIs>;
  /** A flow or algorithm sheet's hop or step, by its layout id (`<sheet>.<hop>`): added or changed by the change. */
  hops: Record<string, 'added' | 'changed'>;
};

const MARKS = new WeakMap<SystemModel, ChangeMarks>();

/** The marks of a changed model, or null for a drawing with no change on it. */
export const marksOf = (model: SystemModel): ChangeMarks | null => MARKS.get(model) ?? null;

/** Ties marks to a changed model (called once, when the model is made). */
export function setMarks(model: SystemModel, marks: ChangeMarks): void {
  MARKS.set(model, marks);
}
