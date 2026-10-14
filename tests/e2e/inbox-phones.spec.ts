/**
 * Phones in the Inbox window's Settings → Devices (mobile plan steps P1 and
 * P2; adr/implementation/inbox-mobile.md sections 1 to 3; Pair a phone as a
 * guided flow, design of record `.product/approved/inbox-settings-tabs/`),
 * proved in a real browser against the compiled binary under a temp
 * PLANNOTATOR_DATA_DIR and HOME. Chromium drives Settings, and the "phone" is
 * this script redeeming the code through the device door with real fetch, as
 * the iPhone app does. `tailscale` is a script on PATH (its serve mappings in
 * a scratch file, its status as the test sets it), so no test runs the real
 * one; Reach from this Wi-Fi uses the real `openssl` under the temp data dir.
 *
 * Proved: Pair a phone always starts at step 1 ("How will your phone reach
 * this computer?"); no code is made while no way is on; turning Tailscale on
 * there and continuing draws the QR of the offer's own link, the six digits
 * and the countdown; wrong digits over the tailnet show on the code's screen;
 * the phone that redeems it moves the flow to Paired and, after Done, into
 * the list; Remove (asked twice) revokes it. The owner's no-loop rule on the
 * binary: Tailscale's check says signed out while its switch is on, and the
 * code still shows. A code closed by five wrong tries, and the Tailscale
 * switch's two error states. This Wi-Fi turned on in step 1: the QR gains
 * `lan` and `fp`, a pinned phone pairs over the LAN address, the row shows
 * the address and the certificate's SHA-256, off closes it. A second Inbox
 * with no dns-sd or avahi-publish draws the no-Bonjour note, an `openssl`
 * that fails draws the error, and a listener that cannot open at start shows
 * the switch on with the reason and turns off in one click.
 *
 * With PLANNOTATOR_E2E_TAILNET=1 on a Mac signed in to Tailscale, one more
 * test turns on the real Tailscale way, reaches the door at the MagicDNS name
 * on 8443, and turns it off again (CI has no tailnet; that run is filed by
 * hand).
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs, light and dark at 1440 by 900, land in .local/proof/phones/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { qrModules } from '../../packages/inbox/qr';
import { pinnedRequest } from '../helpers/pinned-phone';
import { E2E_MAGIC as MAGIC, fakeTailscale } from './fake-tailscale';
import { inboxScratch, removeInboxScratch, stopScratchInbox } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'phones');

interface World {
  root: string;
  dataDir: string;
  url: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
}

let world: World;

function registry() {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

async function shot(name: string): Promise<void> {
  const page = world.page;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.locator('[data-settings-phones]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** The first `name` on PATH, or null. */
function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

