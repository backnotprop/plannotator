/**
 * Mermaid runtime slot.
 *
 * ONE code path feeds `MermaidBlock`: `loadMermaidRuntime()`. It resolves at
 * once from a filled slot and otherwise imports the runtime lazily: the
 * runtime is fetched on the first diagram, a failed import is dropped from
 * the memo so the next call issues a fresh `import()`, and the block
 * re-attempts once and offers Retry.
 *
 * Since Mermaid 12 (ELK layout by default, about 1.8 MB more runtime than 11)
 * the lazy path IS Plannotator's own path: `packages/editor/App.tsx` no longer
 * imports `./mermaid-eager`, so a plan with no diagram never downloads the
 * runtime in a chunked build (the share portal, any host that bundles by
 * route). The single-file builds inline the `import('mermaid')` target through
 * `inlineDynamicImports`, so there the lazy import resolves from the bundle
 * itself and nothing is fetched. A host that wants the runtime registered at
 * startup imports `./mermaid-eager`, which fills the slot at module
 * evaluation; the slot then short-circuits this loader.
 *
 * This module has NO static import of `mermaid`; the only place the
 * dependency is named at runtime is the default loader's `import('mermaid')`.
 */
import type { Mermaid, MermaidConfig } from 'mermaid';

/**
 * Hoisted verbatim from the former module-scope `mermaid.initialize(...)` in
 * MermaidBlock. Nothing in it reads a CSS token or the resolved mode.
 * `securityLevel: 'strict'` is a deliberate security pin (see MermaidBlock.test.ts).
 */
export const MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'dark',
  themeVariables: {
    primaryColor: '#3b82f6',
    primaryTextColor: '#f8fafc',
    primaryBorderColor: '#475569',
    lineColor: '#64748b',
    secondaryColor: '#1e293b',
    tertiaryColor: '#0f172a',
    background: '#1e293b',
    mainBkg: '#1e293b',
    nodeBorder: '#475569',
    clusterBkg: '#1e293b',
    clusterBorder: '#475569',
    titleColor: '#f8fafc',
    edgeLabelBackground: '#1e293b',
    /**
     * Mermaid 12's neo look shadows every node from a fixed
     * `drop-shadow(1px 2px 2px rgba(185,185,185,1))` grey, which reads as a
     * halo. The token-driven mapping replaces it per palette
     * (`buildMermaidShadow` in `./mermaidTheme`); this static config is what a
     * host with no theme tokens renders with, so it carries the same
     * toned-down 0.7 geometry with a fixed colour. The value is what
     * `buildMermaidShadow(#1e293b, 0.7)` returns for THIS config's own slate
     * ground, which is dark — hence a light shadow, exactly as Mermaid's own
     * `insertLookDefs` uses a white flood colour on dark themes.
     */
    dropShadow: 'drop-shadow(0.79px 1.58px 1.58px rgba(210, 212, 217, 0.684))',
  },
  flowchart: {
    htmlLabels: true,
    curve: 'basis',
  },
};

/**
 * Who filled the slot. The eager value doubles as a build marker: the literal
 * only reaches a bundle when `./mermaid-eager` is evaluated in it, which is
 * how `tests/entry-assets.test.ts` proves on the built HTML that Plannotator's
 * own bundles do NOT register the runtime eagerly.
 */
export type MermaidRuntimeSource = 'plannotator-mermaid-eager' | 'loader' | 'host';

export type MermaidRuntimeLoader = () => Promise<Mermaid>;

/** Default lazy loader: import the runtime and initialize it once. */
const defaultMermaidLoader: MermaidRuntimeLoader = () =>
  import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize(MERMAID_CONFIG);
    return mermaid;
  });

let runtime: Mermaid | null = null;
let runtimeSource: MermaidRuntimeSource | null = null;
let loader: MermaidRuntimeLoader = defaultMermaidLoader;
let pending: Promise<Mermaid> | null = null;

/**
 * Delay before the block's one automatic re-attempt after a failed lazy
 * import. Only chunked builds can fail here (the share portal, a host that
 * bundles by route); a single-file build resolves the import from itself and
 * a filled slot never loads.
 */
let retryDelayMs = 750;

/** Current runtime, or `null` while the slot is empty. */
export function getMermaidRuntime(): Mermaid | null {
  return runtime;
}

/** How the current runtime was registered, or `null` while the slot is empty. */
export function getMermaidRuntimeSource(): MermaidRuntimeSource | null {
  return runtimeSource;
}

/** Register an already-initialized runtime (what `./mermaid-eager` does). */
export function setMermaidRuntime(next: Mermaid, source: MermaidRuntimeSource = 'host'): void {
  runtime = next;
  runtimeSource = source;
  pending = null;
}

/** The block's retry delay for the lazy path. */
export function getMermaidRetryDelayMs(): number {
  return retryDelayMs;
}

/**
 * Resolve the runtime: at once from a filled slot, otherwise through the
 * loader. A rejected load is dropped from the memo so the next call (the
 * block's automatic re-attempt, a later mount, or the Retry button) issues a
 * fresh `import()` instead of replaying the cached rejection.
 */
export function loadMermaidRuntime(): Promise<Mermaid> {
  if (runtime) return Promise.resolve(runtime);
  if (!pending) {
    const attempt = loader().then(
      (loaded) => {
        setMermaidRuntime(loaded, 'loader');
        return loaded;
      },
      (err: unknown) => {
        if (pending === attempt) pending = null;
        throw err;
      },
    );
    pending = attempt;
  }
  return pending;
}

/** Test hook: empty the slot, stand in for the lazy import, shorten the retry delay. */
export function __setMermaidRuntimeLoaderForTests(
  next: MermaidRuntimeLoader | undefined,
  options?: { retryDelayMs?: number },
): void {
  runtime = null;
  runtimeSource = null;
  pending = null;
  loader = next ?? defaultMermaidLoader;
  retryDelayMs = options?.retryDelayMs ?? 750;
}
