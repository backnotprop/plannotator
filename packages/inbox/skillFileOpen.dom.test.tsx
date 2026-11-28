/**
 * A skill the person's sent message used opens as its file beside the thread: the chip in the sent words and the
 * name on the skills line each open the skill's SKILL.md read only in the referenced file's pane (SkillFilePane),
 * with Escape or Close giving focus back to what was pressed. A skill no longer on any computer says so in the pane.
 * The reply box's chip is the words being written: it has no such control.
 *
 * The failures this catches: the chip or the name drawn as plain text again (nothing opens), a click that selected
 * words opening the file, a double-click leaving the file open and its words unselected (or an entry the browser's
 * Back reopens it from), an offline or silent linked computer holding the pane, a built-in asked of another computer, the chips' buttons coming
 * after the skills line in the tab order, comment tools on a skill's file, focus going back to a stale chip after
 * Back or another thread, a linked computer's skill reading as missing (either way round), the copy from where the
 * reply was not written winning, a cut copy shown as whole, and an open control creeping into the reply box.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No Inbox is started: fetch is stubbed.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { composeInboxSkillsBlock } from '@plannotator/core/inbox-skills-compose';
import { INBOX_REPLY_SKILL_AUDIENCE } from '@plannotator/core/skill-reference-block';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { MessageBody } = (hasDom ? await import('./parts/MessageBody/MessageBody') : {}) as typeof import('./parts/MessageBody/MessageBody');
const { ReferencedFilePane } = (hasDom ? await import('./components/ReferencedFilePane') : {}) as typeof import('./components/ReferencedFilePane');
const { InboxComposerField } = (hasDom ? await import('./components/ComposerField') : {}) as typeof import('./components/ComposerField');
const catalog = (hasDom ? await import('@plannotator/ui/utils/skillCatalog') : {}) as typeof import('@plannotator/ui/utils/skillCatalog');
const { readSkillFile } = (hasDom ? await import('./data/skillFile') : {}) as typeof import('./data/skillFile');
const { resetMachineRoutes, setSelfMachine } = (hasDom ? await import('./inboxUrl') : {}) as typeof import('./inboxUrl');
const { skillOpenerNow } = (hasDom ? await import('./skillOpener') : {}) as typeof import('./skillOpener');
const routes = (hasDom
  ? { ...(await import('./app/route')), ...(await import('./app/writeRoute')), ...(await import('./app/focus')) }
  : {}) as typeof import('./app/route') & typeof import('./app/writeRoute') & typeof import('./app/focus');

const ID = 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ';
const OTHER_THREAD = 'msg_01K7YYYYYYYYYYYYYYYYYYYYYY';
const SELF = 'ibx_01K7AAAAAAAAAAAAAAAAAAAAAA';
const STUDIO = 'ibx_01K7BBBBBBBBBBBBBBBBBBBBBB';
const SKILLS: SkillCatalogEntry[] = [
  { name: 'picture-it', root: 'plannotator', description: 'Show it in pictures', humanOnly: true },
  { name: 'readback', root: 'claude', description: 'State the request back', humanOnly: false },
];
/** What this computer's `skills/file` answers, by name. */
let HERE: Record<string, unknown> = {};
/** What the linked computer's `skills/content` answers, by name (absent: 404). */
let THERE: Record<string, { content: string; truncated?: boolean }> = {};

