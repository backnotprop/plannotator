/**
 * Where a figure finds its canvas. A plan names a canvas by id; the host
 * loads that canvas however it likes (a file, a server, memory) and puts its
 * store here. Every figure of one canvas then shares one store and one
 * spatial index: fifty snapshots of a canvas hold one copy of it.
 */
import React, { createContext, useContext, useSyncExternalStore } from 'react';
import type { CanvasStore } from '../events/store';

export class CanvasRegistry {
  private readonly stores = new Map<string, CanvasStore>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  get(canvasId: string): CanvasStore | undefined {
    return this.stores.get(canvasId);
  }

  /** Make a canvas available, or take it away with `undefined`. */
  set(canvasId: string, store: CanvasStore | undefined): void {
    if (this.stores.get(canvasId) === store) return;
    if (store) this.stores.set(canvasId, store);
    else this.stores.delete(canvasId);
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;
}

const RegistryContext = createContext<CanvasRegistry | null>(null);

export function CanvasRegistryProvider({ registry, children }: { registry: CanvasRegistry; children: React.ReactNode }) {
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

export const useCanvasRegistry = (): CanvasRegistry | null => useContext(RegistryContext);

const NO_SUBSCRIBE = () => () => {};
const ZERO = () => 0;

/** The store of one canvas, or undefined while it is not available. */
export function useRegisteredCanvas(canvasId: string, registry?: CanvasRegistry | null): CanvasStore | undefined {
  const fromContext = useContext(RegistryContext);
  const source = registry ?? fromContext;
  useSyncExternalStore(source ? source.subscribe : NO_SUBSCRIBE, source ? source.getVersion : ZERO, source ? source.getVersion : ZERO);
  return source?.get(canvasId);
}
