import { createContext } from 'react';

export class DiagramAnchorClaims {
  private readonly reports = new Map<string, Map<string, boolean>>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(readonly blockIds: readonly string[]) {}

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

export const DiagramAnchorClaimsContext = createContext<DiagramAnchorClaims | null>(null);
