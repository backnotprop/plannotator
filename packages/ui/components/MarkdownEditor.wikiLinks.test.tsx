/**
 * Re-export surface test: hosts import wikiLinks (and its types) from
 * @plannotator/ui's MarkdownEditor module — never from @plannotator/atomic-editor
 * directly (the engine is outside the consumer import allowlist).
 *
 * Runs without DOM: it pins identity and the type surface, not editor behavior
 * (the extensions seam itself is covered by MarkdownEditor.extensions.test.tsx).
 */
import { describe, test, expect } from 'bun:test';
import {
  wikiLinks as engineWikiLinks,
  slashCommands as engineSlashCommands,
  selectionToolbar as engineSelectionToolbar,
} from '@plannotator/atomic-editor';
import {
  wikiLinks,
  slashCommands,
  selectionToolbar,
  defaultSlashCommands,
  type WikiLinksConfig,
  type WikiLinkSuggestion,
  type WikiLinkResolvedTarget,
  type WikiLinkStatus,
  type SlashCommandItem,
  type SlashCommandsConfig,
  type SelectionToolbarConfig,
} from './MarkdownEditor';

describe('MarkdownEditor module: wikiLinks re-export', () => {
  test('wikiLinks is the engine implementation, re-exported unchanged', () => {
    expect(typeof wikiLinks).toBe('function');
    expect(wikiLinks).toBe(engineWikiLinks);
  });

  test('the config types round-trip through the ui surface', () => {
    // Compile-time assertions: these fail typecheck (not just this test) if
    // the re-exported types drift from the engine's contracts.
    const suggestion: WikiLinkSuggestion = { target: 'doc_01XYZ', label: 'Roadmap' };
    const resolved: WikiLinkResolvedTarget = {
      target: 'doc_01XYZ',
      label: 'Roadmap',
      status: 'resolved',
    };
    const status: WikiLinkStatus = 'missing';
    const config: WikiLinksConfig = {
      suggest: async () => [suggestion],
      resolve: async () => resolved,
      onOpen: () => {},
      openOnClick: true,
      maxSuggestions: 10,
      // Engine ≥0.7.0: labeled links opt into resolved titles. This line is
      // the seam assertion — it fails typecheck if the flag ever drops out of
      // the ui re-export of WikiLinksConfig.
      preferResolvedLabel: true,
    };
    const extension = wikiLinks(config);
    expect(extension).toBeDefined();
    expect(status).toBe('missing');
  });

  test('slashCommands and selectionToolbar are the engine implementations', () => {
    expect(slashCommands).toBe(engineSlashCommands);
    expect(selectionToolbar).toBe(engineSelectionToolbar);
    expect(Array.isArray(defaultSlashCommands)).toBe(true);
    expect(defaultSlashCommands.length).toBeGreaterThan(0);
  });

  test('slash and toolbar config types round-trip through the ui surface', () => {
    const item: SlashCommandItem = {
      label: 'Callout',
      snippet: '> ${}',
      icon: '<svg viewBox="0 0 16 16"></svg>',
    };
    const slashConfig: SlashCommandsConfig = { items: [item], replaceDefaults: false };
    const toolbarConfig: SelectionToolbarConfig = { buttons: ['bold', 'italic', 'link'] };
    expect(slashCommands(slashConfig)).toBeDefined();
    expect(selectionToolbar(toolbarConfig)).toBeDefined();
  });
});
