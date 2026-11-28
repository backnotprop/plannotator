/** Real HtmlViewer, two loopback origins, no parent CSP except the explicit inheritance case. */
import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';

let server: ChildProcess;
let url: string;
test.beforeAll(async () => {
  server = spawn('bun', ['tests/e2e/html-viewer-resource-policy-harness.ts'], { stdio: ['ignore', 'pipe', 'pipe'] });
  url = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Harness startup timed out: ${output}`)), 60_000);
    server.stdout!.on('data', chunk => {
      output += chunk;
      const match = output.match(/HTML_POLICY_URL=(\S+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    server.stderr!.on('data', chunk => { output += chunk; });
    server.on('exit', code => { clearTimeout(timeout); reject(new Error(`Harness exited ${code}: ${output}`)); });
  });
});
test.afterAll(async () => {
  if (!server || server.exitCode !== null) return;
  await new Promise<void>(resolve => { server.once('exit', () => resolve()); server.kill('SIGTERM'); });
});

async function open(page: Page, run: string, extra = '') {
  await page.goto(`${url}?run=${run}${extra}`);
  const frame = page.frameLocator('iframe[title="HTML Plan Viewer"]');
  await expect(frame.locator('body')).toHaveAttribute('data-loaded', 'true');
  return frame;
}
async function counts(page: Page, run: string) {
  const all: Record<string, number> = await (await page.request.get(`${url}counts`)).json();
  return Object.fromEntries(Object.entries(all).filter(([path]) => path.startsWith(`/${run}/`)));
}

const kinds = ['script', 'stylesheet', 'import', 'css-image', 'image', 'font', 'frame', 'fetch', 'xhr', 'websocket', 'beacon'];
const phases = ['early', 'head', 'late'];

test('control endpoints work; the opted-in frame blocks early, head and late resources', async ({ page }) => {
  await open(page, 'control', '&control');
  await expect.poll(async () => {
    const requests = await counts(page, 'control');
    return phases.flatMap(phase => kinds.map(kind => `/${'control'}/${phase}/${kind}`)).filter(path => !requests[path]);
  }).toEqual([]);
  const frame = await open(page, 'restricted');
  await expect.poll(() => frame.locator('body').evaluate(() => {
    // The fixture records browser CSP events, not simulated request failures.
    return Array.from(new Set((window as Window & { violations?: { directive: string }[] }).violations?.map(v => v.directive)));
  })).toEqual(expect.arrayContaining(['script-src-elem', 'style-src-elem', 'img-src', 'font-src', 'frame-src', 'connect-src', 'worker-src']));
  expect(await counts(page, 'restricted')).toEqual({});
  expect(await frame.locator('html').getAttribute('data-author')).toBe('preserved');
  expect(await frame.locator('html').getAttribute('lang')).toBe('en');
  expect(await frame.locator('html').evaluate(() => document.compatMode)).toBe('CSS1Compat');
  // Every phase reports the attempted URLs, not only one representative resource.
  const blocked = await frame.locator('body').evaluate(() => (window as Window & { violations?: { uri: string }[] }).violations?.map(v => v.uri));
  for (const phase of phases) for (const kind of kinds.filter(kind => kind !== 'frame')) {
    expect(blocked?.some(uri => uri.endsWith(`/restricted/${phase}/${kind}`)), `${phase}/${kind}`).toBe(true);
  }
  expect(await frame.locator('body').evaluate(() => (window as Window & { violations?: { directive: string }[] }).violations?.filter(v => v.directive === 'frame-src').length)).toBeGreaterThanOrEqual(3);
  expect(blocked?.filter(uri => uri === 'blob').length).toBeGreaterThanOrEqual(3);
});

test('restricted inline interaction, live-config lock, text and pinpoint comments survive reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const frame = await open(page, 'usable');
  expect(await frame.locator('body').evaluate(() => Object.getOwnPropertyDescriptor(window, '__plannotatorLiveConfig')))
    .toEqual({ value: null, writable: false, configurable: false, enumerable: false });
  await frame.getByRole('button', { name: 'Add inline', exact: true }).click();
  await frame.getByRole('button', { name: 'Add with listener' }).click();
  await expect(frame.locator('#cart')).toHaveText('2');
  await expect(frame.locator('#eval')).toHaveText('42');
  expect(await frame.locator('#embedded').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(frame.locator('#pin')).toHaveCSS('border-top-width', '1px');

  const quote = frame.locator('#quote');
  const box = (await quote.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 16 });
  await page.mouse.up();
  await page.locator('[data-pn-annotation-toolbar-row]').getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByPlaceholder('Add a comment...', { exact: true }).fill('Keep this cart copy');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#annotations')).toContainText('Keep this cart copy');
  await page.getByRole('checkbox', { name: 'Annotate', exact: true }).check();
  await frame.locator('#pin').click();
  await page.getByPlaceholder('Add a comment...', { exact: true }).fill('Move checkout closer');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const annotations = JSON.parse((await page.locator('#annotations').textContent())!);
  expect(annotations).toHaveLength(2);
  expect(annotations[0]).toMatchObject({ originalText: 'A small cart with inline interaction.', text: 'Keep this cart copy' });
  expect(annotations[1]).toMatchObject({ text: 'Move checkout closer', htmlAnchor: { selector: '#pin', tagName: 'div' } });
  expect(annotations[1].htmlAnchor.point.x).toBeGreaterThanOrEqual(0);
  expect(annotations[1].htmlAnchor.point.y).toBeLessThanOrEqual(1);
  await page.reload();
  const restored = page.frameLocator('iframe[title="HTML Plan Viewer"]');
  await expect(restored.locator('[data-plannotator-marker]')).toHaveCount(2);
  expect(JSON.parse((await page.locator('#annotations').textContent())!)).toEqual(annotations);
  await expect(restored.locator('.pn-hl[data-annotation-id]').first()).toBeVisible();
  expect(await counts(page, 'usable')).toEqual({});
  expect(errors).toEqual([]);
});

test('a stricter inherited host CSP blocks the inline bridge', async ({ page }) => {
  const reports: string[] = [];
  page.on('console', message => reports.push(message.text()));
  await page.goto(`${url}?run=inherited&inherited`);
  const frame = page.frameLocator('iframe[title="HTML Plan Viewer"]');
  await expect(frame.locator('#pin')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Annotate', exact: true }).check();
  await frame.locator('#pin').click();
  await expect.poll(() => reports.some(message => message.includes('inline script') && message.includes('script-src'))).toBe(true);
  expect(await frame.locator('body').evaluate(() => Object.hasOwn(window, '__plannotatorLiveConfig'))).toBe(false);
  await expect(page.getByPlaceholder('Add a comment...')).toHaveCount(0);
  await expect(page.locator('#annotations')).toHaveText('[]');
});
