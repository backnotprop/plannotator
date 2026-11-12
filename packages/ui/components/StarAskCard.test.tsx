import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { StarAskCard, STAR_ASK_REPO_URL } = (hasDom ? await import('./StarAskCard') : {}) as typeof import('./StarAskCard');
const { STAR_ASK_WORDS } = (hasDom ? await import('../utils/starAskWords') : {}) as typeof import('../utils/starAskWords');
const { useStarAskDoneScreen } = (hasDom ? await import('./StarAskDoneScreen') : {}) as typeof import('./StarAskDoneScreen');
type StarAskClient = import('./StarAskDoneScreen').StarAskClient;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function render(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll<HTMLElement>('button, a')].find((b) => b.textContent?.trim() === text) ?? null;
const art = (el: HTMLElement) => el.querySelector('[data-star-ask-art]')!;

function calls() {
  const log: string[] = [];
  return {
    log,
    onAnswer: (answer: 'not-now' | 'opened') => log.push(`answer:${answer}`),
    onLeave: () => log.push('leave'),
  };
}

describe.skipIf(!hasDom)('the card', () => {
  test('both shapes: the short body, a named region (never a dialog), no "only once" line, the art asking', async () => {
    for (const shape of ['corner', 'card'] as const) {
      const c = calls();
      const el = await render(<StarAskCard shape={shape} canStar onStar={async () => true} {...c} />);
      const region = el.querySelector('section')!;
      const title = el.querySelector('h2')!;
      expect(title.id).not.toBe('');
      expect(region.getAttribute('aria-labelledby')).toBe(title.id);
      expect(el.querySelector('dialog, [role="dialog"]')).toBeNull();
      // Every surface uses the one short body, never a longer one.
      expect(el.querySelector('.psa-p')?.textContent).toBe(STAR_ASK_WORDS.body);
      expect(el.textContent).not.toContain('only ask once');
      expect(art(el).getAttribute('data-star-ask-art')).toBe('ask');
      expect(art(el).getAttribute('aria-hidden')).toBe('true');
      expect(art(el).textContent).toContain('star it?');
      expect(art(el).textContent).toContain('a small ask');
      await act(async () => root!.unmount());
      root = null;
      host?.remove();
    }
  });

  test('Star on GitHub (gh can star): one star on the click, "Starring…", then thanks with the art lit and the keyboard on Close', async () => {
    const c = calls();
    let stars = 0;
    let finish!: (starred: boolean) => void;
    const onStar = () => {
      stars++;
      return new Promise<boolean>((resolve) => (finish = resolve));
    };
    const el = await render(<StarAskCard shape="card" canStar onStar={onStar} {...c} />);
    expect(stars).toBe(0);
    const star = button(el, 'Star on GitHub')!;
    expect(star.tagName).toBe('BUTTON');
    star.focus();
    await act(async () => star.click());
    expect(stars).toBe(1);
    expect(button(el, 'Starring…')?.getAttribute('aria-busy')).toBe('true');
    await act(async () => button(el, 'Starring…')!.click());
    expect(stars).toBe(1);
    await act(async () => finish(true));
    await settle();
    expect(el.querySelector('[role="status"]')?.textContent).toBe('Starred. Thank you!');
    expect(art(el).getAttribute('data-star-ask-art')).toBe('lit');
    expect(art(el).textContent).toContain('starred.');
    expect(art(el).textContent).toContain('decided · recorded');
    expect(document.activeElement?.textContent).toBe('Close');
    expect(c.log).toEqual([]);
    await act(async () => button(el, 'Close')!.click());
    expect(c.log).toEqual(['leave']);
  });

  test('a failed star: no thanks, an Open GitHub link (a real new-tab link) that records the open', async () => {
    const c = calls();
    const el = await render(<StarAskCard shape="corner" canStar onStar={async () => false} {...c} />);
    await act(async () => button(el, 'Star on GitHub')!.click());
    await settle();
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Couldn’t star it from here.');
    expect(art(el).getAttribute('data-star-ask-art')).toBe('ask');
    const link = button(el, 'Open GitHub') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(STAR_ASK_REPO_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    link.addEventListener('click', (event) => event.preventDefault());
    await act(async () => link.click());
    expect(c.log).toEqual(['answer:opened']);
    expect(el.querySelector('[role="status"]')?.textContent).toBe('Thank you! GitHub is open in a new tab.');
  });

  test('gh cannot star (missing, signed out): the button is a real link, opened by the click itself', async () => {
    const c = calls();
    let stars = 0;
    const el = await render(<StarAskCard shape="card" canStar={false} onStar={async () => (stars++, true)} {...c} />);
    const link = button(el, 'Star on GitHub') as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('https://github.com/backnotprop/plannotator');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    link.addEventListener('click', (event) => event.preventDefault());
    await act(async () => link.click());
    expect(stars).toBe(0);
    expect(c.log).toEqual(['answer:opened']);
    expect(el.querySelector('[role="status"]')?.textContent).toBe('Thank you! GitHub is open in a new tab.');
    expect(art(el).getAttribute('data-star-ask-art')).toBe('lit');
  });

  test('Not now records and leaves; no key closes it (no new shortcut)', async () => {
    const c = calls();
    const el = await render(<StarAskCard shape="corner" canStar onStar={async () => true} {...c} />);
    el.querySelector('section')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(c.log).toEqual([]);
    await act(async () => button(el, 'Not now')!.click());
    expect(c.log).toEqual(['answer:not-now', 'leave']);
  });

  test('after a thank-you the corner sees itself out; the card waits for Close', async () => {
    const corner = calls();
    await render(<StarAskCard shape="corner" canStar onStar={async () => true} initialState="starred" leaveAfterMs={20} {...corner} />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(corner.log).toEqual(['leave']);
    await act(async () => root!.unmount());
    root = null;
    const card = calls();
    await render(<StarAskCard shape="card" canStar onStar={async () => true} initialState="starred" leaveAfterMs={20} {...card} />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(card.log).toEqual([]);
  });
});

describe.skipIf(!hasDom)('the done screen (useStarAskDoneScreen)', () => {
  function client(answer: { show: boolean; can_star: boolean }, shown = true) {
    const log: string[] = [];
    const api: StarAskClient = {
      claim: async () => (log.push('claim'), answer),
      shown: async () => (log.push('shown'), { show: shown }),
      answer: async (a) => log.push(`answer:${a}`),
    };
    return { api, log };
  }

  function Screen(props: { ready?: boolean; eligible: boolean; decided: boolean; api: StarAskClient; delay?: string | (() => string); tick?: number }) {
    const delay = props.delay;
    const footer = useStarAskDoneScreen({ ready: props.ready ?? true, eligible: props.eligible, decided: props.decided, client: props.api, autoCloseDelay: typeof delay === 'function' ? delay : () => delay ?? 'off' });
    return <div data-tick={props.tick}>{footer}</div>;
  }

  test('claims once at load (nothing used up), stamps it with shown only at the decision, then draws the card with the link', async () => {
    const { api, log } = client({ show: true, can_star: true });
    const el = await render(<Screen ready={false} eligible decided={false} api={api} />);
    expect(log).toEqual([]);
    await act(async () => root!.render(<Screen eligible decided={false} api={api} />));
    await settle();
    expect(log).toEqual(['claim']);
    expect(el.querySelector('[data-star-ask]')).toBeNull();
    await act(async () => root!.render(<Screen eligible decided api={api} tick={2} />));
    await settle();
    expect(log).toEqual(['claim', 'shown']);
    expect(el.querySelector('[data-star-ask="card"]')).not.toBeNull();
    expect(button(el, 'Star on GitHub')?.tagName).toBe('A');
    await act(async () => button(el, 'Not now')!.click());
    expect(log).toEqual(['claim', 'shown', 'answer:not-now']);
    expect(el.querySelector('[data-star-ask]')).toBeNull();
  });

  test('never stamped without a decision (a reload, a session left open or closed): the claim alone uses nothing up', async () => {
    const { api, log } = client({ show: true, can_star: true });
    const el = await render(<Screen eligible decided={false} api={api} />);
    await settle();
    await act(async () => root!.unmount());
    root = null;
    host?.remove();
    expect(log).toEqual(['claim']);
    expect(el.querySelector('[data-star-ask]')).toBeNull();
  });

  test('auto-close turned on during the review: no shown at the decision, no card', async () => {
    let delay = 'off';
    const { api, log } = client({ show: true, can_star: true });
    const el = await render(<Screen eligible decided={false} api={api} delay={() => delay} />);
    await settle();
    delay = '3';
    await act(async () => root!.render(<Screen eligible decided api={api} delay={() => delay} tick={2} />));
    await settle();
    expect(log).toEqual(['claim']);
    expect(el.querySelector('[data-star-ask]')).toBeNull();
  });

  test('shown says no (another surface or process drew it first, or the server is gone): no card', async () => {
    const { api, log } = client({ show: true, can_star: true }, false);
    const el = await render(<Screen eligible decided api={api} />);
    await settle();
    await settle();
    expect(log).toEqual(['claim', 'shown']);
    expect(el.querySelector('[data-star-ask]')).toBeNull();
  });

  test('the server says no: nothing shows on the done screen', async () => {
    const { api, log } = client({ show: false, can_star: false });
    const el = await render(<Screen eligible decided api={api} />);
    await settle();
    expect(log).toEqual(['claim']);
    expect(el.querySelector('[data-star-ask]')).toBeNull();
  });

  test('never asks with auto-close on, or outside a live session (shared, archive, portal, VS Code)', async () => {
    for (const props of [{ eligible: true, delay: '3' }, { eligible: true, delay: '0' }, { eligible: false }]) {
      const { api, log } = client({ show: true, can_star: true });
      const el = await render(<Screen {...props} decided api={api} />);
      await settle();
      expect(log).toEqual([]);
      expect(el.querySelector('[data-star-ask]')).toBeNull();
      await act(async () => root!.unmount());
      root = null;
      host?.remove();
    }
  });
});
