/**
 * System → Set up a project (system/SetupDialog.tsx through system/SetupHost.tsx), the server calls stubbed.
 * What regresses: anything of System shown while System or Code review is off; a setup that needs typing beyond
 * extra repos and doc sites; a step that loses what was chosen or typed; a repo or doc site that does not parse
 * saved, or one typed and not yet added dropped; Draw it offered with no agent to start, or Copy prompt offered
 * beside it; a Copy prompt whose copy does not start in the click; a Cancel that saves; a removed chip dropping
 * focus to the page instead of the next chip (or its field when none is left); an agent the Inbox launches itself
 * (Claude Code, Pi, OpenCode) not offered; Draw it for an agent the Inbox cannot start here; a Pi or OpenCode save
 * whose recommended model is not in the `provider/model` form those agents take.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SystemSetup, SystemSetupAgent, SystemSetupInput, SystemSetupProject } from '@plannotator/core/inbox-system-setup';

const hasDom = typeof document !== 'undefined';
const { SystemSetupHost } = (hasDom ? await import('./SetupHost') : {}) as typeof import('./SetupHost');
const { openSystemSetup, closeSystemSetup } = (hasDom ? await import('./opener') : {}) as typeof import('./opener');

let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  if (hasDom) {
    act(() => closeSystemSetup());
    document.body.innerHTML = '';
  }
});

const APP: SystemSetupProject = { id: 'prj_app', key: 'app-abc123', name: 'app', root: '/Users/ada/code/app', repo: 'github.com/acme/app', drawing: '/Users/ada/.plannotator/system/app-abc123/drawing', setup: null };
const DOCS: SystemSetupProject = {
  id: 'prj_docs',
  key: 'docs-def456',
  name: 'docs',
  root: '/Users/ada/code/docs',
  repo: 'github.com/acme/docs',
  drawing: '/Users/ada/.plannotator/system/docs-def456/drawing',
  setup: { v: 1, repos: ['github.com/acme/brand'], docs: ['https://help.example.com/'], agent: 'claude', model: null, thread_message: null },
};
const ON = { code_review: { on: true }, system: { on: true }, home: '/Users/ada' };

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function mount(options: { settings?: Record<string, unknown> | null; agents?: SystemSetupAgent[]; copyOk?: boolean } = {}) {
  const saves: SystemSetupInput[] = [];
  const copies: string[] = [];
  const toasts: string[] = [];
  const order: string[] = [];
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SystemSetupHost
        settings={(options.settings === undefined ? ON : options.settings) as never}
        phone={false}
        showToast={(toast) => toasts.push(toast.lead)}
        api={{
          load: async () => ({ projects: [APP, DOCS] }),
          loadAgents: async () => options.agents ?? ['claude'],
          save: async (input) => {
            order.push('save');
            saves.push(input);
            return { v: 1, repos: input.repos, docs: input.docs, agent: input.agent, model: input.model, thread_message: null } satisfies SystemSetup;
          },
          copy: (text) => {
            order.push('copy');
            copies.push(text);
            return Promise.resolve(options.copyOk ?? true);
          },
        }}
      />,
    ),
  );
  const q = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);
  return {
    saves,
    copies,
    toasts,
    order,
    dialog: () => q<HTMLDialogElement>('[data-dialog="system-setup"]'),
    step: () => Number(q('[data-system-step]')?.getAttribute('data-system-step')),
    current: () => q('[data-system-steps] [aria-current="step"]')?.textContent,
    btn: (name: string) => q<HTMLButtonElement>(`[data-system-${name}]`),
    q,
  };
}

async function open(ui: ReturnType<typeof mount>, project: string | null = null) {
  act(() => openSystemSetup(project));
  await settle();
  return ui;
}

async function press(button: HTMLElement | null) {
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
  });
  await settle();
}

/** Types into a React-controlled field the way a person does (the native setter, then `input`). */
function type(el: HTMLInputElement | null, value: string) {
  expect(el).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el!, value);
    el!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Enter in a field: its form submits. */