let host: HTMLElement | null = null;
let root: Root | null = null;
const restores: (() => void)[] = [];
const asked: string[] = [];
/** The reads of an asleep computer that were dropped (aborted). */
const dropped: string[] = [];
const ASLEEP = 'ibx_01K7CCCCCCCCCCCCCCCCCCCCCC';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  if (!hasDom) return;
  asked.length = 0;
  HERE = {
    'picture-it': { found: true, name: 'picture-it', source: 'plannotator', root: 'plannotator', text: '# Picture it\n\nOne page of big pictures for the harbor checkout.\n' },
    readback: { found: true, name: 'readback', source: 'own', root: 'claude', text: '---\nname: readback\ndescription: State the request back.\n---\n\n# Readback\n\nSay back what Charlie Dunn asked for.\n' },
  };
  THERE = {};
  const realFetch = globalThis.fetch;
  dropped.length = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    asked.push(`${url.pathname}${url.search}`);
    const name = url.searchParams.get('name') ?? '';
    // An asleep computer: its door never answers; the read is only ever dropped.
    if (url.pathname.startsWith(`/api/inbox/m/${ASLEEP}/`)) {
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => {
          dropped.push(`${url.pathname}${url.search}`);
          reject(new DOMException('Aborted', 'AbortError'));
        }),
      );
    }
    if (url.pathname === '/api/inbox/skills/file') return Promise.resolve(json(HERE[name] ?? { found: false }));
    if (url.pathname === `/api/inbox/m/${STUDIO}/skills/content`) {
      const skill = THERE[name];
      return Promise.resolve(skill ? json({ skill: { name, dir: `/studio/skills/${name}`, path: `/studio/skills/${name}/SKILL.md`, content: skill.content, truncated: skill.truncated === true, humanOnly: false } }) : json({ error: 'Not found' }, 404));
    }
    return Promise.resolve(json({ error: 'Not found' }, 404));
  }) as typeof fetch;
  restores.push(() => (globalThis.fetch = realFetch));
  // happy-dom lays nothing out: each chip's words get a box, as a browser gives them.
  const rects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [{ left: 12, top: 4, width: 72, height: 18, right: 84, bottom: 22, x: 12, y: 4 }],
  });
  restores.push(() => (rects ? Object.defineProperty(Range.prototype, 'getClientRects', rects) : delete (Range.prototype as { getClientRects?: unknown }).getClientRects));
  catalog.resetSkillCatalogCache();
  catalog.setSkillCatalogTransport(async () => SKILLS);
  restores.push(() => {
    catalog.resetSkillCatalogTransport();
    catalog.resetSkillCatalogCache();
  });
  restores.push(() => resetMachineRoutes());
});

afterEach(async () => {
  if (!hasDom) return;
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  for (const restore of restores.splice(0).reverse()) restore();
  for (const el of document.querySelectorAll('.annotation-toolbar, [data-comment-popover]')) el.remove();
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

/** What the person sent: their words, then the block the window composed at Send. */
function sent(words: string, refs: SkillCatalogEntry[], extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  const contents = new Map(refs.filter((r) => r.humanOnly).map((r) => [r.name, { content: 'Draw it as pictures for Bob Tully.', truncated: false, dir: '/home/skills/x', path: '/home/skills/x/SKILL.md' }]));
  return {
    id: ID,
    thread_id: ID,
    project_id: 'prj_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    author: { kind: 'person' },
    body: `${words}\n\n${composeInboxSkillsBlock(refs, contents, INBOX_REPLY_SKILL_AUDIENCE)}`,
    attachments: [],
    questions: [],
    ...extra,
  } as unknown as InboxMessageWire;
}

let switchThread: (thread: string) => void = () => {};

/** The thread's message and the pane beside it, as Thread draws them for a `skill` ref. */
function Harness({ message }: { message: InboxMessageWire }) {
  const [open, setOpen] = useState<string | null>(null);
  const [thread, setThread] = useState(ID);
  switchThread = setThread;
  return (
    <>
      <MessageBody message={message} projectRoot="/work/harbor" onOpenAttachment={() => {}} onOpenSkill={setOpen} readOnly={false} answers={new Map()} onPick={() => {}} footerFor={() => null} />
      {open && (
        <ReferencedFilePane
          threadId={thread}
          fileRef={{ path: open, messageId: ID, skill: true }}
          skillMessage={message}
          phone={false}
          full={false}
          onOpen={() => {}}
          onClose={() => setOpen(null)}
          onAttached={() => {}}
        />
      )}
    </>
  );
}

/** The same, opened and closed through the window's address as the Inbox does (a new entry, `closeTo`). */
function RoutedHarness({ message }: { message: InboxMessageWire }) {
  const [ref, setRef] = useState(() => routes.readRoute().ref ?? null);
  useEffect(() => {
    const read = () => setRef(routes.readRoute().ref ?? null);
    window.addEventListener('hashchange', read);
    window.addEventListener('popstate', read);
    return () => {
      window.removeEventListener('hashchange', read);
      window.removeEventListener('popstate', read);
    };
  }, []);
  return (
    <>
      <MessageBody
        message={message}
        projectRoot="/work/harbor"
        onOpenAttachment={() => {}}
        onOpenSkill={(name) => routes.writeRoute({ ...routes.readRoute(), ref: { path: name, messageId: ID, skill: true } })}
        readOnly={false}
        answers={new Map()}
        onPick={() => {}}
        footerFor={() => null}
      />
      {ref?.skill && (
        <ReferencedFilePane threadId={ID} fileRef={ref} skillMessage={message} phone={false} full={false} onOpen={() => {}} onClose={() => routes.closeTo({ ...routes.readRoute(), ref: null })} onAttached={() => {}} />
      )}
    </>
  );
}

async function draw(message: InboxMessageWire, routed = false) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(routed ? <RoutedHarness message={message} /> : <Harness message={message} />);
  });
  await settle(() => host!.querySelector('[data-skill-chips] [data-skill-open]') !== null);
}

