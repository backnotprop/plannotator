import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeGuideData, GuideOverviewDiagram } from '@plannotator/core/guide';
import { FIXTURE_V2_OVERVIEW, FIXTURE_V1_LOCAL } from '@plannotator/core/guide-format-fixtures';
import type { DiffFile } from './types';
import { GuideHostProvider, type GuideHostValue } from './host';
import { GuideView } from './GuideView';
import { GuideViewer } from './GuideViewer';
import { renderInlineMarkdown } from './renderInlineMarkdown';

const hasDom = typeof document !== 'undefined';

function FakeDiffRenderer(props: Record<string, unknown>) {
  const files = props.files as DiffFile[];
  return <div data-testid="file-code-view" data-file={files[0]?.path} />;
}

function makeFile(path: string): DiffFile {
  return { path, patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`, additions: 1, deletions: 1, status: 'modified' };
}

const GUIDE: CodeGuideData = {
  title: 'Webhook backoff',
  intent: 'Retries back off.',
  overview: {
    text: 'Delivery asks [`computeBackoff`](symbol:computeBackoff) for a budget ([the call](code:src/deliver.ts#L2)). Tests are in [chapter 3](chapter:3); [a file outside](code:docs/notes.md).',
    diagram: { kind: 'mermaid', source: 'flowchart LR\n  a --> b\n  click a "code:src/deliver.ts"' },
  },
  sections: [
    { title: 'Retry budget', overview: 'Read with [the tests](chapter:3).', diffs: [{ file: 'src/deliver.ts', summary: 'Asks for a budget.' }] },
    { title: 'Backoff curve', overview: 'The curve.', diffs: [{ file: 'src/backoff.ts', summary: 'The curve.' }] },
    { title: 'Prose only', overview: 'Context.', diffs: [] },
  ],
  reviewed: [false, false, false],
};

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  if (!hasDom) return;
  if (typeof globalThis.IntersectionObserver === 'undefined') {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

async function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

function hostValue(extra: Partial<GuideHostValue<Record<string, unknown>>> = {}): GuideHostValue<Record<string, unknown>> {
  return {
    files: [makeFile('src/deliver.ts'), makeFile('src/backoff.ts')],
    DiffRenderer: FakeDiffRenderer as unknown as GuideHostValue<Record<string, unknown>>['DiffRenderer'],
    getDiffRendererProps: () => ({}),
    ...extra,
  };
}

function View({ guide, value, onFocus }: { guide: CodeGuideData; value: GuideHostValue<Record<string, unknown>>; onFocus?: (p: string) => void }) {
  const [focused, setFocused] = React.useState<string | null>(null);
  return (
    <GuideHostProvider value={value}>
      <GuideView
        guide={guide}
        reviewed={guide.reviewed}
        onToggleReviewed={() => {}}
        focusedFile={focused}
        onFocusFile={(p) => {
          setFocused(p);
          onFocus?.(p);
        }}
      />
    </GuideHostProvider>
  );
}

const overviewEl = () => host!.querySelector('[data-guide-overview]') as HTMLElement | null;
const linkButtons = () => [...overviewEl()!.querySelectorAll('button[data-guide-link]')].map((b) => b.getAttribute('data-guide-link'));

describe('guide overview (format version 2)', () => {
  test.skipIf(!hasDom)('a guide without an overview renders no overview section', async () => {
    const { overview: _o, ...plain } = GUIDE;
    await mount(<View guide={plain} value={hostValue()} />);
    expect(overviewEl()).toBeNull();
  });

  test.skipIf(!hasDom)('renders the prose above the chapters; only chapter and in-guide code links are actions', async () => {
    await mount(<View guide={GUIDE} value={hostValue()} />);
    const overview = overviewEl()!;
    expect(overview.textContent).toContain('Delivery asks computeBackoff for a budget (the call).');
    const firstChapter = host!.querySelector('[data-guide-section="0"]')!;
    expect(overview.compareDocumentPosition(firstChapter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(linkButtons()).toEqual(['code:src/deliver.ts#L2', 'chapter:3']);
    expect(overview.textContent).not.toContain('](');
    const plain = [...overview.querySelectorAll('span[data-guide-link]')].map((s) => s.getAttribute('data-guide-link'));
    expect(plain).toEqual(['symbol:computeBackoff', 'code:docs/notes.md']);
  });

  test.skipIf(!hasDom)('a code link reveals its file; a chapter link with files reveals its first file', async () => {
    const revealed: string[] = [];
    await mount(<View guide={GUIDE} value={hostValue({ onRevealFile: (p) => revealed.push(p) })} />);
    const click = async (href: string) => {
      const button = overviewEl()!.querySelector(`button[data-guide-link="${href}"]`) as HTMLButtonElement;
      await act(async () => button.click());
    };
    await click('code:src/deliver.ts#L2');
    expect(revealed).toEqual(['src/deliver.ts']);
    const scrolled: string[] = [];
    const proto = (globalThis as { HTMLElement: typeof HTMLElement }).HTMLElement.prototype as HTMLElement & { scrollIntoView: unknown };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.getAttribute('data-guide-section') ?? '?');
    } as typeof proto.scrollIntoView;
    try {
      await click('chapter:3');
    } finally {
      proto.scrollIntoView = original as typeof proto.scrollIntoView;
    }
    expect(scrolled).toEqual(['2']);
  });

  test.skipIf(!hasDom)('chapter links work in chapter overviews too', async () => {
    await mount(<View guide={GUIDE} value={hostValue()} />);
    const inChapter = host!.querySelector('[data-guide-section="0"] button[data-guide-link="chapter:3"]');
    expect(inChapter).not.toBeNull();
  });

  test.skipIf(!hasDom)('the host draws the diagram; without one, Mermaid shows as its source', async () => {
    const asked: GuideOverviewDiagram[] = [];
    await mount(
      <View
        guide={GUIDE}
        value={hostValue({ renderOverviewDiagram: (d) => { asked.push(d); return <div data-testid="drawn">drawn</div>; } })}
      />,
    );
    expect(asked).toEqual([GUIDE.overview!.diagram!]);
    expect(host!.querySelector('[data-guide-overview-diagram="mermaid"] [data-testid="drawn"]')).not.toBeNull();
    expect(host!.querySelector('[data-guide-overview-diagram] pre')).toBeNull();

    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    await mount(<View guide={GUIDE} value={hostValue()} />);
    const pre = host!.querySelector('[data-guide-overview-diagram="mermaid"] pre');
    expect(pre?.textContent).toBe(GUIDE.overview!.diagram!.source);
  });

  test.skipIf(!hasDom)('an HTML picture is never put in the page; the viewer says it does not draw it', async () => {
    const guide: CodeGuideData = {
      ...GUIDE,
      overview: { text: 'Picture.', diagram: { kind: 'html', source: '<svg data-agent="1"><script>window.__pwned = 1</script></svg>' } },
    };
    await mount(<View guide={guide} value={hostValue({ renderOverviewDiagram: (d) => (d.kind === 'mermaid' ? <div /> : null) })} />);
    const box = host!.querySelector('[data-guide-overview-diagram="html"]')!;
    expect(box.textContent).toContain('does not draw');
    expect(host!.querySelector('[data-agent]')).toBeNull();
    expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined();
  });

  test.skipIf(!hasDom)('GuideViewer carries a version-2 snapshot overview and passes the diagram renderer through', async () => {
    let drawn = 0;
    await mount(
      <GuideViewer
        snapshot={FIXTURE_V2_OVERVIEW}
        DiffRenderer={FakeDiffRenderer as never}
        getDiffRendererProps={() => ({})}
        renderOverviewDiagram={() => { drawn += 1; return <span data-testid="drawn" />; }}
      />,
    );
    expect(overviewEl()?.textContent).toContain('The guard in refresh runs first');
    expect(drawn).toBeGreaterThan(0);
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    await mount(<GuideViewer snapshot={FIXTURE_V1_LOCAL} DiffRenderer={FakeDiffRenderer as never} getDiffRendererProps={() => ({})} />);
    expect(overviewEl()).toBeNull();
  });
});

describe('renderInlineMarkdown guide links', () => {
  test('without a renderer a guide link is its label, never raw markdown', () => {
    const html = (nodes: React.ReactNode[]) => nodes.map((n) => (typeof n === 'string' ? n : 'node')).join('');
    expect(html(renderInlineMarkdown('see [x](code:a.ts) now'))).toBe('see node now');
  });

  test('a target with balanced parentheses reaches the renderer whole', () => {
    const seen: string[] = [];
    renderInlineMarkdown('open [page](code:app/(shop)/page.tsx#L3) now', { renderLink: (href) => { seen.push(href); return null; } });
    expect(seen).toEqual(['code:app/(shop)/page.tsx#L3']);
  });

  test('a renderer may decline a link (null) and it falls back to the label', () => {
    const nodes = renderInlineMarkdown('[a](chapter:1) [b](symbol:x)', { renderLink: (href, label, key) => (href === 'chapter:1' ? <b key={key}>{label}</b> : null) });
    const types = nodes.filter((n) => typeof n !== 'string').map((n) => (n as React.ReactElement).type);
    expect(types).toEqual(['b', 'span']);
  });
});
