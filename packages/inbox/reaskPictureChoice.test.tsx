/**
 * A picture choice opened from a tile (the Artifacts view, a message's file
 * tiles) rather than its zoom, in a thread where an agent asked again with the
 * same two pictures from other paths (`Replaces:` the first question, a third
 * choice with no picture, a `Prototype:` page per pictured choice). What
 * regresses here: such a picture opening without its question's set, so the
 * full-screen viewer shows no option card; and the copy the replaced question
 * showed opening as a choice of a question that is no longer asked.
 *
 * DOM-gated parts run under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAttachmentState, InboxAuthor, InboxInlineImage, InboxMessageWire, InboxProject, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import { attachmentSequence } from './stepping';
import { openChoiceSetOf, optionSetAddress, optionSetId } from './optionSets';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'web-abcdef', name: 'web', root: '/work/web', created_at: '2026-11-12T09:00:00.000Z' };
const CLAUDE: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const M1 = 'msg_01M78XPYRJJV93CVGKHCMF944M';
const M2 = 'msg_01M78XPYRS0TBH15HTAC8AVMKA';

const ASKED = [':::question', 'Which header should ship?', '', '- [ ] A · Tabs — ![Tabs](shots/a.png) tabs on top', '- [ ] B · Menu — ![Menu](shots/b.png) a menu', ':::'].join('\n');
const KEY = parseInboxQuestionBlocks(ASKED)[0]!.key;
const ASKED_AGAIN = [
  ':::question',
  `Replaces: ${M1}/${KEY}`,
  'Which header should ship?',
  '',
  '- [ ] A · Tabs — ![Tabs](mock/a.png) tabs on top',
  '  Prototype: mock/a.html',
  '- [ ] B · Menu — ![Menu](mock/b.png) a menu',
  '  Prototype: mock/b.html',
  '- [ ] Neither; leave it as it is',
  ':::',
].join('\n');

function questionsOf(messageId: string, body: string, patch: Partial<InboxQuestion> = {}): InboxQuestion[] {
  return parseInboxQuestionBlocks(body).map((q) => ({
    key: q.key,
    position: q.position,
    kind: q.kind,
    prompt: q.prompt,
    context: q.parsed.context,
    choices: q.parsed.choices,
    recommendation: q.parsed.recommendation,
    suggested_text: q.parsed.suggested_text,
    stopped: q.stopped,
    holds_up: q.holds_up,
    asked_by_agent_id: CLAUDE.session,
    orphaned: false,
    state: 'open',
    answer: null,
    revision: 0,
    sent_revision: 0,
    picked_by: null,
    picked_at: null,
    sent_reply_id: null,
    message_id: messageId,
    superseded_by: null,
    ...patch,
  }));
}

/** The same bytes in both messages (one blob), sent from different paths: a record of each message's own. */
function captured(id: string, ref: string, sha: string): InboxInlineImage {
  return { id, ref, path: `/work/web/${ref}`, named_path: null, name: ref.split('/').pop()!, kind: 'image', sent_sha256: sha.repeat(64), size: 10, sent_at: '2026-11-12T10:00:00.000Z', sent_mtime: '2026-11-12T10:00:00.000Z', media_type: 'image/png' };
}
const A1 = captured('att_01M78XPYRJA1A1A1A1A1A1A1A1', 'shots/a.png', 'a');
const B1 = captured('att_01M78XPYRJB1B1B1B1B1B1B1B1', 'shots/b.png', 'b');
const A2 = captured('att_01M78XPYRSA2A2A2A2A2A2A2A2', 'mock/a.png', 'a');
const B2 = captured('att_01M78XPYRSB2B2B2B2B2B2B2B2', 'mock/b.png', 'b');

function message(id: string, body: string, minute: number, extra: Partial<InboxMessageWire>): InboxMessageWire {
  return { id, project_id: PROJECT.id, thread_id: M1, reply_to: id === M1 ? null : M1, author: CLAUDE, subject: id === M1 ? 'Header' : null, body, created_at: `2026-11-12T10:${String(minute).padStart(2, '0')}:00.000Z`, resolved_at: null, idempotency_key: null, seq: minute, ...extra };
}

function thread(again: Partial<InboxQuestion> = {}): InboxThread {
  return {
    thread_id: M1,
    project: PROJECT,
    subject: 'Header',
    thread_name: 'header',
    resolved_at: null,
    messages: [
      message(M1, `Two headers.\n\n${ASKED}`, 1, { inline_images: [A1, B1], questions: questionsOf(M1, ASKED, { state: 'superseded', superseded_by: { message_id: M2, key: KEY } }) }),
      message(M2, `Asking again.\n\n${ASKED_AGAIN}`, 2, { inline_images: [A2, B2], questions: questionsOf(M2, ASKED_AGAIN, again) }),
    ],
  };
}

const state = (image: InboxInlineImage, messageId: string) => ({ ...image, message_id: messageId, changed_since_sent: false, unavailable: null, current: { sha256: image.sent_sha256, size: 10, mtime: image.sent_mtime } }) as InboxAttachmentState;
const FILES = [state(A1, M1), state(B1, M1), state(A2, M2), state(B2, M2)];
const AGAIN_SET = optionSetId(M2, KEY);

test('a picture of the open question opens on its choice; the copy the replaced question showed opens as a plain file', () => {
  const t = thread();
  const steps = attachmentSequence(t.messages, [], FILES);
  expect(openChoiceSetOf(t.messages, steps, A2.id)).toBe(optionSetAddress({ id: AGAIN_SET }, 0));
  expect(openChoiceSetOf(t.messages, steps, B2.id)).toBe(optionSetAddress({ id: AGAIN_SET }, 1));
  // The same picture, as the replaced question showed it.
  expect(openChoiceSetOf(t.messages, steps, A1.id)).toBeNull();
  expect(openChoiceSetOf(t.messages, steps, B1.id)).toBeNull();
  // Once the question is answered, its pictures open as plain files too.
  const answered = thread({ state: 'sent' });
  expect(openChoiceSetOf(answered.messages, attachmentSequence(answered.messages, [], FILES), A2.id)).toBeNull();
});

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], inline_images: FILES, annotations: [], earlier_annotations: [] });
    if (path.includes('/artifact-pins')) return Response.json({ pins: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test.skipIf(!hasDom)('from the Artifacts view, A and B of the question asked again open with its set, on their choice', async () => {
  const opened: { id: string; set: string | null | undefined }[] = [];
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ThreadPane
        thread={thread()}
        sent={null}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={null}
        onOpenFile={(target) => target && opened.push({ id: target.id, set: target.set })}
        onOpenGuide={() => {}}
        artifacts
        onArtifacts={() => {}}
      />,
    );
  });
  const tile = (id: string) => host!.querySelector<HTMLButtonElement>(`[data-artifact-tile="${id}"]`);
  for (let i = 0; i < 60 && !tile(A2.id); i += 1) await settle();
  for (const id of [A2.id, B2.id, A1.id]) await act(async () => tile(id)!.click());
  expect(opened).toEqual([
    { id: A2.id, set: optionSetAddress({ id: AGAIN_SET }, 0) },
    { id: B2.id, set: optionSetAddress({ id: AGAIN_SET }, 1) },
    { id: A1.id, set: null },
  ]);
});