async function settle(done: () => boolean) {
  for (let i = 0; i < 60 && !done(); i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
}

const pane = () => host!.querySelector<HTMLElement>('[data-skill-file]');
const chip = (name: string) => host!.querySelector<HTMLButtonElement>(`[data-skill-chips] [data-skill-open="${name}"]`);
const lineName = (name: string) => host!.querySelector<HTMLButtonElement>(`[data-skills-line] [data-skill-open="${name}"]`);

/** The element holding `phrase` in the message's words. */
function wordsWith(phrase: string): HTMLElement {
  const walker = document.createTreeWalker(host!.querySelector('[data-message-id]')!, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(phrase)) return n.parentElement!;
  throw new Error(`"${phrase}" is not in the words`);
}

/** A mouse press on the words at (20, 10), inside the chip's box: down, up, click; `detail` counts the clicks. */
async function pressWords(target: HTMLElement, detail = 1, at = { x: 20, y: 10 }) {
  const init = { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 0, detail };
  await act(async () => {
    target.dispatchEvent(new MouseEvent('pointerdown', init));
    target.dispatchEvent(new MouseEvent('mousedown', init));
    target.dispatchEvent(new MouseEvent('mouseup', init));
    target.dispatchEvent(new MouseEvent('click', init));
  });
}

/** Select `phrase` inside `scope` the way a drag does, and let the viewer hear the pointer go up. */
async function select(scope: HTMLElement, phrase: string) {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(phrase)) node = n as Text;
  if (!node) throw new Error(`"${phrase}" is not in ${scope.tagName}`);
  const at = node.textContent!.indexOf(phrase);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + phrase.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  const article = node.parentElement!.closest('article') ?? node.parentElement!;
  await act(async () => {
    article.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 30)));
}

test.skipIf(!hasDom)("the chip's button (Enter, Space) opens the skill's SKILL.md beside the thread, and Escape gives focus back to it", async () => {
  await draw(sent('/picture-it show me how it works', [SKILLS[0]!]));
  const button = chip('picture-it');
  expect(button?.tagName).toBe('BUTTON');
  expect(button!.tabIndex).toBe(0);
  expect(button!.getAttribute('aria-label')).toBe('Open picture-it');
  button!.focus();
  await act(async () => button!.click());
  await settle(() => pane()?.querySelector('[data-skill-doc]') !== null);
  expect(asked).toContain('/api/inbox/skills/file?name=picture-it');
  expect(pane()!.getAttribute('data-skill-file')).toBe('picture-it');
  expect(pane()!.querySelector('[data-header-from]')!.textContent).toBe('Plannotator skill');
  expect(pane()!.textContent).toContain('One page of big pictures for the harbor checkout.');

  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await settle(() => document.activeElement === chip('picture-it'));
  expect(pane()).toBeNull();
  expect(document.activeElement).toBe(chip('picture-it'));
});

