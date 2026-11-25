/**
 * Decision mode's card is the thread's own question card (the owner, 2026-11-24: decision mode "supported the new
 * various Question card fields/capabilities"): DecisionCard draws the message through MessageBody, only the one
 * question's card (ui Viewer `onlyQuestionKey`), with its key and number from the whole message.
 *
 * What regresses if this fails: decision mode falls back to a lesser drawing (no Before/After, no picture tiles, no
 * "Try prototype"), it draws the message's other questions or prose around the card, a pick does not reach the
 * draft with the question's real key, a picture choice's zoom or a prototype does not reach the dialog's own viewer
 * and window, or an action item loses its Done.
 *
 * DOM-gated (DOM_TESTS=1, happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxDecision, InboxInlineImage, InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { resetImageSrcResolver, setImageSrcResolver } from '@plannotator/ui/components/ImageThumbnail';
import { inboxImageSrcResolver } from './images';

const hasDom = typeof document !== 'undefined';
const { DecisionCard, sentence } = (hasDom ? await import('./decisions/DecisionCard') : {}) as typeof import('./decisions/DecisionCard');

// The tiles' pictures load from a loopback server (a 1x1 GIF for every path), so happy-dom draws them as tiles.
const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='), (c) => c.charCodeAt(0));
let images: ReturnType<typeof Bun.serve> | null = null;
let savedUrl = '';
beforeAll(() => {
  if (!hasDom) return;
  images = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(GIF, { headers: { 'Content-Type': 'image/gif' } }) });
  savedUrl = window.location.href;
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${images.port}/`);
});
afterAll(() => {
  if (!hasDom) return;
  if (savedUrl) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(savedUrl);
  images?.stop(true);
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetImageSrcResolver();
});

const ID = 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ';
const BODY = [
  'The refund drawer is ready apart from two calls.',
  '',
  ':::question',
  'Keep the total next to the Refund button?',
  '',
  'Where: The refund drawer on a phone',
  'Before: The total scrolls away under the reason field',
  'After: The total stays next to the Refund button',
  '',
  '- [ ] Yes, pin it',
  '- [ ] No, leave it',
  ':::',
  '',
  'And the layout:',
  '',
  ':::question',
  'Which refund drawer should ship?',
  "- [ ] A · Total on top — ![A](shots/a.png) closest to today",
  '    Prototype: http://localhost:4000/refund?v=a',
  '- [ ] B · Total pinned — ![B](shots/b.png) the total never scrolls away',
  '    Prototype: http://localhost:4000/refund?v=b',
  'Recommended: B · Total pinned',
  ':::',
].join('\n');
const KEYS = parseInboxQuestionBlocks(BODY).map((q) => q.key);

function picture(id: string, ref: string): InboxInlineImage {
  return { id, ref, path: `/work/harbor/${ref}`, named_path: null, name: ref.split('/').pop()!, kind: 'image', sent_sha256: 'a'.repeat(64), size: 10, sent_at: '', sent_mtime: '', media_type: 'image/png' } as InboxInlineImage;
}

const message = {
  id: ID,
  project_id: 'prj_01K7PPPPPPPPPPPPPPPPPPPPPP',
  thread_id: ID,
  reply_to: null,
  author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' },
  subject: 'Refund drawer',
  body: BODY,
  created_at: '2026-11-24T10:00:00.000Z',
  resolved_at: null,
  idempotency_key: null,
  inline_images: [picture('att_01K7AAAAAAAAAAAAAAAAAAAAAA', 'shots/a.png'), picture('att_01K7BBBBBBBBBBBBBBBBBBBBBB', 'shots/b.png')],
  live_sites: ['a', 'b'].map((n) => ({ id: `liv_000000000000000${n}`, url: `http://localhost:4000/refund?v=${n}`, opened_by: 'agent', opened_at: '2026-11-24T10:00:00.000Z' })),
  questions: [],
} as unknown as InboxMessageWire;

function decisionFor(key: string, extra: Partial<InboxQuestion> = {}): InboxDecision {
  const q = {
    key,
    position: 0,
    kind: 'single',
    prompt: 'A question',
    context: null,
    choices: [],
    recommendation: null,
    suggested_text: null,
    stopped: null,
    holds_up: [],
    asked_by_agent_id: null,
    orphaned: false,
    state: 'open',
    answer: null,
    revision: 0,
    sent_revision: 0,
    picked_by: null,
    picked_at: null,
    sent_reply_id: null,
    message_id: ID,
    superseded_by: null,
    ...extra,
  } as InboxQuestion;
  return {
    id: `${ID}/${key}`,
    question: q,
    message: { id: ID, created_at: message.created_at, author: message.author, excerpt: null },
    pictures: { inline: [], attachments: [] },
    thread: { id: ID, subject: 'Refund drawer', thread_name: null, project: { id: 'prj_1', name: 'harbor' }, section: 'waiting' },
    session: { key: 's:claude-code\u0000ses_a', host: 'claude-code', session: 'ses_a', name: null, wakes: true },
  } as unknown as InboxDecision;
}

interface Heard {
  picks: [string, QuestionAnswer | null, boolean][];
  sets: [string, number][];
  protos: string[];
  actions: string[];
  /** Pictures the dialog's own viewer was asked to show. */
  images: string[];
}

