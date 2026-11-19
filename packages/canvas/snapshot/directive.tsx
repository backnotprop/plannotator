/**
 * The adapter between a plan's block renderer and the snapshot figure.
 *
 * `@plannotator/ui` has a seam for directive containers
 * (`configurePlannotatorUI({ directiveRenderer })`): a host gives it a
 * function, and a `:::kind` block the function answers for is drawn by the
 * host instead of as a callout. This file makes that function. It takes the
 * block structurally, so this package does not depend on the UI package and
 * the UI package does not depend on this one: only a host that wants
 * canvases in its plans joins the two.
 *
 * Returning `undefined` hands the block back: a `:::canvas-snapshot` this
 * version cannot read is drawn as the callout it would have been.
 */
import React from 'react';
import { CANVAS_SNAPSHOT_DIRECTIVE, parseSnapshotBlock } from './block';
import type { CanvasRegistry } from './registry';
import { SnapshotFigure, type SnapshotOpenRequest } from './SnapshotFigure';

export interface DirectiveBlockLike {
  id: string;
  directiveKind?: string;
  content: string;
}

export interface SnapshotDirectiveOptions {
  /** Absent: figures read the registry from React context. */
  registry?: CanvasRegistry;
  onOpen?: (request: SnapshotOpenRequest) => void;
  resolveImageSrc?: (src: string) => string;
}

export function createSnapshotDirectiveRenderer(options: SnapshotDirectiveOptions = {}) {
  return function renderSnapshotDirective(block: DirectiveBlockLike): React.ReactNode | undefined {
    if ((block.directiveKind ?? '').toLowerCase() !== CANVAS_SNAPSHOT_DIRECTIVE) return undefined;
    const ref = parseSnapshotBlock(block.content);
    if (!ref) return undefined;
    return (
      <SnapshotFigure
        canvas={ref.canvas}
        snapshot={ref.snapshot}
        title={ref.title}
        fallback={ref.fallback}
        registry={options.registry}
        onOpen={options.onOpen}
        resolveImageSrc={options.resolveImageSrc}
      />
    );
  };
}
