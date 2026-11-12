import type { SystemModel } from '../format/types.ts';

export type ChangeIs = 'added' | 'changed' | 'removed';

export type ChangeMarks = {
  parts: Record<string, { is: ChangeIs; n: number; lines: string | null; who?: string[] }>;
  flows: Record<string, ChangeIs>;
  hops: Record<string, 'added' | 'changed'>;
};

const MARKS = new WeakMap<SystemModel, ChangeMarks>();

export const marksOf = (model: SystemModel): ChangeMarks | null => MARKS.get(model) ?? null;

export function setMarks(model: SystemModel, marks: ChangeMarks): void {
  MARKS.set(model, marks);
}
