/**
 * The glyph of a Plannotator built-in in the composers' "/" list (the owner on the `/side` PR, 2026-11-09: "maybe
 * there's an icon that can indicate it's kinda built in"; his pick of three: Plannotator's mark on every built-in):
 * `PlannotatorMark` (icons.tsx) in the theme's primary colour, in place of the cube a person's own skill has. It is
 * drawn in the cube's own frame (ui SkillReferenceMenu's SkillIcon: 16 px, `shrink-0`), so a row is the same size
 * whichever it wears. Decorative: the row's name and the word "Plannotator" at its right say what it is.
 */
import type { ReactNode } from 'react';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import { PlannotatorMark } from '../icons';

/** The mark for a built-in (root `plannotator`), or null for any other row (the list then draws its cube). */
export function builtinSkillIcon(item: SkillCatalogEntry): ReactNode {
  return item.root === 'plannotator' ? <PlannotatorMark className="w-4 h-4 shrink-0 text-primary" /> : null;
}
