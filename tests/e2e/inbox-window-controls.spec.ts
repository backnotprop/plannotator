/**
 * The window controls hook, in a real browser against the compiled binary: a
 * desktop host that draws the window's buttons over the page sets
 * `--pn-window-controls-width` and `-height` on `:root` (health says
 * `window_controls: 2`), and reads `--pn-window-controls-center-y` to place them.
 *
 *  - Set: the sidebar's first row clears the height, a header against the
 *    window's left edge clears the width (sidebar collapsed, peeking, a phone's
 *    width), and a full-window layer clears the height.
 *  - Set: the toggle, the list's title and the thread toolbar share one line, the
 *    one `--pn-window-controls-center-y` names, whatever the sidebar does.
 *  - Blank header space drags and every control a pointer can reach does not.
 *    Headless Chromium does not report drag regions, so `dragAt` works them out
 *    the way Blink does: each visible box in layout order, a later one over an
 *    earlier one, modal dialogs last.
 *  - Unset: nothing moves and nothing drags.
 *
 * Pictures land in PLANNOTATOR_WINDOW_CONTROLS_SHOTS (default
 * .local/proof/window-controls). Build the binary first (see inbox.spec.ts).
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { removeInboxScratch } from './inbox-scratch';
import { openFullScreenFile, openRoute, seedControlsWorld, type ControlsWorld } from './inbox-window-controls-world';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_WINDOW_CONTROLS_SHOTS ?? join(repo, '.local/proof/window-controls'));
const W = 78;
const H = 46;

let world: ControlsWorld;
let context: BrowserContext;
let page: Page;
let phoneContext: BrowserContext;
let phone: Page;

test.describe.configure({ mode: 'serial' });

/** As a host injects it: a sheet added after the page has loaded. */
async function setControls(on: Page): Promise<void> {
  await on.addStyleTag({ content: `:root { --pn-window-controls-width: ${W}px; --pn-window-controls-height: ${H}px; }` });
  await on.waitForTimeout(100);
}

const top = (on: Page, selector: string) => on.locator(selector).first().evaluate((el) => el.getBoundingClientRect().top);

const boxOf = (on: Page, selector: string) =>
  on.locator(selector).first().evaluate((el) => {
    const { top, bottom, height } = el.getBoundingClientRect();
    return { top, bottom, height, centre: top + height / 2 };
  });

/** The line the page says its heads sit on: a host reads a number. */
const centerY = (on: Page) => on.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pn-window-controls-center-y'));

/** The left edge of the first thing in a header that holds something: a control, a title. */
const firstContentLeft = (on: Page, selector: string) =>
  on.locator(selector).first().evaluate((head) => {
    const lefts = [...head.children].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0).map((r) => r.left);
    return Math.min(...lefts);
  });

/** How far in from the header's own edge its content starts. */
const contentInset = async (on: Page, selector: string) => (await firstContentLeft(on, selector)) - (await on.locator(selector).first().evaluate((head) => head.getBoundingClientRect().left));

/** Installs `dragAt(x, y)`: whether a press at that point would drag the window, as the page stands now. */
async function installDragAt(on: Page): Promise<void> {
  await on.evaluate(() => {
    const regions: { left: number; top: number; right: number; bottom: number; drag: boolean }[] = [];
    const all = [...document.body.querySelectorAll('*')];
    const inModal = (el: Element) => el.closest('dialog:modal') !== null;
    for (const el of [...all.filter((e) => !inModal(e)), ...all.filter(inModal)]) {
      const style = getComputedStyle(el);
      if (style.display === 'none') continue;
      const mode = style.getPropertyValue('-webkit-app-region');
      if (style.visibility === 'visible' && mode !== 'none') {
        const { left, top, right, bottom } = el.getBoundingClientRect();
        regions.push({ left, top, right, bottom, drag: mode === 'drag' });
      }
      const before = getComputedStyle(el, '::before');
      const beforeMode = before.getPropertyValue('-webkit-app-region');
      if (before.content !== 'none' && before.position === 'fixed' && beforeMode !== 'none') {
        regions.push({ left: 0, top: 0, right: innerWidth, bottom: parseFloat(before.height), drag: beforeMode === 'drag' });
      }
    }
    (window as unknown as { dragAt: (x: number, y: number) => boolean }).dragAt = (x, y) => {
      let drag = false;
      for (const r of regions) if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) drag = r.drag;
      return drag;
    };
  });
}

