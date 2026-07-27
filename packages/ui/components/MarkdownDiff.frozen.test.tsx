/**
 * Mounted-surface tests for the ui MarkdownDiff shim: byte preservation,
 * the frozen (never-editable) contract, consumer extension composition, and
 * theme/host-class forwarding. Mounting goes through the SHIM
 * (components/MarkdownDiff.tsx), so these pin the whole seam end-to-end:
 * shim → @plannotator/markdown-editor MarkdownDiff → @plannotator/atomic-editor.
 *
 * Requires DOM_TESTS=1 (happy-dom preload). Run:
 *   DOM_TESTS=1 bun test MarkdownDiff.frozen
 */
import { describe, test, expect } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { EditorView } from '@codemirror/view';
import { MarkdownDiff, type MarkdownDiffHandle, type MarkdownDiffProps } from './MarkdownDiff';
import { wikiLinks } from './MarkdownEditor';
import { ThemeProvider } from './ThemeProvider';

const hasDom = typeof document !== 'undefined';

const OLDER = `# Release plan

The old paragraph that gets rewritten.

- unchanged bullet
- removed bullet
`;

const NEWER = `# Release plan

The new paragraph that replaced the old one.

- unchanged bullet
- added bullet with more words
`;

/* Byte-preservation fixtures deliberately include the shapes an editor is
   most tempted to normalize: CRLF line endings, trailing spaces, a missing
   final newline. The diff handle's contract is "the exact text supplied". */
const BYTE_FIXTURES: Record<string, { older: string; newer: string }> = {
  'lf-trailing-spaces': {
    older: `line one  \nline two\t\n\nend without newline`,
    newer: `line one  \nline TWO\t\n\nend without newline`,
  },
  'crlf-windows': {
    older: `# Title\r\n\r\nparagraph one\r\nparagraph two  \r\n`,
    newer: `# Title\r\n\r\nparagraph ONE\r\nparagraph two  \r\n`,
  },
  'mixed-endings': {
    older: `alpha\r\nbeta\ngamma  \r\n`,
    newer: `alpha\r\nBETA\ngamma  \r\n`,
  },
};

interface Mounted {
  host: HTMLElement;
  handleRef: { current: MarkdownDiffHandle | null };
  unmount: () => Promise<void>;
}

async function mountDiff(
  props: Partial<MarkdownDiffProps> & { defaultTheme?: 'dark' | 'light' },
): Promise<Mounted> {
  const { defaultTheme, ...diffProps } = props;
  const host = document.createElement('div');
  host.style.width = '600px';
  host.style.height = '400px';
  document.body.appendChild(host);
  const handleRef: { current: MarkdownDiffHandle | null } = { current: null };
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ThemeProvider defaultTheme={defaultTheme ?? 'dark'}>
        <MarkdownDiff
          originalMarkdown={OLDER}
          modifiedMarkdown={NEWER}
          documentId="diff-doc"
          editorHandleRef={handleRef}
          {...diffProps}
        />
      </ThemeProvider>,
    );
  });
  // Flush the engine's post-mount async work (change-count state, async
  // resolvers) inside act so assertions see the settled surface.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    host,
    handleRef,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

describe('MarkdownDiff shim: byte preservation', () => {
  for (const [name, { older, newer }] of Object.entries(BYTE_FIXTURES)) {
    test.skipIf(!hasDom)(
      `fixture ${name}: getMarkdown/getOriginalMarkdown are byte-identical to the inputs`,
      async () => {
        const mounted = await mountDiff({ originalMarkdown: older, modifiedMarkdown: newer });
        expect(mounted.handleRef.current?.getMarkdown()).toBe(newer);
        expect(mounted.handleRef.current?.getOriginalMarkdown()).toBe(older);
        await mounted.unmount();
      },
    );
  }
});