test.skipIf(!hasDom)("a skill's file takes no comments: selecting its words offers no comment tools", async () => {
  await draw(sent('/picture-it show me how it works', [SKILLS[0]!]));
  await act(async () => chip('picture-it')!.click());
  await settle(() => pane()?.querySelector('[data-skill-doc]') !== null);
  await select(pane()!.querySelector('[data-skill-doc]')!, 'big pictures');
  expect(document.querySelector('.annotation-toolbar')).toBeNull();
  // The selection is the person's to copy: nothing took it for a comment.
  expect(window.getSelection()!.toString()).toBe('big pictures');
});

test.skipIf(!hasDom)('a plain click on the chip in the words opens it; a click that selected words, or one beside the chip, opens nothing', async () => {
  await draw(sent('/picture-it show me how it works', [SKILLS[0]!]));
  const words = wordsWith('/picture-it');

  await select(host!.querySelector('[data-message-id]')!, 'picture-it show');
  await act(async () => words.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 20, clientY: 10, button: 0, detail: 1 })));
  await settle(() => pane() !== null);
  expect(pane()).toBeNull();
  window.getSelection()!.removeAllRanges();

  await pressWords(words, 1, { x: 200, y: 10 });
  await settle(() => pane() !== null);
  expect(pane()).toBeNull();

  await pressWords(words);
  await settle(() => pane()?.querySelector('[data-skill-doc]') !== null);
  expect(pane()!.getAttribute('data-skill-file')).toBe('picture-it');
});

test.skipIf(!hasDom)("a double-click on the chip takes back its first click's open and selects the chip's words; the browser's Back then opens no file", async () => {
  const href = window.location.href;
  restores.push(() => window.history.replaceState(null, '', href));
  window.history.replaceState(null, '', `#thread=${ID}`);
  const before = window.location.hash;
  await draw(sent('/picture-it show me how it works', [SKILLS[0]!]), true);
  const words = wordsWith('/picture-it');
  await pressWords(words, 1);
  await settle(() => pane() !== null);
  expect(pane()).not.toBeNull();
  expect(window.location.hash).not.toBe(before);
  // The open moved the words (the file took half the window): the second press lands outside the message.
  const elsewhere = document.createElement('div');
  document.body.appendChild(elsewhere);
  await pressWords(elsewhere, 2);
  await settle(() => pane() === null && window.location.hash === before);
  expect(pane()).toBeNull();
  expect(window.location.hash).toBe(before);
  expect(window.getSelection()!.toString()).toBe('/picture-it');
  expect(skillOpenerNow()).toBeNull();

  // History is as it was before the first click: Back never lands on the open the double-click took back.
  await act(async () => window.history.back());
  for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 20)));
  expect(pane()).toBeNull();
  expect(window.location.hash).not.toContain('skill');
});

test.skipIf(!hasDom)("a double-click on the chip of a file already open changes nothing: the file stays, history stays", async () => {
  const href = window.location.href;
  restores.push(() => window.history.replaceState(null, '', href));
  window.history.replaceState(null, '', `#thread=${ID}`);
  await draw(sent('/picture-it show me how it works', [SKILLS[0]!]), true);
  const words = wordsWith('/picture-it');
  await pressWords(words, 1);
  await settle(() => pane()?.querySelector('[data-skill-doc]') !== null);
  const open = window.location.hash;
  // Some time later: a double-click on the same chip, its first click opening what is open already.
  await act(async () => new Promise((r) => setTimeout(r, 600)));
  await pressWords(words, 1);
  await pressWords(words, 2);
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 20)));
  expect(window.location.hash).toBe(open);
  expect(pane()).not.toBeNull();
});

