import type React from 'react';
import type { Block } from '../../types';

/**
 * Host seam: draw a directive container (`:::kind` … `:::`) the host owns.
 *
 * Default: none, so every directive that is not a question renders as the
 * callout it always has. A host registers one renderer at startup
 * (`configurePlannotatorUI({ directiveRenderer })`); it is asked for each
 * non-question directive block and answers with a node, or with `undefined`
 * (or `null`) to leave the block to the callout. Question directives are
 * never offered: their cards are the document's own.
 *
 * The node is drawn inside the block's own element, which keeps
 * `data-block-id` and the source-line label, so the block stays one
 * annotatable block and exports its lines as before.
 */
export type DirectiveRenderer = (block: Block) => React.ReactNode | undefined;

let directiveRenderer: DirectiveRenderer | null = null;

export function setDirectiveRenderer(renderer: DirectiveRenderer | null): void {
  directiveRenderer = renderer;
}

export function resetDirectiveRenderer(): void {
  directiveRenderer = null;
}

/** The host's node for this block, or `null` when the callout should draw it. */
export function renderHostDirective(block: Block): React.ReactNode | null {
  if (!directiveRenderer) return null;
  return directiveRenderer(block) ?? null;
}
