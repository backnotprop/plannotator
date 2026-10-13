/**
 * The stale-tab reload prompt (DOM_TESTS=1).
 *
 * Guards: a decision refused with `409 session_mismatch` (this tab's server
 * was replaced by another session on the same address) must show the reload
 * prompt instead of reading as an ordinary failure; another 409 (the plan was
 * revised) must NOT show it; and the decision bodies the tab sends must carry
 * the nonce it loaded, or the server could never tell the tabs apart.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ServerSessionReplacedBanner } from './ServerSessionReplacedBanner';
import {
  __resetServerSessionForTests,
  adoptServerSession,
  noteServerSessionMismatch,
  withServerSession,
  withServerSessionQuery,
} from '../utils/serverSession';

const hasDom = typeof document !== 'undefined';
const BANNER = '[data-server-session-replaced]';
let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(onReload: () => void) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<ServerSessionReplacedBanner onReload={onReload} />);
  });
}

function conflict(code: string): Response {
  return new Response(JSON.stringify({ code, error: 'x' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
}

describe('ServerSessionReplacedBanner', () => {
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    __resetServerSessionForTests();
    if (hasDom) document.body.replaceChildren();
  });

  test.skipIf(!hasDom)('a session_mismatch refusal shows the reload prompt; Reload reloads', async () => {
    let reloads = 0;
    await mount(() => { reloads += 1; });
    expect(document.querySelector(BANNER)).toBeNull();

    let replaced = false;
    await act(async () => {
      replaced = await noteServerSessionMismatch(conflict('session_mismatch'));
    });
    expect(replaced).toBe(true);
    const banner = document.querySelector<HTMLElement>(BANNER);
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(banner?.textContent).toContain('This review was replaced');

    const reload = Array.from(banner?.querySelectorAll('button') ?? []).find((b) => b.textContent?.trim() === 'Reload');
    await act(async () => reload?.click());
    expect(reloads).toBe(1);
  });

  test.skipIf(!hasDom)('a plan_revised 409 or a 200 does not show it', async () => {
    await mount(() => {});
    await act(async () => {
      expect(await noteServerSessionMismatch(conflict('plan_revised'))).toBe(false);
      expect(await noteServerSessionMismatch(new Response('{}', { status: 200 }))).toBe(false);
    });
    expect(document.querySelector(BANNER)).toBeNull();
  });

  test.skipIf(!hasDom)('decision bodies and exit URLs carry the adopted nonce, and nothing before one is adopted', () => {
    expect(withServerSession({ feedback: 'x' })).toEqual({ feedback: 'x' });
    expect(withServerSessionQuery('/api/exit')).toBe('/api/exit');
    adoptServerSession('abc123');
    expect(withServerSession({ feedback: 'x' })).toEqual({ feedback: 'x', serverSession: 'abc123' });
    expect(withServerSessionQuery('/api/exit?draftGeneration=2')).toBe('/api/exit?draftGeneration=2&serverSession=abc123');
  });
});
