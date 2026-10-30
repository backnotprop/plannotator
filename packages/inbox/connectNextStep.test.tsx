/**
 * First run, "One next step" (components/EmptyState.tsx; the approved design
 * inbox-connect-next-step, variant C), on each of the mock's computers:
 * Typical, Plugin missing, Nothing found, Tool locked off, and a page that
 * cannot read this computer's agents (opened over the tailnet). Turn on goes
 * through POST /api/inbox/agents (a recording fetch) and the card moves to the
 * next step; Not now puts a step off; installing is a command to copy; MCP is
 * folded behind "Use MCP instead"; Message opens compose to the live session.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxToolCostText, type InboxAgentsModel } from '@plannotator/core/inbox-types';
import type { ComposeSessionsModel } from './api';
import { SCENARIOS, agentsModel, missing, ready, toolOff } from './connectSteps.fixtures';
import { MCP_WAKE_LINE, WAKE_LINE, mcpWakeLine, wakeLine } from './connectSteps';

const hasDom = typeof document !== 'undefined';
const { EmptyState } = (hasDom ? await import('./components/EmptyState') : {}) as typeof import('./components/EmptyState');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
});

const context = { command: ['/opt/plannotator', 'inbox', 'mcp'], mcpUrl: 'http://127.0.0.1:1/mcp', platform: 'mac' as const };
const live: ComposeSessionsModel = {
  serverSession: 's',
  home: '/Users/me',
  projects: [
    {
      project: { id: 'prj_1', name: 'plannotator', root: '/Users/me/plannotator' },
      sessions: [{ session: 'ses_cc', host: 'claude-code', started_at: '2026-10-16T10:00:00Z', last_seen_at: '2026-10-16T10:00:00Z', busy: false, idle_since: null, last_thread: null }],
    },
  ],
};

interface Mounted {
  el: HTMLElement;
  messages: { session: string }[];
  model: () => InboxAgentsModel | null;
}

function mount(start: InboxAgentsModel | null, options: { unavailable?: 'tailnet' | 'failed' | null; sessions?: ComposeSessionsModel | null; onRetry?: () => void } = {}): Mounted {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  let current = start;
  const messages: { session: string }[] = [];
  const render = () =>
    root!.render(
      <SidebarProvider>
      <EmptyState
        context={context}
        agents={current}
        agentsUnavailable={options.unavailable ?? null}
        onRetry={options.onRetry}
        sessions={options.sessions ?? null}
        onAgents={(next) => {
          current = next;
          render();
        }}
        onMessage={(session) => messages.push({ session })}
      />
      </SidebarProvider>,
    );
  act(() => {
    root = createRoot(host!);
    render();
  });
  return { el: host, messages, model: () => current };
}

const card = (el: HTMLElement) => el.querySelector<HTMLElement>('.ib-cn')!;
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const button = (el: Element, name: string) => [...el.querySelectorAll('button')].find((b) => text(b) === name) as HTMLButtonElement | undefined;
const listOf = (el: HTMLElement, heading: string) =>
  [...el.querySelectorAll('.ib-cl > div')].find((col) => text(col.querySelector('h4')) === heading)!.querySelectorAll('li');
const click = async (target: HTMLElement) => {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

test.skipIf(!hasDom)('typical: the next step turns on Pi\'s Inbox tool, naming its measured cost; the lists say what is done and left; Message Claude Code opens compose', async () => {
  const m = mount(SCENARIOS.typical(), { sessions: live });
  const hero = card(m.el);
  expect(hero.getAttribute('data-connect-step')).toBe('pi');
  expect(text(hero.querySelector('.ib-cn-eb'))).toBe('Next step · 1 of 2');
  expect(text(hero.querySelector('h3'))).toBe("Turn on Pi's Inbox tool");
  expect(text(hero.querySelector('p'))).toBe(
    `Plannotator's extension is installed. Turn its Inbox tool on so Pi can send you messages and get your replies in the session. It adds the tool to every Pi request: ${inboxToolCostText('pi')}.`,
  );
  expect(text(hero.querySelector('p b'))).toBe(inboxToolCostText('pi'));
  expect(button(hero, 'Turn on')).toBeDefined();
  expect(button(hero, 'Not now')).toBeDefined();
  // One primary per card; nothing to copy for a one-click step.
  expect(hero.querySelectorAll('.ib-btn.ib-pri')).toHaveLength(1);
  expect(hero.querySelector('pre')).toBeNull();

  expect([...listOf(m.el, 'Already connected')].map(text)).toEqual(['Claude Code plugin · running now', 'Codex MCP · sees replies when it checks', 'Cursor MCP · sees replies when it checks']);
  expect([...listOf(m.el, 'Left to do')].map(text)).toEqual(['Pi now', 'OpenCode install']);

  const message = button(m.el, 'Message Claude Code')!;
  expect(message).toBeDefined();
  // Something is left to do, so Message is not the primary.
  expect(message.classList.contains('ib-pri')).toBe(false);
  expect(text(m.el.querySelector('.ib-try-where'))).toBe('Claude Code is running in plannotator. It answers here.');
  expect(text(m.el.querySelector('.ib-try p'))).toBe('Or in a new Claude Code or Codex session, ask:');
  await click(message);
  expect(m.messages).toEqual([{ session: 'ses_cc' }]);
});

test.skipIf(!hasDom)('Turn on saves through POST /api/inbox/agents, says when it applies, and the card moves to the next step', async () => {
  const m = mount(SCENARIOS.typical());
  const sent: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    const next = SCENARIOS.typical();
    next.agents = next.agents.map((row) => (row.id === 'pi' ? { ...row, ...ready() } : row));
    return new Response(JSON.stringify({ ...next, error: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  await click(button(card(m.el), 'Turn on')!);
  expect(sent).toHaveLength(1);
  expect((sent[0] as { url: string }).url).toContain('/api/inbox/agents');
  expect((sent[0] as { body: object }).body).toMatchObject({ agent: 'pi', reach: true });
  const hero = card(m.el);
  expect(hero.getAttribute('data-connect-step')).toBe('opencode');
  expect(text(hero.querySelector('.ib-cn-eb'))).toBe('Next step · last one');
  expect([...listOf(m.el, 'Already connected')].map(text)).toContain('Pi next session');
  expect(text(m.el.querySelector('[aria-live="polite"]'))).toBe("Pi's Inbox tool is on. Start a new Pi session, or run /reload in one that is running.");
});

test.skipIf(!hasDom)('a refused Turn on says why on the card and offers Try again', async () => {
  const m = mount(SCENARIOS.typical());
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ...SCENARIOS.typical(), error: "Plannotator's config.json can't be written" }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  await click(button(card(m.el), 'Turn on')!);
  expect(text(card(m.el).querySelector('[role="alert"]'))).toBe("Plannotator's config.json can't be written");
  expect(button(card(m.el), 'Try again')).toBeDefined();
  expect(card(m.el).getAttribute('data-connect-step')).toBe('pi');
});

test.skipIf(!hasDom)('Not now puts the step off: OpenCode is next, with its plugin line to copy, OpenCode 1 or 2, and MCP folded', async () => {
  const m = mount(SCENARIOS.typical());
  await click(button(card(m.el), 'Not now')!);
  const hero = card(m.el);
  expect(hero.getAttribute('data-connect-step')).toBe('opencode');
  expect(text(hero.querySelector('h3'))).toBe("Connect OpenCode with Plannotator's plugin");
  expect(text(hero.querySelector('.ib-clab'))).toBe('~/.config/opencode/opencode.json');
  expect(text(hero.querySelector('pre'))).toBe('"plugins": [{ "package": "@plannotator/opencode@latest" }]');
  const v1 = [...hero.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((input) => input.value === '1')!;
  await act(async () => {
    v1.click();
  });
  expect(text(card(m.el).querySelector('pre'))).toBe('"plugin": ["@plannotator/opencode@latest"]');
  expect([...listOf(m.el, 'Left to do')].map(text)).toEqual(['OpenCode now', 'Pi later']);
  // MCP is one fold away, never first.
  const fold = button(card(m.el), 'Use MCP instead')!;
  expect(fold.getAttribute('aria-expanded')).toBe('false');
  expect(card(m.el).querySelectorAll('pre')).toHaveLength(1);
  await click(fold);
  const mcp = [...card(m.el).querySelectorAll('pre')].map(text);
  expect(mcp[1]).toBe('"mcp": { "plannotator-inbox": { "type": "local", "command": ["/opt/plannotator","inbox","mcp"], "enabled": true } }');
  expect(text(card(m.el))).toContain("Works, but OpenCode sees your replies only when it checks the Inbox; they don't arrive as a new turn.");
});

test.skipIf(!hasDom)('plugin missing: Claude Code\'s install command, restart, Use MCP instead; Pi through MCP is done but left to give its extension', async () => {
  const m = mount(SCENARIOS.missing());
  const hero = card(m.el);
  expect(text(hero.querySelector('h3'))).toBe("Connect Claude Code with Plannotator's plugin");
  expect(text(hero.querySelector('.ib-cn-eb'))).toBe('Next step · 1 of 2');
  expect(hero.querySelector('pre')?.textContent).toBe('claude plugin marketplace add backnotprop/plannotator\nclaude plugin install plannotator@plannotator');
  expect(text(hero)).toContain('Run it in a terminal, then restart Claude Code.');
  expect(button(hero, 'Use MCP instead')).toBeDefined();
  expect([...listOf(m.el, 'Already connected')].map(text)).toEqual(['Pi MCP · sees replies when it checks', 'Codex MCP · sees replies when it checks']);
  expect([...listOf(m.el, 'Left to do')].map(text)).toEqual(['Claude Code now', 'Pi install', 'OpenCode: not on this computer']);
  await click(button(hero, 'Not now')!);
  const next = card(m.el);
  expect(text(next.querySelector('h3'))).toBe("Give Pi Plannotator's extension");
  expect(text(next.querySelector('pre'))).toBe('pi install npm:@plannotator/pi-extension');
  // Pi already reaches the Inbox through MCP: no MCP fold.
  expect(button(next, 'Use MCP instead')).toBeUndefined();
  expect(text(m.el.querySelector('.ib-try p'))).toBe('In a new Pi or Codex session, ask:');
});

test.skipIf(!hasDom)('nothing found: connect your first agent, Claude Code, Pi or OpenCode, each with its install command; no lists', async () => {
  const m = mount(SCENARIOS.none());
  const hero = card(m.el);
  expect(text(hero.querySelector('.ib-cn-eb'))).toBe('First step');
  expect(text(hero.querySelector('h3'))).toBe('Connect your first agent');
  expect(m.el.querySelector('.ib-cl')).toBeNull();
  expect(hero.querySelector('pre')?.textContent).toContain('claude plugin install plannotator@plannotator');
  const pi = [...hero.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((input) => input.value === 'pi')!;
  await act(async () => {
    pi.click();
  });
  expect(text(card(m.el).querySelector('pre'))).toBe('pi install npm:@plannotator/pi-extension');
  expect(text(m.el.querySelector('.ib-try p'))).toBe('Once an agent is connected, ask it in a new session:');
  // The picker for every other agent or editor, folded.
  const picker = button(m.el, 'Another agent or editor')!;
  expect(text(picker.parentElement)).toBe('Another agent or editor VS Code, Zed, JetBrains, Goose, any MCP client');
  await click(picker);
  const tabs = [...m.el.querySelectorAll('[role="tab"]')].map(text);
  expect(tabs).not.toContain('Claude Code');
  expect(tabs).not.toContain('Pi');
  expect(tabs).toContain('VS Code');
});

test.skipIf(!hasDom)('locked: the tools PLANNOTATOR_INBOX_TOOL=0 keeps off are not steps; they say so in Left to do', () => {
  const m = mount(SCENARIOS.locked());
  expect(card(m.el).getAttribute('data-connect-step')).toBe('opencode');
  expect(text(card(m.el).querySelector('.ib-cn-eb'))).toBe('Next step · last one');
  expect([...listOf(m.el, 'Left to do')].map(text)).toEqual([
    'OpenCode now',
    'Claude Code locked by PLANNOTATOR_INBOX_TOOL=0',
    'Pi locked by PLANNOTATOR_INBOX_TOOL=0',
  ]);
  expect(button(m.el, 'Turn on')).toBeUndefined();
});

test.skipIf(!hasDom)('all set: nothing left, a quiet card, and Message is the primary', () => {
  const model = SCENARIOS.typical();
  model.agents = model.agents.map((row) => (row.id === 'pi' ? { ...row, ...ready() } : row.id === 'opencode' ? { ...row, detected: false } : row));
  const m = mount(model, { sessions: live });
  expect(text(card(m.el).querySelector('h3'))).toBe('Your agents reach the Inbox');
  expect(button(m.el, 'Message Claude Code')!.classList.contains('ib-pri')).toBe(true);
});

test.skipIf(!hasDom)('the agents cannot be read here (a page over the tailnet): the first step with the commands, and where to connect in one click', () => {
  const m = mount(null, { unavailable: 'tailnet' });
  expect(text(card(m.el).querySelector('h3'))).toBe('Connect your first agent');
  expect(text(card(m.el))).toContain('Open the Inbox on the computer to connect agents with one click.');
});

test.skipIf(!hasDom)('while the agents load, nothing but the heading shows', () => {
  const m = mount(null);
  expect(m.el.querySelector('.ib-cn')).toBeNull();
  expect(m.el.querySelector('.ib-try')).toBeNull();
  expect(text(m.el.querySelector('h2'))).toBe('No agent has written yet');
});

test.skipIf(!hasDom)('a read of the agents that failed on this computer says so, with Try again; never the tailnet line', async () => {
  let retried = 0;
  const m = mount(null, { unavailable: 'failed', onRetry: () => retried++ });
  expect(text(card(m.el).querySelector('h3'))).toBe('Connect your first agent');
  expect(text(card(m.el))).not.toContain('Open the Inbox on the computer');
  expect(text(card(m.el).querySelector('[data-agents-failed]'))).toBe('The Inbox could not read the agents on this computer. Try again');
  await click(button(card(m.el), 'Try again')!);
  expect(retried).toBe(1);
});

test.skipIf(!hasDom)('keyboard focus follows the card: after Turn on to the next step\'s heading, after Not now too, and to Try it once nothing is left', async () => {
  const m = mount(SCENARIOS.typical());
  globalThis.fetch = (async () => {
    const next = SCENARIOS.typical();
    next.agents = next.agents.map((row) => (row.id === 'pi' ? { ...row, ...ready() } : row));
    return new Response(JSON.stringify({ ...next, error: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  const turnOn = button(card(m.el), 'Turn on')!;
  turnOn.focus();
  await click(turnOn);
  // Never the page: the new card's heading.
  expect(document.activeElement).not.toBe(document.body);
  expect(document.activeElement?.tagName).toBe('H3');
  expect(text(document.activeElement)).toBe("Connect OpenCode with Plannotator's plugin");
  // Not now on the last step: nothing is left to offer, so focus goes to Try it.
  const notNow = button(card(m.el), 'Not now')!;
  notNow.focus();
  await click(notNow);
  expect(text(document.activeElement)).toBe('Try it');
});

test.skipIf(!hasDom)('while it saves, Turn on keeps focus (aria-disabled, never disabled) and a second click is ignored', async () => {
  const m = mount(SCENARIOS.typical());
  let calls = 0;
  let release: () => void = () => {};
  globalThis.fetch = (async () => {
    calls++;
    await new Promise<void>((resolve) => (release = resolve));
    return new Response(JSON.stringify({ ...SCENARIOS.typical(), error: 'nope' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  const turnOn = button(card(m.el), 'Turn on')!;
  turnOn.focus();
  await click(turnOn);
  const saving = button(card(m.el), 'Turning on…')!;
  expect(saving.disabled).toBe(false);
  expect(saving.getAttribute('aria-disabled')).toBe('true');
  expect(document.activeElement).toBe(saving);
  await click(saving);
  expect(calls).toBe(1);
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(document.activeElement).toBe(button(card(m.el), 'Try again')!);
});

test.skipIf(!hasDom)('a Claude Code session running now counts as connected, even when no settings file the Inbox reads enables the plugin (a project setting, --plugin-dir)', () => {
  const m = mount(SCENARIOS.missing(), { sessions: live });
  expect(card(m.el).getAttribute('data-connect-step')).toBe('pi');
  expect([...listOf(m.el, 'Already connected')].map(text)).toContain('Claude Code plugin · running now');
  expect(button(m.el, 'Message Claude Code')).toBeDefined();
});

test.skipIf(!hasDom)('a tool the person turned off by name (config.json false) is not offered as the step: Left to do says off', () => {
  const model = SCENARIOS.typical();
  model.agents = model.agents.map((row) => (row.id === 'pi' ? { ...row, ...toolOff(), tool: { on: false, locked: false, chosen_off: true } } : row));
  const m = mount(model);
  expect(card(m.el).getAttribute('data-connect-step')).toBe('opencode');
  expect([...listOf(m.el, 'Left to do')].map(text)).toEqual(['OpenCode now', 'Pi off']);
});

test.skipIf(!hasDom)('the cost on the card: the measured size, and the tokens said as roughly', () => {
  const m = mount(SCENARIOS.typical());
  expect(text(card(m.el).querySelector('p b'))).toMatch(/^about \d+ KB, roughly [\d,]+ tokens$/);
});

// Found by the first-run scenario matrix (a person's `plannotator inbox` on scratch computers).

test.skipIf(!hasDom)('every tool locked off (PLANNOTATOR_INBOX_TOOL=0): never "All set"; the card says no agent reaches the Inbox, and why', () => {
  const m = mount(agentsModel({ 'claude-code': toolOff(true), pi: toolOff(true), opencode: toolOff(true) }, { tool_env: false }));
  const hero = card(m.el);
  expect(hero.getAttribute('data-connect-step')).toBe('blocked');
  expect(text(hero.querySelector('h3'))).toBe('No agent reaches the Inbox yet');
  expect(text(hero.querySelector('p'))).toBe('PLANNOTATOR_INBOX_TOOL=0 keeps the Inbox tool off for Claude Code, Pi and OpenCode.');
  expect(text(m.el)).not.toContain('All set');
  expect([...listOf(m.el, 'Already connected')].map(text)).toEqual(['None yet']);
});

test.skipIf(!hasDom)('the only agent\'s tool turned off by name: blocked, with the way back in Settings → Agents', () => {
  const m = mount(agentsModel({ pi: { ...toolOff(), tool: { on: false, locked: false, chosen_off: true } } }));
  expect(card(m.el).getAttribute('data-connect-step')).toBe('blocked');
  expect(text(card(m.el).querySelector('p'))).toBe('You turned the Inbox tool off for Pi. Turn it back on in Settings → Agents.');
  expect(card(m.el).querySelector('a')?.getAttribute('href')).toBe('#settings/agents');
});

test.skipIf(!hasDom)('putting off every step is not "All set" either', async () => {
  const m = mount(agentsModel({ 'claude-code': missing('claude-code') }));
  await click(button(card(m.el), 'Not now')!);
  expect(card(m.el).getAttribute('data-connect-step')).toBe('blocked');
  expect(text(card(m.el).querySelector('p'))).toBe('You put Claude Code off for later.');
});

test.skipIf(!hasDom)('Claude Code\'s plugin disabled (claude plugin disable): no install step, Left to do says it is turned off', () => {
  const m = mount(agentsModel({ 'claude-code': { ...missing('claude-code'), plugin: { installed: false, disabled: true } }, pi: missing('pi') }));
  expect(card(m.el).getAttribute('data-connect-step')).toBe('pi');
  expect(m.el.textContent).not.toContain('claude plugin install');
  expect([...listOf(m.el, 'Left to do')].map(text)).toEqual(['Pi now', 'Claude Code plugin turned off', 'OpenCode: not on this computer']);
});

test.skipIf(!hasDom)('Claude Code\'s mod off: not connected, never offered; the card says why', () => {
  const m = mount(agentsModel({ 'claude-code': { ...toolOff(), tool: { on: false, locked: false, mod_off: true } } }));
  expect(card(m.el).getAttribute('data-connect-step')).toBe('blocked');
  expect(text(card(m.el).querySelector('p'))).toContain("Plannotator's Claude Code mod is turned off");
  expect([...listOf(m.el, 'Left to do')].map(text)[0]).toBe('Claude Code Plannotator mod turned off');
});

test.skipIf(!hasDom)('only OpenCode 1 on PATH: its plugin line ("plugin", not V2\'s "plugins") shows first', () => {
  const m = mount(agentsModel({ opencode: { ...missing('opencode'), plugin: { installed: false, generation: '1' } } }));
  const hero = card(m.el);
  expect(text(hero.querySelector('pre'))).toBe('"plugin": ["@plannotator/opencode@latest"]');
  expect([...hero.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((input) => input.checked)?.value).toBe('1');
  // OpenCode 2 on PATH (or not known): V2's line, as before.
  act(() => root?.unmount());
  host?.remove();
  const v2 = mount(agentsModel({ opencode: { ...missing('opencode'), plugin: { installed: false, generation: '2' } } }));
  expect(text(card(v2.el).querySelector('pre'))).toBe('"plugins": [{ "package": "@plannotator/opencode@latest" }]');
});

test.skipIf(!hasDom)('the OpenCode plugin line follows a later read that learns the version', () => {
  let current = agentsModel({ opencode: { ...missing('opencode'), plugin: { installed: false } } });
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  const render = () =>
    root!.render(
      <SidebarProvider>
        <EmptyState context={context} agents={current} agentsUnavailable={null} sessions={null} onAgents={() => {}} onMessage={() => {}} />
      </SidebarProvider>,
    );
  act(() => {
    root = createRoot(host!);
    render();
  });
  expect(text(card(host).querySelector('pre'))).toBe('"plugins": [{ "package": "@plannotator/opencode@latest" }]');
  current = agentsModel({ opencode: { ...missing('opencode'), plugin: { installed: false, generation: '1' } } });
  act(() => render());
  expect(text(card(host).querySelector('pre'))).toBe('"plugin": ["@plannotator/opencode@latest"]');
});

test.skipIf(!hasDom)('the screen says plainly which agents a reply wakes: once under the lists, and over the other agents\' picker', async () => {
  const m = mount(SCENARIOS.typical(), { sessions: live });
  const notes = [...m.el.querySelectorAll('[data-wake-note]')];
  expect(notes).toHaveLength(1);
  // Codex is on this computer (typical): the line names it.
  expect(text(notes[0]!)).toBe(wakeLine(['codex']));
  // It sits after the lists and before Try it.
  const order = [...m.el.querySelectorAll('.ib-cl, [data-wake-note], .ib-try')];
  expect(order.map((el) => el.className.split(' ')[0])).toEqual(['ib-cl', 'ib-note', 'ib-try']);
  await click(button(m.el, 'Another agent or editor')!);
  expect(text(m.el.querySelector('[data-wake-note="mcp"]'))).toBe(mcpWakeLine(['codex']));
  // A component tooltip or plain text, never a native title.
  expect(m.el.querySelector('[data-wake-note] [title], [data-wake-note][title]')).toBeNull();
});

test.skipIf(!hasDom)('nothing found: the card asks which agent; the line under it says what a reply does, once', () => {
  const m = mount(SCENARIOS.none());
  expect(text(card(m.el).querySelector('p'))).toBe('Which agent do you use?');
  expect(m.el.querySelectorAll('[data-wake-note=""]')).toHaveLength(1);
  // No Codex here: the line is unchanged, it never names Codex.
  expect(text(m.el.querySelector('[data-wake-note]'))).toBe(WAKE_LINE);
  expect(text(m.el.querySelector('[data-wake-note]'))).not.toContain('Codex');
});

test.skipIf(!hasDom)('without Codex on this computer, neither wake line names it', async () => {
  const m = mount(agentsModel({ 'claude-code': ready() }));
  expect(text(m.el.querySelector('[data-wake-note=""]'))).toBe(WAKE_LINE);
  const other = button(m.el, 'Another agent or editor');
  expect(other).toBeTruthy();
  await click(other!);
  expect(text(m.el.querySelector('[data-wake-note="mcp"]'))).toBe(MCP_WAKE_LINE);
});
