/**
 * A skill the person's sent message used opens as its file beside the thread: the chip in the sent words and the
 * name on the skills line are real buttons, each opening the skill's SKILL.md read only in the referenced file's pane
 * (SkillFilePane), with Escape or Close giving focus back to what was pressed. A skill no longer on this computer says
 * so in the pane. The reply box's chip is the words being written: it has no such control.
 *
 * The failures this catches: the chip or the name drawn as plain text again (nothing opens), the pane showing the
 * wrong skill or nothing, focus lost to the page when the file closes, comment tools on a skill's file, and an open
 * control creeping into the reply box.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No Inbox is started: fetch is stubbed.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
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

const ID = 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ';
const SKILLS: SkillCatalogEntry[] = [
  { name: 'picture-it', root: 'plannotator', description: 'Show it in pictures', humanOnly: true },
  { name: 'readback', root: 'claude', description: 'State the request back', humanOnly: false },
];
const FILES: Record<string, unknown> = {
  'picture-it': { found: true, name: 'picture-it', source: 'plannotator', root: 'plannotator', text: '# Picture it\n\nOne page of big pictures for the harbor checkout.\n', other_files: 0 },
  readback: { found: true, name: 'readback', source: 'own', root: 'claude', text: '---\nname: readback\ndescription: State the request back.\n---\n\n# Readback\n\nSay back what Charlie Dunn asked for.\n', other_files: 2 },
};

let host: HTMLElement | null = null;
let root: Root | null = null;
const restores: (() => void)[] = [];
const asked: string[] = [];

beforeEach(() => {
  if (!hasDom) return;
  asked.length = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    asked.push(`${url.pathname}${url.search}`);
    const answer = url.pathname === '/api/inbox/skills/file' ? (FILES[url.searchParams.get('name') ?? ''] ?? { found: false }) : { error: 'Not found' };
    return Promise.resolve(new Response(JSON.stringify(answer), { headers: { 'Content-Type': 'application/json' } }));
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
});

afterEach(async () => {
  if (!hasDom) return;
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  for (const restore of restores.splice(0).reverse()) restore();
  document.body.replaceChildren();
});

/** What the person sent: their words, then the block the window composed at Send. */
function sent(words: string, refs: SkillCatalogEntry[]): InboxMessageWire {
  const contents = new Map(refs.filter((r) => r.humanOnly).map((r) => [r.name, { content: 'Draw it as pictures.', truncated: false, dir: '', path: '' }]));
  return {
    id: ID,
    thread_id: ID,
    project_id: 'prj_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    author: { kind: 'person' },
    body: `${words}\n\n${composeInboxSkillsBlock(refs, contents, INBOX_REPLY_SKILL_AUDIENCE)}`,
    attachments: [],
    questions: [],
  } as unknown as InboxMessageWire;
}

/** The thread's message and the pane beside it, as Thread draws them for a `skill` ref. */
function Harness({ message }: { message: InboxMessageWire }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <MessageBody message={message} projectRoot="/work/harbor" onOpenAttachment={() => {}} onOpenSkill={setOpen} readOnly={false} answers={new Map()} onPick={() => {}} footerFor={() => null} />
      {open && (
        <ReferencedFilePane threadId={ID} fileRef={{ path: open, messageId: ID, skill: true }} phone={false} full={false} onOpen={() => {}} onClose={() => setOpen(null)} onAttached={() => {}} />
      )}
    </>
  );
}

async function draw(message: InboxMessageWire) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Harness message={message} />);
  });
  await settle(() => host!.querySelector('[data-skill-chips] [data-skill-open]') !== null);
}

async function settle(done: () => boolean) {
  for (let i = 0; i < 60 && !done(); i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
}

const pane = () => host!.querySelector<HTMLElement>('[data-skill-file]');
const chip = (name: string) => host!.querySelector<HTMLButtonElement>(`[data-skill-chips] [data-skill-open="${name}"]`);
const lineName = (name: string) => host!.querySelector<HTMLButtonElement>(`[data-skills-line] [data-skill-open="${name}"]`);

test.skipIf(!hasDom)("the chip in the sent words opens the skill's SKILL.md beside the thread, read only, and Escape gives focus back to it", async () => {
  await draw(sent('/picture-it show me how it works', [SKILLS[0]!]));
  const button = chip('picture-it');
  expect(button?.tagName).toBe('BUTTON');
  expect(button!.tabIndex).toBe(0);
  button!.focus();
  await act(async () => button!.click());
  await settle(() => pane()?.querySelector('[data-skill-doc]') !== null);
  expect(asked).toContain('/api/inbox/skills/file?name=picture-it');
  expect(pane()!.getAttribute('data-skill-file')).toBe('picture-it');
  expect(pane()!.querySelector('[data-header-from]')!.textContent).toBe('Plannotator skill');
  expect(pane()!.textContent).toContain('One page of big pictures for the harbor checkout.');
  // Read only: no comment tools on a skill's file.
  expect(pane()!.querySelector('textarea, [data-annotation-toolbar], [data-comment-popover]')).toBeNull();

  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await settle(() => document.activeElement === chip('picture-it'));
  expect(pane()).toBeNull();
  expect(document.activeElement).toBe(chip('picture-it'));
});

test.skipIf(!hasDom)("the name on the skills line opens that skill too (the person's own), and Close gives focus back to the name", async () => {
  await draw(sent('Thanks, $readback it first.', [SKILLS[1]!]));
  const name = lineName('readback');
  expect(name?.tagName).toBe('BUTTON');
  expect(name!.textContent).toBe('readback');
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

test.skipIf(!hasDom)('a skill no longer on this computer says so in the pane, with no error', async () => {
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
