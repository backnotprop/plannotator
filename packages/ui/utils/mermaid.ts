import type { Mermaid, MermaidConfig } from 'mermaid';

export const MERMAID_LABEL_WRAP_WIDTH = 140;

/** Hoisted verbatim from the former module-scope `mermaid.initialize(...)` in MermaidBlock. */
export const MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
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
    dropShadow: 'drop-shadow(0.79px 1.58px 1.58px rgba(210, 212, 217, 0.684))',
  },
  flowchart: {
    htmlLabels: true,
    curve: 'basis',
    wrappingWidth: MERMAID_LABEL_WRAP_WIDTH,
  },
  state: {
    wrappingWidth: MERMAID_LABEL_WRAP_WIDTH,
  },
};

/** Who filled the slot. */
export type MermaidRuntimeSource = 'plannotator-mermaid-eager' | 'loader' | 'host';

export type MermaidRuntimeLoader = () => Promise<Mermaid>;

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
 * Only chunked builds can fail here (the share portal, a host that bundles by route); a
 * single-file build resolves the import from itself and a filled slot never loads.
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

export function getMermaidRetryDelayMs(): number {
  return retryDelayMs;
}

/** Resolve the runtime: at once from a filled slot, otherwise through the loader. */
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
