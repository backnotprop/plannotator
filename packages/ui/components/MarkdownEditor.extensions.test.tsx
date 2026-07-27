/**
 * Shim seam test: the ui MarkdownEditor wrapper forwards `extensions` all the
 * way into the mounted CodeMirror 6 editor.
 *
 * The probe is facet-based (EditorView.editorAttributes) so a passing test
 * proves the extension was applied by the ENGINE, not merely accepted by a
 * prop type: the attribute can only appear on the editor DOM if the engine's
 * EditorState.create() received the extension. Mounting goes through the SHIM
 * (components/MarkdownEditor.tsx), so this pins the whole seam end-to-end:
 * shim → @plannotator/markdown-editor → @plannotator/atomic-editor.
 *
 * Requires DOM_TESTS=1 (happy-dom preload). Run:
 *   DOM_TESTS=1 bun test MarkdownEditor.extensions
 */
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

// Module-level constant: the engine captures `extensions` once per
// `documentId`, so stable references are the documented calling convention.
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

      // The editorAttributes facet writes onto the editor's outer DOM element —
      // reachable only if the engine composed our extension into its state.
      const probed = host.querySelector('[data-extensions-probe="reached-engine"]');
      expect(probed).not.toBeNull();
      expect(probed?.classList.contains('cm-editor')).toBe(true);

      // Byte fidelity is unaffected by a decoration-only consumer extension.
      expect(handleRef.current?.getMarkdown()).toBe(SOURCE);

      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  );
});
