/**
 * Re-export surface test: hosts import MarkdownDiff (and its handle/prop types) from
 * @plannotator/ui's MarkdownDiff module — never from AtomicDiffEditor directly (both are outside
 * the consumer import allowlist).
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
