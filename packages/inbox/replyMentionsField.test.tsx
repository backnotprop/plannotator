/**
 * A thread mentioned in the reply box, as the person does it (approval "inbox-drag-threads", piece 1, treatment A):
 * a row dragged onto the box, the row menu's Mention in reply, a pasted thread link, Backspace over a mention, and a
 * sent mention drawn as a link. What regresses: a drop that lands at the end instead of where it was let go, a box
 * that looks like a target when nothing is dragged (or takes your own thread), a mention lost when the box's other
 * parts change, a file drop or file paste that stops attaching, and a sent mention drawn as the agent's text.
 *
 * Happy-dom lays nothing out, so the pointer's hit test and the caret under it are stood in for (the real look and
 * the real drag are in the build's shots and recording); the engine, the field and the words are the product's.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxThreadMentionRef } from '@plannotator/core/inbox-thread-mention';

const hasDom = typeof document !== 'undefined';
const { InboxComposerField } = (hasDom ? await import('./components/ComposerField') : {}) as typeof import('./components/ComposerField');
const { pressThreadRow, setThreadDragHitTestForTests } = (hasDom ? await import('./threadDrag') : {}) as typeof import('./threadDrag');
const { requestMention, resetReplyMentionsForTests } = (hasDom ? await import('./threadMentions') : {}) as typeof import('./threadMentions');
const { noteMentionRefs } = (hasDom ? await import('./data/threadMentionRefs') : {}) as typeof import('./data/threadMentionRefs');
const { replyWordsWithMentions } = (hasDom ? await import('./threadMentions') : {}) as typeof import('./threadMentions');
const { linkInboxThreadMentions } = (hasDom ? await import('@plannotator/core/inbox-thread-mention') : {}) as typeof import('@plannotator/core/inbox-thread-mention');
const { InlineMarkdown } = (hasDom ? await import('@plannotator/ui/components/InlineMarkdown') : {}) as typeof import('@plannotator/ui/components/InlineMarkdown');
const { Menu } = (hasDom ? await import('@base-ui/react/menu') : {}) as typeof import('@base-ui/react/menu');
const { MentionMenuItem } = (hasDom ? await import('./components/MentionMenuItem') : {}) as typeof import('./components/MentionMenuItem');

const HERE = 'msg_01JD5LOGINREDIRECTLOOP00';
const FLAKY: InboxThreadMentionRef = { id: 'msg_01JD5FLAKYLOGINTESTCI000', title: 'Flaky login test on CI', project: null };
const RATE: InboxThreadMentionRef = { id: 'msg_01JD5RATELIMITPUBLICAPI0', title: 'Rate limit for the public API', project: null };
const OLD: InboxThreadMentionRef = { id: 'msg_01JD5COOKIEDOMAINSSTAGE0', title: 'Cookie domains in staging', project: null, archived: true };

let root: Root | null = null;
let host: HTMLElement | null = null;
let realFetch: typeof fetch;
let words = '';

beforeEach(() => {
  realFetch = globalThis.fetch;
  // The field asks for the skills list when it mounts: none here.
  globalThis.fetch = (async () => Response.json({ skills: [] })) as unknown as typeof fetch;
  noteMentionRefs([FLAKY, RATE, OLD]);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  setThreadDragHitTestForTests(null);
  resetReplyMentionsForTests();
  delete (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
  window.location.hash = '';
});

/** A reply box: the field among what else the box can hold (a quote line, file tiles, answers), as Thread.tsx draws it. */
function Box({ initial = '', card = false, extras }: { initial?: string; card?: boolean; extras?: ReactNode }) {
  const [value, setValue] = useState(initial);
  words = value;
  return (
    <div className="pn-inbox">
      <div className={card ? 'ib-fcomp' : 'ib-rbox'} data-testid="box">
        {extras}
        <InboxComposerField
          value={value}
          onChange={setValue}
          placeholder="Write a reply"
          ariaLabel="Reply"
          destination="your reply"
          mentionThread={HERE}
          textareaRef={{ current: null }}
        />
      </div>
    </div>
  );
}