describe('MarkdownDiff shim: frozen surface', () => {
  test.skipIf(!hasDom)('the content DOM is contenteditable="false" and changes are navigable', async () => {
    const mounted = await mountDiff({});
    const handle = mounted.handleRef.current;
    expect(handle).not.toBeNull();

    // Frozen at the view boundary: CM6's content element must never be editable.
    const content = handle!.getContentDOM();
    expect(content).not.toBeNull();
    expect(content!.getAttribute('contenteditable')).toBe('false');

    // The comparison is real: changed regions exist and the review cursor moves.
    expect(handle!.getChangeCount()).toBeGreaterThan(0);
    // Navigation updates the toolbar's React state — keep it inside act.
    let moved = false;
    await act(async () => {
      moved = handle!.goToNextChange();
    });
    expect(moved).toBe(true);

    await mounted.unmount();
  });
});

describe('MarkdownDiff shim: extension composition', () => {
  // Module-level constants: the diff captures `extensions` once per mounted
  // comparison, so stable references are the documented calling convention.
  const WIKI_OLDER = `See [[roadmap]] for details.\n`;
  const WIKI_NEWER = `See [[roadmap]] for the updated details.\n`;
  const WIKI_EXTENSIONS = [
    wikiLinks({ resolve: async (target) => ({ target, label: 'Roadmap', status: 'resolved' }) }),
    EditorView.editorAttributes.of({ 'data-extensions-probe': 'reached-diff-engine' }),
  ];

  test.skipIf(!hasDom)(
    'wikiLinks from the ui surface composes into the frozen view',
    async () => {
      const mounted = await mountDiff({
        originalMarkdown: WIKI_OLDER,
        modifiedMarkdown: WIKI_NEWER,
        extensions: WIKI_EXTENSIONS,
      });

      // The facet probe proves the extension array reached the engine's
      // EditorState.create() through the shim and the packaged wrapper.
      const probed = mounted.host.querySelector('[data-extensions-probe="reached-diff-engine"]');
      expect(probed).not.toBeNull();

      // And the wiki-link decoration actually renders in the frozen document.
      const wikiEl = mounted.host.querySelector('.cm-atomic-wiki-link');
      expect(wikiEl).not.toBeNull();

      // Byte fidelity is unaffected by consumer extensions.
      expect(mounted.handleRef.current?.getMarkdown()).toBe(WIKI_NEWER);
      expect(mounted.handleRef.current?.getOriginalMarkdown()).toBe(WIKI_OLDER);

      await mounted.unmount();
    },
  );
});

describe('MarkdownDiff shim: theme and host-class forwarding', () => {
  test.skipIf(!hasDom)('ThemeProvider light mode reaches the themed wrapper', async () => {
    const mounted = await mountDiff({ defaultTheme: 'light' });
    const wrapper = mounted.host.querySelector('.pn-markdown-editor.pn-markdown-diff');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.getAttribute('data-theme')).toBe('light');
    await mounted.unmount();
  });

  test.skipIf(!hasDom)('an explicit mode prop overrides the provider (dark default)', async () => {
    const mounted = await mountDiff({ defaultTheme: 'dark', mode: 'light' });
    const wrapper = mounted.host.querySelector('.pn-markdown-editor.pn-markdown-diff');
    expect(wrapper!.getAttribute('data-theme')).toBe('light');
    await mounted.unmount();
  });

  test.skipIf(!hasDom)('dark mode leaves the wrapper unstamped (package default contract)', async () => {
    const mounted = await mountDiff({ defaultTheme: 'dark' });
    const wrapper = mounted.host.querySelector('.pn-markdown-editor.pn-markdown-diff');
    expect(wrapper!.getAttribute('data-theme')).toBeNull();
    await mounted.unmount();
  });

  test.skipIf(!hasDom)('className and gridEnabled forward to wrapper and card', async () => {
    const mounted = await mountDiff({ className: 'host-outer-probe', gridEnabled: true });
    const wrapper = mounted.host.querySelector('.pn-markdown-editor.pn-markdown-diff');
    expect(wrapper!.classList.contains('host-outer-probe')).toBe(true);

    // gridEnabled maps to the same design-system card chrome the editor uses.
    const card = mounted.host.querySelector('.pn-markdown-editor-card');
    expect(card).not.toBeNull();
    expect(card!.classList.contains('shadow-xl')).toBe(true);
    await mounted.unmount();
  });
});
