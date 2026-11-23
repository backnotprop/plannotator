/**
 * The risk bars' card (approval "review-risk-bars", q-070bc2a3: "a card on the bars; no row in the diff"), on the real
 * mark buttons the diff keeps (review-editor's hostLineMarks.ts) inside a file's shadow root. What regresses: the
 * reason unreadable (no card on hover, keyboard focus or a press), a pinned card closing when the pointer leaves, a card
 * that Escape, a press outside or a second press does not close, the header's places stepper not opening the place's
 * card (or leaving the one before open), the bars with no accessible name that says the reason, the person's rule the
 * old row showed missing, or a Medium place's card without its reason (or a made-up one when it has none); a card
 * left on bars that are gone (stuck at the page's corner), or one that takes an Escape a comment box was typed in.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPullRiskJudgment, InboxPullRiskPlace } from '@plannotator/core/inbox-types';
import { REF_CARD_CLOSE_MS, REF_CARD_DELAY_MS } from '@plannotator/ui/components/RefHoverCard';
import { dropHostLineMarks, keepHostLineMarks } from '../../review-editor/components/hostLineMarks';
import { riskBarsMarkId, riskBarsOf, type RiskBars } from './riskBars';
import { riskBarsLineMarks } from './riskBarsMarks';
import { useRiskBarsCard } from './RiskBarsCard';

const hasDom = typeof document !== 'undefined';

const PATCH = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -10,3 +10,4 @@\n keep\n-old\n+one\n+two\n keep\n`;
const FILES = [{ path: 'src/retry.ts', patch: PATCH('src/retry.ts') }, { path: 'src/client.ts', patch: PATCH('src/client.ts') }];
const place = (file: string, line: number, why: string, rule?: string, side: 'old' | 'new' = 'new'): InboxPullRiskPlace => ({ file, side, lines: [line, line], why, ...(rule ? { rule } : {}) });
const judged = (level: 'high' | 'medium', where: InboxPullRiskPlace[]): InboxPullRiskJudgment => ({ level, why: 'It charges twice.', where });

const HIGH = riskBarsOf(judged('high', [place('src/retry.ts', 11, 'Each retry charges the card twice.', 'Anything in billing.'), place('src/client.ts', 11, 'Charges stop being idempotent.', undefined, 'old')]), FILES)!;

let host: HTMLDivElement | null = null;
let root: Root | null = null;
const shadows: ShadowRoot[] = [];
let api: ReturnType<typeof useRiskBarsCard> | null = null;

/** A file of the diff as the PR page draws it: its shell, Pierre's container and its lines in a shadow root. */
function fileDiff(path: string) {
  const shell = document.createElement('div');
  shell.setAttribute('data-guide-file-shell', path);
  const container = document.createElement('diffs-container');
  shell.appendChild(container);
  host!.appendChild(shell);
  const shadow = container.attachShadow({ mode: 'open' });
  const pre = document.createElement('pre');
  pre.setAttribute('data-overflow', 'scroll');
  for (const [column, lines] of [['deletions', [10, 11, 12]], ['additions', [10, 11, 12, 13]]] as const) {
    const code = document.createElement('code');
    code.setAttribute(`data-${column}`, '');
    for (const n of lines) {
      const line = document.createElement('div');
      line.setAttribute('data-line', String(n));
      line.textContent = 'const x = 1;';
      code.appendChild(line);
    }
    pre.appendChild(code);
  }
  shadow.appendChild(pre);
  shadows.push(shadow);
  return shadow;
}

function Page({ bars }: { bars: RiskBars }): ReactElement {
  const card = useRiskBarsCard(bars);
  api = card;
  return <>{card.node}</>;
}

async function mount(bars: RiskBars) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  const app = document.createElement('div');
  host.appendChild(app);
  root = createRoot(app);
  await act(async () => root!.render(<Page bars={bars} />));
  const marks = riskBarsLineMarks(bars);
  for (const path of FILES.map((f) => f.path)) {
    keepHostLineMarks(fileDiff(path), marks.filter((m) => m.filePath === path), (...args) => api!.onMark(...args));
  }
}

const wait = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
const bars = (path: string) => document.querySelector(`[data-guide-file-shell="${path}"] diffs-container`)!.shadowRoot!.querySelector<HTMLButtonElement>('button[data-host-line-mark]')!;
const card = () => document.querySelector<HTMLElement>('.ib-riskcard');

afterEach(async () => {
  for (const shadow of shadows.splice(0)) dropHostLineMarks(shadow);
  await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  api = null;
});

