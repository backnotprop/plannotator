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
  const ctx = useMemo(() => (context === undefined ? resolveModelContext() : context), [context]);
  const enabled = !!ctx && getWebMcpPolicy().enabled && active;

  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;
  const stableHooks = useMemo<ToolsetHooks>(() => ({
    buildNudges: (info) => hooksRef.current.buildNudges(info),
    afterResponse: (response) => hooksRef.current.afterResponse?.(response),
  }), []);

  const tools = useMemo(() => (enabled ? build() : null), [enabled, ...deps]);

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
