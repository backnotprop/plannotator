/**
 * The Plannotator Inbox row in Settings (DOM_TESTS=1), on every Settings
 * surface (plan review, annotate, code review), and the serverConfig read
 * behind it (utils/inboxOnSetting.ts).
 *
 * Regressions guarded: the row showing to someone who never turned the Inbox
 * on (it must not push the Inbox at everyone); the row missing on a surface;
 * a failed Turn off shown as off; the off row not saying how it comes back, or
 * reading as unavailable (its words greyed).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';
import { parseInboxOnSetting, saveInboxOnSetting } from '../utils/inboxOnSetting';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
const ROW = '[data-inbox-on-setting]';
type Mode = 'plan' | 'annotate' | 'review';

function Harness({ mode, initial, save }: { readonly mode: Mode; readonly initial: boolean | undefined; readonly save?: (on: boolean) => Promise<string | undefined> }) {
  const [on, setOn] = useState(initial);
  const [line, setLine] = useState<string | undefined>(undefined);
  return (
    <Settings
      taterMode={false}
      onTaterModeChange={() => {}}
      mode={mode}
      origin="claude-code"
      annotateParity={mode === 'annotate'}
      externalOpen
      inboxOnSetting={on}
      inboxOnLine={line}
      onInboxOnChange={save && (async (next) => {
        const said = await save(next);
        setOn(next);
        setLine(said);
      })}
    />
  );
}

async function mount(props: React.ComponentProps<typeof Harness>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Harness {...props} />);
  });
}
const toggle = () => document.querySelector<HTMLButtonElement>(`${ROW} button[role="switch"]`);

describe('serverConfig inboxOn', () => {
  test('a row only while the server reports the Inbox on', () => {
    expect(parseInboxOnSetting({ inboxOn: true })).toBe(true);
    for (const config of [{}, { inboxOn: false }, { inboxOn: 'true' }, null, undefined]) expect(parseInboxOnSetting(config)).toBeUndefined();
  });

  test('the write sends { inboxOn } and passes on the line, or rejects with the server error', async () => {
    const sent: unknown[] = [];
    const ok = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true, inboxOnLine: 'Turn it back on any time with plannotator inbox.' }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await saveInboxOnSetting(false, ok)).toBe('Turn it back on any time with plannotator inbox.');
    await saveInboxOnSetting(true, ok);
    expect(sent).toEqual([{ inboxOn: false }, { inboxOn: true }]);
    const failing = (async () => new Response(JSON.stringify({ error: 'state.json could not be written.' }), { status: 500 })) as unknown as typeof fetch;
    await expect(saveInboxOnSetting(false, failing)).rejects.toThrow('state.json could not be written.');
  });
});

describe('Settings Plannotator Inbox row', () => {
  afterEach(async () => {
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    root = null;
    host?.remove();
    host = null;
    if (hasDom) document.body.replaceChildren();
  });

  for (const mode of ['plan', 'annotate', 'review'] as const) {
    test.skipIf(!hasDom)(`${mode}: turning it off saves false and says how to turn it back on`, async () => {
      const saved: boolean[] = [];
      await mount({ mode, initial: true, save: async (on) => (saved.push(on), on ? undefined : 'Turn it back on any time with plannotator inbox.') });
      expect(toggle()?.getAttribute('aria-checked')).toBe('true');
      await act(async () => toggle()?.click());
      expect(saved).toEqual([false]);
      expect(document.querySelector(ROW)?.getAttribute('data-inbox-on-setting')).toBe('off');
      // Off says how it comes back, with the command as code, and reads as an ordinary off switch (nothing dimmed).
      const row = document.querySelector(ROW);
      expect(row?.textContent).toContain('Turn it on here, or run plannotator inbox.');
      expect(row?.querySelector('code')?.textContent).toBe('plannotator inbox');
      expect(row?.querySelector('.opacity-50')).toBeNull();
      expect(toggle()?.disabled).toBe(false);
    });
  }

  // T4 (the owner's "no guardrails"): a plain on/off switch; on again saves true.
  test.skipIf(!hasDom)('off, then on again: the switch turns the Inbox back on', async () => {
    const saved: boolean[] = [];
    await mount({ mode: 'plan', initial: true, save: async (on) => (saved.push(on), on ? undefined : 'Turn it back on any time with plannotator inbox.') });
    await act(async () => toggle()?.click());
    await act(async () => toggle()?.click());
    expect(saved).toEqual([false, true]);
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector(ROW)?.textContent).toContain('On for this computer: agents can leave you messages and questions in it.');
  });

  test.skipIf(!hasDom)('no row for someone who never turned the Inbox on', async () => {
    await mount({ mode: 'plan', initial: undefined, save: async () => undefined });
    expect(document.querySelector(ROW)).toBeNull();
  });

  test.skipIf(!hasDom)('a failed Turn off stays on and says why', async () => {
    await mount({ mode: 'review', initial: true, save: async () => { throw new Error('state.json could not be written.'); } });
    await act(async () => toggle()?.click());
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[data-inbox-on-setting-error]')?.textContent).toBe('state.json could not be written.');
  });
});
