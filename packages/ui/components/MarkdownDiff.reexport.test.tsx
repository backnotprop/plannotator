/**
 * Re-export surface test: hosts import MarkdownDiff (and its handle/prop
 * types) from @plannotator/ui's MarkdownDiff module — never from
 * @plannotator/markdown-editor's MarkdownDiff or @plannotator/atomic-editor's
 * AtomicDiffEditor directly (both are outside the consumer import allowlist).
 *
 * Runs without DOM: it pins availability and the type surface, not diff
 * behavior (the mounted surface is covered by MarkdownDiff.frozen.test.tsx).
 */
import { describe, test, expect } from 'bun:test';
import { EditorView } from '@codemirror/view';
import { MarkdownDiff, type MarkdownDiffHandle, type MarkdownDiffProps } from './MarkdownDiff';
import { wikiLinks } from './MarkdownEditor';

describe('MarkdownDiff module: public re-export surface', () => {
  test('MarkdownDiff is exported as a renderable component', () => {
    expect(typeof MarkdownDiff).toBe('function');
  });

  test('the handle type round-trips through the ui surface', () => {
    // Compile-time assertion: fails typecheck (not just this test) if the
    // re-exported handle drifts from the engine's navigation/byte contract.
    const handle: MarkdownDiffHandle = {
      goToNextChange: () => true,
      goToPreviousChange: () => false,
      getMarkdown: () => 'newer',
      getOriginalMarkdown: () => 'older',
      getChangeCount: () => 1,
      getContentDOM: () => null,
    };
    expect(handle.getMarkdown()).toBe('newer');
    expect(handle.getOriginalMarkdown()).toBe('older');
  });

  test('the props type round-trips, including the extensions seam', () => {
    // Compile-time assertions: the shim keeps the packaged prop surface
    // (minus mode/cardClassName, which the shim owns) and adds gridEnabled.
    // wikiLinks comes from the ui MarkdownEditor surface and must be
    // assignable to the diff's extensions seam so consumer extensions compose.
    const props: MarkdownDiffProps = {
      originalMarkdown: 'older\n',
      modifiedMarkdown: 'newer\n',
      documentId: 'doc-1',
      ariaLabel: 'Document changes',
      showToolbar: true,
      showOverview: true,
      gutter: true,
      allowInlineDiffs: true,
      highlightChanges: true,
      syntaxHighlightDeletions: true,
      gridEnabled: true,
      mode: 'light',
      maxWidth: 720,
      className: 'host-outer',
      onLinkClick: () => {},
      extensions: [
        wikiLinks({ suggest: async () => [], resolve: async () => null }),
        EditorView.editorAttributes.of({ 'data-host-probe': 'ok' }),
      ],
    };
    expect(props.modifiedMarkdown).toBe('newer\n');
  });
});
