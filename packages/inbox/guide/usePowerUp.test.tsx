/**
 * Power Up in an Inbox reader (usePowerUp.ts, PowerUpMark.tsx): asked only once the page's first settings read is in
 * and while code review's Power Up switch is on (config.json `diffOptions.powerUp`, read on any address) and a key is
 * set; the mark in the review's bar sums the drawn views' statuses and says why when the provider failed; a view that
 * goes (another chapter) takes its status with it; a phone shows the face alone, whose press opens one card that a
 * press anywhere else closes. The provider is never called: the settings read is a stand-in fetch. That Retry asks
 * again is AllFilesCodeView.hostSemantic.test.tsx's (the shared config and slot).
 */
import { afterEach, expect, test } from 'bun:test';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configStore } from '@plannotator/ui/config';
import { POWER_UP_CHANGED_EVENT } from '@plannotator/ui/components/settings/PowerUpSettings';
import type { SemDiffClient } from '@plannotator/review-editor/semDiff/semDiffClient';
import { resetInboxDiffOptionsForTests } from '../diffOptions';
import { resetReviewAnalysisForTests, waitForReviewAnalysis } from '../reviewAnalysis';
import { usePowerUp, usePowerUpReport, type InboxPowerUp } from './usePowerUp';
import { PowerUpMark } from './PowerUpMark';

const hasDom = typeof document !== 'undefined';
const realFetch = globalThis.fetch;
const roots: Root[] = [];
const CLIENT = {} as SemDiffClient;