async function mount(decision: InboxDecision, withBody = true, body: InboxMessageWire = message): Promise<Heard> {
  const heard: Heard = { picks: [], sets: [], protos: [], actions: [], images: [] };
  setImageSrcResolver(inboxImageSrcResolver);
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <DecisionCard
        decision={decision}
        body={withBody ? { message: body, projectRoot: '/work/harbor', repo: null, answers: new Map(), footerFor: () => null } : null}
        stamp={null}
        onPick={(key, answer, pointer) => heard.picks.push([key, answer, pointer])}
        onAction={(mark) => heard.actions.push(mark.outcome)}
        onOpenThread={() => {}}
        onOpenFileRef={() => {}}
        onImage={(pictures, index) => heard.images.push(pictures[index]!.src)}
        onOptionSet={(key, _image, choice) => heard.sets.push([key, choice])}
        onTryPrototype={(key) => heard.protos.push(key)}
        fieldOpenRef={{ current: null }}
      />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return heard;
}

describe.skipIf(!hasDom)("decision mode's card is the thread's card", () => {
  test('only this question is drawn, with its key and number from the whole message, Before/After and Where included', async () => {
    await mount(decisionFor(KEYS[0]!));
    const cards = [...host!.querySelectorAll('fieldset[data-question-key]')];
    expect(cards.map((c) => c.getAttribute('data-question-key'))).toEqual([KEYS[0]!]);
    // The thread's card: its change lines, the change marked.
    expect(host!.querySelector('[data-question-change-group]')).not.toBeNull();
    expect(host!.querySelector('[data-question-change-after]')?.textContent).toContain('next to the Refund button');
    // Numbered among the message's questions, as in the thread; the prose around it is not drawn here.
    expect(cards[0]!.textContent).toContain('Question 1 of 2');
    expect(host!.querySelector('[data-decision-question]')!.textContent).not.toContain('And the layout');
  });

  test('a click on a choice reaches the draft with the real key, and says it was a pointer', async () => {
    const heard = await mount(decisionFor(KEYS[0]!));
    const radio = [...host!.querySelectorAll<HTMLInputElement>('fieldset[data-question-key] input[type="radio"]')][0]!;
    await act(async () => {
      radio.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      radio.click();
    });
    expect(heard.picks.length).toBeGreaterThan(0);
    const [key, answer, pointer] = heard.picks.at(-1)!;
    expect(key).toBe(KEYS[0]!);
    expect(answer?.selected).toEqual(['Yes, pin it']);
    expect(pointer).toBe(true);
  });

  test("the second question: picture tiles whose zoom opens the dialog's viewer on that choice, and Try prototypes", async () => {
    const heard = await mount(decisionFor(KEYS[1]!));
    expect([...host!.querySelectorAll('fieldset[data-question-key]')].map((c) => c.getAttribute('data-question-key'))).toEqual([KEYS[1]!]);
    const tiles = [...host!.querySelectorAll<HTMLElement>('[data-question-tile]')];
    expect(tiles).toHaveLength(2);
    await act(async () => tiles[1]!.querySelector<HTMLButtonElement>('[data-question-zoom]')!.click());
    expect(heard.sets).toEqual([[KEYS[1]!, 1]]);
    // A zoom never answers.
    expect(heard.picks).toHaveLength(0);
    const tab = host!.querySelector<HTMLButtonElement>('button[data-try-prototype]')!;
    expect(tab).not.toBeNull();
    await act(async () => tab.click());
    expect(heard.protos).toEqual([KEYS[1]!]);
  });

  test("a picture the store never captured opens in the dialog's own viewer, never the page's lightbox behind the modal dialog", async () => {
    // No `inline_images`: the zoom has no captured file, so it falls back; that fallback is the dialog's viewer.
    const heard = await mount(decisionFor(KEYS[1]!), true, { ...message, inline_images: [] } as InboxMessageWire);
    const tiles = [...host!.querySelectorAll<HTMLElement>('[data-question-tile]')];
    expect(tiles).toHaveLength(2);
    await act(async () => tiles[0]!.querySelector<HTMLButtonElement>('[data-question-zoom]')!.click());
    expect(heard.images).toHaveLength(1);
    expect(heard.images[0]).toContain('a.png');
    expect(heard.sets).toHaveLength(0);
    expect(document.querySelector('[data-image-lightbox]')).toBeNull();
    expect(heard.picks).toHaveLength(0);
  });

  test('read only once its reply is on its way: no pick reaches the draft', async () => {
    host = null;
    const heard: Heard = { picks: [], sets: [], protos: [], actions: [], images: [] };
    setImageSrcResolver(inboxImageSrcResolver);
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(
        <DecisionCard
          decision={decisionFor(KEYS[0]!)}
          body={{ message, projectRoot: '/work/harbor', repo: null, answers: new Map(), footerFor: () => null }}
          stamp={null}
          sending
          onPick={(key, answer, pointer) => heard.picks.push([key, answer, pointer])}
          onAction={() => {}}
          onOpenThread={() => {}}
          onOpenFileRef={() => {}}
          onImage={() => {}}
          onOptionSet={() => {}}
          onTryPrototype={() => {}}
          fieldOpenRef={{ current: null }}
        />,
      );
    });
    const radio = host!.querySelector<HTMLInputElement>('fieldset[data-question-key] input[type="radio"]');
    if (radio) await act(async () => radio.click());
    expect(heard.picks).toHaveLength(0);
  });

  test('an action item keeps its own card: Done', async () => {
    const heard = await mount(decisionFor('a-1', { kind: 'action', prompt: 'Rotate the staging key' }), false);
    expect(host!.querySelector('fieldset[data-question-key]')).toBeNull();
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-decision-done]')!.click());
    expect(heard.actions).toEqual(['done']);
  });

  test('a line is drawn as a sentence only when its first word is plain lower-case letters', () => {
    expect(sentence('ship it today')).toBe('Ship it today');
    expect(sentence('iOS first')).toBe('iOS first');
    expect(sentence('`code` first')).toBe('`code` first');
  });
});
