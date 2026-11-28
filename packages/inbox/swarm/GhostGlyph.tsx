import type { CSSProperties } from 'react';
import glanceFull from '../assets/ghost/ghost-glance.svg';
import glanceSmall from '../assets/ghost/ghost-glance-small.svg';

/**
 * The ghost thread's mark, "Glancing" (option B, the owner's pick of 2026-11-24): an upright ghost, two pill eyes set
 * to one side, a small flick at the hem (assets/ghost/). The small cut is for 16 to 20 px (the thread's Ghost button,
 * the status view's foot), drawn on a 16 px grid with its eyes larger and further apart; the full cut for 22 px and up
 * (the ghost pane's header, its empty state). Drawn as a mask over `currentColor`, so it takes the colour of the words
 * around it (muted at rest, the accent when pressed or in the pane). Both drawings are 24 × 24 and the box is square,
 * the mask `contain` and centred (swarm.css `.ib-ghost-g`), so the ghost is never stretched.
 */
export function GhostGlyph({ size, className }: { size: number; className?: string }) {
  const src = size <= 20 ? glanceSmall : glanceFull;
  const style = { width: size, height: size, '--ib-ghost-src': `url("${src}")` } as CSSProperties;
  return <span className={`ib-ghost-g${className ? ` ${className}` : ''}`} data-ghost-cut={size <= 20 ? 'small' : 'full'} style={style} aria-hidden="true" />;
}