describe.skipIf(!hasDom)('the risk bars card', () => {
  test('the bars are a button named by the level, the rule and the reason, as the card says them', async () => {
    await mount(HIGH);
    expect(bars('src/retry.ts').getAttribute('aria-label')).toBe('High risk · your rule “Anything in billing.”: Each retry charges the card twice.');
    expect(bars('src/client.ts').getAttribute('aria-label')).toBe('High risk: Charges stop being idempotent.');
    expect(bars('src/client.ts').parentElement!.closest('[data-deletions]')).not.toBeNull();
  });

  test('hover opens it with what the old row said; leaving closes it', async () => {
    await mount(HIGH);
    await act(async () => void bars('src/retry.ts').dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' })));
    expect(card()).toBeNull();
    await wait(REF_CARD_DELAY_MS + 50);
    const text = card()?.textContent ?? '';
    expect(text).toContain('Risk');
    expect(text).toContain('High');
    expect(text).toContain('your rule “Anything in billing.”');
    expect(text).toContain('Each retry charges the card twice.');
    expect(card()!.getAttribute('aria-label')).toBe('High risk · your rule “Anything in billing.”: Each retry charges the card twice.');
    await act(async () => void bars('src/retry.ts').dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' })));
    await wait(REF_CARD_CLOSE_MS + 50);
    expect(card()).toBeNull();
  });

  test('keyboard focus opens it; focus leaving closes it', async () => {
    await mount(HIGH);
    await act(async () => bars('src/client.ts').focus());
    await wait(REF_CARD_DELAY_MS + 50);
    expect(card()?.textContent).toContain('Charges stop being idempotent.');
    // No rule named for this place: no rule words.
    expect(card()?.querySelector('[data-risk-card-rule]')).toBeNull();
    await act(async () => bars('src/client.ts').blur());
    expect(card()).toBeNull();
  });

  test('a press pins it: it stays when the pointer leaves; a second press, Escape or a press outside close it', async () => {
    await mount(HIGH);
    const b = bars('src/retry.ts');
    await act(async () => b.click());
    expect(card()?.hasAttribute('data-risk-card-pinned')).toBe(true);
    await act(async () => void b.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' })));
    await wait(REF_CARD_CLOSE_MS + 50);
    expect(card()).not.toBeNull();
    await act(async () => b.click());
    expect(card()).toBeNull();

    await act(async () => b.click());
    await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(card()).toBeNull();

    await act(async () => b.click());
    // A press in the card keeps it; one outside closes it.
    await act(async () => void card()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true })));
    expect(card()).not.toBeNull();
    await act(async () => void document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect(card()).toBeNull();
  });

  test('a card closes when its bars are taken away, and the bars made again open none until asked', async () => {
    await mount(HIGH);
    const b = bars('src/retry.ts');
    await act(async () => b.click());
    expect(card()).not.toBeNull();
    // The line drawn again (Pierre replaces its element): the same button goes back on it, and the card stays.
    const line = b.parentElement!;
    const again = document.createElement('div');
    again.setAttribute('data-line', line.getAttribute('data-line')!);
    again.textContent = 'const x = 1;';
    await act(async () => line.replaceWith(again));
    await wait(50);
    expect(bars('src/retry.ts')).toBe(b);
    expect(card()).not.toBeNull();
    // The file's element let go (the view drops its marks): the card closes.
    const shadow = shadows[0]!;
    await act(async () => dropHostLineMarks(shadow));
    await wait(50);
    expect(b.isConnected).toBe(false);
    expect(card()).toBeNull();
    // The file back: its bars are a new button, and no card opens on them by itself.
    const marks = riskBarsLineMarks(HIGH).filter((m) => m.filePath === 'src/retry.ts');
    await act(async () => keepHostLineMarks(shadow, marks, (...args) => api!.onMark(...args)));
    await wait(50);
    expect(bars('src/retry.ts')).not.toBe(b);
    expect(card()).toBeNull();
  });

  test('Escape typed in a comment box is the box’s, with a card open; from the bars or nowhere it closes the card', async () => {
    await mount(HIGH);
    const box = document.createElement('textarea');
    host!.appendChild(box);
    let boxHeard = 0;
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) boxHeard++;
    });
    const b = bars('src/retry.ts');
    await act(async () => b.click());
    await act(async () => box.focus());
    await act(async () => void box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true })));
    expect(boxHeard).toBe(1);
    expect(card()).not.toBeNull();
    // From the bars themselves: the card's.
    await act(async () => b.focus());
    await act(async () => void b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true })));
    expect(card()).toBeNull();
  });

  test('the bars say they open a dialog, and whether it is open', async () => {
    await mount(HIGH);
    const b = bars('src/retry.ts');
    expect(b.getAttribute('aria-haspopup')).toBe('dialog');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    await act(async () => b.click());
    expect(b.getAttribute('aria-expanded')).toBe('true');
    await act(async () => b.click());
    expect(b.getAttribute('aria-expanded')).toBe('false');
  });

  test('the places stepper opens each place’s card in turn, closing the one before', async () => {
    await mount(HIGH);
    await act(async () => api!.show(riskBarsMarkId('src/retry.ts', 'new', 11)));
    await wait(120);
    expect(card()?.textContent).toContain('Each retry charges the card twice.');
    expect(card()?.hasAttribute('data-risk-card-pinned')).toBe(true);
    await act(async () => api!.show(riskBarsMarkId('src/client.ts', 'old', 11)));
    await wait(120);
    expect(document.querySelectorAll('.ib-riskcard')).toHaveLength(1);
    expect(card()?.textContent).toContain('Charges stop being idempotent.');
    expect(card()?.textContent).not.toContain('Each retry');
  });

  test('Medium: the same card with its reason; a place with none shows the level alone', async () => {
    await mount(riskBarsOf(judged('medium', [place('src/retry.ts', 11, 'It looks the charge up first.'), place('src/client.ts', 12, '')]), FILES)!);
    expect(bars('src/client.ts').getAttribute('aria-label')).toBe('Medium risk');
    await act(async () => bars('src/retry.ts').click());
    expect(card()?.getAttribute('data-risk-card')).toBe('medium');
    expect(card()?.textContent).toContain('Medium');
    expect(card()?.textContent).toContain('It looks the charge up first.');
    await act(async () => bars('src/client.ts').click());
    expect(card()?.textContent).toContain('Medium');
    expect(card()?.querySelector('.ib-ctxn-t')).toBeNull();
  });
});
