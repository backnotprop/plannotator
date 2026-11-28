import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';

const hasDom = typeof document !== 'undefined';
const { InboxComposerField } = (hasDom ? await import('./components/ComposerField') : {}) as typeof import('./components/ComposerField');
const catalog = (hasDom ? await import('@plannotator/ui/utils/skillCatalog') : {}) as typeof import('@plannotator/ui/utils/skillCatalog');

const SKILLS: SkillCatalogEntry[] = [{ name: 'readback', root: 'claude', description: 'Read it back', humanOnly: false }];
const AGENT = { group: 'Claude Code', agent: 'Claude Code', host: 'claude-code', owner: false, wakes: true, taggable: true, project: 'ledger' };
const TAGS = { options: [{ ...AGENT, id: 'ses_a', label: 'Claude Code', detail: 'ledger · idle', owner: true }], onChange: () => {} };

let root: Root | null = null;
let host: HTMLElement | null = null;
let hostEscapes = 0;

beforeEach(() => {
  if (!hasDom) return;
  hostEscapes = 0;
  catalog.resetSkillCatalogCache();
  catalog.setSkillCatalogTransport(async () => SKILLS);
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  catalog.resetSkillCatalogTransport();
  catalog.resetSkillCatalogCache();
});

function Box() {
  const [value, setValue] = useState('');
  return (
    <InboxComposerField
      value={value}
      onChange={setValue}
      placeholder="Write a message"
      ariaLabel="Message"
      destination="your message"
      tags={TAGS}
      onKeyDown={(event) => {
        if (event.key === 'Escape') hostEscapes++;
      }}
    />
  );
}

async function mount(): Promise<HTMLTextAreaElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Box />);
  });
  await act(async () => {});
  const field = host.querySelector('textarea')!;
  await act(async () => field.focus());
  return field;
}

async function write(el: HTMLTextAreaElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
    el.setSelectionRange(text.length, text.length);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    document.dispatchEvent(new Event('selectionchange'));
  });
}

async function escape(el: HTMLTextAreaElement, init: KeyboardEventInit & { keyCode?: number } = {}) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }));
  });
}

const skillList = () => document.querySelector('[data-skill-menu]');
const tagList = () => document.querySelector('[data-tag-picker]');

const BOXES: Array<[string, string, () => boolean]> = [
  ['a reply or new message box (its own Escape closes it)', 'ありがとう', () => hostEscapes > 0],
  ['the / list in it', 'use /rea', () => !skillList()],
  ['the @ list in it', 'ask @Cla', () => !tagList()],
];

for (const [name, words, escaped] of BOXES) {
  test.skipIf(!hasDom)(`${name}: an IME Escape keeps it open with the words, a plain Escape still closes it`, async () => {
    const el = await mount();
    await write(el, words);
    let reachedWindow = 0;
    const spy = () => { reachedWindow++; };
    window.addEventListener('keydown', spy);
    try {
      await escape(el, { isComposing: true });
      await escape(el, { keyCode: 229 });
      expect(escaped()).toBe(false);
      expect(el.value).toBe(words);
      expect(reachedWindow).toBe(0);
      await escape(el);
      expect(escaped()).toBe(true);
    } finally {
      window.removeEventListener('keydown', spy);
    }
  });
}
