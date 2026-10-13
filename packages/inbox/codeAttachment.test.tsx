/**
 * A code attachment in the window: the pane draws the file in the code review
 * engine's single-file view with line comments (a shell `#` comment never
 * becomes a heading), and the tile names the kind. The phone surface's one
 * code block stays plain text over the highlight bound, never one long
 * synchronous Shiki pass.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { CODE_EXCERPT_MAX_CHARS, CODE_HIGHLIGHT_MAX_CHARS, codeCommentAnnotation, codeDocumentBlocks, codeRangeMatches, codeRangeOf, hasLineLongerThan, inboxViewKind } from './attachments';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import { AnnotationType, type Annotation } from '@plannotator/ui/types';

const hasDom = typeof document !== 'undefined';
// The pane pulls in the Viewer, which reads `window` at module-eval time.
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');
const { AttachmentTiles } = (hasDom ? await import('./components/AttachmentTiles') : {}) as typeof import('./components/AttachmentTiles');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
});

const SCRIPT = '#!/bin/sh\n# Replay the failed webhook\ncurl -X POST http://localhost:4242/hooks\n';
const attachment: InboxAttachmentState = {
  id: 'att_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  path: '/work/api/scripts/replay.sh',
  named_path: null,
  name: 'replay.sh',
  kind: 'code',
  sent_sha256: 'a'.repeat(64),
  size: SCRIPT.length,
  sent_at: '2026-10-10T10:00:00.000Z',
  sent_mtime: '2026-10-10T10:00:00.000Z',
  message_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  current: { sha256: 'a'.repeat(64), size: SCRIPT.length, mtime: '2026-10-10T10:00:00.000Z' },
  changed_since_sent: false,
  unavailable: null,
};

async function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

async function openPane(text: string, file: InboxAttachmentState = attachment, records: InboxAnnotationRecord[] = []) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ serverSession: 's', attachment: file, version: 'current', text, html: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  const noop = () => {};
  await render(
    <AttachmentPane
      attachment={file}
      attachments={[file]}
      records={records}
      agent="Claude Code"
      projectName="api"
      projectRoot="/work/api"
      version="current"
      onVersion={noop}
      full={false}
      onToggleFull={noop}
      focusId={null}
      readOnly={false}
      onSaved={noop}
      onRemoved={noop}
      onOpenAt={noop}
      onClose={noop}
      strip={{ picks: 0, annotations: 0, onBack: noop, onWriteReply: noop }}
    />,
  );
  await act(async () => {
    for (let i = 0; i < 200 && !host!.querySelector('[data-code-view] diffs-container'); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

test.skipIf(!hasDom)('the pane draws a script in the code view (Pierre), with line comments offered and no document toolstrip', async () => {
  await openPane(SCRIPT);
  const view = host!.querySelector('[data-code-view]');
  expect(view).not.toBeNull();
  // The code review engine's single-file view, never the markdown pipeline (a `#` comment is not a heading).
  expect(view!.querySelector('diffs-container')).not.toBeNull();
  expect(host!.querySelector('.ib-docscroll')).toBeNull();
  expect(host!.querySelector('.ib-toolstrip')).toBeNull();
  expect(view!.textContent).toContain('Click a line number');
});

test('a code file over the highlight bound is one block with no language (plain text, no Shiki pass)', () => {
  const small = codeDocumentBlocks('const a = 1;\n', 'app.ts');
  expect(small[0]!.language).toBe('ts');
  const large = codeDocumentBlocks('x'.repeat(CODE_HIGHLIGHT_MAX_CHARS + 1), 'bundle.min.js');
  expect(large).toHaveLength(1);
  expect(large[0]!.language).toBeUndefined();
});

test.skipIf(!hasDom)('the tile names the kind of a code attachment', async () => {
  await render(<AttachmentTiles attachments={[attachment]} annotationCounts={new Map()} onOpen={() => {}} />);
  expect(host!.querySelector(`[data-attachment-id="${attachment.id}"]`)?.textContent).toContain('Code (.sh)');
});

// Row 44: logs, YAML, CSV and JSON ran their lines together through the markdown pipeline (# read as a heading).
test('data and log files are drawn as code; .txt and markdown keep their own view', () => {
  for (const name of ['worker.log', 'config.yaml', 'ci.yml', 'data.csv', 'rows.tsv', 'package.json', 'Cargo.toml', 'app.ini', 'site.conf', 'feed.xml', '.env.example']) {
    expect(inboxViewKind('text', name)).toBe('code');
  }
  expect(inboxViewKind('text', 'notes.txt')).toBe('text');
  expect(inboxViewKind('text', 'README')).toBe('text');
  expect(inboxViewKind('markdown', 'plan.md')).toBe('markdown');
  expect(inboxViewKind('code', 'replay.sh')).toBe('code');
});

const yaml: InboxAttachmentState = { ...attachment, id: 'att_01K7YYYYYYYYYYYYYYYYYYYYYY', path: '/work/api/deploy.yaml', name: 'deploy.yaml', kind: 'text' };
const YAML = '# deploy\nservices:\n  api:\n    image: api:1.4\n';

function textComment(): InboxAnnotationRecord {
  const annotation: Annotation = { id: 'ann-old', blockId: 'block-1', startOffset: 0, endOffset: 8, type: AnnotationType.COMMENT, text: 'Pin the tag.', originalText: 'services', createdA: 1 };
  return {
    id: 'ann-old',
    project_id: 'prj_x',
    thread_id: 'msg_x',
    message_id: yaml.message_id,
    attachment_id: yaml.id,
    path: yaml.path,
    version: 'current',
    annotation: annotation as unknown as Record<string, unknown>,
    created_at: yaml.sent_at,
    updated_at: yaml.sent_at,
    removed_at: null,
    sent_reply_id: null,
  };
}

test.skipIf(!hasDom)('a YAML file sent as text opens in the code view, and a text comment left on it before shows as Unanchored', async () => {
  await openPane(YAML, yaml, [textComment()]);
  expect(host!.querySelector('[data-code-view] diffs-container')).not.toBeNull();
  expect(host!.querySelector('.ib-docscroll')).toBeNull();
  const chip = [...host!.querySelectorAll('[data-annotation-panel] *')].find((el) => el.textContent === 'Unanchored');
  expect(chip).toBeDefined();
});

// Row 60: a comment on a minified file's one line stored the whole 323 KB line.
test('a comment on a very long line keeps an excerpt with the length and a hash; old whole-line records still match', () => {
  const line = `var a=${'x'.repeat(330_000)};`;
  const stored = codeRangeOf(codeCommentAnnotation({ id: 'a', lineStart: 1, lineEnd: 1, text: 'too long', code: line }))!;
  expect(stored.code.length).toBeLessThanOrEqual(CODE_EXCERPT_MAX_CHARS);
  expect(line.startsWith(stored.code.slice(0, -1))).toBe(true);
  expect(stored.length).toBe(line.length);
  expect(codeRangeMatches(stored, line)).toBe(true);
  expect(codeRangeMatches(stored, line.replace('x;', 'y;'))).toBe(false);
  expect(codeRangeMatches(stored, `${line} `)).toBe(false);

  // A short comment is kept whole, with no hash: the same record as before.
  const short = codeRangeOf(codeCommentAnnotation({ id: 'b', lineStart: 2, lineEnd: 2, text: 'ok', code: 'const a = 1;' }))!;
  expect(short).toEqual({ lineStart: 2, lineEnd: 2, code: 'const a = 1;' });
  // A record from before excerpts (the whole lines, no hash) matches by its text.
  expect(codeRangeMatches({ lineStart: 1, lineEnd: 1, code: line }, line)).toBe(true);
  expect(codeRangeMatches({ lineStart: 1, lineEnd: 1, code: line }, `${line} `)).toBe(false);
});

// Row 59: a minified file's one line could not wrap.
test('a line over the wrap bound is found on any line, and short lines are not', () => {
  expect(hasLineLongerThan('a\nb\n', 1000)).toBe(false);
  expect(hasLineLongerThan(`a\n${'x'.repeat(1001)}\nb`, 1000)).toBe(true);
  expect(hasLineLongerThan('x'.repeat(1001), 1000)).toBe(true);
  expect(hasLineLongerThan('x'.repeat(1000), 1000)).toBe(false);
});