function submit(el: HTMLInputElement | null) {
  act(() => {
    el!.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe.skipIf(!hasDom)('System setup', () => {
  test('with System off, or Code review off, nothing opens', async () => {
    for (const settings of [null, { code_review: { on: true } }, { code_review: { on: false }, system: { on: true } }, { system: { on: true } }]) {
      const ui = await open(mount({ settings }));
      expect(ui.dialog()).toBeNull();
      expect(document.querySelector('.ib-sys, [data-system-steps]')).toBeNull();
      act(() => root?.unmount());
      root = null;
      act(() => closeSystemSetup());
    }
    const ui = await open(mount());
    expect(ui.dialog()).not.toBeNull();
  });

  test('nothing typed: Next, Next, Draw it saves the first project with the recommended model', async () => {
    const ui = await open(mount());
    expect(ui.step()).toBe(1);
    expect(ui.current()).toContain('Project');
    expect(ui.q<HTMLInputElement>('[data-system-project="prj_app"] input')!.checked).toBe(true);
    await press(ui.btn('next'));
    expect(ui.step()).toBe(2);
    // The project's own repo is there already, and cannot be removed.
    expect(ui.q('[data-system-own]')?.textContent).toContain('acme/app');
    expect(ui.q('[data-system-own] button')).toBeNull();
    await press(ui.btn('next'));
    expect(ui.step()).toBe(3);
    expect(ui.current()).toContain('Keep it current');
    // An agent the Inbox can start: Draw it, and no Copy prompt beside it.
    expect(ui.btn('copy')).toBeNull();
    await press(ui.btn('draw'));
    expect(ui.saves).toEqual([{ project_id: 'prj_app', repos: [], docs: [], agent: 'claude', model: 'claude-opus-5-5' }]);
    expect(ui.copies).toEqual([]);
    expect(ui.dialog()).toBeNull();
  });

  test('extra repos and doc sites: a bad one says why and holds Next; a typed one goes in with Next', async () => {
    const ui = await open(mount());
    await press(ui.btn('next'));
    await press(ui.btn('add-repo'));
    const repo = () => ui.q<HTMLInputElement>('[data-system-repo-input]');
    type(repo(), 'not-a-repo');
    submit(repo());
    expect(ui.q('[data-system-repo-error]')).not.toBeNull();
    expect(ui.q('[data-system-repo]')).toBeNull();
    await press(ui.btn('next'));
    expect(ui.step()).toBe(2);
    type(repo(), 'https://github.com/acme/brand/tree/main');
    expect(ui.q('[data-system-repo-error]')).toBeNull();
    submit(repo());
    expect(ui.q('[data-system-repo="github.com/acme/brand"]')).not.toBeNull();
    // The project's own repo again adds nothing.
    type(repo(), 'acme/app');
    submit(repo());
    expect(document.querySelectorAll('[data-system-repo]').length).toBe(1);

    const doc = () => ui.q<HTMLInputElement>('[data-system-doc-input]');
    type(doc(), 'ftp://files.example.com');
    submit(doc());
    expect(ui.q('[data-system-doc-error]')).not.toBeNull();
    await press(ui.btn('next'));
    expect(ui.step()).toBe(2);
    type(doc(), 'help.example.com');
    submit(doc());
    expect(ui.q('[data-system-doc="https://help.example.com/"]')).not.toBeNull();
    // Typed, not added: Next takes it.
    type(repo(), 'gitlab.com/group/tools');
    await press(ui.btn('next'));
    expect(ui.step()).toBe(3);
    // Back keeps every choice.
    await press(ui.btn('back'));
    expect(document.querySelectorAll('[data-system-repo]').length).toBe(2);
    await press(ui.btn('next'));
    await press(ui.btn('draw'));
    expect(ui.saves[0]).toMatchObject({ repos: ['github.com/acme/brand', 'gitlab.com/group/tools'], docs: ['https://help.example.com/'] });
  });

  test('a removed chip is not saved; a project set up before starts from its own choices', async () => {
    const ui = await open(mount(), 'prj_docs');
    expect(ui.q<HTMLInputElement>('[data-system-project="prj_docs"] input')!.checked).toBe(true);
    await press(ui.btn('next'));
    expect(ui.q('[data-system-repo="github.com/acme/brand"]')).not.toBeNull();
    await press(ui.q('[data-system-doc="https://help.example.com/"] button'));
    expect(ui.q('[data-system-doc]')).toBeNull();
    await press(ui.btn('next'));
    // Its saved model (the agent's own default) is the one chosen.
    expect(ui.q<HTMLInputElement>('[data-system-model=""] input')!.checked).toBe(true);
    await press(ui.btn('draw'));
    expect(ui.saves).toEqual([{ project_id: 'prj_docs', repos: ['github.com/acme/brand'], docs: [], agent: 'claude', model: null }]);
  });

  test('removing a chip moves focus to the chip after it, or to its field when none is left', async () => {
    const ui = await open(mount(), 'prj_docs');
    await press(ui.btn('next'));
    // Repos: brand, then tools; remove brand (focus to tools' remove), then tools (focus to the add button).
    await press(ui.btn('add-repo'));
    type(ui.q<HTMLInputElement>('[data-system-repo-input]'), 'acme/tools');
    submit(ui.q<HTMLInputElement>('[data-system-repo-input]'));
    await settle();
    await press(ui.q('[data-system-repo="github.com/acme/brand"] button'));
    expect(document.activeElement).toBe(ui.q('[data-system-repo="github.com/acme/tools"] button'));
    await press(ui.q('[data-system-repo="github.com/acme/tools"] button'));
    expect(document.activeElement).toBe(ui.q('[data-system-repo-input]'));
    // Doc sites: the last one removed, focus to the doc field.
    await press(ui.q('[data-system-doc="https://help.example.com/"] button'));
    expect(document.activeElement).toBe(ui.q('[data-system-doc-input]'));
    expect(document.activeElement).not.toBe(document.body);
  });

  test('step 3 offers Claude Code, Pi and OpenCode; Draw it only for one the Inbox can start, Copy prompt otherwise', async () => {
    const ui = await open(mount({ agents: ['claude'] }));
    await press(ui.btn('next'));
    await press(ui.btn('next'));
    expect([...document.querySelectorAll('[data-system-agent]')].map((row) => row.getAttribute('data-system-agent'))).toEqual(['claude', 'pi', 'opencode']);
    expect(ui.btn('draw')).not.toBeNull();
    // Pi: not startable here, so Copy prompt; the recommended model follows the pick, in Pi's provider/model form.
    await press(ui.q('[data-system-agent="pi"] input'));
    expect(ui.btn('draw')).toBeNull();
    expect(ui.btn('copy')).not.toBeNull();
    // The line above the agents names the one picked, and where to paste the prompt.
    expect(ui.q('[data-system-how]')?.textContent).toBe("The Inbox can't start Pi yet. Copy the prompt and paste it into Pi in app. Redraws use Pi too.");
    expect(ui.q<HTMLInputElement>('[data-system-model="anthropic/claude-opus-5-5"] input')!.checked).toBe(true);
    // The agent's own default stays the default across a pick.
    await press(ui.q('[data-system-model=""] input'));
    await press(ui.q('[data-system-agent="opencode"] input'));
    expect(ui.q<HTMLInputElement>('[data-system-model=""] input')!.checked).toBe(true);
    expect(ui.q('[data-system-how]')?.textContent).toContain("The Inbox can't start OpenCode yet.");
    await press(ui.q('[data-system-model="anthropic/claude-opus-5-5"] input'));
    await press(ui.btn('copy'));
    expect(ui.saves).toEqual([{ project_id: 'prj_app', repos: [], docs: [], agent: 'opencode', model: 'anthropic/claude-opus-5-5' }]);
  });

  test('no agent the Inbox can start: Copy prompt only, copied in the click before the save', async () => {
    const ui = await open(mount({ agents: [] }));
    await press(ui.btn('next'));
    await press(ui.btn('next'));
    expect(ui.btn('draw')).toBeNull();
    expect(ui.q('[data-system-how]')?.getAttribute('data-system-how')).toBe('prompt');
    await press(ui.btn('copy'));
    expect(ui.order).toEqual(['copy', 'save']);
    expect(ui.copies[0]).toContain('/Users/ada/code/app');
    expect(ui.copies[0]).toContain('/Users/ada/.plannotator/system/app-abc123/drawing');
    expect(ui.toasts).toEqual(['Prompt copied']);
    expect(ui.dialog()).toBeNull();
  });

  test('a copy that fails keeps the dialog open, saved, for another press', async () => {
    const ui = await open(mount({ agents: [], copyOk: false }));
    await press(ui.btn('next'));
    await press(ui.btn('next'));
    await press(ui.btn('copy'));
    expect(ui.saves.length).toBe(1);
    expect(ui.dialog()).not.toBeNull();
    expect(ui.q('[data-system-save-error]')).not.toBeNull();
    expect(ui.toasts).toEqual([]);
  });

  test('Cancel on any step saves nothing', async () => {
    const ui = await open(mount());
    await press(ui.btn('next'));
    type(ui.q<HTMLInputElement>('[data-system-doc-input]'), 'help.example.com');
    await press(ui.btn('cancel'));
    expect(ui.dialog()).toBeNull();
    expect(ui.saves).toEqual([]);
  });
});