function keySet(configured: boolean, extra: Record<string, unknown> = {}) {
  const reads: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    reads.push(String(input));
    return new Response(JSON.stringify({ configured, provider: configured ? 'custom' : null, ...(configured ? { endpoint: '127.0.0.1:4317' } : {}), ...extra }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return reads;
}

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function render(node: HTMLElement, element: React.ReactElement) {
  const root = createRoot(node);
  roots.push(root);
  await act(async () => root.render(element));
  await settle();
}

async function reader(compact = false): Promise<{ seen: InboxPowerUp[]; node: HTMLElement }> {
  const seen: InboxPowerUp[] = [];
  const node = document.createElement('div');
  document.body.appendChild(node);
  function Probe() {
    const power = usePowerUp(CLIENT);
    seen.push(power);
    return <PowerUpMark power={power} compact={compact} />;
  }
  await render(node, <Probe />);
  return { seen, node };
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
  resetInboxDiffOptionsForTests();
  resetReviewAnalysisForTests();
  configStore.seed('diffSemantic', true);
  configStore.seed('diffPowerUp', true);
});

const ok = (links: number) => ({ asking: 0, answered: 1, links, unavailable: null });
const FAILED = { asking: 0, answered: 0, links: 0, unavailable: 'failed' as const };
const TWO_LINKS = ok(2);

test.skipIf(!hasDom)('with a key, the mark sums every drawn view and says why a provider failed', async () => {
  configStore.seed('diffSemantic', true);
  configStore.seed('diffPowerUp', true);
  const reads = keySet(true);
  const { seen, node } = await reader();
  const power = () => seen.at(-1)!;
  expect(reads).toEqual(['/api/sem-diff/opinion/settings']);
  expect(power().powerUp?.active).toBe(true);
  // Nothing shown until a view has said how it went.
  expect(node.querySelector('[data-inbox-power-up]')).toBeNull();
  await act(async () => {
    power().report('cart', ok(1));
    power().report('tax', ok(2));
  });
  expect(node.querySelector('[data-power-up-status]')?.getAttribute('data-power-up-status')).toBe('powered');
  expect(node.textContent).toContain('Powered up · 3 links');
  await act(async () => power().report('tax', { asking: 0, answered: 0, links: 0, unavailable: 'refusedKey' }));
  expect(node.textContent).toContain('Power Up: key refused');
  expect([...node.querySelectorAll('button')].some((button) => button.textContent === 'Retry')).toBe(true);
});

test.skipIf(!hasDom)('a guide that changes chapters: a failure in a chapter no longer drawn does not stay on the mark', async () => {
  configStore.seed('diffSemantic', true);
  configStore.seed('diffPowerUp', true);
  keySet(true);
  const node = document.createElement('div');
  document.body.appendChild(node);
  let power: InboxPowerUp | null = null;
  let showChapter: (chapter: number) => void = () => {};
  // Each chapter's file view, wired as GuideReader's GuideDiff is (usePowerUpReport).
  function FileView({ report, status }: { report: InboxPowerUp['report']; status: Parameters<InboxPowerUp['report']>[1] }) {
    const onStatus = usePowerUpReport(report);
    // As AllFilesCodeView does once its ask came back.
    useEffect(() => {
      if (status) onStatus?.(status);
    }, [onStatus, status]);
    return null;
  }
  function Guide() {
    const current = usePowerUp(CLIENT);
    power = current;
    const [chapter, setChapter] = useState(1);
    showChapter = setChapter;
    return (
      <>
        <PowerUpMark power={current} compact={false} />
        {chapter === 1 && <FileView key="one" report={current.report} status={FAILED} />}
        {chapter === 2 && <FileView key="two" report={current.report} status={TWO_LINKS} />}
      </>
    );
  }
  await render(node, <Guide />);
  await settle();
  expect(power!.powerUp?.active).toBe(true);
  expect(node.querySelector('[data-power-up-status]')?.getAttribute('data-power-up-status')).toBe('unavailable');
  await act(async () => showChapter(2));
  await settle();
  expect(node.querySelector('[data-power-up-status]')?.getAttribute('data-power-up-status')).toBe('powered');
  expect(node.textContent).toContain('Powered up · 2 links');
  expect([...node.querySelectorAll('button')].some((button) => button.textContent === 'Retry')).toBe(false);
});

test.skipIf(!hasDom)('no key: nothing is asked and no mark is drawn', async () => {
  configStore.seed('diffSemantic', true);
  configStore.seed('diffPowerUp', true);
  keySet(false);
  const { seen, node } = await reader();
  expect(seen.at(-1)!.powerUp).toBeNull();
  expect(node.querySelector('[data-inbox-power-up]')).toBeNull();
});

test.skipIf(!hasDom)('a phone: the face alone in the bar; its press opens one card, and a press anywhere else closes it', async () => {
  configStore.seed('diffSemantic', true);
  configStore.seed('diffPowerUp', true);
  keySet(true, { source: 'env' });
  const { seen, node } = await reader(true);
  await act(async () => seen.at(-1)!.report('cart', { asking: 0, answered: 0, links: 0, unavailable: 'refusedKey' }));
  const face = node.querySelector<HTMLButtonElement>('button[data-power-up-slot]')!;
  expect(face.getAttribute('aria-label')).toBe('Power Up: key refused');
  expect(node.querySelector('[data-power-up-card]')).toBeNull();
  expect(node.textContent).not.toContain('Power Up');
  await act(async () => face.click());
  const card = node.querySelector('[data-power-up-card]')!;
  // One title (the bar's words), not a second one under it.
  expect([...card.querySelectorAll('.font-medium')].map((line) => line.textContent)).toEqual(['Power Up: key refused']);
  // A key from the environment is not changed in code review's Settings: the card says where it comes from.
  expect(card.textContent).toContain('PLANNOTATOR_OPINION_API_KEY');
  expect(card.textContent).not.toContain("code review's Settings");
  // Inside the card (Retry's row) keeps it open; a press on the page outside closes it, focus or not (iOS).
  await act(async () => card.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(node.querySelector('[data-power-up-card]')).not.toBeNull();
  await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(node.querySelector('[data-power-up-card]')).toBeNull();
});

test.skipIf(!hasDom)('a key saved on Settings › Reviews (its Power Up section) powers up an open reader without a reload', async () => {
  configStore.seed('diffSemantic', true);
  configStore.seed('diffPowerUp', true);
  keySet(false);
  const { seen } = await reader();
  expect(seen.at(-1)!.powerUp).toBeNull();
  const reads = keySet(true);
  // What the Reviews page's Power Up form sends once a key is saved (PowerUpSettings.tsx `changed`).
  await act(async () => window.dispatchEvent(new Event(POWER_UP_CHANGED_EVENT)));
  await settle();
  expect(reads).toEqual(['/api/sem-diff/opinion/settings']);
  expect(seen.at(-1)!.powerUp?.active).toBe(true);
});

// Last: config.json's value, once adopted, stays this page's (the store's server value).
test.skipIf(!hasDom)('a slow first settings read: nothing is asked from the cookie meanwhile, and Power Up off in config.json stays off', async () => {
  configStore.seed('diffSemantic', true);
  configStore.seed('diffPowerUp', true);
  keySet(true);
  // The page's first settings read is still out; this address's cookie says Power Up is on.
  let answer: (settings: object) => void = () => {};
  waitForReviewAnalysis(new Promise<object>((resolve) => (answer = resolve)));
  const { seen, node } = await reader();
  await settle();
  expect(seen.every((power) => power.powerUp === null)).toBe(true);
  // It answers: code review saved Power Up off.
  await act(async () => answer({ diff_options: { power_up: false }, review_analysis: null }));
  await settle();
  await act(async () => seen.at(-1)!.report('cart', { asking: 1, answered: 0, links: 0, unavailable: null }));
  expect(seen.every((power) => power.powerUp === null)).toBe(true);
  expect(node.querySelector('[data-inbox-power-up]')).toBeNull();
});