function draw(node: ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const box = () => document.querySelector<HTMLElement>('[data-testid="box"]')!;
const field = () => document.querySelector<HTMLTextAreaElement>('textarea')!;
const tokens = () => [...document.querySelectorAll('[data-skill-ref-token^="thread"]')].map((t) => [t.getAttribute('data-skill-ref-token'), t.textContent]);

/** The caret a pointer would put in the words: `offset` in the mirror's text. */
function caretAt(offset: number) {
  (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint = () => {
    const mirror = document.querySelector('.ib-rmirror')!;
    const text = [...mirror.childNodes].find((n) => n.nodeType === Node.TEXT_NODE)!;
    const range = document.createRange();
    range.setStart(text, offset);
    return range;
  };
}

/** A row picked up and carried: below the threshold it is still a press, past it a drag. */
function pickUp(ids: string[]) {
  const row = document.createElement('button');
  document.body.appendChild(row);
  const at = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, pointerType: 'mouse', pointerId: 1, bubbles: true });
  act(() => pressThreadRow(new PointerEvent('pointerdown', at(0, 0)), { ids: () => ids, label: () => 'thread', rows: () => [row], spoken: () => 'Picked up.' }, document.querySelector('.pn-inbox')!));
  act(() => void window.dispatchEvent(new PointerEvent('pointermove', at(2, 1))));
  const before = box().getAttribute('data-thread-drop');
  act(() => void window.dispatchEvent(new PointerEvent('pointermove', at(40, 40))));
  return {
    before,
    over: (target: Element | null) => {
      setThreadDragHitTestForTests(() => target);
      act(() => void window.dispatchEvent(new PointerEvent('pointermove', at(60, 60))));
    },
    drop: () => act(() => void window.dispatchEvent(new PointerEvent('pointerup', at(60, 60)))),
    escape: () => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))),
  };
}

describe.skipIf(!hasDom)('a row dragged onto the reply box', () => {
  test('the box is a target only while a thread is carried, and the drop puts the mention where it was let go', () => {
    draw(<Box initial="Same as the failure we saw." />);
    expect(box().hasAttribute('data-thread-drop')).toBe(false);
    caretAt('Same as the fai'.length);
    const drag = pickUp([FLAKY.id]);
    // 2 px is still a press: nothing shows.
    expect(drag.before).toBeNull();
    expect(box().getAttribute('data-thread-drop')).toBe('target');
    drag.over(field());
    expect(box().getAttribute('data-thread-drop')).toBe('over');
    expect(box().querySelector('.ib-tdrop')?.textContent).toContain('Drop to mention this thread');
    drag.drop();
    // Snapped to the end of the word under the pointer, with its spaces.
    expect(words).toBe('Same as the failure Flaky login test on CI we saw.');
    expect(tokens()).toEqual([[`thread:${FLAKY.id}`, FLAKY.title]]);
    expect(box().hasAttribute('data-thread-drop')).toBe(false);
    expect(box().querySelector('.ib-tdrop')).toBeNull();
  });

  test('several picked rows drop as several mentions; the thread you are in is refused quietly', () => {
    draw(<Box initial="Read these first:" />);
    caretAt('Read these first:'.length);
    const mine = pickUp([HERE]);
    expect(box().getAttribute('data-thread-drop')).toBe('refuse');
    mine.over(field());
    expect(box().querySelector('.ib-tdrop')?.textContent).toContain('This is the thread you are in');
    mine.drop();
    expect(words).toBe('Read these first:');
    const many = pickUp([FLAKY.id, HERE, RATE.id]);
    many.over(field());
    expect(box().querySelector('.ib-tdrop')?.textContent).toContain('Drop to mention 2 threads');
    many.drop();
    expect(words).toBe(`Read these first: ${FLAKY.title}, ${RATE.title} `);
    expect(tokens().map((t) => t[1])).toEqual([FLAKY.title, RATE.title]);
  });

  test('Escape, or a drop on nothing, changes nothing', () => {
    draw(<Box initial="Keep me." />);
    const drag = pickUp([FLAKY.id]);
    drag.escape();
    expect(box().hasAttribute('data-thread-drop')).toBe(false);
    const again = pickUp([FLAKY.id]);
    again.over(null);
    again.drop();
    expect(words).toBe('Keep me.');
  });

  test('a mention already in the words is not added twice', () => {
    draw(<Box />);
    act(() => requestMention(HERE, [FLAKY]));
    caretAt(0);
    const drag = pickUp([FLAKY.id]);
    drag.over(field());
    drag.drop();
    expect(words).toBe(`${FLAKY.title} `);
  });
});

describe.skipIf(!hasDom)('every state of the box', () => {
  test('the box\'s other parts coming and going keep the mentions', () => {
    draw(<Box initial="See " />);
    act(() => requestMention(HERE, [FLAKY]));
    act(() => root!.render(<Box initial="ignored" extras={<><div className="ib-rquote">Replying to</div><div className="ib-rfiles">trace.har</div><div className="ib-ranswers">Q1 → Yes</div></>} />));
    expect(tokens()).toEqual([[`thread:${FLAKY.id}`, FLAKY.title]]);
  });

  test('while sending (the field is read-only) the box is no target', () => {
    draw(<Box initial="Going" />);
    act(() => void (field().readOnly = true));
    const drag = pickUp([FLAKY.id]);
    expect(box().hasAttribute('data-thread-drop')).toBe(false);
    drag.escape();
  });

  test('full screen\'s card is the target there; an archived thread is a grey mention', () => {
    draw(<Box card initial="Settled in " />);
    const drag = pickUp([OLD.id]);
    expect(box().getAttribute('data-thread-drop')).toBe('target');
    caretAt('Settled in '.length);
    drag.over(field());
    drag.drop();
    expect(tokens()).toEqual([[`thread-archived:${OLD.id}`, OLD.title]]);
  });
});

