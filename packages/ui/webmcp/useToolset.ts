/**
 * Handlers read through refs, so a re-render never touches `registerTool`; only `deps` (surface
 * membership inputs) rebuild the tool list, and the registry reconciles by name so an unchanged
 * descriptor merely swaps its handler in place.
 */
import { useEffect, useMemo, useRef } from 'react';
import { resolveModelContext, type ModelContextLike } from './modelContext';
import { getWebMcpPolicy } from './policy';
import { getRegistryFor, type ToolSpec, type ToolsetHooks } from './toolset';

export interface UseToolsetOptions {
  id: string;
  active?: boolean;
  build: () => ToolSpec<never, unknown>[];
  deps: ReadonlyArray<unknown>;
  hooks: ToolsetHooks;
  context?: ModelContextLike | null;
}

export interface UseToolsetResult {
  available: boolean;
  registered: boolean;
}

export function useToolset(options: UseToolsetOptions): UseToolsetResult {
  const { id, active = true, build, deps, hooks, context } = options;
  // One detection per mount; the entry point is created with the document
  // and never appears later.
  const ctx = useMemo(() => (context === undefined ? resolveModelContext() : context), [context]);
  const enabled = !!ctx && getWebMcpPolicy().enabled && active;

  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;
  const stableHooks = useMemo<ToolsetHooks>(() => ({
    buildNudges: (info) => hooksRef.current.buildNudges(info),
    afterResponse: (response) => hooksRef.current.afterResponse?.(response),
  }), []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tools = useMemo(() => (enabled ? build() : null), [enabled, ...deps]);

  // Two effects on purpose: a rebuilt tool list reconciles IN PLACE (the registry swaps handlers
  // for unchanged descriptors and only aborts names that disappeared), while unmount and `active:
  // false` are the only paths that detach the whole set.
  const detachRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!ctx || !enabled || !tools) return;
    const registry = getRegistryFor(ctx, { prefix: () => getWebMcpPolicy().namePrefix });
    detachRef.current = registry.attach(id, tools, stableHooks);
  }, [ctx, enabled, tools, id, stableHooks]);
  useEffect(() => {
    if (!ctx || !enabled) return;
    return () => {
      detachRef.current?.();
      detachRef.current = null;
    };
  }, [ctx, enabled, id]);

  return { available: !!ctx, registered: enabled && !!tools };
}
