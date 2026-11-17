/**
 * The `/`, `$` and `@` lists open when the person types, not when they delete (the owner, 2026-11-17: "Open it only
 * when you type, not when you delete"; "make sure this doesn't break the UX of when I type a skill and typo and then
 * I'm back. I'm still in the middle of typing a skill, so I don't want to lose the panel.").
 *
 * Both directions, in the reply box's field and in the real New message dialog: Backspace held back over a `/name`,
 * `$name` or `@name` already in the words never opens a list; a list for the name being typed stays open through a
 * Backspace, and one a typo shut comes back when the Backspace fixes it.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';

const hasDom = typeof document !== 'undefined';
const { InboxComposerField } = (hasDom ? await import('./components/ComposerField') : {}) as typeof import('./components/ComposerField');
const { ComposeDialog } = (hasDom ? await import('./compose/ComposeDialog') : {}) as typeof import('./compose/ComposeDialog');
const catalog = (hasDom ? await import('@plannotator/ui/utils/skillCatalog') : {}) as typeof import('@plannotator/ui/utils/skillCatalog');

const SKILLS: SkillCatalogEntry[] = [
  { name: 'readback', root: 'claude', description: 'Read it back', humanOnly: false },
  { name: 'write-better', root: 'claude', description: 'Improve prose', humanOnly: false },
];
const AGENT = { group: 'Claude Code', agent: 'Claude Code', host: 'claude-code', owner: false, wakes: true, taggable: true, project: 'ledger' };
const TAGS = {
  options: [
    { ...AGENT, id: 'ses_a', label: 'Claude Code', detail: 'ledger · idle', owner: true },
    { ...AGENT, id: 'ses_b', label: 'Claude Code 2', detail: 'ledger · working' },
  ],
  onChange: () => {},
};
const ROOT = '/Users/me/work/ledger';

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  // New message saves its draft as it goes: answered here, nothing else is reached.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const draft = /\/drafts\/([^/?]+)$/.exec(url);
    if (draft && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const now = new Date().toISOString();
      const view = { v: 1, id: decodeURIComponent(draft[1]!), created_at: now, updated_at: now, body: body.body, to: null, project: null, files: [], status: 'none' };
      return new Response(JSON.stringify({ draft: view }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  catalog.resetSkillCatalogCache();
  catalog.setSkillCatalogTransport(async () => SKILLS);
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  catalog.resetSkillCatalogTransport();
  catalog.resetSkillCatalogCache();
});

const skillList = () => document.querySelector('[data-skill-menu]');
const tagList = () => document.querySelector('[data-tag-picker]');

function Reply() {
  const [value, setValue] = useState('');
  return <InboxComposerField value={value} onChange={setValue} placeholder="Write a reply" ariaLabel="Reply" destination="your reply" tags={TAGS} />;
}

async function openReply(): Promise<HTMLTextAreaElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Reply />);
  });
  await act(async () => {}); // the catalog's fetch
  const field = host.querySelector('textarea')!;
  await act(async () => field.focus());
  return field;
}

async function openCompose(): Promise<HTMLTextAreaElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ComposeDialog
        request={{}}
        phone={false}
        current={{ id: 'p1', root: ROOT, name: 'ledger' }}
        lastSent={null}
        home="/Users/me"
        onSent={() => {}}
        onSaved={() => {}}
        onDeleted={() => {}}
        onClose={() => {}}
        transport={{
          sessions: async () => ({
            serverSession: 's',
            home: '/Users/me',
            projects: [
              {
                project: { id: 'p1', name: 'ledger', root: ROOT },
                sessions: [{ session: 'ses_1', host: 'claude-code', started_at: new Date(Date.now() - 60_000).toISOString(), last_seen_at: new Date().toISOString(), busy: false, idle_since: null, last_thread: null }],
              },
            ],
          }),
          startThread: async () => ({ thread_id: 't1' }),
          drafts: true,
          uploads: false,
        }}
      />,
    );
  });
  for (let i = 0; i < 100 && !document.querySelector('dialog[data-compose] button[data-compose-to]:not([data-loading])'); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  const field = document.querySelector<HTMLTextAreaElement>('dialog[data-compose] [data-compose-text] textarea')!;
  await act(async () => field.focus());
  return field;
}

const setter = () => Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;

/** One edit as the browser makes it: the value and the caret change, then `input` with its `inputType`. */
async function edit(el: HTMLTextAreaElement, next: string, caret: number, inputType: string) {
  await act(async () => {
    setter().call(el, next);
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
    // The caret move the browser reports after the edit (React's onSelect).
    document.dispatchEvent(new Event('selectionchange'));
  });
}

async function typeKeys(el: HTMLTextAreaElement, keys: string) {
  for (const ch of keys) {
    const at = el.selectionStart;
    await edit(el, el.value.slice(0, at) + ch + el.value.slice(at), at + 1, 'insertText');
  }
}