test.skipIf(!hasDom)("the name on the skills line opens that skill too, named as the chips are, after them in the tab order; Close gives focus back to the name", async () => {
  await draw(sent('/picture-it first, then $readback it.', [SKILLS[0]!, SKILLS[1]!]));
  const name = lineName('readback');
  expect(name?.tagName).toBe('BUTTON');
  expect(name!.textContent).toBe('readback');
  expect(name!.getAttribute('aria-label')).toBe('Open readback');
  const order = [...host!.querySelectorAll<HTMLElement>('[data-skill-open]')].filter((el) => el.tabIndex >= 0).map((el) => `${el.getAttribute('data-skill-place')}:${el.getAttribute('data-skill-open')}`);
  expect(order).toEqual(['words:picture-it', 'words:readback', 'line:picture-it', 'line:readback']);

  await act(async () => name!.click());
  await settle(() => pane()?.querySelector('[data-skill-doc]') !== null);
  expect(pane()!.getAttribute('data-skill-file')).toBe('readback');
  expect(pane()!.querySelector('[data-header-from]')!.textContent).toBe('Your skill');
  expect(pane()!.textContent).toContain('Say back what Charlie Dunn asked for.');

  await act(async () => pane()!.querySelector<HTMLButtonElement>('button[aria-label="Close readback"]')!.click());
  await settle(() => document.activeElement === lineName('readback'));
  expect(pane()).toBeNull();
  expect(document.activeElement).toBe(lineName('readback'));
});

test.skipIf(!hasDom)("the browser's Back, or another thread, forgets what opened the file: a later close sends focus nowhere stale", async () => {
  await draw(sent('/picture-it show me how it works', [SKILLS[0]!]));
  await act(async () => chip('picture-it')!.click());
  await settle(() => pane()?.querySelector('[data-skill-doc]') !== null);
  expect(skillOpenerNow()).toBe(chip('picture-it'));
  await act(async () => window.dispatchEvent(new Event('popstate')));
  expect(skillOpenerNow()).toBeNull();
  await act(async () => pane()!.querySelector<HTMLButtonElement>('button[aria-label="Close picture-it"]')!.click());
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 20)));
  expect(document.activeElement).not.toBe(chip('picture-it'));

  await act(async () => chip('picture-it')!.click());
  await settle(() => pane()?.querySelector('[data-skill-doc]') !== null);
  expect(skillOpenerNow()).toBe(chip('picture-it'));
  await act(async () => switchThread(OTHER_THREAD));
  await act(async () => new Promise((r) => setTimeout(r, 10)));
  expect(skillOpenerNow()).toBeNull();
});

test.skipIf(!hasDom)('a skill on no computer says so in the pane, with no error', async () => {
  await draw(sent('/fern-notes on the release', [{ name: 'fern-notes', root: 'claude', humanOnly: false }]));
  await act(async () => chip('fern-notes')!.click());
  await settle(() => pane()?.querySelector('[data-ref-missing]') !== null);
  expect(pane()!.querySelector('[data-ref-missing]')!.textContent).toBe('fern-notesis not on this computer.');
  expect(pane()!.querySelector('[role="alert"]')).toBeNull();
});

test.skipIf(!hasDom)("the reply box's chip is the words being written: no control opens a skill there", async () => {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<InboxComposerField value="/picture-it show me how it works" onChange={() => {}} placeholder="Reply" ariaLabel="Reply" destination="your reply" />);
  });
  await settle(() => host!.querySelector('[data-skill-ref-token="picture-it"]') !== null);
  const token = host!.querySelector<HTMLElement>('[data-skill-ref-token="picture-it"]');
  expect(token).not.toBeNull();
  expect(host!.querySelector('[data-skill-open], [data-skill-chips]')).toBeNull();
  await act(async () => token!.click());
  expect(asked.filter((path) => path.startsWith('/api/inbox/skills/file'))).toEqual([]);
});

