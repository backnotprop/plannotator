/**
 * Outside a ThemeProvider the code fences follow the PAGE's light or dark,
 * not a fixed dark (utils/pageColorMode.ts); inside one, the provider's mode.
 *
 * What regresses if these fail: a host page that is light and mounts no
 * ThemeProvider draws its fences in the dark palette (`#fafafa` text on a
 * light block); a page that switches its `light` class never re-colours its
 * fences; a mounted Viewer keeps a fence in the colours it was first
 * highlighted with after the page turns dark (no re-highlight without a new
 * render from the host); or a page's own signals override a mounted provider.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ThemeProvider } from '../components/ThemeProvider';
import { FENCE_COLOR_FIXES, FENCE_SYNTAX_THEME } from '../utils/fenceSyntaxThemes';
import { useFenceTheme } from './useFenceTheme';
import { parseMarkdownToBlocks } from '../utils/parser';

const viewerMod = typeof document !== 'undefined' ? await import('../components/Viewer') : null;

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let seen: string[] = [];

function Probe() {
  seen.push(useFenceTheme());
  return null;
}

function mount(element: React.ReactElement): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(element));
}

const html = () => document.documentElement;
const saved = hasDom
  ? { className: html().className, style: html().getAttribute('style'), body: document.body.getAttribute('style'), theme: html().getAttribute('data-theme'), colorMode: html().getAttribute('data-color-mode') }
  : null;

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  seen = [];
  if (!hasDom || !saved) return;
  document.body.innerHTML = '';
  html().className = saved.className;
  if (saved.style === null) html().removeAttribute('style');
  else html().setAttribute('style', saved.style);
  if (saved.body === null) document.body.removeAttribute('style');
  else document.body.setAttribute('style', saved.body);
  for (const [name, value] of [['data-theme', saved.theme], ['data-color-mode', saved.colorMode]] as const) {
    if (value === null) html().removeAttribute(name);
    else html().setAttribute(name, value);
  }
});

const last = () => seen[seen.length - 1];

/** Change the page, then let its MutationObserver records arrive (they are delivered after the change). */
async function page(change: () => void): Promise<void> {
  await act(async () => {
    change();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe.if(hasDom)('fences outside a ThemeProvider follow the page', () => {
  test('a page that says nothing is a white page: light code colours', () => {
    mount(<Probe />);
    expect(last()).toBe(FENCE_SYNTAX_THEME.light);
  });

  test('<html class="light"> is light; a theme class without it is theme.css\'s dark half; a dark class is dark', async () => {
    html().classList.add('light');
    mount(<Probe />);
    expect(last()).toBe(FENCE_SYNTAX_THEME.light);
    await page(() => {
      html().classList.remove('light');
      html().classList.add('theme-plannotator');
    });
    expect(last()).toBe(FENCE_SYNTAX_THEME.dark);
    await page(() => {
      html().classList.remove('theme-plannotator');
      html().classList.add('dark');
    });
    expect(last()).toBe(FENCE_SYNTAX_THEME.dark);
  });

  test('a host that switches its theme with data-theme or data-color-mode on <html> is followed live', async () => {
    html().setAttribute('data-theme', 'dark');
    mount(<Probe />);
    expect(last()).toBe(FENCE_SYNTAX_THEME.dark);
    await page(() => html().setAttribute('data-theme', 'light'));
    expect(last()).toBe(FENCE_SYNTAX_THEME.light);
    await page(() => {
      html().removeAttribute('data-theme');
      html().setAttribute('data-color-mode', 'dark');
    });
    expect(last()).toBe(FENCE_SYNTAX_THEME.dark);
    // A value that names no mode (GitHub's `auto`) says nothing: the white page is light.
    await page(() => html().setAttribute('data-color-mode', 'auto'));
    expect(last()).toBe(FENCE_SYNTAX_THEME.light);
  });

  test('color-scheme on <html> and the page\'s own background decide when there is no class', async () => {
    html().style.colorScheme = 'dark';
    mount(<Probe />);
    expect(last()).toBe(FENCE_SYNTAX_THEME.dark);
    await page(() => {
      html().style.colorScheme = '';
      document.body.style.backgroundColor = '#111318';
    });
    expect(last()).toBe(FENCE_SYNTAX_THEME.dark);
    await page(() => {
      document.body.style.backgroundColor = '#fbfbf8';
    });
    expect(last()).toBe(FENCE_SYNTAX_THEME.light);
  });
});

/** The colours of a fence's tokens, as drawn. */
const fenceColours = (): string[] =>
  Array.from(document.querySelectorAll<HTMLElement>('pre code span[style]'), (el) => el.getAttribute('style') ?? '').sort();

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  if (!check()) throw new Error(`timed out waiting for ${what}`);
}

describe.if(hasDom)('a mounted Viewer re-colours its fences when the page changes mode', () => {
  test('rendered once by the host, its fence turns from the light palette to the dark one', async () => {
    const Viewer = viewerMod!.Viewer;
    const markdown = '```ts\n// a comment\nconst answer: number = 42;\nexport { answer };\n```';
    html().classList.add('theme-plannotator', 'light');
    // The host renders once and never again: only the Viewer's own subscriptions can re-colour it.
    mount(
      <Viewer blocks={parseMarkdownToBlocks(markdown)} markdown={markdown} annotations={[]} onAddAnnotation={() => {}} onSelectAnnotation={() => {}} selectedAnnotationId={null} mode="comment" inputMethod="drag" taterMode={false} stickyActions={false} disableCodePathValidation />,
    );
    await until(() => fenceColours().length > 2, 'the light highlight');
    const light = fenceColours();
    await page(() => html().classList.remove('light'));
    await until(() => fenceColours().join() !== light.join() && fenceColours().length > 2, 'the dark highlight');
    const dark = fenceColours();
    expect(dark).not.toEqual(light);
    // The comment in each half's fixed colour (Pierre's own #737373 reads under 4.5:1 on both).
    expect(light).toContain(`color:${FENCE_COLOR_FIXES.light['#737373']!.toUpperCase()}`);
    expect(dark).toContain(`color:${FENCE_COLOR_FIXES.dark['#737373']!.toUpperCase()}`);
    expect([...light, ...dark]).not.toContain('color:#737373');
    expect(document.querySelector('pre code')?.textContent).toContain('const answer: number = 42;');
    // And back: the same colours as the first light highlight (recomputed, not lost).
    await page(() => html().classList.add('light'));
    await until(() => fenceColours().join() === light.join(), 'the light highlight again');
  });
});

describe.if(hasDom)('inside a ThemeProvider the provider decides', () => {
  test('a dark provider draws dark code even on a page whose <body> is painted light', () => {
    document.body.style.backgroundColor = '#ffffff';
    mount(
      <ThemeProvider defaultTheme="dark">
        <Probe />
      </ThemeProvider>,
    );
    expect(last()).toBe(FENCE_SYNTAX_THEME.dark);
  });
});