async function backspace(el: HTMLTextAreaElement) {
  const at = el.selectionStart;
  await edit(el, el.value.slice(0, at - 1) + el.value.slice(at), at - 1, 'deleteContentBackward');
}

/** A row picked with the pointer, then the caret the pick places. */
async function pick(row: Element | null, type: 'pointerdown' | 'mousedown') {
  expect(row).not.toBeNull();
  await act(async () => {
    if (type === 'pointerdown') row!.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true }));
    else {
      row!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      row!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    }
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    document.dispatchEvent(new Event('selectionchange'));
  });
}

/** Words already in the box (a draft, a paste): no list is open, the caret at the end. */
async function words(el: HTMLTextAreaElement, text: string) {
  await edit(el, text, text.length, 'insertFromPaste');
  // A paste that ends inside a name may draw its list, as it did; the person moves on before deleting.
  await typeKeys(el, ', thanks');
}

for (const box of [
  { name: 'the reply box', open: openReply },
  { name: 'New message', open: openCompose },
]) {
  describe.if(hasDom)(box.name, () => {
    test('Backspace held back over a /name and a $name already in the words opens no list', async () => {
      const el = await box.open();
      await words(el, 'Please use /write-better on this and then $readback it');
      expect(skillList()).toBeNull();
      while (el.value.length > 0) {
        await backspace(el);
        expect({ left: el.value, list: skillList() !== null }).toEqual({ left: el.value, list: false });
      }
      // Typed again, the list is there.
      await typeKeys(el, '/');
      expect(skillList()).not.toBeNull();
    });

    test('a /name being typed keeps its list through a Backspace, and one a typo shut comes back', async () => {
      const el = await box.open();
      await typeKeys(el, 'use /');
      expect(skillList()).not.toBeNull();
      for (const step of ['w', 'r', 'i']) {
        await typeKeys(el, step);
        expect(skillList()).not.toBeNull();
      }
      await backspace(el);
      expect(el.value).toBe('use /wr');
      expect(skillList()).not.toBeNull();
      await typeKeys(el, 'i');
      expect(skillList()).not.toBeNull();
      // A typo nothing matches shuts it, as ever; the Backspace that fixes it brings it back.
      await typeKeys(el, 'q');
      expect(skillList()).toBeNull();
      await backspace(el);
      expect(el.value).toBe('use /wri');
      expect(skillList()).not.toBeNull();
      // Backspace down to the bare trigger keeps it; past the trigger it goes.
      for (let i = 0; i < 3; i++) await backspace(el);
      expect(el.value).toBe('use /');
      expect(skillList()).not.toBeNull();
      await backspace(el);
      expect(skillList()).toBeNull();
    });

    test('a Backspace after picking a skill opens no list', async () => {
      const el = await box.open();
      await typeKeys(el, 'use /wri');
      await pick(document.querySelector('[data-skill-item="write-better"]'), 'pointerdown');
      expect(el.value).toBe('use /write-better ');
      expect(skillList()).toBeNull();
      await backspace(el);
      expect(el.value).toBe('use /write-better');
      expect(skillList()).toBeNull();
      // Typed again at the name, the list is there.
      await typeKeys(el, 'x');
      await backspace(el);
      expect(skillList()).not.toBeNull();
    });
  });
}

describe.if(hasDom)('the reply box, @', () => {
  test('Backspace held back over an @name already in the words opens no list', async () => {
    const el = await openReply();
    await words(el, 'Ping @Claude Code about this when the build is green');
    expect(tagList()).toBeNull();
    while (el.value.length > 0) {
      await backspace(el);
      expect({ left: el.value, list: tagList() !== null }).toEqual({ left: el.value, list: false });
    }
    await typeKeys(el, '@');
    expect(tagList()).not.toBeNull();
  });

  test('an @name being typed keeps its list through a Backspace', async () => {
    const el = await openReply();
    await typeKeys(el, 'ping @cl');
    expect(tagList()).not.toBeNull();
    await backspace(el);
    expect(el.value).toBe('ping @c');
    expect(tagList()).not.toBeNull();
    await typeKeys(el, 'la');
    expect(tagList()).not.toBeNull();
  });

  test('a Backspace that lands back on a picked agent opens no list', async () => {
    const el = await openReply();
    await edit(el, 'ping ,', 6, 'insertFromPaste');
    await act(async () => {
      el.setSelectionRange(5, 5);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await typeKeys(el, '@cl');
    await pick(document.querySelector('[data-tag-option="ses_a"]'), 'mousedown');
    expect(el.value).toBe('ping @Claude Code ,');
    // The caret goes past the comma, then one Backspace brings it back to "@Claude Code ", which "Claude Code 2" matches.
    await act(async () => {
      el.setSelectionRange(el.value.length, el.value.length);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(tagList()).toBeNull();
    await backspace(el);
    expect(el.value).toBe('ping @Claude Code ');
    expect(tagList()).toBeNull();
  });
});
