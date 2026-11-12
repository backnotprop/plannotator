import type { Mermaid, MermaidConfig } from 'mermaid';

export const MERMAID_LABEL_WRAP_WIDTH = 140;

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

let retryDelayMs = 750;

export function getMermaidRuntime(): Mermaid | null {
  return runtime;
}

export function getMermaidRuntimeSource(): MermaidRuntimeSource | null {
  return runtimeSource;
}

export function setMermaidRuntime(next: Mermaid, source: MermaidRuntimeSource = 'host'): void {
  runtime = next;
  runtimeSource = source;
  pending = null;
}

export function getMermaidRetryDelayMs(): number {
  return retryDelayMs;
}

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
