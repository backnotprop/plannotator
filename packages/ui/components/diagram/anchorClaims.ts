import { createContext } from 'react';

/**
 * Who shows a diagram comment that names no diagram block of the document.
 *
 * A comment composed in a block carries that block's `blockId`. One that
 * arrives through `POST /api/external-annotations` carries `blockId:
 * "external"`, and one whose fence was deleted carries an id that no longer
 * exists; neither says which diagram it belongs to, but its anchor does.
 * Every diagram block tries such a comment against its own render and
 * reports the verdict here; the FIRST block in document order whose finder
 * resolves it shows it, and when every block has answered and none did, it
 * is unanchored (listed in the rail with the chip, never silently dropped).
 * A block that has not answered yet keeps the verdict pending, so nothing is
 * called unanchored while a diagram is still rendering.
 */
export class DiagramAnchorClaims {
  private readonly reports = new Map<string, Map<string, boolean>>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  /** The diagram blocks of the document, in document order. */
  constructor(readonly blockIds: readonly string[]) {}

  /** A block's verdicts for the unowned comments it tried. Verdicts for ids
   * it no longer tries are kept: a block stops trying a comment once another
   * block owns it, and that must not read as "could not resolve". */
  report(blockId: string, results: ReadonlyMap<string, boolean>): void {
    let mine = this.reports.get(blockId);
    let changed = false;
    if (mine === undefined) {
      mine = new Map();
      this.reports.set(blockId, mine);
      changed = true;
    }
    for (const [id, resolved] of results) {
      if (mine.get(id) !== resolved) {
        mine.set(id, resolved);
        changed = true;
      }
    }
    if (!changed) return;
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  /** The block that shows the comment; `null` when every block answered and
   * none resolved it (unanchored); `undefined` while an earlier block has
   * not answered yet. */
  owner(annotationId: string): string | null | undefined {
    for (const blockId of this.blockIds) {
      const verdict = this.reports.get(blockId)?.get(annotationId);
      if (verdict === undefined) return undefined;
      if (verdict) return blockId;
    }
    return null;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getVersion = (): number => this.version;
}

/** Provided by `Viewer` with the document's diagram block ids; a diagram
 * block rendered on its own makes a one-block coordinator for itself. */
export const DiagramAnchorClaimsContext = createContext<DiagramAnchorClaims | null>(null);