/** The phone: a request through the device door, as the app sends it (no Origin). */
function door(path: string, init: { token?: string; method?: string; body?: unknown; base?: string } = {}): Promise<Response> {
  return fetch(`${init.base ?? `http://127.0.0.1:${registry().port}`}/api/inbox/device/${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** The tailnet's door listener, where the scripted serve points (a phone over Tailscale lands there). */
const tailnetDoor = () => `http://127.0.0.1:${registry().tailnet.door_port}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-phones-e2e-');
  const dataDir = join(root, 'data');
  const ts = fakeTailscale(join(root, 'ts'));
  const env = { PATH: `${ts}:${process.env.PATH ?? ''}`, HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_INBOX_PHONES: '1' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = { root, dataDir, url: started.stdout.trim(), context, page, errors };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.context.close();
  } finally {
    // Every Inbox this spec started, then its folders (inbox-scratch.ts).
    await removeInboxScratch();
  }
});

/** Step 1's primary button: "Show the code" while no way is on, "Continue to the code" once one is. */
const showCode = (page: Page) => page.locator('[data-show-code]');

test("Pair a phone: step 1 first; no code until a way is on; the QR is the offer's link; wrong digits show; the phone that redeems it is Paired and joins the list", async () => {
  const { page } = world;
  await page.goto(`${world.url}#settings/devices`);
  const block = page.locator('[data-settings-phones]');
  await expect(block.getByRole('heading', { name: 'Phones' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Tailscale', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(block.locator('[data-device]')).toHaveCount(0);
  await shot('settings-phones-empty');

  await block.getByRole('button', { name: 'Pair a phone' }).click();
  await expect(page).toHaveURL(/#settings\/devices\/pair$/);
  const flow = block.locator('[data-pair-flow]');
  await expect(flow.getByRole('heading', { name: 'How will your phone reach this computer?' })).toBeFocused();
  // The scripted status names this login; step 1 reads it (with --peers=false: no other device is read).
  await expect(flow.locator('[data-pair-way="tailscale"] [data-check="ok"]').first()).toContainText('e2e@example.com');
  await expect(flow).toContainText('is not available yet');
  await shot('settings-phones-pair-1-choose');

  // The gate: no way on, no code.
  await expect(showCode(page)).toHaveText('Show the code');
  await expect(showCode(page)).toHaveAttribute('aria-disabled', 'true');
  let made = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/api/inbox/pairing') && r.method() === 'POST') made += 1;
  });
  // aria-disabled, so Playwright would wait for it to enable: the press is forced, as a person's click lands on it.
  await showCode(page).click({ force: true });
  await expect(flow.locator('[data-pair-hint]')).toHaveAttribute('data-pair-hint', 'need-way');
  expect(made).toBe(0);

  await flow.getByRole('button', { name: 'Turn on Tailscale' }).click();
  await expect(flow.locator('[data-pair-way="tailscale"] [data-way-state="on"]')).toBeVisible();
  await expect(flow.locator('[data-pair-way="tailscale"]')).toContainText(`${MAGIC}:8443`);
  await expect(showCode(page)).toHaveText('Continue to the code');
  await shot('settings-phones-pair-1-tailscale-on');

  const offered = page.waitForResponse((r) => r.url().endsWith('/api/inbox/pairing') && r.request().method() === 'POST');
  await showCode(page).click();
  const response = await offered;
  expect(response.status()).toBe(201);
  const offer = (await response.json()) as { offer: { code: string; expires_at: string }; link: string; reachable: boolean };
  expect(offer.reachable).toBe(true);
  expect(offer.link).toContain(`tailnet=${encodeURIComponent(`${MAGIC}:8443`)}`);
  const panel = flow.locator('[data-pair-offer]');
  await expect(panel.locator('[data-pair-code]')).toHaveAttribute('data-pair-code', offer.offer.code);
  await expect(panel.locator('[data-pair-code]')).toHaveText(`${offer.offer.code.slice(0, 3)} ${offer.offer.code.slice(3)}`);
  expect(await panel.locator('[data-pair-qr] path').getAttribute('d')).toBe(qrModules(offer.link).d);
  await expect(panel.locator('[data-pair-left]')).toHaveText(/expires in (10:00|9:\d\d)$/);
  await expect(panel.locator('[data-pair-address="tailscale"]')).toContainText(`${MAGIC}:8443`);
  await shot('settings-phones-pair-2-code');

  // A phone over the tailnet types the wrong digits: the code's screen says so.
  const wrong = offer.offer.code === '000000' ? '000001' : '000000';
  expect((await door('pair', { base: tailnetDoor(), body: { code: wrong, name: 'x', platform: 'ios' } })).status).toBe(401);
  const note = panel.locator('[data-pair-note="wrong_code"]');
  await expect(note).toHaveAttribute('data-via', 'tailnet');
  await expect(note).toHaveAttribute('data-tries-left', '4');
  await shot('settings-phones-pair-2-wrong-digits');

  // The phone scans the QR: the link's secret, redeemed at the tailnet's door.
  const secret = new URL(offer.link.replace('plannotator://', 'https://x/')).searchParams.get('secret')!;
  const redeemed = await door('pair', { base: tailnetDoor(), body: { secret, name: 'iPhone 15', platform: 'ios' } });
  expect(redeemed.status).toBe(201);
  const { token, device } = (await redeemed.json()) as { token: string; device: { id: string } };
  await expect(flow.locator('[data-pair-done]')).toContainText('Paired with iPhone 15', { timeout: 10_000 });
  await expect(flow.locator('[data-pair-done]')).toContainText('over Tailscale');
  await shot('settings-phones-pair-3-paired');
  await flow.getByRole('button', { name: 'Done' }).click();
  await expect(page).toHaveURL(/#settings\/devices$/);
  await expect(block.getByRole('button', { name: 'Pair a phone' })).toBeFocused();
  await expect(block.locator('[data-paired]')).toHaveText(/Paired with iPhone 15\./);
  const row = block.locator(`[data-device="${device.id}"]`);
  await expect(row).toContainText('iPhone 15');
  await expect(row).toContainText(/iPhone · last seen \d{1,2}:\d{2} [AP]M/);
  expect((await door('health', { token })).status).toBe(200);
  await shot('settings-phones-paired');

  // Remove asks twice, then the phone's token stops working.
  await row.getByRole('button', { name: 'Remove iPhone 15' }).click();
  await expect(row.getByRole('button', { name: 'Remove iPhone 15: click again to remove' })).toHaveText('Remove? Click again');
  await shot('settings-phones-remove-confirm');
  await row.getByRole('button', { name: 'Remove iPhone 15: click again to remove' }).click();
  await expect(row).toHaveCount(0);
  const after = await door('threads', { token });
  expect(after.status).toBe(401);
  expect(((await after.json()) as { code: string }).code).toBe('device_revoked');

  // Leave the way off for the next test, from the Devices row.
  const tailscale = page.getByRole('switch', { name: 'Tailscale', exact: true });
  await tailscale.click();
  await expect(tailscale).toHaveAttribute('aria-checked', 'false');
  expect(world.errors).toEqual([]);
});

test("the owner's no-loop rule: Tailscale's check says signed out, its switch is on, and Continue still shows the code", async () => {
  const { page } = world;
  writeFileSync(join(world.root, 'ts', 'mode'), 'signedout');
  try {
    await page.goto('about:blank');
    await page.goto(`${world.url}#settings/devices/pair`);
    const flow = page.locator('[data-pair-flow]');
    const way = flow.locator('[data-pair-way="tailscale"]');
    await expect(way.locator('[data-check="fail"]')).toHaveCount(1);
    // Turn on stays offered beside Check again: a failing check never takes the way away.
    await expect(way.locator('[data-check-again]')).toBeVisible();
    await way.getByRole('button', { name: 'Turn on Tailscale' }).click();
    await expect(way).toHaveAttribute('data-way-on', 'true');
    await expect(way.locator('[data-check="fail"]')).toHaveCount(1);
    await expect(showCode(page)).toHaveText('Continue to the code');
    await expect(showCode(page)).toHaveAttribute('aria-disabled', 'false');
    await shot('settings-phones-no-loop-checks-fail');
    await showCode(page).click();
    await expect(flow.locator('[data-pair-code]')).toBeVisible();
    await expect(flow.locator('[data-pair-qr]')).toBeVisible();
    await flow.getByRole('button', { name: 'Cancel' }).click();
    const tailscale = page.getByRole('switch', { name: 'Tailscale', exact: true });
    await tailscale.click();
    await expect(tailscale).toHaveAttribute('aria-checked', 'false');
  } finally {
    writeFileSync(join(world.root, 'ts', 'mode'), '');
  }
  expect(world.errors).toEqual([]);
});

test("a code closed by five wrong tries, and the Tailscale switch's two error states (a mapping that is not the Inbox's on 8443; Tailscale stopped)", async () => {
  const { page } = world;
  await page.goto('about:blank');
  await page.goto(`${world.url}#settings/devices/pair`);
  const flow = page.locator('[data-pair-flow]');
  await flow.getByRole('button', { name: 'Turn on Tailscale' }).click();
  await expect(showCode(page)).toHaveText('Continue to the code');
  const made = page.waitForResponse((r) => r.url().endsWith('/api/inbox/pairing') && r.request().method() === 'POST');
  await showCode(page).click();
  const offer = (await (await made).json()) as { offer: { code: string } };
  const wrong = offer.offer.code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) expect((await door('pair', { base: tailnetDoor(), body: { code: wrong, name: 'x', platform: 'ios' } })).status).toBe(401);
  expect((await door('pair', { base: tailnetDoor(), body: { code: offer.offer.code, name: 'x', platform: 'ios' } })).status).toBe(410);
  await expect(flow.locator('[data-pair-offer]')).toHaveAttribute('data-expired', 'true', { timeout: 10_000 });
  await expect(flow.locator('[data-pair-closed]')).toHaveAttribute('data-pair-closed', 'tries');
  await shot('settings-phones-code-closed-by-wrong-tries');
  await flow.getByRole('button', { name: 'Cancel' }).click();
  const mine = page.getByRole('switch', { name: 'Tailscale', exact: true });
  await mine.click();
  await expect(mine).toHaveAttribute('aria-checked', 'false');

  // A second Inbox whose `tailscale` is a script on PATH, so CI and this Mac show the same states without a tailnet.
  const root = inboxScratch('plannotator-inbox-phones-tailscale-');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'tailscale'),
    `#!/bin/sh\nif [ "$(cat '${join(root, 'mode')}')" = down ]; then echo 'Tailscale is stopped.' >&2; exit 1; fi\nif [ "$1" = serve ] && [ "$2" = status ]; then echo '{"TCP":{"8443":{"HTTPS":true}},"Web":{"x.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}'; exit 0; fi\nexit 1\n`,
  );
  chmodSync(join(bin, 'tailscale'), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_INBOX_PHONES: '1' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const other = await world.context.newPage();
  try {
    world.page = other;
    await other.goto(`${started.stdout.trim()}#settings/devices`);
    const phones = other.locator('[data-settings-phones]');
    const toggle = other.getByRole('switch', { name: 'Tailscale', exact: true });
    for (const [mode, words, name] of [
      ['taken', 'Another tailscale serve mapping already uses port 8443', 'settings-phones-tailnet-port-taken'],
      ['down', 'Tailscale could not publish the Inbox', 'settings-phones-tailnet-unavailable'],
    ] as const) {
      writeFileSync(join(root, 'mode'), mode);
      await toggle.click();
      await expect(phones.getByRole('alert')).toContainText(words);
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await shot(name);
    }
  } finally {
    world.page = page;
    await other.close().catch(() => {});
    // This test's Inbox, then its folder (inbox-scratch.ts).
    await removeInboxScratch(root);
  }
});

test('This Wi-Fi: turned on in step 1, the code carries the address and the certificate SHA-256, a pinned phone pairs over the LAN, the row shows them, off closes it', async () => {
  const { page } = world;
  await page.goto('about:blank');
  await page.goto(`${world.url}#settings/devices`);
  const block = page.locator('[data-settings-phones]');
  const toggle = page.getByRole('switch', { name: 'This Wi-Fi' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('[data-lan]')).toContainText('phones on the same Wi-Fi, over an encrypted connection they check');

  await block.getByRole('button', { name: 'Pair a phone' }).click();
  const flow = block.locator('[data-pair-flow]');
  await flow.getByRole('button', { name: 'Turn on This Wi-Fi' }).click();
  await expect(flow.locator('[data-pair-way="wifi"] [data-way-state="on"]')).toBeVisible({ timeout: 20_000 });
  const offered = page.waitForResponse((r) => r.url().endsWith('/api/inbox/pairing') && r.request().method() === 'POST');
  await showCode(page).click();
  const offer = (await (await offered).json()) as { offer: { code: string }; link: string; addresses: { lan: string; fingerprint: string; tailnet: string | null } };
  const { lan, fingerprint } = offer.addresses;
  expect(lan).toMatch(/^\d{1,3}(\.\d{1,3}){3}:\d+$/);
  expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(offer.addresses.tailnet).toBeNull();
  expect(offer.link).toContain(`lan=${encodeURIComponent(lan)}&fp=${fingerprint}&`);
  const panel = flow.locator('[data-pair-offer]');
  expect(await panel.locator('[data-pair-qr] path').getAttribute('d')).toBe(qrModules(offer.link).d);
  // Over Wi-Fi the phone pairs by scanning only: no digits on screen.
  await expect(panel.locator('[data-pair-code]')).toHaveCount(0);
  await expect(panel.locator('[data-pair-scan-only]')).toBeVisible();
  await expect(panel.locator('[data-pair-address="wifi"]')).toContainText(lan);
  await shot('settings-phones-lan-pair');

  // The phone types the digits over the Wi-Fi: refused there, and the code's screen says so.
  const typed = await pinnedRequest(lan, fingerprint, { method: 'POST', path: '/api/inbox/device/pair', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: offer.offer.code, name: 'x', platform: 'ios' }) });
  expect(typed.status).toBe(400);
  await expect(panel.locator('[data-pair-note="code_over_wifi"]')).toHaveAttribute('data-via', 'wifi');

  // The phone scans the QR: it pins fp and redeems the secret at the LAN address.
  const secret = new URL(offer.link.replace('plannotator://', 'https://x/')).searchParams.get('secret')!;
  const paired = await pinnedRequest(lan, fingerprint, { method: 'POST', path: '/api/inbox/device/pair', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret, name: 'iPhone over Wi-Fi', platform: 'ios' }) });
  expect(paired.status).toBe(201);
  await expect(flow.locator('[data-pair-done]')).toContainText('Paired with iPhone over Wi-Fi', { timeout: 10_000 });
  await expect(flow.locator('[data-pair-done]')).toContainText('It answers only on this Wi-Fi');
  await shot('settings-phones-lan-paired');
  await flow.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('[data-lan-address]')).toHaveAttribute('data-lan-address', lan);
  await expect(page.locator('[data-lan-fingerprint]')).toHaveAttribute('data-lan-fingerprint', fingerprint);
  await expect(page.locator('[data-lan-fingerprint] .ib-sfp')).toHaveAttribute('title', fingerprint.match(/.{4}/g)!.join(' '));
  const bonjour = process.platform === 'darwin' || onPath('avahi-publish') !== null;
  await expect(page.locator('[data-lan-no-bonjour]')).toHaveCount(bonjour ? 0 : 1);
  // A phone holding another fingerprint refuses the connection itself.
  await expect(pinnedRequest(lan, '0'.repeat(64), { path: '/api/inbox/device/health' })).rejects.toThrow(/does not match the pinned fingerprint/);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('[data-lan-fingerprint]')).toHaveCount(0);
  expect(await pinnedRequest(lan, fingerprint, { path: '/api/inbox/device/health' }).then(() => 'answered', () => 'closed')).toBe('closed');
  await shot('settings-phones-lan-off');
  expect(world.errors).toEqual([]);
});

