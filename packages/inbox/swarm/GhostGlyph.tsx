import type { CSSProperties } from 'react';
import hugFull from '../assets/ghost/ghost-HC-hug.svg';
import hugSmall from '../assets/ghost/ghost-HC-hug-small.svg';

/**
 * The ghost thread's mark, "Hug" without the smile (H-c; approval "inbox-swarm-thread-ui"): the owner's two drawings,
 * kept as they were approved (assets/ghost/). The small cut is for 16 to 20 px (the thread's Ghost button), the full
 * cut for 22 px and up (the ghost pane's header, its empty state). Drawn as a mask over `currentColor`, so it takes
 * the colour of the words around it (muted at rest, the accent when pressed or in the pane).
 */
export function GhostGlyph({ size, className }: { size: number; className?: string }) {
  const src = size <= 20 ? hugSmall : hugFull;
  const style = { width: size, height: size, '--ib-ghost-src': `url("${src}")` } as CSSProperties;
  return <span className={`ib-ghost-g${className ? ` ${className}` : ''}`} data-ghost-cut={size <= 20 ? 'small' : 'full'} style={style} aria-hidden="true" />;
}
