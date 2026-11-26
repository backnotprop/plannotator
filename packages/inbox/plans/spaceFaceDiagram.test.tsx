/**
 * A Mermaid plan's face and row thumbnail on the plans home, drawn by the engine that ships (Pele, for a flowchart),
 * leave the page as a picture in the window's own colours.
 *
 * What regresses if this fails: the still picture of a Pele drawing (`diagramStill.ts`) loses the colours Pele defines
 * on its own svg root (`--_s`, `--_l`, … and the theme's `--pele-*`), so every shape, line and word is drawn
 * `currentColor`, black inside an `<img>`.
 *
 * No stand-in Mermaid here (no `drawMermaidFencesWithMermaid()`): the shipped switch draws the fence.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PlanSummary } from '@plannotator/core/plans';

const hasDom = typeof document !== 'undefined';
const { SpaceFace, SpaceThumb, resetSpaceFacesForTests } = (hasDom ? await import('./SpaceFace') : {}) as typeof import('./SpaceFace');
const { ThemeProvider } = (hasDom ? await import('@plannotator/ui/components/ThemeProvider') : {}) as typeof import('@plannotator/ui/components/ThemeProvider');
const { setPeleInBuildForTests } = (hasDom ? await import('@plannotator/ui/test-setup/pele') : {}) as typeof import('@plannotator/ui/test-setup/pele');
const { readPeleThemeVariables } = (hasDom ? await import('@plannotator/ui/utils/peleTheme') : {}) as typeof import('@plannotator/ui/utils/peleTheme');
const { installInertDiagramSvgParser } = (hasDom ? await import('@plannotator/ui/test-setup/diagramSvg') : {}) as typeof import('@plannotator/ui/test-setup/diagramSvg');

const FLOW = 'flowchart LR\n  A[Detect agents] -->|found| B{Ask the person}\n  B --> C[Install]';

/** The window's palette, as a theme stylesheet puts it on the root. */
const TOKENS: Record<string, string> = {
  background: '#fbf7ef',
  foreground: '#2b2118',
  card: '#f3ead9',
  'card-foreground': '#2b2118',
  popover: '#fffaf2',
  border: '#c9b79a',
  muted: '#ece2cf',
  'muted-foreground': '#6d5a45',
  primary: '#b4532a',
  'primary-foreground': '#ffffff',
  secondary: '#3f7d6e',
  accent: '#d9a441',
};

const realFetch = globalThis.fetch;
const realImage = globalThis.Image;
/** Every address a picture was asked to load. */
let loaded: string[] = [];
let root: Root | null = null;
let n = 0;
let restoreParser = () => {};

beforeAll(() => {
  if (!hasDom) return;
  restoreParser = installInertDiagramSvgParser();
  setPeleInBuildForTests(true);
  for (const [name, value] of Object.entries(TOKENS)) document.documentElement.style.setProperty(`--${name}`, value);
  globalThis.fetch = (async () => Response.json({ text: FLOW, cut: false })) as unknown as typeof fetch;
  // A picture that decodes: the face keeps what it was asked to draw.
  (globalThis as { Image: unknown }).Image = class {
    decoding = '';
    naturalWidth = 120;
    naturalHeight = 60;
    set src(url: string) {
      loaded.push(url);
    }
    decode() {
      return Promise.resolve();
    }
  };
});

afterAll(() => {
  if (!hasDom) return;
  setPeleInBuildForTests(false);
  restoreParser();
  for (const name of Object.keys(TOKENS)) document.documentElement.style.removeProperty(`--${name}`);
  globalThis.fetch = realFetch;
  (globalThis as { Image: unknown }).Image = realImage;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  loaded = [];
  resetSpaceFacesForTests();
});

const planOf = (): PlanSummary => ({ id: `pln_face_${++n}`, name: 'Install flow', head_version_number: 1, primary_kind: 'mermaid' }) as unknown as PlanSummary;

async function drawn(node: React.ReactNode): Promise<Document> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<ThemeProvider defaultTheme="light">{node}</ThemeProvider>));
  for (let i = 0; i < 40 && !loaded.length; i++) await act(async () => await new Promise((r) => setTimeout(r, 5)));
  const url = loaded.find((u) => u.startsWith('data:image/svg+xml'));
  expect(url).toBeDefined();
  return new DOMParser().parseFromString(decodeURIComponent(url!.slice(url!.indexOf(',') + 1)), 'image/svg+xml');
}

/** The picture is Pele's flowchart, every part painted in the window's palette as the live page paints it. */
function expectPaletteColours(doc: Document) {
  const svg = doc.documentElement;
  expect(svg.getAttribute('class')).toContain('pele-flowchart');
  const pele = readPeleThemeVariables('light')!;
  expect(pele).not.toBeNull();
  const markup = new XMLSerializer().serializeToString(svg);
  expect(markup).not.toContain('var(');
  expect(markup).not.toContain('currentColor');
  const node = svg.querySelector('.pele-node rect, .pele-node path, .pele-node polygon')!;
  expect(node.getAttribute('fill')).toBe(pele['--pele-surface']);
  expect(node.getAttribute('stroke')).toBe(pele['--pele-border']);
  expect(svg.querySelector('.pele-edges')!.getAttribute('stroke')).toBe(pele['--pele-line']);
  expect(svg.getAttribute('fill')).toBe(pele['--pele-fg']);
  // The palette is the window's, not Pele's own built-in grey.
  expect(pele['--pele-surface']).not.toBe('#f3f3f3');
}

test('a Mermaid plan drawn by Pele: the face is a picture in the palette, not black shapes', async () => {
  if (!hasDom) return;
  const plan = planOf();
  expectPaletteColours(await drawn(<SpaceFace plan={plan} />));
});

test('a Mermaid plan drawn by Pele: the row thumbnail is the same picture in the palette', async () => {
  if (!hasDom) return;
  const plan = planOf();
  expectPaletteColours(await drawn(<SpaceThumb plan={plan} />));
});

// The neutral and doom-64 themes quote their font (`"Inter", …`): put in raw, the quote ended the svg's style
// attribute, the picture did not parse and the face was blank.
test('a Mermaid plan drawn by Pele in a theme whose font is quoted: the face is still a picture, in that font', async () => {
  if (!hasDom) return;
  const font = '"Inter", system-ui, sans-serif';
  document.documentElement.style.setProperty('--font-sans', font);
  try {
    const doc = await drawn(<SpaceFace plan={planOf()} />);
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(doc.documentElement.getAttribute('class')).toContain('pele-flowchart');
    expect(new XMLSerializer().serializeToString(doc.documentElement)).not.toContain('var(');
    // The font survives, quotes and all: the root style sets it for every word in the drawing.
    expect(doc.documentElement.getAttribute('style') ?? '').toContain(`--pele-font: ${font};`);
  } finally {
    document.documentElement.style.removeProperty('--font-sans');
  }
});
