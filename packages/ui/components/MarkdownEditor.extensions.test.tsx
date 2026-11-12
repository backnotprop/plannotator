import { describe, test, expect } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { EditorView } from '@codemirror/view';
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor';
import { ThemeProvider } from './ThemeProvider';

const hasDom = typeof document !== 'undefined';

const SOURCE = `# Extension probe

Body text stays byte-identical with consumer extensions installed.
`;

const PROBE_EXTENSIONS = [
  EditorView.editorAttributes.of({ 'data-extensions-probe': 'reached-engine' }),
];

describe('MarkdownEditor shim: extensions passthrough', () => {
  test.skipIf(!hasDom)(
    'a facet-based probe extension reaches the editor DOM through the shim',
    async () => {
      const host = document.createElement('div');
      host.style.width = '600px';
      host.style.height = '400px';
      document.body.appendChild(host);
      const handleRef: { current: MarkdownEditorHandle | null } = { current: null };
      const root = createRoot(host);
      await act(async () => {
        root.render(
          <ThemeProvider>
            <MarkdownEditor
              markdown={SOURCE}
              documentId="extensions-probe-doc"
              editorHandleRef={handleRef}
              extensions={PROBE_EXTENSIONS}
            />
          </ThemeProvider>,
        );
      });

      const probed = host.querySelector('[data-extensions-probe="reached-engine"]');
      expect(probed).not.toBeNull();
      expect(probed?.classList.contains('cm-editor')).toBe(true);

      expect(handleRef.current?.getMarkdown()).toBe(SOURCE);

      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  );
});
