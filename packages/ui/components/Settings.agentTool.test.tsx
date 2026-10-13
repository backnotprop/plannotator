/**
 * The agent tool switch in Settings (DOM_TESTS=1), on every Settings surface:
 * plan review, annotate and code review render the same component with a
 * different `mode`, and the row must be in each one's General tab.
 *
 * Regressions guarded: the row disappearing from a surface; a write that
 * fails being shown as saved (the switch must stay put and say why); the
 * PLANNOTATOR_AGENT_TOOL lock being editable; a `@plannotator/ui` host that
 * passes neither prop getting a row.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';
import { withSavedAgentTool, type AgentToolSetting } from '../utils/agentToolSetting';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

const ROW = '[data-agent-tool-setting]';
type Mode = 'plan' | 'annotate' | 'review';

/** Holds the setting like the Apps' useAgentToolSetting does. */
function Harness({ mode, initial, save }: {
  readonly mode: Mode;
  readonly initial: AgentToolSetting | undefined;
  readonly save?: (enabled: boolean) => Promise<void>;
}) {
  const [setting, setSetting] = useState(initial);
  return (
    <Settings
      taterMode={false}
      onTaterModeChange={() => {}}
      mode={mode}
      origin="pi"
      annotateParity={mode === 'annotate'}
      externalOpen
      agentToolSetting={setting}
      onAgentToolChange={save && (async (enabled) => {
        await save(enabled);
        setSetting((current) => (current ? withSavedAgentTool(current, enabled) : current));
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

function toggle(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`${ROW} button[role="switch"]`);
}

const PI_OFF: AgentToolSetting = { host: 'pi', enabled: false, configured: false };

describe('Settings agent tool switch', () => {
  afterEach(async () => {
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    root = null;
    host?.remove();
    host = null;
    if (hasDom) document.body.replaceChildren();
  });

  for (const mode of ['plan', 'annotate', 'review'] as const) {
    test.skipIf(!hasDom)(`${mode}: turning it on saves true and shows it on`, async () => {
      const saved: boolean[] = [];
      await mount({ mode, initial: PI_OFF, save: async (enabled) => void saved.push(enabled) });
      expect(document.querySelector(ROW)?.getAttribute('data-agent-tool-setting')).toBe('pi');
      expect(toggle()?.getAttribute('aria-checked')).toBe('false');

      await act(async () => toggle()?.click());

      expect(saved).toEqual([true]);
      expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    });

    test.skipIf(!hasDom)(`${mode}: locked when PLANNOTATOR_AGENT_TOOL decides it`, async () => {
      const saved: boolean[] = [];
      await mount({ mode, initial: { ...PI_OFF, env: true, enabled: true }, save: async (enabled) => void saved.push(enabled) });
      expect(toggle()?.disabled).toBe(true);
      expect(toggle()?.getAttribute('aria-checked')).toBe('true');
      expect(document.querySelector(ROW)?.textContent).toContain('PLANNOTATOR_AGENT_TOOL');
      await act(async () => toggle()?.click());
      expect(saved).toEqual([]);
    });

    test.skipIf(!hasDom)(`${mode}: no row without a tool host or a save handler`, async () => {
      await mount({ mode, initial: undefined, save: async () => {} });
      expect(document.querySelector(ROW)).toBeNull();
      await act(async () => root?.unmount());
      root = null;
      // A @plannotator/ui host that passes the setting but no writer gets nothing either.
      await mount({ mode, initial: PI_OFF });
      expect(document.querySelector(ROW)).toBeNull();
    });
  }

  test.skipIf(!hasDom)('a failed save keeps the switch where it was and says why', async () => {
    await mount({
      mode: 'review',
      initial: PI_OFF,
      save: async () => { throw new Error('Could not save the setting to config.json.'); },
    });
    await act(async () => toggle()?.click());
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    expect(document.querySelector(`${ROW} [data-agent-tool-setting-error]`)?.textContent).toContain('config.json');
  });

  test.skipIf(!hasDom)('names the cost per host: Claude Code defers the tool, Pi sends it every request', async () => {
    await mount({ mode: 'plan', initial: { host: 'claude-code', enabled: true, configured: false }, save: async () => {} });
    expect(document.querySelector(ROW)?.textContent).not.toContain('780');
    // The mod decides once per Claude Code process, so it takes a restart, not a new session.
    expect(document.querySelector(ROW)?.textContent).toContain('next time Claude Code starts');
    await act(async () => root?.unmount());
    root = null;
    await mount({ mode: 'plan', initial: PI_OFF, save: async () => {} });
    expect(document.querySelector(ROW)?.textContent).toContain('780');
  });

  // Oh My Pi defaults the tool on: the row must show it on and must not
  // quote Pi's per-request cost, which OMP does not pay.
  test.skipIf(!hasDom)('Oh My Pi: shown on by default, with its own cost and when it applies', async () => {
    await mount({ mode: 'plan', initial: { host: 'oh-my-pi', enabled: true, configured: false }, save: async () => {} });
    expect(document.querySelector(ROW)?.getAttribute('data-agent-tool-setting')).toBe('oh-my-pi');
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector(ROW)?.textContent).not.toContain('780');
    expect(document.querySelector(ROW)?.textContent).toContain('next time Oh My Pi starts');
  });
});