// Linked computers: this one is "Harbor Mac", the linked one "Studio".
function linkStudio() {
  setSelfMachine(SELF, [
    { id: SELF, self: true, name: 'Harbor Mac' },
    { id: STUDIO, name: 'Studio', list_cursor: 1, state: 'online' },
  ]);
}
const studioContent = (name: string) => `/api/inbox/m/${STUDIO}/skills/content?name=${name}`;

test.skipIf(!hasDom)("this computer's thread, replied to from the linked computer with a skill only it has: that computer's copy", async () => {
  linkStudio();
  THERE = { 'studio-notes': { content: '# Studio notes\n\nWrite the fern-api notes.\n' } };
  const message = { body: sent('/studio-notes', [{ name: 'studio-notes', root: 'claude', humanOnly: false }]).body, sent_from: { kind: 'machine', name: 'Studio' } };
  const view = await readSkillFile('studio-notes', { thread: null, message });
  expect(view).toEqual({ found: true, name: 'studio-notes', source: 'own', text: '# Studio notes\n\nWrite the fern-api notes.\n', tooLarge: false, machine: STUDIO });
  // Where it was written is read first.
  expect(asked[0]).toBe(studioContent('studio-notes'));

  // No record of where it was written: here first, then the linked computer.
  asked.length = 0;
  expect(await readSkillFile('studio-notes', { thread: null, message: { body: message.body } })).toMatchObject({ found: true, machine: STUDIO });
  expect(asked).toEqual(['/api/inbox/skills/file?name=studio-notes', studioContent('studio-notes')]);
});

test.skipIf(!hasDom)("the linked computer's thread, replied to in its own window: its copy wins over this computer's skill of the same name", async () => {
  linkStudio();
  THERE = { readback: { content: '# Readback\n\nStudio says it back to Bob Tully.\n' } };
  const message = { body: sent('$readback', [SKILLS[1]!]).body, sent_from: { kind: 'here' } };
  const view = await readSkillFile('readback', { thread: STUDIO, message });
  expect(view).toMatchObject({ found: true, machine: STUDIO, text: '# Readback\n\nStudio says it back to Bob Tully.\n' });
  expect(asked[0]).toBe(studioContent('readback'));

  // Typed here and forwarded: this computer's own file, though the thread's machine has one too.
  asked.length = 0;
  const here = await readSkillFile('readback', { thread: STUDIO, message: { ...message, sent_from: { kind: 'machine', name: 'Harbor Mac' } } });
  expect(here).toMatchObject({ found: true, machine: null, text: expect.stringContaining('Say back what Charlie Dunn asked for.') });
  expect(asked[0]).toBe('/api/inbox/skills/file?name=readback');

  // Not here: the thread's machine is read.
  asked.length = 0;
  THERE = { 'fern-check': { content: '# Fern check\n' } };
  expect(await readSkillFile('fern-check', { thread: STUDIO, message: { body: message.body } })).toMatchObject({ found: true, machine: STUDIO, text: '# Fern check\n' });
});

test.skipIf(!hasDom)("a linked computer's copy cut at its cap shows as too large, never silently short; a skill on no computer shows what the message carried", async () => {
  linkStudio();
  THERE = { long: { content: '# Long\n\nThe first part only.', truncated: true } };
  expect(await readSkillFile('long', { thread: STUDIO, message: null })).toMatchObject({ found: true, machine: STUDIO, text: null, tooLarge: true });

  THERE = {};
  const message = { body: sent('/drawn-only', [{ name: 'drawn-only', root: 'claude', humanOnly: true }]).body };
  expect(await readSkillFile('drawn-only', { thread: null, message })).toEqual({ found: true, name: 'drawn-only', source: 'own', text: 'Draw it as pictures for Bob Tully.', tooLarge: false, machine: null, sent: true });
  expect(await readSkillFile('drawn-only', { thread: null, message: null })).toEqual({ found: false });
});

