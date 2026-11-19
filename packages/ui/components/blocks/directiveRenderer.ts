import React from 'react';
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
 *
 * The renderer is called while the block renders: it returns an element and
 * must not call hooks itself (put them in a component it returns). A
 * renderer that throws, or whose element throws while rendering, does not
 * take the document down: the block falls back to the callout.
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
  try {
    return directiveRenderer(block) ?? null;
  } catch {
    return null;
  }
}

/**
 * Draws a host's node, and the block's ordinary rendering instead if that
 * node throws while it renders or later updates.
 */
export class HostDirectiveBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): React.ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