describe.skipIf(!hasDom)('the ways that are not a drag', () => {
  test('the row menu\'s Mention in reply puts the thread in the reply on screen', async () => {
    window.location.hash = `#thread=${HERE}`;
    draw(
      <>
        <Box initial="Compare with" />
        <Menu.Root>
          <Menu.Trigger data-testid="row">Rate limit for the public API</Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner>
              <Menu.Popup>
                <MentionMenuItem rows={[{ thread_id: RATE.id, thread_name: RATE.title, subject: null, resolved_at: null, project: { id: 'p', name: 'harbor' } } as never]} phone={false} />
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </>,
    );
    // Base UI opens on the pointer's press, as a person's click does.
    const trigger = document.querySelector<HTMLElement>('[data-testid="row"]')!;
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      trigger.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
      trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      trigger.click();
    });
    const item = document.querySelector<HTMLElement>('[data-row-action="mention"]')!;
    expect(item.getAttribute('role')).toBe('menuitem');
    expect(item.textContent).toContain('Mention in reply');
    await act(async () => {
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(words).toBe(`Compare with ${RATE.title} `);
  });

  test('on the open thread itself the item is disabled and says so', () => {
    window.location.hash = `#thread=${HERE}`;
    draw(
      <Menu.Root open>
        <Menu.Portal>
          <Menu.Positioner>
            <Menu.Popup>
              <MentionMenuItem rows={[{ thread_id: HERE, thread_name: 'Login redirect loop', subject: null, resolved_at: null, project: { id: 'p', name: 'harbor' } } as never]} phone={false} />
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>,
    );
    const item = document.querySelector<HTMLElement>('[data-row-action="mention"]')!;
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.textContent).toContain('This thread');
  });

  test('a pasted thread link becomes the same mention; a file paste is left to the box', () => {
    let boxPastes = 0;
    draw(
      <div onPaste={(event) => void (event.defaultPrevented ? null : boxPastes++)}>
        <Box initial="Like " />
      </div>,
    );
    const paste = (data: { text?: string; files?: File[] }) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { getData: () => data.text ?? '', files: data.files ?? [], items: [], types: data.files ? ['Files'] : ['text/plain'] } });
      act(() => {
        field().focus();
        field().setSelectionRange(5, 5);
        field().dispatchEvent(event);
      });
    };
    paste({ text: `http://localhost:19432/#thread=${FLAKY.id}` });
    expect(words).toBe(`Like ${FLAKY.title} `);
    expect(tokens()).toEqual([[`thread:${FLAKY.id}`, FLAKY.title]]);
    paste({ files: [new File(['x'], 'shot.png', { type: 'image/png' })] });
    expect(boxPastes).toBe(1);
  });

  test('Backspace right after a mention takes it whole', () => {
    draw(<Box initial="See " />);
    act(() => requestMention(HERE, [FLAKY]));
    const end = words.indexOf(FLAKY.title) + FLAKY.title.length;
    act(() => {
      field().focus();
      field().setSelectionRange(end, end);
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    });
    expect(words).toBe('See  ');
    expect(tokens()).toEqual([]);
  });
});

describe.skipIf(!hasDom)('what else the box takes', () => {
  test('a file dropped on the box still reaches the box (thread drags never use native drag events)', () => {
    let dropped = 0;
    const Files = () => (
      <div onDrop={(event) => void (dropped += event.dataTransfer?.files.length ?? 0)} onDragOver={(event) => event.preventDefault()}>
        <Box initial="Here is the trace" />
      </div>
    );
    draw(<Files />);
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [new File(['x'], 'trace.har')], types: ['Files'], items: [] } });
    act(() => void box().dispatchEvent(event));
    expect(dropped).toBe(1);
    expect(words).toBe('Here is the trace');
  });
});

describe.skipIf(!hasDom)('after Send', () => {
  test('the person\'s sent message shows the mention as a link that opens the thread, not the agent\'s words', () => {
    draw(<Box initial="Same as " />);
    act(() => requestMention(HERE, [FLAKY]));
    const sent = replyWordsWithMentions(HERE, words);
    expect(sent).toContain(`(thread ${FLAKY.id})`);
    act(() => root!.render(<div className="ib-body"><InlineMarkdown text={linkInboxThreadMentions(sent)} /></div>));
    const link = document.querySelector<HTMLAnchorElement>('a[href^="#thread="]')!;
    expect(link.getAttribute('href')).toBe(`#thread=${FLAKY.id}`);
    expect(link.textContent).toBe(FLAKY.title);
    expect(document.body.textContent).not.toContain(FLAKY.id);
  });
});
