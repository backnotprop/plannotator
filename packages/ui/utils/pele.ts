import type { RenderOptions, RenderResult } from 'pele';

export const PELE_SOURCE_LIMIT = 100_000;
export const PELE_OUTPUT_LIMIT = 1_000_000;
export const PELE_MAX_EDGES = 5_000;

export type PeleRuntime = {
  render(source: string, options?: RenderOptions): RenderResult;
};

let runtimePromise: Promise<PeleRuntime> | undefined;

/** The alternative renderer stays off the default Mermaid import path. */
export function loadPeleRuntime(): Promise<PeleRuntime> {
  if (runtimePromise === undefined) {
    runtimePromise = import('pele').then((runtime) => ({ render: runtime.render }));
    void runtimePromise.catch(() => {
      runtimePromise = undefined;
    });
  }
  return runtimePromise;
}

/** Stable, document-unique SVG prefix, including accessibility title/description IDs. */
export function peleSvgId(renderId: string): string {
  return `plannotator-pele-${renderId.replace(/[^a-zA-Z0-9_-]/gu, '-')}`;
}

/** Theme Pele's own CSS variables from the existing app tokens. */
export function peleFontFamilies(): { sans: string; mono: string } {
  if (typeof document === 'undefined') return { sans: 'sans-serif', mono: 'monospace' };
  const style = getComputedStyle(document.documentElement);
  return {
    sans: style.getPropertyValue('--font-sans').trim() || 'sans-serif',
    mono: style.getPropertyValue('--font-mono').trim() || 'monospace',
  };
}

export function renderPeleSource(runtime: PeleRuntime, source: string, renderId: string): RenderResult {
  const { sans, mono } = peleFontFamilies();
  const measurer = peleCanvasMeasurer(sans, mono);
  return runtime.render(source, {
    idPrefix: peleSvgId(renderId),
    fontFamily: sans,
    fontFamilyMono: mono,
    ...(measurer === undefined ? {} : { measurer }),
    links: false,
    images: false,
    limit: PELE_SOURCE_LIMIT,
    outputLimit: PELE_OUTPUT_LIMIT,
    maxEdges: PELE_MAX_EDGES,
    responsive: false,
  });
}

function peleCanvasMeasurer(
  sans: string,
  mono: string,
): import('pele').TextMeasurer | undefined {
  if (typeof document === 'undefined') return undefined;
  const context = document.createElement('canvas').getContext('2d');
  if (context === null) return undefined;
  return {
    width(text, size, style) {
      const italic = (style & 2) !== 0 ? 'italic ' : '';
      const bold = (style & 1) !== 0 ? 'bold ' : '';
      const family = (style & 4) !== 0 ? mono : sans;
      context.font = `${italic}${bold}${size}px ${family}`;
      return context.measureText(text).width;
    },
  };
}

export function peleThemeStyle(): string {
  return [
    '--pele-bg:var(--background)',
    '--pele-fg:var(--foreground)',
    '--pele-muted:var(--muted-foreground)',
    '--pele-line:var(--foreground)',
    '--pele-surface:var(--card)',
    '--pele-surface-alt:var(--muted)',
    '--pele-border:var(--border)',
    '--pele-accent:var(--primary)',
    '--pele-font:var(--font-sans)',
    '--pele-font-mono:var(--font-mono)',
  ].join(';');
}
