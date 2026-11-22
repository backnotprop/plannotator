/**
 * A thread mentioned in the reply box, as the person does it (approval "inbox-drag-threads", piece 1, treatment A):
 * a row dragged onto the box, the row menu's Mention in reply, a pasted thread link, Backspace over a mention, a
 * draft opened elsewhere, and a sent mention drawn as a link. What regresses: a drop that lands at the end instead of
 * where it was let go, a box that looks like a target when nothing is dragged (or takes your own thread), typed words
 * painted as a mention, a mention lost when the box's other parts change or the draft is opened on another device, a
 * paste whose late read takes out other words, a file drop or file paste that stops attaching, no word that the
 * reply's agent cannot open a mention, a press whose release was lost arming a drag, and a sent mention drawn as the
 * agent's text or unable to wrap.
 *
 * Happy-dom lays nothing out, so the pointer's hit test and the caret under it are stood in for (the real look and
 * the real drag are in the build's shots and recording); the engine, the field and the words are the product's.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MentionRef } from './threadMentions';

const hasDom = typeof document !== 'undefined';
const { InboxComposerField } = (hasDom ? await import('./components/ComposerField') : {}) as typeof import('./components/ComposerField');
const { pressThreadRow, scrollStep, setThreadDragHitTestForTests } = (hasDom ? await import('./threadDrag') : {}) as typeof import('./threadDrag');
const { clearReplyMentions, noteDraftMentions, requestMention, resetReplyMentionsForTests, useMentionBoxOpener } = (hasDom ? await import('./threadMentions') : {}) as typeof import('./threadMentions');
const { rememberMachine, resetMachineRoutes, setSelfMachine } = (hasDom ? await import('./inboxUrl') : {}) as typeof import('./inboxUrl');
const { noteMentionRefs } = (hasDom ? await import('./data/threadMentionRefs') : {}) as typeof import('./data/threadMentionRefs');
const { replyWordsWithMentions } = (hasDom ? await import('./threadMentions') : {}) as typeof import('./threadMentions');
const { INBOX_THREAD_MENTION_WORDS: W, inboxThreadMentionHref, linkInboxThreadMentions } = (hasDom ? await import('@plannotator/core/inbox-thread-mention') : {}) as typeof import('@plannotator/core/inbox-thread-mention');
const { InlineMarkdown } = (hasDom ? await import('@plannotator/ui/components/InlineMarkdown') : {}) as typeof import('@plannotator/ui/components/InlineMarkdown');
const { Menu } = (hasDom ? await import('@base-ui/react/menu') : {}) as typeof import('@base-ui/react/menu');
const { MentionMenuItem } = (hasDom ? await import('./components/MentionMenuItem') : {}) as typeof import('./components/MentionMenuItem');

const idOf = (seed: string) => `msg_${seed.padEnd(26, '0')}`;
const HERE = idOf('01JD5HERE');
const FLAKY: MentionRef = { id: idOf('01JD5F1AKY'), title: 'Flaky login test on CI', project: null };
const RATE: MentionRef = { id: idOf('01JD5RATE'), title: 'Rate limit for the public API', project: null };
const OLD: MentionRef = { id: idOf('01JD5C00K1E'), title: 'Cookie domains in staging', project: null, archived: true };
/** A thread the window holds nothing of (a link pasted from elsewhere): one read names it. */
const LATE: MentionRef = { id: idOf('01JD5WA1T'), title: 'Session cookie rotation', project: null, archived: true };

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
  resetMachineRoutes();
  delete (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
  window.location.hash = '';
});

