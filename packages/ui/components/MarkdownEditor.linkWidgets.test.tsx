/**
 * Re-export surface test: hosts import linkWidgets / refreshLinkWidgets (and
 * their types) from @plannotator/ui's MarkdownEditor module — never from
 * @plannotator/atomic-editor directly (the engine is outside the consumer
 * import allowlist). Requires engine >=0.9.0.
 *
 * Runs without DOM: it pins identity and the type surface, not editor
 * behavior (the engine's own suite covers the link decorator).
 */
import { describe, test, expect } from 'bun:test';
import { WidgetType } from '@codemirror/view';
import {
  linkWidgets as engineLinkWidgets,
  refreshLinkWidgets as engineRefreshLinkWidgets,
} from '@plannotator/atomic-editor';
import {
  linkWidgets,
  refreshLinkWidgets,
  type LinkWidgetSpec,
  type LinkWidgetLink,
} from './MarkdownEditor';

class ChipWidget extends WidgetType {
  constructor(readonly url: string) {
    super();
  }
  eq(other: ChipWidget): boolean {
    return other.url === this.url;
  }
  toDOM(): HTMLElement {
    throw new Error('not rendered in this test');
  }
}

describe('MarkdownEditor module: linkWidgets re-export', () => {
  test('linkWidgets and refreshLinkWidgets are the engine exports, unchanged', () => {
    expect(typeof linkWidgets).toBe('function');
    expect(linkWidgets).toBe(engineLinkWidgets);
    expect(refreshLinkWidgets).toBe(engineRefreshLinkWidgets);
  });

  test('the spec and link types round-trip through the ui surface', () => {
    // Compile-time assertions: these fail typecheck (not just this test) if
    // the re-exported types drift from the engine's contracts.
    const link: LinkWidgetLink = { url: 'doc:01XYZ', text: 'Roadmap', title: 'Q3', from: 0, to: 22 };
    const spec: LinkWidgetSpec = {
      match: (l) => (l.url.startsWith('doc:') ? new ChipWidget(l.url) : null),
    };
    expect(spec.match(link)).toBeInstanceOf(ChipWidget);
    expect(spec.match({ ...link, url: 'https://example.com' })).toBeNull();
    expect(linkWidgets(spec)).toBeDefined();
    expect(refreshLinkWidgets.of(null).is(engineRefreshLinkWidgets)).toBe(true);
  });
});