/** Every control a pointer reaches at its centre, and those that a press there would not click. */
async function controlsThatDrag(on: Page): Promise<{ reached: number; dragging: string[] }> {
  await installDragAt(on);
  return on.evaluate(() => {
    const { dragAt } = window as unknown as { dragAt: (x: number, y: number) => boolean };
    const controls = document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, label, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"]');
    let reached = 0;
    const dragging: string[] = [];
    for (const control of controls) {
      const box = control.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(control === hit || control.contains(hit))) continue;
      reached += 1;
      if (dragAt(x, y)) dragging.push(`${control.tagName}.${control.className} "${control.getAttribute('aria-label') ?? control.textContent?.slice(0, 30)}" at ${Math.round(x)},${Math.round(y)}`);
    }
    return { reached, dragging };
  });
}

/** A press on the header's own blank space, found by walking across its middle. */
async function headerBlankDrags(on: Page, selector: string): Promise<boolean> {
  await installDragAt(on);
  return on.locator(selector).first().evaluate((head) => {
    const { dragAt } = window as unknown as { dragAt: (x: number, y: number) => boolean };
    const box = head.getBoundingClientRect();
    const y = box.top + box.height / 2;
    for (let x = box.right - 2; x > box.left; x -= 4) {
      const hit = document.elementFromPoint(x, y);
      if (hit === head || hit?.matches('.ib-sp, .ib-bsp')) return dragAt(x, y);
    }
    throw new Error('the header has no blank space');
  });
}

/** Whether the band above a layer drags, right of the window's buttons. */
async function bandDrags(on: Page): Promise<boolean> {
  await installDragAt(on);
  return on.evaluate(([x, y]) => (window as unknown as { dragAt: (x: number, y: number) => boolean }).dragAt(x!, y!), [W + 40, H / 2]);
}