test('This Wi-Fi where nothing can announce it (no Bonjour) and where openssl fails', async () => {
  const { page } = world;
  // A second Inbox whose PATH holds only `openssl`: no dns-sd, no avahi-publish, no tailscale. The script fails while the mode file says so.
  const root = inboxScratch('plannotator-inbox-phones-lan-');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const real = onPath('openssl');
  expect(real, 'openssl on PATH').not.toBeNull();
  writeFileSync(join(root, 'mode'), 'ok');
  writeFileSync(join(bin, 'openssl'), `#!/bin/sh\nread mode < '${join(root, 'mode')}'\nif [ "$mode" = broken ]; then echo 'openssl: broken' >&2; exit 1; fi\nexec '${real!}' "$@"\n`);
  chmodSync(join(bin, 'openssl'), 0o755);
  const env = { PATH: bin, HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_INBOX_PHONES: '1' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const other = await world.context.newPage();
  try {
    world.page = other;
    await other.goto(`${started.stdout.trim()}#settings/devices`);
    const phones = other.locator('[data-settings-phones]');
    const toggle = other.getByRole('switch', { name: 'This Wi-Fi' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(other.locator('[data-lan-no-bonjour]')).toContainText('Scanning the code still pairs them.');
    await shot('settings-phones-lan-no-bonjour');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    // openssl fails and there is no certificate yet: the switch stays off and the window says why.
    rmSync(join(root, 'data', 'inbox', 'tls'), { recursive: true, force: true });
    writeFileSync(join(root, 'mode'), 'broken');
    await toggle.click();
    await expect(phones.getByRole('alert')).toContainText('The Inbox could not make its certificate');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await shot('settings-phones-lan-unavailable');

    // On, then a stop; the certificate goes and openssl fails: the next start cannot open the listener.
    // The switch shows what the Inbox keeps (on), the reason under it, and one click turns it off.
    writeFileSync(join(root, 'mode'), 'ok');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    const kept = () => JSON.parse(readFileSync(join(root, 'data', 'inbox', 'inbox.json'), 'utf8'));
    const port = kept().lan.port;
    await stopScratchInbox(join(root, 'data'));
    rmSync(join(root, 'data', 'inbox', 'tls'), { recursive: true, force: true });
    writeFileSync(join(root, 'mode'), 'broken');
    const again = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(again.status, again.stderr).toBe(0);
    // Same port as before: leave the page first, or a same-URL goto keeps the old state.
    await other.goto('about:blank');
    await other.goto(`${again.stdout.trim()}#settings/devices`);
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(other.locator('[data-lan]')).toContainText('Not working');
    await expect(other.locator('[data-lan-address]')).toHaveAttribute('data-lan-address', '');
    await expect(other.locator('[data-lan-address]')).toContainText('The Inbox could not make its certificate');
    await shot('settings-phones-lan-start-failed');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(other.locator('[data-lan]')).not.toContainText('Not working');
    expect(kept().lan).toEqual({ port, on: false });
  } finally {
    world.page = page;
    await other.close().catch(() => {});
    // This test's Inbox, then its folder (inbox-scratch.ts).
    await removeInboxScratch(root);
  }
});

test('Tailscale for phones: the door answers at the MagicDNS name on 8443, nothing else does (run by hand on a tailnet)', async () => {
  test.skip(process.env.PLANNOTATOR_E2E_TAILNET !== '1', 'needs a Mac signed in to Tailscale (PLANNOTATOR_E2E_TAILNET=1)');
  // A real tailnet: an Inbox whose PATH is the person's own (the scripted tailscale is not on it).
  const root = inboxScratch('plannotator-inbox-phones-real-tailnet-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_INBOX_PHONES: '1' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const page = await world.context.newPage();
  const base = started.stdout.trim();
  await page.goto(`${base}#settings/devices`);
  const toggle = page.getByRole('switch', { name: 'Tailscale', exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });
  const address = (await page.locator('[data-tailnet-address]').getAttribute('data-tailnet-address'))!;
  expect(address).toMatch(/\.ts\.net:8443$/);
  try {
    const made = (await (await fetch(`${base}api/inbox/pairing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()) as { offer: { code: string }; link: string };
    expect(made.link).toContain(`tailnet=${encodeURIComponent(address)}`);
    const tailnet = `https://${address}`;
    const redeemed = await door('pair', { base: tailnet, body: { code: made.offer.code, name: 'Tailnet proof', platform: 'ios' } });
    expect(redeemed.status).toBe(201);
    const { token } = (await redeemed.json()) as { token: string };
    expect((await door('health', { base: tailnet, token })).status).toBe(200);
    // Only the door is served there (tailscale serve points at the door-only listener), whatever Host the peer sends.
    expect((await fetch(`${tailnet}/api/inbox/threads`)).status).toBe(404);
    expect((await fetch(`${tailnet}/mcp`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(`${tailnet}/`)).status).toBe(404);
  } finally {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 20_000 });
    await page.close();
    await removeInboxScratch(root);
  }
});