// A second linked computer, "Attic", asleep: its door never answers.
function linkAttic(state: string) {
  setSelfMachine(SELF, [
    { id: SELF, self: true, name: 'Harbor Mac' },
    { id: STUDIO, name: 'Studio', list_cursor: 1, state: 'online' },
    { id: ASLEEP, name: 'Attic', list_cursor: 1, state },
  ]);
}
const atticContent = (name: string) => `/api/inbox/m/${ASLEEP}/skills/content?name=${name}`;

test.skipIf(!hasDom)("a reply written on a linked computer that is offline now: the pane shows this computer's copy at once, never waiting on that one", async () => {
  linkAttic('offline');
  const message = sent('$readback it', [SKILLS[1]!], { sent_from: { kind: 'machine', name: 'Attic' } } as Partial<InboxMessageWire>);
  await draw(message);
  await act(async () => chip('readback')!.click());
  await settle(() => pane()?.querySelector('[data-skill-doc]') !== null);
  expect(pane()!.textContent).toContain('Say back what Charlie Dunn asked for.');
  // Offline, or still connecting: not asked at all.
  expect(asked.filter((path) => path.startsWith(`/api/inbox/m/${ASLEEP}/`))).toEqual([]);
  linkAttic('connecting');
  asked.length = 0;
  expect(await readSkillFile('readback', { thread: null, message })).toMatchObject({ found: true, machine: null });
  expect(asked.filter((path) => path.startsWith(`/api/inbox/m/${ASLEEP}/`))).toEqual([]);
});

test.skipIf(!hasDom)('linked computers are asked at once: the first found in order wins, one that does not answer is waited on only briefly and dropped', async () => {
  linkAttic('online');
  // Online but not answering, and where the reply was written: read first, so waited on for its short time only.
  const written = { body: sent('$readback', [SKILLS[1]!]).body, sent_from: { kind: 'machine', name: 'Attic' } };
  const started = Date.now();
  expect(await readSkillFile('readback', { thread: null, message: written }, 80)).toMatchObject({ found: true, machine: null, text: expect.stringContaining('Charlie Dunn') });
  expect(Date.now() - started).toBeLessThan(2000);
  expect(asked.slice(0, 2)).toEqual([atticContent('readback'), '/api/inbox/skills/file?name=readback']);
  expect(dropped).toEqual([atticContent('readback')]);

  // Found here, ahead of it in the order: returned at once, and its read dropped.
  asked.length = 0;
  dropped.length = 0;
  expect(await readSkillFile('readback', { thread: null, message: { body: written.body } })).toMatchObject({ found: true, machine: null });
  expect(asked).toContain(atticContent('readback'));
  expect(dropped).toEqual([atticContent('readback')]);

  // Not here: the next in order that has it (Studio) is kept, however Attic fares.
  asked.length = 0;
  THERE = { 'fern-check': { content: '# Fern check\n' } };
  expect(await readSkillFile('fern-check', { thread: null, message: null }, 80)).toMatchObject({ found: true, machine: STUDIO, source: 'own' });
});

test.skipIf(!hasDom)("a built-in skill is never asked of another computer (its door never serves one), so it is never another computer's \"Your skill\"", async () => {
  linkStudio();
  THERE = { 'picture-it': { content: '# Someone else\n' } };
  expect(await readSkillFile('picture-it', { thread: STUDIO, message: null })).toMatchObject({ found: true, source: 'plannotator', machine: null });
  delete HERE['picture-it'];
  expect(await readSkillFile('picture-it', { thread: STUDIO, message: null })).toEqual({ found: false });
  expect(asked.filter((path) => path.includes('/skills/content'))).toEqual([]);
});