/** Nothing in the page asks to drag, and the band does not exist. */
async function nothingDrags(on: Page): Promise<void> {
  const found = await on.evaluate(() => [...document.querySelectorAll('*')].filter((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region') !== 'none').length + (getComputedStyle(document.querySelector('.pn-inbox')!, '::before').content === 'none' ? 0 : 1));
  expect(found).toBe(0);
}

/** The window's buttons, drawn on the picture only: the host draws its own. */
async function shot(on: Page, name: string): Promise<void> {
  await on.evaluate(([w, h]) => {
    const lights = document.createElement('div');
    lights.setAttribute('data-proof-lights', '');
    lights.style.cssText = `position:fixed;top:0;left:0;width:${w}px;height:${h}px;z-index:9999;pointer-events:none;display:flex;align-items:center;justify-content:center;gap:8px;outline:1px dashed rgb(255 0 128 / 0.55);outline-offset:-1px`;
    for (const color of ['#ff5f57', '#febc2e', '#28c840']) {
      const dot = document.createElement('span');
      dot.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color}`;
      lights.append(dot);
    }
    document.body.append(lights);
  }, [W, H]);
  for (const scheme of ['light', 'dark'] as const) {
    await on.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await on.waitForTimeout(200);
    await on.screenshot({ path: join(shots, `${name}-${scheme}.png`) });
  }
  await on.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await on.evaluate(() => document.querySelector('[data-proof-lights]')?.remove());
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  world = await seedControlsWorld(binary, 'plannotator-inbox-window-controls-');
  const notifications = async (c: BrowserContext) => {
    await c.grantPermissions(['notifications'], { origin: new URL(world.url).origin });
    await c.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), (route) => route.abort());
    return c;
  };
  context = await notifications(await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' }));
  page = await context.newPage();
  phoneContext = await notifications(await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', reducedMotion: 'reduce' }));
  phone = await phoneContext.newPage();
});

test.afterAll(async () => {
  try {
    await context?.close();
    await phoneContext?.close();
    for (const agent of world?.agents ?? []) await agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

test('health declares the hook', async () => {
  const health = (await (await page.request.get(`${world.url}api/inbox/health`)).json()) as { window_controls?: unknown };
  expect(health.window_controls).toBe(2);
});

test('unset: nothing moves and nothing drags', async () => {
  await openRoute(page, world, '');
  expect(await top(page, '.ib-brand')).toBe(14);
  expect((await boxOf(page, '.ib-lhead')).height).toBe(60);
  await nothingDrags(page);

  expect(await contentInset(page, '.ib-lhead')).toBe(22);

  await openRoute(page, world, '', 'collapsed');
  expect(await contentInset(page, '.ib-lhead')).toBe(22);
  expect(await top(page, '.ib-peek-strip')).toBe(0);
  await nothingDrags(page);

  await openRoute(page, world, `#thread=${world.thread}&guide=${world.guide}`);
  expect(await top(page, '.ib-viewer .ib-vhead')).toBe(0);
  await nothingDrags(page);

  await openRoute(page, world, '#settings');
  expect((await top(page, '.ib-sback')) - (await top(page, '.ib-spage'))).toBe(26);
  await nothingDrags(page);

  await openFullScreenFile(page, world, world.picture);
  expect(await top(page, '.ib-view.ib-full .ib-vbody')).toBe(0);
  await nothingDrags(page);

  await openRoute(phone, world, '');
  expect(await contentInset(phone, '.ib-lhead')).toBe(4);
  await nothingDrags(phone);
});

test('the sidebar open: its first row clears the height, the list stays put, blank header space drags', async () => {
  await openRoute(page, world, '');
  const before = await firstContentLeft(page, '.ib-lhead');
  await setControls(page);
  expect(await top(page, '.ib-brand')).toBeGreaterThanOrEqual(H);
  expect(await firstContentLeft(page, '.ib-lhead')).toBe(before);

  expect(await headerBlankDrags(page, '.ib-lhead')).toBe(true);
  expect(await bandDrags(page)).toBe(true);
  const { reached, dragging } = await controlsThatDrag(page);
  expect(reached).toBeGreaterThan(5);
  expect(dragging).toEqual([]);
  await shot(page, 'sidebar-open');
});

test('the sidebar collapsed: the header at the left edge clears the width and its toggle clicks', async () => {
  await openRoute(page, world, '', 'collapsed');
  await setControls(page);
  expect(await firstContentLeft(page, '.ib-lhead')).toBeGreaterThanOrEqual(W);
  // The hover strip starts under the buttons, so hovering them never brings the peek out.
  expect(await top(page, '.ib-peek-strip')).toBe(H);
  const { reached, dragging } = await controlsThatDrag(page);
  expect(reached).toBeGreaterThan(2);
  expect(dragging).toEqual([]);
  await shot(page, 'sidebar-collapsed');

  // A real press on the toggle, where the buttons would have covered it without the hook.
  const toggle = page.locator('.ib-lhead .ib-sb-trigger');
  const box = (await toggle.boundingBox())!;
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('.ib-sb-trigger') !== null, [box.x + box.width / 2, box.y + box.height / 2]);
  expect(hit).toBe(true);
  await toggle.click();
  await page.locator('.ib-sb[data-state="expanded"]').waitFor({ state: 'attached' });
  await page.waitForTimeout(300);
  expect(await top(page, '.ib-brand')).toBeGreaterThanOrEqual(H);
});

test('the peek: its first row clears the height and its controls click over the header below', async () => {
  await openRoute(page, world, '', 'collapsed');
  await setControls(page);
  await page.mouse.move(5, 300);
  await page.locator('[data-sidebar-peek][data-visible]').waitFor();
  await page.waitForTimeout(400);
  expect(await top(page, '[data-sidebar-peek] .ib-brand')).toBeGreaterThanOrEqual(H);
  const { reached, dragging } = await controlsThatDrag(page);
  expect(reached).toBeGreaterThan(5);
  expect(dragging).toEqual([]);
  await shot(page, 'sidebar-peek');
  await page.mouse.move(900, 500);
});

test('a thread alone at the left edge: its header clears the width', async () => {
  await openRoute(page, world, `#thread=${world.picture}`, 'collapsed');
  await setControls(page);
  // The list is first: it holds the edge, and the thread beside it stays where it was.
  expect(await firstContentLeft(page, '.ib-lhead')).toBeGreaterThanOrEqual(W);
  const beside = await page.locator('.ib-phead').evaluate((head) => parseFloat(getComputedStyle(head).paddingLeft));
  expect(beside).toBe(14);
  expect(await headerBlankDrags(page, '.ib-phead')).toBe(true);
  expect((await controlsThatDrag(page)).dragging).toEqual([]);

  // A narrow window stacks the thread over the list: then the thread holds the edge.
  await page.setViewportSize({ width: 800, height: 700 });
  await page.waitForTimeout(400);
  await page.locator('.pn-inbox[data-stack~="thread"]').waitFor();
  expect(await firstContentLeft(page, '.ib-phead')).toBeGreaterThanOrEqual(W);
  expect((await controlsThatDrag(page)).dragging).toEqual([]);

  // A file covers its thread there, as a layer: it clears the height.
  await page.locator('.ib-att-t').first().click();
  await page.locator('.pn-inbox[data-stack~="file"] .ib-view.ib-full').waitFor();
  expect(await top(page, '.ib-view.ib-full .ib-vbody')).toBeGreaterThanOrEqual(H);
  expect((await controlsThatDrag(page)).dragging).toEqual([]);
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('a file beside its thread: the thread holds the edge, the file stays where it was', async () => {
  await openRoute(page, world, `#thread=${world.picture}`, 'collapsed');
  await page.locator('.ib-att-t').first().click();
  // A picture opens in full screen; the thread comes back beside it with Side by side.
  await page.locator('.ib-view.ib-full').getByRole('button', { name: 'Side by side' }).click();
  await page.locator('.ib-view:not(.ib-full) .ib-vbody').waitFor();
  await page.waitForTimeout(400);
  const fileTop = await top(page, '.ib-view .ib-vbody');
  await setControls(page);
  expect(await firstContentLeft(page, '.ib-pane.ib-withfile .ib-phead')).toBeGreaterThanOrEqual(W);
  expect(await top(page, '.ib-view .ib-vbody')).toBe(fileTop);
  expect((await controlsThatDrag(page)).dragging).toEqual([]);
});

test('the other pages: the header at the left edge clears the width, its controls click', async () => {
  const pages = [
    { hash: '#board', head: '.ib-bhead' },
    { hash: '#drafts', head: '.ib-dh' },
    { hash: '#reviews', head: '.ib-lhead' },
    { hash: '#shapes', head: '.ib-bhead' },
    { hash: '#whats-new=', head: '.ib-wn-bar' },
  ];
  for (const { hash, head } of pages) {
    await test.step(hash, async () => {
      await openRoute(page, world, hash, 'collapsed');
      await page.locator(head).first().waitFor();
      await setControls(page);
      expect(await firstContentLeft(page, head), hash).toBeGreaterThanOrEqual(W);
      expect((await controlsThatDrag(page)).dragging, hash).toEqual([]);
    });
  }
});

test('full-window layers clear the height, their controls click and their band drags', async () => {
  const layers: { name: string; open: () => Promise<void>; first: string }[] = [
    { name: 'full-screen-file', open: () => openFullScreenFile(page, world, world.picture), first: '.ib-view.ib-full .ib-vbody' },
    { name: 'settings', open: () => openRoute(page, world, '#settings', 'collapsed'), first: '.ib-sback' },
    { name: 'settings-sidebar-open', open: () => openRoute(page, world, '#settings', 'open'), first: '.ib-sback' },
    { name: 'pr-page', open: () => openRoute(page, world, '#reviews&stack=none&layer=none', 'collapsed'), first: '.ib-prreview .ib-vhead' },
    { name: 'guided-review', open: () => openRoute(page, world, `#thread=${world.thread}&guide=${world.guide}`), first: '.ib-viewer .ib-vhead' },
    { name: 'shape-board', open: () => openRoute(page, world, `#thread=${world.picture}&shape=${world.board}`, 'collapsed'), first: '.ib-shape-layer .shp-head' },
  ];
  for (const layer of layers) {
    await test.step(layer.name, async () => {
      await layer.open();
      await page.locator(layer.first).first().waitFor();
      await setControls(page);
      expect(await top(page, layer.first), layer.name).toBeGreaterThanOrEqual(H);
      expect(await bandDrags(page), layer.name).toBe(true);
      const { reached, dragging } = await controlsThatDrag(page);
      expect(reached, layer.name).toBeGreaterThan(0);
      expect(dragging, layer.name).toEqual([]);
      await shot(page, layer.name);
    });
  }
  // The header of a layer drags on its own blank space too.
  await openRoute(page, world, `#thread=${world.thread}&guide=${world.guide}`);
  await setControls(page);
  expect(await headerBlankDrags(page, '.ib-viewer .ib-vhead')).toBe(true);
});

test('the fixed row: the toggle, the title and the toolbar sit on the line the page names, sidebar open or closed', async () => {
  for (const sidebar of ['collapsed', 'open'] as const) {
    await openRoute(page, world, `#thread=${world.thread}`, sidebar);
    await setControls(page);
    expect(await centerY(page), sidebar).toBe('31px');
    const line = parseFloat(await centerY(page));
    expect((await boxOf(page, '.ib-lhead')).centre, sidebar).toBe(line);
    expect((await boxOf(page, '.ib-lhead .ib-sb-trigger')).centre, sidebar).toBe(line);
    expect((await boxOf(page, '.ib-lhead h1')).centre, sidebar).toBe(line);
    expect((await boxOf(page, '.ib-phead')).centre, sidebar).toBe(line);
    // The sidebar's first row starts where the buttons' room ends.
    if (sidebar === 'open') expect((await boxOf(page, '.ib-brand')).top).toBe(H);
  }
  // A page whose head is its own comes up to the same line.
  await openRoute(page, world, '#board', 'collapsed');
  await setControls(page);
  expect((await boxOf(page, '.ib-bhead')).centre).toBe(parseFloat(await centerY(page)));
});

test('the tour bar and Decision mode, with the variables set: clear of the buttons and every control clicks', async () => {
  await page.goto(`${world.url}#tour=2`);
  await page.locator('[data-tour-bar]').waitFor();
  await setControls(page);
  expect(await contentInset(page, '[data-tour-bar]')).toBeGreaterThanOrEqual(W);
  expect((await controlsThatDrag(page)).dragging).toEqual([]);
  await page.locator('[data-tour-exit="exit"]').click();
  await page.locator('[data-tour-bar]').waitFor({ state: 'detached' });

  await openRoute(page, world, `#thread=${world.questions}`, 'collapsed');
  await setControls(page);
  await page.locator('section.ib-pane [data-open-questions]').click();
  await page.locator('[data-thread-decide]').click();
  await page.locator('[data-decision-mode]').waitFor();
  expect((await boxOf(page, '[data-decision-mode]')).top).toBeGreaterThanOrEqual(H);
  expect((await controlsThatDrag(page)).dragging).toEqual([]);
  await page.keyboard.press('Escape');

  // At a phone's width it fills what the buttons leave, and its foot stays in the window.
  await phone.goto(`${world.url}#thread=${world.questions}`);
  await phone.locator('section.ib-pane [data-open-questions]').waitFor();
  await setControls(phone);
  await phone.locator('section.ib-pane [data-open-questions]').click();
  await phone.locator('[data-thread-decide]').click();
  await phone.locator('[data-decision-mode]').waitFor();
  const dialog = await boxOf(phone, '[data-decision-mode]');
  expect(dialog.top).toBe(H);
  expect(dialog.bottom).toBe(844);
  await phone.keyboard.press('Escape');
});

test('a phone-width window: the header holds the edge and the layer clears the height', async () => {
  await openRoute(phone, world, '');
  await setControls(phone);
  expect(await firstContentLeft(phone, '.ib-lhead')).toBeGreaterThanOrEqual(W);
  const { reached, dragging } = await controlsThatDrag(phone);
  expect(reached).toBeGreaterThan(1);
  expect(dragging).toEqual([]);
  await shot(phone, 'phone-list');

  await phone.locator('.ib-lhead .ib-sb-trigger').click();
  await phone.locator('.ib-sb-sheet').waitFor();
  await phone.waitForTimeout(400);
  expect(await top(phone, '.ib-sb-sheet .ib-brand')).toBeGreaterThanOrEqual(H);
  await phone.keyboard.press('Escape');

  await openRoute(phone, world, `#thread=${world.picture}`);
  await setControls(phone);
  expect(await firstContentLeft(phone, '.ib-phead')).toBeGreaterThanOrEqual(W);

  await openFullScreenFile(phone, world, world.picture);
  await setControls(phone);
  expect(await top(phone, '.ib-view.ib-full .ib-vbody')).toBeGreaterThanOrEqual(H);
});

test('a control added later clicks: a button over the band, and anything inside a header', async () => {
  await openRoute(page, world, '');
  await setControls(page);
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.textContent = 'later';
    button.style.cssText = 'position:fixed;top:4px;left:300px;width:60px;height:24px;z-index:99';
    document.querySelector('.pn-inbox')!.append(button);
  });
  expect((await controlsThatDrag(page)).dragging).toEqual([]);

  const insideHeader = await page.evaluate(() => {
    const head = document.querySelector('.ib-lhead')!;
    const span = document.createElement('span');
    span.textContent = 'later';
    head.append(span);
    return getComputedStyle(span).getPropertyValue('-webkit-app-region');
  });
  expect(insideHeader).toBe('no-drag');
});

test('a host that sets them inline is honoured the same, and taking them away restores the page', async () => {
  await openRoute(page, world, '');
  const before = await top(page, '.ib-brand');
  await page.evaluate(([w, h]) => {
    document.documentElement.style.setProperty('--pn-window-controls-width', `${w}px`);
    document.documentElement.style.setProperty('--pn-window-controls-height', `${h}px`);
  }, [W, H]);
  await page.waitForTimeout(100);
  expect(await top(page, '.ib-brand')).toBeGreaterThanOrEqual(H);
  expect(await bandDrags(page)).toBe(true);
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('--pn-window-controls-width');
    document.documentElement.style.removeProperty('--pn-window-controls-height');
  });
  await page.waitForTimeout(100);
  expect(await top(page, '.ib-brand')).toBe(before);
  await nothingDrags(page);
});