/** A reply box: the field among what else the box can hold (a quote line, file tiles, answers), as Thread.tsx draws it. */
function Box({ initial = '', card = false, extras }: { initial?: string; card?: boolean; extras?: ReactNode }) {
  const [value, setValue] = useState(initial);
  words = value;
  // The pane's half, as Thread.tsx calls it with the box open: whether the reply holds words not sent yet.
  useMentionBoxOpener(HERE, true, false, () => {}, value.trim() !== '');
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
const tokens = () => [...document.querySelectorAll('[data-skill-ref-token^="ib-mention"]')].map((t) => [t.getAttribute('data-skill-ref-token'), t.textContent]);

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

/** The person's typing: the field's words become `text`, the caret at their end (the field's own input event). */
function type(text: string) {
  act(() => {
    const el = field();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
    el.setSelectionRange(text.length, text.length);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** A paste in the field (`clipboardData` as a browser hands it); true when the box let it go through. */
function pasteIn(data: { text?: string; files?: File[] }, at: number): boolean {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => data.text ?? '', files: data.files ?? [], items: [], types: data.files ? ['Files'] : ['text/plain'] } });
  act(() => {
    field().focus();
    field().setSelectionRange(at, at);
    field().dispatchEvent(event);
  });
  return !event.defaultPrevented;
}

/** A row picked up and carried: below the threshold it is still a press, past it a drag. */
function pickUp(ids: string[]) {
  const row = document.createElement('button');
  document.body.appendChild(row);
  const at = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, buttons: 1, pointerType: 'mouse', pointerId: 1, bubbles: true });
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
    drop: () => act(() => void window.dispatchEvent(new PointerEvent('pointerup', { ...at(60, 60), buttons: 0 }))),
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
    expect(tokens()).toEqual([[`ib-mention:${FLAKY.id}`, FLAKY.title]]);
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
    expect(tokens()).toEqual([[`ib-mention:${FLAKY.id}`, FLAKY.title]]);
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
    expect(tokens()).toEqual([[`ib-mention-archived:${OLD.id}`, OLD.title]]);
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

  test('on the open thread itself there is no item (it would take room and do nothing)', () => {
    window.location.hash = `#thread=${HERE}`;
    draw(
      <>
        <Box initial="Compare with" />
        <Menu.Root open>
          <Menu.Portal>
            <Menu.Positioner>
              <Menu.Popup>
                <MentionMenuItem rows={[{ thread_id: HERE, thread_name: 'Login redirect loop', subject: null, resolved_at: null, project: { id: 'p', name: 'harbor' } } as never]} phone={false} />
                <span data-testid="menu-drawn" />
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </>,
    );
    expect(document.querySelector('[data-testid="menu-drawn"]')).not.toBeNull();
    expect(document.querySelector('[data-row-action="mention"]')).toBeNull();
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
    expect(tokens()).toEqual([[`ib-mention:${FLAKY.id}`, FLAKY.title]]);
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

/** The browser's undo or redo putting the field's words back to `text` (its input event says which). */
function history(text: string, kind: 'historyUndo' | 'historyRedo') {
  act(() => {
    const el = field();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
    const event = new Event('input', { bubbles: true });
    Object.defineProperty(event, 'inputType', { value: kind });
    el.dispatchEvent(event);
  });
}

/** The caret put at `at` by a click or a key: the field hears it as the browser tells it (the release of the click). */
function caretMoved(at: number) {
  act(() => {
    field().focus();
    field().setSelectionRange(at, at);
    field().dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}

/** A paste of `text` with the caret at `at`. */
function pasteAt(text: string, at: number) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text, files: [], items: [], types: ['text/plain'] } });
  act(() => {
    field().focus();
    field().setSelectionRange(at, at);
    field().dispatchEvent(event);
  });
}

