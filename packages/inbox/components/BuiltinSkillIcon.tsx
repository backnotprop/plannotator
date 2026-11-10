/**
 * The glyph of a Plannotator built-in in the composers' "/" list (the owner on the `/side` PR, 2026-11-09: "maybe
 * there's an icon that can indicate it's kinda built in"): each built-in wears the mark the Inbox already uses for
 * what it does, in the theme's primary colour, in place of the cube a person's own skill has.
 *
 * - `side`: the Side button's two bubbles (ui AnnotationToolbar; Lucide's messages-square, ISC);
 * - `shape`: Shape's Pebble at rest (ui `PEBBLE_REST`, the mark on the thread's header);
 * - the review skills (`review-…`): the guided review's mark (`reviews`, as on a review's card).
 *
 * Every glyph is drawn in the cube's own frame (ui SkillReferenceMenu's SkillIcon: 16 px, a 24 box, stroke 1.7,
 * round caps and joins), so a row is the same size whichever it wears. Decorative: the row's name says what it is.
 * A built-in with no glyph here keeps the cube (tinted by the list).
 */
import type { ReactNode } from 'react';
import { PEBBLE_REST } from '@plannotator/ui/components/shape/Pebble';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import { iconPath } from '../icons';

/** The two bubbles, as the selection bar's Side draws them. */
const SIDE_PATHS = [
  'M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z',
  'M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1',
];

function pathsOf(name: string): readonly string[] | null {
  if (name === 'side') return SIDE_PATHS;
  if (name === 'shape') return [PEBBLE_REST];
  if (name.startsWith('review-')) return [iconPath('reviews')];
  return null;
}

/** The built-in's own glyph, or null for any other row (the list then draws its cube). */
export function builtinSkillIcon(item: SkillCatalogEntry): ReactNode {
  const paths = item.root === 'plannotator' ? pathsOf(item.name) : null;
  if (!paths) return null;
  return (
    <svg className="w-4 h-4 shrink-0 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-builtin-skill-icon={item.name}>
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
