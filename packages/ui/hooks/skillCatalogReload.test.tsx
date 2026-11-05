/**
 * A composer that is already open follows a catalog change at its source
 * (`reloadSkillCatalog`, the Inbox's Code review switch saved in another
 * window): a skill that is gone stops being painted, one that came is
 * painted, without the composer remounting.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SkillCatalogEntry } from '../utils/skillReferences';

const hasDom = typeof document !== 'undefined';
const hook = (hasDom ? await import('./useSkillReferenceAutocomplete') : {}) as typeof import('./useSkillReferenceAutocomplete');
const catalog = (hasDom ? await import('../utils/skillCatalog') : {}) as typeof import('../utils/skillCatalog');

const skill = (name: string): SkillCatalogEntry => ({ name, root: 'plannotator', description: name, humanOnly: false });

let root: Root | null = null;
let host: HTMLElement | null = null;
let painted: string[] = [];

function Composer({ text }: { text: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const result = hook.useSkillReferenceAutocomplete({ text, setText: () => {}, textareaRef: ref, enabled: true });
  painted = result.referenceTokens.map((token) => token.entry.name);
  return <textarea ref={ref} value={text} readOnly />;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  catalog.resetSkillCatalogTransport();
  catalog.resetSkillCatalogCache();
});

describe.if(hasDom)('reloadSkillCatalog', () => {
  test('an open composer reads the catalog again and repaints', async () => {
    let served = [skill('review-curate')];
    catalog.setSkillCatalogTransport(async () => served);
    catalog.resetSkillCatalogCache();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<Composer text="/review-curate please" />));
    await act(async () => {});
    expect(painted).toEqual(['review-curate']);

    served = [];
    await act(async () => catalog.reloadSkillCatalog());
    await act(async () => {});
    expect(painted).toEqual([]);

    served = [skill('review-curate')];
    await act(async () => catalog.reloadSkillCatalog());
    await act(async () => {});
    expect(painted).toEqual(['review-curate']);
  });
});
