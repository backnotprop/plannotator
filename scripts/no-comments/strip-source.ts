import { sameCode } from './code-shape.ts';
import { planComments } from './plan.ts';
import type { KeepEntry } from './rules.ts';
import { stripSites } from './strip.ts';

export type StripResult =
  | { ok: true; text: string; removed: number; kept: number }
  | { ok: false; reason: string };

export function stripSource(path: string, text: string, keepList: KeepEntry[]): StripResult {
  const plan = planComments(path, text, keepList);
  if (plan.parseErrors > 0) return { ok: false, reason: 'does not parse cleanly, left as it is' };
  if (plan.remove.length === 0) return { ok: true, text, removed: 0, kept: plan.keep.length };
  const stripped = stripSites(text, plan.remove);
  const changed = sameCode(path, text, stripped);
  if (changed) return { ok: false, reason: `removing its comments would change the code (${changed}), left as it is` };
  const again = planComments(path, stripped, keepList);
  if (again.remove.length > 0) return { ok: false, reason: 'comments remained after one pass, left as it is' };
  return { ok: true, text: stripped, removed: plan.remove.length, kept: again.keep.length };
}
