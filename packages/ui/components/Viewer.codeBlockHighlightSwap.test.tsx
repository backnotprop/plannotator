import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { AnnotationType, type Annotation, type Block } from '../types';
import {
  __resetCodeHighlightCacheForTests,
  __setCodeHighlightModuleForTests,
} from '../utils/codeHighlight';
import { syncHistoryHighlight } from '../utils/undoHistory';

const hasDom = typeof document !== 'undefined';

// Viewer pulls in @plannotator/web-highlighter, whose UMD bundle reads `window` at module-eval
// time.
const viewerMod = hasDom ? await import('./Viewer') : null;
const Viewer = viewerMod?.Viewer as typeof import('./Viewer')['Viewer'];
type ViewerHandle = import('./Viewer').ViewerHandle;
const themeMod = hasDom ? await import('./ThemeProvider') : null;
const ThemeProvider = themeMod?.ThemeProvider as typeof import('./ThemeProvider')['ThemeProvider'];
const useTheme = themeMod?.useTheme as typeof import('./ThemeProvider')['useTheme'];

const CODE = 'const archived = true;';
const codeBlocks: Block[] = [
  { id: 'code-1', type: 'code', content: CODE, language: 'typescript', order: 0, startLine: 1 },
];

const TOKEN_COLOR: Record<string, string> = {
  'github-dark': '#79c0ff',
  'github-light': '#0550ae',
  'kanagawa-wave': '#7e9cd8',
};

/**
 * `attach` decides when a (lang, theme) pair becomes available: `'immediate'` resolves on the
 * microtask queue, `'gated'` hands back a release function so a test can hold the async swap
 * open.
 */
function fakePierre(attach: 'immediate' | 'gated'): {
  mod: typeof import('@pierre/diffs');
  release: () => void;
} {
  const pending: Array<() => void> = [];
  const mod = {
    getSharedHighlighter: () =>
      attach === 'immediate'
        ? Promise.resolve(undefined)
        : new Promise((resolve) => pending.push(() => resolve(undefined))),
    getHighlighterIfLoaded: () => ({
      codeToTokens: (code: string, { theme }: { theme: string }) => ({
        tokens: code
          .split('\n')
          .map((line) => [{ content: line, color: TOKEN_COLOR[theme] ?? '#ffffff' }]),
      }),
    }),
  };
  return {
    mod: mod as unknown as typeof import('@pierre/diffs'),
    release: () => {
      const waiting = pending.splice(0);
      waiting.forEach((resolve) => resolve());
    },
  };
}

function codeBlockAnnotation(id: string, type: AnnotationType): Annotation {
  return {
    id,
    blockId: 'code-1',
    startOffset: 0,
    endOffset: CODE.length,
    type,
    originalText: CODE,
    createdA: Date.now(),
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let keySeq = 0;

interface Controls {
  setColorTheme: (theme: string) => void;
  viewer: ViewerHandle | null;
  removeAnnotation: (id: string) => void;
  repaintAnnotation: (id: string) => void;
}
const controls: Controls = {
  setColorTheme: () => {},
  viewer: null,
  removeAnnotation: () => {},
  repaintAnnotation: () => {},
};

const Harness: React.FC<{ initial: Annotation[] }> = ({ initial }) => {
  const [annotations, setAnnotations] = React.useState<Annotation[]>(initial);
  const theme = useTheme();
  const viewerRef = React.useRef<ViewerHandle>(null);
  React.useEffect(() => {
    controls.setColorTheme = theme.setColorTheme;
    controls.viewer = viewerRef.current;
    controls.removeAnnotation = (id: string) => {
      viewerRef.current?.removeHighlight(id);
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
    };
    controls.repaintAnnotation = (id: string) => {
      const annotation = annotations.find((candidate) => candidate.id === id);
      if (!annotation) return;
      syncHistoryHighlight(viewerRef.current, annotation, true);
    };
  });
  return (
    <Viewer
      ref={viewerRef}
      blocks={codeBlocks}
      markdown={`\`\`\`typescript\n${CODE}\n\`\`\``}
      annotations={annotations}
      onAddAnnotation={(annotation) => setAnnotations((prev) => [...prev, annotation])}
      onSelectAnnotation={() => {}}
      selectedAnnotationId={null}
      mode="redline"
      inputMethod="pinpoint"
      taterMode={false}
      disableCodePathValidation
    />
  );
};

async function mountHarness(initial: Annotation[] = []): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      // A fresh storage key per mount: ThemeProvider persists the palette, and
      // a leftover cookie would otherwise decide the starting theme.
      <ThemeProvider
        defaultTheme="dark"
        defaultColorTheme="github"
        colorThemeStorageKey={`plannotator-color-theme-swap-test-${++keySeq}`}
        storageKey={`plannotator-theme-swap-test-${keySeq}`}
      >
        <Harness initial={initial} />
      </ThemeProvider>,
    );
  });
}

