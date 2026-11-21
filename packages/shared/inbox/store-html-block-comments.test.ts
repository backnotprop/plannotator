/**
 * Comments on an element of a live html block in a message (the owner's pick
 * "A · In place", 2026-11-20), in the store. Failures this catches:
 * - the store refuses the element's description on such a comment (as it
 *   does on a comment on words), so the comment cannot be saved at all;
 * - it stores a malformed anchor, or keys of the anchor it does not know,
 *   which the window and the export would then read;
 * - what a block's page supplied about the element is kept without a size
 *   limit (the page is the agent's HTML: it could fill the store);
 * - a comment on words gains an element description through the same door.
 * Each test uses its own temp data dir.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INBOX_LIVE_ELEMENT_MAX } from '@plannotator/core/inbox-types';
import { InboxStore } from './store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ID = '0123456789abcdef0123456789abcdef';
const CHART = ['Signups by plan:', '', '```html', '<svg><rect id="pro-3"/></svg>', '```'].join('\n');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'plannotator-inbox-html-block-comments-'));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: 'site', root: '/work/site' });
  const claude = { kind: 'agent' as const, host: 'claude-code', session: 'ses_claude', name: 'Claude Code' };
  const message = store.sendMessage({ project_id: project.id, author: claude, body: CHART, idempotency_key: 'm1' }).message;
  return { store, message };
}

const pin = (extra: Record<string, unknown> = {}) => ({
  id: 'html-ann-abc-1',
  blockId: 'block-1',
  startOffset: 0,
  endOffset: 0,
  type: 'COMMENT',
  text: 'Label this dip.',
  originalText: 'Pro, W3',
  createdA: 1,
  htmlBlockAnchor: { v: 1, index: 1, id: ID, sourceLine: [3, 5] },
  htmlAnchor: { selector: '#pro-3', tagName: 'rect', text: '' },
  elementContext: { tag: 'rect', outline: '<rect id="pro-3">', path: 'svg > rect' },
  ...extra,
});

describe('a comment on an element of a live html block', () => {
  test('is kept on its message with its anchor, its element and its description, and survives a reopen of the store', () => {
    const { store, message } = setup();
    const record = store.saveMessageAnnotation(message.id, pin());
    expect(record.message_id).toBe(message.id);
    expect(record.annotation.htmlBlockAnchor).toEqual({ v: 1, index: 1, id: ID, sourceLine: [3, 5] });
    expect(record.annotation.htmlAnchor).toEqual({ selector: '#pro-3', tagName: 'rect', text: '' });
    expect(record.annotation.elementContext).toEqual({ tag: 'rect', outline: '<rect id="pro-3">', path: 'svg > rect' });
    expect(record.annotation.text).toBe('Label this dip.');
    expect(record.sent_reply_id).toBeNull();
  });

  test('the anchor is stored as parsed: keys it does not know are dropped', () => {
    const { store, message } = setup();
    const record = store.saveMessageAnnotation(message.id, pin({ htmlBlockAnchor: { v: 1, index: 1, id: ID, sourceLine: [3, 5], text: 'from the page' } }));
    expect(record.annotation.htmlBlockAnchor).toEqual({ v: 1, index: 1, id: ID, sourceLine: [3, 5] });
  });

  test('a malformed anchor is refused', () => {
    const { store, message } = setup();
    for (const bad of [null, {}, { v: 1, index: 0, id: ID, sourceLine: null }, { v: 1, index: 1, id: 'nope', sourceLine: null }]) {
      expect(() => store.saveMessageAnnotation(message.id, pin({ htmlBlockAnchor: bad }))).toThrow(/htmlBlockAnchor/);
    }
  });

  test("what the page supplied about the element is capped", () => {
    const { store, message } = setup();
    const big = 'x'.repeat(INBOX_LIVE_ELEMENT_MAX);
    expect(() => store.saveMessageAnnotation(message.id, pin({ elementContext: { tag: 'rect', outline: big } }))).toThrow(/elementContext/);
    expect(() => store.saveMessageAnnotation(message.id, pin({ htmlAnchor: { selector: big, tagName: 'rect', text: '' } }))).toThrow(/htmlAnchor/);
    expect(() => store.saveMessageAnnotation(message.id, pin({ htmlAdditionalTargets: [{ label: 'rect', text: big }] }))).toThrow(/htmlAdditionalTargets/);
  });

  test('it still needs words of its own, and is never a general comment', () => {
    const { store, message } = setup();
    expect(() => store.saveMessageAnnotation(message.id, pin({ text: '' }))).toThrow(/annotation.text/);
    expect(() => store.saveMessageAnnotation(message.id, pin({ type: 'GLOBAL_COMMENT' }))).toThrow(/annotation.type/);
  });
});

describe('a comment on the words of a message', () => {
  test('still takes no element description', () => {
    const { store, message } = setup();
    const { htmlBlockAnchor: _anchor, ...onWords } = pin();
    expect(() => store.saveMessageAnnotation(message.id, onWords)).toThrow(/elementContext/);
  });
});