describe.skipIf(!hasDom)('undo, redo and the caret never lose a mention silently', () => {
  test('⌘Z after Backspace took a mention brings the mention back, not only its words; redo takes it again', () => {
    draw(<Box initial="See " />);
    act(() => requestMention(HERE, [FLAKY]));
    const withIt = words;
    const end = withIt.indexOf(FLAKY.title) + FLAKY.title.length;
    act(() => {
      field().focus();
      field().setSelectionRange(end, end);
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    });
    const without = words;
    expect(tokens()).toEqual([]);
    history(withIt, 'historyUndo');
    expect(tokens()).toEqual([[`ib-mention:${FLAKY.id}`, FLAKY.title]]);
    expect(replyWordsWithMentions(HERE, words.trim())).toContain(W.inline(1, FLAKY.id));
    history(without, 'historyRedo');
    expect(tokens()).toEqual([]);
    history(withIt, 'historyUndo');
    expect(tokens()).toEqual([[`ib-mention:${FLAKY.id}`, FLAKY.title]]);
  });

  test('undo of a mention put in takes it out, and redo brings it back as a mention; the same words typed by hand stay words', () => {
    draw(<Box initial="See " />);
    const before = words;
    act(() => requestMention(HERE, [FLAKY]));
    const withIt = words;
    history(before, 'historyUndo');
    expect(tokens()).toEqual([]);
    history(withIt, 'historyRedo');
    expect(tokens()).toEqual([[`ib-mention:${FLAKY.id}`, FLAKY.title]]);
    // Typed, not undone: words never become a mention.
    type(before);
    type(withIt);
    expect(tokens()).toEqual([]);
  });

  test('words retyped by hand after Backspace took the mention stay words when undo or redo comes back to them', () => {
    draw(<Box initial="See " />);
    act(() => requestMention(HERE, [FLAKY]));
    const withIt = words;
    const end = withIt.indexOf(FLAKY.title) + FLAKY.title.length;
    act(() => {
      field().focus();
      field().setSelectionRange(end, end);
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    });
    expect(tokens()).toEqual([]);
    // The same title, typed by hand: the same words as when they held the mention.
    type(withIt);
    type(`${withIt}ok`);
    history(withIt, 'historyUndo');
    expect(tokens()).toEqual([]);
    history(`${withIt}ok`, 'historyRedo');
    history(withIt, 'historyUndo');
    expect(tokens()).toEqual([]);
    expect(replyWordsWithMentions(HERE, words.trim())).not.toContain(FLAKY.id);
  });

  test('two threads with the same label, one after the other at the same place: undo to those words brings back neither, never the wrong one', () => {
    const TWIN: MentionRef = { id: idOf('01JD5TW1N'), title: FLAKY.title, project: null };
    draw(<Box initial="See " />);
    act(() => requestMention(HERE, [FLAKY]));
    const withIt = words;
    const end = withIt.indexOf(FLAKY.title) + FLAKY.title.length;
    act(() => {
      field().focus();
      field().setSelectionRange(end, end);
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    });
    const without = words;
    act(() => requestMention(HERE, [TWIN]));
    expect(words).toBe(withIt);
    expect(tokens()).toEqual([[`ib-mention:${TWIN.id}`, TWIN.title]]);
    // Back past the twin to the first mention's words: they held two threads, so neither comes back.
    history(without, 'historyUndo');
    expect(tokens()).toEqual([]);
    history(withIt, 'historyUndo');
    expect(tokens()).toEqual([]);
    expect(replyWordsWithMentions(HERE, words.trim())).not.toContain(TWIN.id);
  });

  test('a caret put inside a mention goes to its nearer edge, and from an edge a step in goes across it; typing then lands beside it', () => {
    draw(<Box initial="See " />);
    act(() => requestMention(HERE, [FLAKY]));
    const start = words.indexOf(FLAKY.title);
    const end = start + FLAKY.title.length;
    caretMoved(start + 3);
    expect(field().selectionStart).toBe(start);
    caretMoved(end - 2);
    expect(field().selectionStart).toBe(end);
    // From its start edge one step right goes across it; from its end one step left goes back across it.
    caretMoved(start);
    caretMoved(start + 1);
    expect(field().selectionStart).toBe(end);
    caretMoved(end - 1);
    expect(field().selectionStart).toBe(start);
    // Typing where the caret now is (its start) puts the words before it; the mention stands.
    const at = field().selectionStart;
    type(`${words.slice(0, at)}X${words.slice(at)}`);
    expect(tokens()).toEqual([[`ib-mention:${FLAKY.id}`, FLAKY.title]]);
  });

  test('a thread link pasted with the caret inside a mention goes in beside it, and every other mention stands', () => {
    draw(<Box initial="See " />);
    act(() => requestMention(HERE, [FLAKY]));
    act(() => requestMention(HERE, [RATE]));
    // Four letters into it: its start is the nearer edge, so the new one goes in before it.
    const inside = words.indexOf(FLAKY.title) + 4;
    pasteAt(`http://localhost:19432/#thread=${OLD.id}`, inside);
    expect(tokens().map(([, label]) => label)).toEqual([OLD.title, FLAKY.title, RATE.title]);
    const sent = replyWordsWithMentions(HERE, words.trim());
    for (const ref of [FLAKY, OLD, RATE]) expect(sent).toContain(ref.id);
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

/** A list 300 px tall at y 100..400 holding 1000 px of rows, scrolled to `top` (happy-dom lays nothing out). */
function list(top: number) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { value: 1000 });
  Object.defineProperty(el, 'clientHeight', { value: 300 });
  el.scrollTop = top;
  el.getBoundingClientRect = () => ({ left: 0, right: 300, top: 100, bottom: 400, width: 300, height: 300, x: 0, y: 100, toJSON: () => null }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

describe.skipIf(!hasDom)('the list scrolls while a thread is held near its edge', () => {
  test('up near the top, down near the bottom, faster nearer the edge; not in the middle, outside it or past its end', () => {
    const el = list(200);
    expect(scrollStep(el, 150, 102)).toBeLessThan(scrollStep(el, 150, 140));
    expect(scrollStep(el, 150, 140)).toBeLessThan(0);
    expect(scrollStep(el, 150, 398)).toBeGreaterThan(scrollStep(el, 150, 360));
    expect(scrollStep(el, 150, 360)).toBeGreaterThan(0);
    expect(scrollStep(el, 150, 250)).toBe(0);
    expect(scrollStep(el, 320, 102)).toBe(0);
    expect(scrollStep(list(0), 150, 102)).toBe(0);
    expect(scrollStep(list(700), 150, 398)).toBe(0);
  });

  test('a held thread scrolls the list, but not while a drop target is under the pointer', async () => {
    draw(<Box />);
    const el = list(200);
    const row = document.createElement('button');
    el.appendChild(row);
    const at = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, buttons: 1, pointerType: 'mouse', pointerId: 1, bubbles: true });
    act(() => pressThreadRow(new PointerEvent('pointerdown', at(150, 250)), { ids: () => [FLAKY.id], label: () => 'thread', rows: () => [row], spoken: () => 'Picked up.', scroller: () => el }, document.querySelector('.pn-inbox')!));
    setThreadDragHitTestForTests(() => field());
    act(() => void window.dispatchEvent(new PointerEvent('pointermove', at(150, 104))));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(el.scrollTop).toBe(200);
    setThreadDragHitTestForTests(() => el);
    act(() => void window.dispatchEvent(new PointerEvent('pointermove', at(150, 104))));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(el.scrollTop).toBeLessThan(200);
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    const stopped = el.scrollTop;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(el.scrollTop).toBe(stopped);
    el.remove();
  });
});

describe.skipIf(!hasDom)('after Send', () => {
  test('the person\'s sent message shows the mention as a link that opens the thread, not the agent\'s words', () => {
    draw(<Box initial="Same as " />);
    act(() => requestMention(HERE, [FLAKY]));
    const sent = replyWordsWithMentions(HERE, words.trim());
    expect(sent).toContain(W.inline(1, FLAKY.id));
    act(() => root!.render(<div className="ib-body"><InlineMarkdown text={linkInboxThreadMentions(sent)} /></div>));
    const link = document.querySelector<HTMLAnchorElement>('a[href^="#thread="]')!;
    expect(link.getAttribute('href')).toBe(inboxThreadMentionHref(FLAKY.id));
    expect(link.textContent).toBe(FLAKY.title);
    expect(document.body.textContent).not.toContain(FLAKY.id);
  });

  test('the link wraps on a phone, and only a mention\'s link takes its paint (other thread links stay as they are)', async () => {
    const css = await Bun.file(new URL('./inbox.css', import.meta.url)).text();
    const rule = css.split('\n').find((line) => line.startsWith('.pn-inbox .ib-body a[href^="#thread="]') && line.includes('{'))!;
    expect(rule).toContain('[href$="&mention"] {');
    expect(rule).not.toContain('nowrap');
    expect(rule).toContain('box-decoration-break: clone');
    expect(css).not.toMatch(/\.ib-body a\[href\^="#thread="\]\s*[{:]/);
  });
});

describe.skipIf(!hasDom)('the mentions are the draft\'s, not words', () => {
  test('a title typed by hand is plain words; words typed after a mention never join it', () => {
    draw(<Box initial="" />);
    type(`${FLAKY.title} `);
    expect(tokens()).toEqual([]);
    act(() => requestMention(HERE, [FLAKY]));
    type(`${words}then Flaky login test on CIDR`);
    expect(tokens()).toEqual([[`ib-mention:${FLAKY.id}`, FLAKY.title]]);
    expect(replyWordsWithMentions(HERE, words.trim()).split(W.inline(1, FLAKY.id)).length).toBe(2);
  });

  test('a draft opened on another device shows its mentions, and the Send writes those same ones', () => {
    const body = `Same cause as ${FLAKY.title}.`;
    noteDraftMentions(HERE, { body, mentions: [{ thread_id: FLAKY.id, title: FLAKY.title, label: FLAKY.title, at: 14 }] });
    draw(<Box initial={body} />);
    expect(tokens()).toEqual([[`ib-mention:${FLAKY.id}`, FLAKY.title]]);
    expect(replyWordsWithMentions(HERE, words)).toContain(W.inline(1, FLAKY.id));
  });

  test('after a Send (or Discard) the same words typed again are plain', () => {
    draw(<Box initial="See " />);
    act(() => requestMention(HERE, [FLAKY]));
    const text = words;
    act(() => clearReplyMentions(HERE));
    type('');
    type(text);
    expect(tokens()).toEqual([]);
    expect(replyWordsWithMentions(HERE, words)).toBe(words);
  });

  test('a mention the reply\'s agent cannot open (another machine\'s) is said under the field before Send', () => {
    setSelfMachine(`ibx_${'01JD5SE1F'.padEnd(26, '0')}`);
    rememberMachine([HERE], `ibx_${'01JD5THER'.padEnd(26, '0')}`);
    draw(<Box initial="See " />);
    act(() => requestMention(HERE, [{ ...FLAKY, machine: null }]));
    const note = document.querySelector('[data-mention-unreadable]');
    expect(note?.textContent).toContain(FLAKY.title);
    expect(field().getAttribute('aria-describedby')).toContain(note!.id);
    expect(replyWordsWithMentions(HERE, words)).toContain(W.unreadable);
  });

  test('a link the window must read first pastes as words, and becomes the mention only where it still stands', async () => {
    let answer: (value: Response) => void = () => {};
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      String(input).includes(`/threads/${LATE.id}`)
        ? new Promise<Response>((resolve) => (answer = resolve))
        : Response.json({ skills: [] })) as unknown as typeof fetch;
    draw(<Box initial="Like " />);
    const link = `http://localhost:19432/#thread=${LATE.id}`;
    // Not a thread the window holds: the browser pastes the words (here, as it would), and the read goes out.
    expect(pasteIn({ text: link }, 5)).toBe(true);
    type(`Like ${link}`);
    // The person keeps typing before it while the read is out.
    type(`Very much like ${link}`);
    await act(async () => {
      answer(Response.json({ thread: { thread_id: LATE.id, thread_name: LATE.title, subject: null, resolved_at: '2026-11-01T00:00:00.000Z', project: null, messages: [] }, row: null }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(words).toBe(`Very much like ${LATE.title} `);
    expect(tokens()).toEqual([[`ib-mention-archived:${LATE.id}`, LATE.title]]);
  });

  test('an edited link waiting for its read stays words, and nothing else is taken out', async () => {
    let answer: (value: Response) => void = () => {};
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      String(input).includes(`/threads/${LATE.id}`)
        ? new Promise<Response>((resolve) => (answer = resolve))
        : Response.json({ skills: [] })) as unknown as typeof fetch;
    draw(<Box initial="Like " />);
    const link = `http://localhost:19432/#thread=${LATE.id}`;
    expect(pasteIn({ text: link }, 5)).toBe(true);
    type(`Like ${link}`);
    type(`Like ${link.slice(0, -3)} and more`);
    await act(async () => {
      answer(Response.json({ thread: { thread_id: LATE.id, thread_name: LATE.title, subject: null, resolved_at: null, project: null, messages: [] }, row: null }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(words).toBe(`Like ${link.slice(0, -3)} and more`);
    expect(tokens()).toEqual([]);
  });
});

describe.skipIf(!hasDom)('a press whose release was lost', () => {
  test('a move with no button held never starts a drag', () => {
    draw(<Box initial="Keep me." />);
    const row = document.createElement('button');
    document.body.appendChild(row);
    const at = (x: number, y: number, buttons: number) => ({ clientX: x, clientY: y, button: 0, buttons, pointerType: 'mouse', pointerId: 1, bubbles: true });
    act(() => pressThreadRow(new PointerEvent('pointerdown', at(0, 0, 1)), { ids: () => [FLAKY.id], label: () => 'thread', rows: () => [row], spoken: () => 'Picked up.' }, document.querySelector('.pn-inbox')!));
    // The release went to another window: the next moves come with no button held.
    act(() => void window.dispatchEvent(new PointerEvent('pointermove', at(40, 40, 0))));
    act(() => void window.dispatchEvent(new PointerEvent('pointermove', at(80, 80, 1))));
    expect(box().hasAttribute('data-thread-drop')).toBe(false);
    expect(document.querySelector('[data-thread-ghost]')).toBeNull();
  });
});
