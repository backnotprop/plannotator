import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

async function setObsidianEnabled(enabled: boolean) {
  const toggle = document.querySelector<HTMLButtonElement>('button[role="switch"]');
  if (toggle && (toggle.getAttribute('aria-checked') === 'true') !== enabled) {
    await act(async () => toggle.click());
  }
}

function sidebarTabs(): string[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('nav.hidden button'))
    .map((b) => b.textContent?.trim() ?? '');
}

async function openTab(label: string) {
  const tab = Array.from(document.querySelectorAll<HTMLButtonElement>('nav.hidden button'))
    .find((b) => b.textContent?.trim() === label);
  if (!tab) throw new Error(`Tab "${label}" did not render`);
  await act(async () => tab.click());
}

async function mountSettings(
  mode: 'plan' | 'annotate',
  origin: 'claude-code' | 'opencode' = 'claude-code',
  annotateParity = mode === 'annotate',
) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <Settings taterMode={false} onTaterModeChange={() => {}} mode={mode} origin={origin} annotateParity={annotateParity} externalOpen />,
    );
  });
}

describe('Settings annotate/plan parity', () => {
  afterEach(async () => {
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    root = null;
    host?.remove();
    host = null;
    if (hasDom) document.body.replaceChildren();
  });

  test.skipIf(!hasDom)('annotate offers the document tabs and notes integrations, not plan-time Hooks', async () => {
    await mountSettings('annotate');
    const tabs = sidebarTabs();
    for (const tab of ['Display', 'Saving', 'Labels', 'Obsidian', 'Bear', 'Octarine']) {
      expect(tabs).toContain(tab);
    }
    expect(tabs).not.toContain('Hooks');
  });

  test.skipIf(!hasDom)('a host that omits annotateParity keeps the pre-parity annotate tabs', async () => {
    await mountSettings('annotate', 'opencode', false);
    const tabs = sidebarTabs();
    for (const tab of ['Display', 'Saving', 'Labels', 'Obsidian', 'Bear', 'Octarine']) {
      expect(tabs).not.toContain(tab);
    }
    expect(Array.from(document.querySelectorAll('option')).some((o) => o.value === 'disabled')).toBe(true);
  });

  test.skipIf(!hasDom)('plan keeps every tab it had, Hooks included', async () => {
    await mountSettings('plan');
    const tabs = sidebarTabs();
    for (const tab of ['Display', 'Saving', 'Labels', 'Hooks', 'Obsidian', 'Bear', 'Octarine']) {
      expect(tabs).toContain(tab);
    }
  });

  test.skipIf(!hasDom)('the plan-snapshot switch is plan-only; the Cmd+S save action is shared', async () => {
    await mountSettings('annotate');
    await openTab('Saving');
    const annotateSwitches = document.querySelectorAll('button[role="switch"]').length;
    const annotateSelects = document.querySelectorAll('select').length;
    await act(async () => root?.unmount());
    root = null;
    host?.remove();

    await mountSettings('plan');
    await openTab('Saving');
    expect(annotateSwitches).toBe(0);
    expect(document.querySelectorAll('button[role="switch"]').length).toBe(1);
    expect(annotateSelects).toBe(1);
    expect(document.querySelectorAll('select').length).toBe(1);
  });

  test.skipIf(!hasDom)('plan-arrival auto-save stays plan-only; the vault browser is offered in both', async () => {
    await mountSettings('annotate');
    await openTab('Obsidian');
    await setObsidianEnabled(true);
    const annotateSwitches = Array.from(document.querySelectorAll('button[role="switch"]'));
    const annotateCopy = document.body.textContent ?? '';
    expect(annotateCopy).toContain('approved plan');
    expect(annotateCopy).not.toContain('Plans saved to');
    await act(async () => root?.unmount());
    root = null;
    host?.remove();

    await mountSettings('plan');
    await openTab('Obsidian');
    await setObsidianEnabled(true);
    const planSwitches = Array.from(document.querySelectorAll('button[role="switch"]'));
    await setObsidianEnabled(false);
    expect(annotateSwitches.length).toBe(2);
    expect(planSwitches.length).toBe(3);
  });

  test.skipIf(!hasDom)('OpenCode agent switching applies to plan approval only', async () => {
    await mountSettings('annotate', 'opencode');
    const annotateHasSwitch = Array.from(document.querySelectorAll('option')).some((o) => o.value === 'disabled');
    await act(async () => root?.unmount());
    root = null;
    host?.remove();

    await mountSettings('plan', 'opencode');
    const planHasSwitch = Array.from(document.querySelectorAll('option')).some((o) => o.value === 'disabled');
    expect(annotateHasSwitch).toBe(false);
    expect(planHasSwitch).toBe(true);
  });
});
