/**
 * Seam test: AlertIconRenderer override (setAlertIconRenderer / resetAlertIconRenderer,
 * and the `alertIconRenderer` key on configurePlannotatorUI).
 *
 * Contract: with no renderer registered, an alert whose title line carries
 * `<!-- icon: name -->` renders the type's own icon (today's behavior). After
 * setAlertIconRenderer(fn), the node fn returns takes the icon slot; fn returning
 * null falls back to the type icon; an emoji on the title line wins over the
 * renderer. resetAlertIconRenderer() restores the default.
 *
 * Requires DOM (happy-dom) — runs under bun test (preloaded via bunfig.toml).
 *
 * IMPORTANT: function references are captured at module-load time (top-level)
 * so they remain valid even when configure.test.ts's mock.module() replaces
 * the module exports later during test execution.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as AlertBlockModule from './AlertBlock';
import { configurePlannotatorUI } from '../../configure';

const setAlertIconRenderer = AlertBlockModule.setAlertIconRenderer;
const resetAlertIconRenderer = AlertBlockModule.resetAlertIconRenderer;
const AlertBlock = AlertBlockModule.AlertBlock;

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;

afterEach(() => {
  resetAlertIconRenderer();
  if (root) { act(() => root!.unmount()); root = null; }
  if (hasDom) document.body.innerHTML = '';
});

async function render(body: string): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<AlertBlock blockId="b1" kind="tip" body={body} />);
  });
  return host.querySelector<HTMLElement>('.alert-title')!;
}

const TITLED = '**Browser quirks** <!-- icon: compass -->\n\nprose';

describe('AlertIconRenderer seam', () => {
  test.skipIf(!hasDom)('default: no renderer, the type icon renders and the name is never shown', async () => {
    const row = await render(TITLED);
    expect(row.querySelector('svg')).not.toBeNull();
    expect(row.querySelector('[data-host-icon]')).toBeNull();
    expect(row.textContent).toBe('Browser quirks');
  });

  test.skipIf(!hasDom)('a registered renderer receives the name and its node takes the icon slot', async () => {
    const names: string[] = [];
    setAlertIconRenderer((name) => { names.push(name); return <i data-host-icon={name} />; });
    const row = await render(TITLED);
    expect(names).toEqual(['compass']);
    expect(row.querySelector('[data-host-icon="compass"]')).not.toBeNull();
    expect(row.querySelector('svg')).toBeNull();
  });

  test.skipIf(!hasDom)('a renderer returning null falls back to the type icon', async () => {
    setAlertIconRenderer(() => null);
    const row = await render(TITLED);
    expect(row.querySelector('svg')).not.toBeNull();
  });

  test.skipIf(!hasDom)('an emoji on the title line wins over the renderer', async () => {
    let called = false;
    setAlertIconRenderer(() => { called = true; return <i data-host-icon />; });
    const row = await render('🧭 **Browser quirks** <!-- icon: compass -->\n\nprose');
    expect(called).toBe(false);
    expect(row.querySelector('.alert-emoji')?.textContent).toBe('🧭');
    expect(row.querySelector('[data-host-icon]')).toBeNull();
  });

  test.skipIf(!hasDom)('the renderer is not consulted when the title line carries no icon comment', async () => {
    let called = false;
    setAlertIconRenderer(() => { called = true; return <i data-host-icon />; });
    await render('**Plain title**\n\nprose');
    expect(called).toBe(false);
  });

  test.skipIf(!hasDom)('reset restores the default', async () => {
    setAlertIconRenderer(() => <i data-host-icon />);
    resetAlertIconRenderer();
    const row = await render(TITLED);
    expect(row.querySelector('[data-host-icon]')).toBeNull();
    expect(row.querySelector('svg')).not.toBeNull();
  });

  test.skipIf(!hasDom)('configurePlannotatorUI({ alertIconRenderer }) installs it', async () => {
    configurePlannotatorUI({ alertIconRenderer: (name) => <i data-host-icon={name} /> });
    const row = await render(TITLED);
    expect(row.querySelector('[data-host-icon="compass"]')).not.toBeNull();
  });
});
