/**
 * Where a Side's words came from (sideSource.ts): the line the agent gets
 * ahead of the question. Failures to catch: a message's line losing its
 * sender, id or heading; a file's line losing its path, version, line or
 * heading; a comment the person has on those words left out, or one on other
 * words put in; the selected block taken for its own heading.
 */
import { describe, expect, test } from 'bun:test';
import type { Annotation, Block } from '@plannotator/ui/types';
import { askSourceFor } from './askWords';
import type { AttachmentView } from '../api';
import { diagramFileAsk, fileSideSource, messageSideSource, sideTime } from './sideSource';

const block = (id: string, type: Block['type'], content: string, startLine: number): Block => ({ id, type, content, order: startLine, startLine }) as Block;
const BLOCKS: Block[] = [
  block('b0', 'paragraph', 'The push worker sent twice.', 1),
  block('b1', 'heading', 'What changed', 3),
  block('b2', 'paragraph', 'The budget is five attempts with a 1, 2, 4, 8 and 16 second backoff.', 5),
  block('b3', 'heading', 'Backoff', 7),
];
const AT = '2026-11-08T16:55:00.000Z';
const MESSAGE = { id: 'msg_01M6Y1CCZXCXQERZPW055JVF6R', created_at: AT, author: { kind: 'agent', host: 'claude-code', name: 'Claude Code' } };
const comment = (originalText: string, text: string, type = 'COMMENT'): Annotation => ({ id: originalText, blockId: '', startOffset: 0, endOffset: 0, type, text, originalText, createdA: 0 }) as Annotation;
const FILE = { name: 'retry-notes.md', path: '/private/work/retry-notes.md', named_path: '/work/retry-notes.md', sent_at: AT, changed_since_sent: false };

describe('Side source', () => {
  test('a message: sender, id, time and the heading above the words', () => {
    expect(messageSideSource(MESSAGE, { selected: 'five attempts', blockId: 'b2', blocks: BLOCKS, annotations: [] })).toBe(
      `[Quoted from Claude Code's message msg_01M6Y1CCZXCXQERZPW055JVF6R (${sideTime(AT)}), under "What changed".]`,
    );
  });

  test('a heading selected is not under itself; no block, no heading', () => {
    expect(messageSideSource(MESSAGE, { selected: 'Backoff', blockId: 'b3', blocks: BLOCKS, annotations: [] })).toContain('under "What changed"');
    expect(messageSideSource(MESSAGE, { selected: 'sent twice', blockId: '', blocks: BLOCKS, annotations: [] })).not.toContain('under');
  });

  test('a comment the person has on those words rides along; one on other words does not', () => {
    const line = messageSideSource(MESSAGE, {
      selected: 'five attempts with a 1, 2, 4, 8',
      blockId: 'b2',
      blocks: BLOCKS,
      annotations: [comment('five attempts', 'Why not a time limit?'), comment('push worker', 'Unrelated.'), comment('1, 2, 4, 8', '', 'DELETION')],
    });
    expect(line).toContain(` The person's comment on these words: "Why not a time limit?"`);
    expect(line).toContain(' The person marked these words to remove.');
    expect(line).not.toContain('Unrelated');
  });

  test('a file: name, the path the agent sent, the version, the line and the heading', () => {
    expect(fileSideSource(FILE, 'sent', { selected: 'five attempts', blockId: 'b2', blocks: BLOCKS, annotations: [] })).toBe(
      `[Quoted from retry-notes.md (/work/retry-notes.md, attached to this thread; the version sent ${sideTime(AT)}), line 5, under "What changed".]`,
    );
    expect(fileSideSource({ ...FILE, changed_since_sent: true }, 'current', { selected: 'x', blockId: '', blocks: [], annotations: [] })).toBe(
      `[Quoted from retry-notes.md (/work/retry-notes.md, attached to this thread; the current version, changed since it was sent ${sideTime(AT)}).]`,
    );
    expect(fileSideSource({ ...FILE, named_path: null }, 'current', { selected: 'x', blockId: '', blocks: [], annotations: [] })).toContain('(/private/work/retry-notes.md, attached to this thread; the version sent, unchanged)');
  });

  test('a quote the person deleted from the box takes its source with it', () => {
    const sources = [
      { quote: '> five attempts', line: '[A]' },
      { quote: '> second backoff', line: '[B]' },
    ];
    expect(askSourceFor('> five attempts\n\nWhy?', sources)).toBe('[A]');
    expect(askSourceFor('> five attempts\n> second backoff', sources)).toBe('[A]\n[B]');
    expect(askSourceFor('Why?', sources)).toBeUndefined();
  });
});

test("a diagram question identifies the displayed version and the attachment's owning message", () => {
  const sent = "a".repeat(64);
  const current = "b".repeat(64);
  const attachment: AttachmentView['attachment'] = {
    id: 'att_delivery', message_id: 'msg_owner', path: '/project/delivery.diagram.json', name: 'delivery.diagram.json', named_path: null,
    kind: 'plannotator-diagram', sent_sha256: sent, sent_at: AT, sent_mtime: AT, size: 100,
    current: { sha256: current, size: 103, mtime: AT }, changed_since_sent: true, unavailable: null,
  };
  for (const [version, sha] of [[sent, sent], ['current', current]]) {
    const view = { serverSession: 'server', attachment, version: version!, text: '{}', html: null };
    const calls: { question: string; source?: string }[] = [];
    const ask = diagramFileAsk(view, (question, source) => { calls.push({ question, source }); });
    ask?.('Where does this run?', { kind: 'selection', detail: 'Asset: delivery; panel queue' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.source).toContain(`SHA-256: ${sha}`);
    expect(calls[0]?.source).toContain('Message: msg_owner');
    expect(calls[0]?.source).toContain('panel queue');
    expect(diagramFileAsk(view)).toBeUndefined();
  }
});