/** Let queued microtasks (the highlighter attach + its swap) run. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function codeEl(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-block-id="code-1"] code');
  if (!el) throw new Error('fenced code block did not render');
  return el;
}

function tokenColors(): string[] {
  return Array.from(codeEl().querySelectorAll<HTMLElement>('span[style]')).map(
    (span) => span.getAttribute('style') ?? '',
  );
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
  controls.viewer = null;
  controls.setColorTheme = () => {};
  controls.removeAnnotation = () => {};
  controls.repaintAnnotation = () => {};
  if (hasDom) document.body.innerHTML = '';
  __resetCodeHighlightCacheForTests();
});

describe('code-block annotations across highlight swaps', () => {
  test.skipIf(!hasDom)('a palette change re-themes the tokens and keeps the mark', async () => {
    const { mod } = fakePierre('immediate');
    __setCodeHighlightModuleForTests(mod);

    await mountHarness();
    await flush();

    expect(tokenColors().join(' ')).toContain(TOKEN_COLOR['github-dark']);

    const block = document.querySelector<HTMLElement>('[data-block-id="code-1"]')!;
    await act(async () => {
      block.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      block.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const mark = codeEl().querySelector<HTMLElement>('mark[data-bind-id]');
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe(CODE);

    await act(async () => {
      controls.setColorTheme('kanagawa-wave');
    });
    await flush();

    const after = codeEl();
    const survivor = after.querySelector<HTMLElement>('mark[data-bind-id]');
    expect(survivor).not.toBeNull();
    expect(survivor!.textContent).toBe(CODE);
    expect(after.textContent).toBe(CODE);
    const styles = tokenColors().join(' ');
    expect(styles).toContain(TOKEN_COLOR['kanagawa-wave']);
    expect(styles).not.toContain(TOKEN_COLOR['github-dark']);
  });

  test.skipIf(!hasDom)('a history repaint survives the next palette change', async () => {
    const { mod } = fakePierre('immediate');
    __setCodeHighlightModuleForTests(mod);

    await mountHarness();
    await flush();

    const block = document.querySelector<HTMLElement>('[data-block-id="code-1"]');
    if (!block) throw new Error('fenced code block did not render');
    await act(async () => {
      block.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      block.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const annotationId = codeEl()
      .querySelector<HTMLElement>('mark[data-bind-id]')
      ?.getAttribute('data-bind-id');
    if (!annotationId) throw new Error('fenced code block was not annotated');

    await act(async () => {
      controls.repaintAnnotation(annotationId);
    });
    expect(codeEl().querySelector(`[data-bind-id="${annotationId}"]`)).not.toBeNull();

    await act(async () => {
      controls.setColorTheme('kanagawa-wave');
    });
    await flush();

    expect(codeEl().querySelector(`[data-bind-id="${annotationId}"]`)).not.toBeNull();
    expect(tokenColors().join(' ')).toContain(TOKEN_COLOR['kanagawa-wave']);
  });

  test.skipIf(!hasDom)(
    'an async swap that lands after a share/draft restore does not wipe it',
    async () => {
      const { mod, release } = fakePierre('gated');
      __setCodeHighlightModuleForTests(mod);

      const restored: Annotation = {
        id: 'codeblock-restored',
        blockId: 'code-1',
        startOffset: 0,
        endOffset: CODE.length,
        type: AnnotationType.DELETION,
        originalText: CODE,
        createdA: Date.now(),
      };

      await mountHarness([restored]);
      await flush();

      expect(tokenColors()).toEqual([]);
      expect(codeEl().querySelector('mark[data-bind-id]')).toBeNull();

      await act(async () => {
        controls.viewer?.applySharedAnnotations([restored]);
      });
      expect(codeEl().querySelector(`[data-bind-id="${restored.id}"]`)).not.toBeNull();

      await act(async () => {
        release();
      });
      await flush();

      const after = codeEl();
      expect(after.querySelector(`[data-bind-id="${restored.id}"]`)).not.toBeNull();
      expect(after.textContent).toBe(CODE);
      expect(tokenColors().join(' ')).toContain(TOKEN_COLOR['github-dark']);
    },
  );

  test.skipIf(!hasDom)('removal is honoured even though it re-highlights the block', async () => {
    const { mod } = fakePierre('immediate');
    __setCodeHighlightModuleForTests(mod);

    const older = codeBlockAnnotation('codeblock-older', AnnotationType.COMMENT);
    const newer = codeBlockAnnotation('codeblock-newer', AnnotationType.DELETION);
    await mountHarness([older, newer]);
    await flush();

    expect(codeEl().querySelector('mark[data-bind-id]')?.getAttribute('data-bind-id'))
      .toBe(newer.id);

    await act(async () => {
      controls.removeAnnotation(newer.id);
    });
    await flush();

    const after = codeEl();
    expect(after.querySelector(`[data-bind-id="${newer.id}"]`)).toBeNull();
    expect(after.querySelector(`[data-bind-id="${older.id}"]`)).not.toBeNull();
    expect(after.textContent).toBe(CODE);

    await act(async () => {
      controls.setColorTheme('kanagawa-wave');
    });
    await flush();
    expect(codeEl().querySelector(`[data-bind-id="${newer.id}"]`)).toBeNull();
    expect(codeEl().querySelector(`[data-bind-id="${older.id}"]`)).not.toBeNull();
    expect(tokenColors().join(' ')).toContain(TOKEN_COLOR['kanagawa-wave']);
  });
});
