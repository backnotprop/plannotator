/**
 * Phones in the Inbox window's Settings (mobile plan step P1;
 * adr/implementation/inbox-mobile.md sections 1 and 2), proved in a real
 * browser against the compiled binary under a temp PLANNOTATOR_DATA_DIR and
 * HOME. Nothing is mocked: Chromium drives Settings, and the "phone" is this
 * script redeeming the code through the device door with real fetch, as the
 * iPhone app does.
 *
 * Proved: Pair a phone draws a QR code of the offer's own link and the
 * offer's six digits with its countdown; a phone that redeems the QR secret
 * appears in the list and the panel closes; Remove (asked twice) revokes it
 * and the phone's next request is 401 device_revoked; a code closed by five
 * wrong tries, and the tailnet switch's two error states, drawn through a
 * `tailscale` script on PATH. Reach from this Wi-Fi (P2, contract section
 * 3): the panel's "Turn on Reach from this Wi-Fi" opens the TLS listener and
 * the QR gains `lan` and `fp`; the row shows the address and the
 * certificate's SHA-256; a phone pins it and pairs over the LAN address; off
 * closes it. A second Inbox whose PATH has no dns-sd or avahi-publish draws
 * the no-Bonjour note, an `openssl` that fails draws the error, and a
 * listener that cannot open at start shows the switch on with the reason
 * and turns off in one click. Over the
 * Wi-Fi the phone pairs by the QR only: the LAN door refuses the six digits.
 *
 * With PLANNOTATOR_E2E_TAILNET=1 on a Mac signed in to Tailscale, one more
 * test turns on "Reach from my tailnet", reaches the door at the MagicDNS name
 * on 8443, and turns it off again (CI has no tailnet; that run is filed by
 * hand).
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs, light and dark at 1440 by 900, land in .local/proof/phones/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { qrModules } from '../../packages/inbox/qr';
import { pinnedRequest } from '../helpers/pinned-phone';

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

function port(): number {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8')).port;
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
  return fetch(`${init.base ?? `http://127.0.0.1:${port()}`}/api/inbox/device/${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-phones-e2e-')));
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: 'none' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = { root, dataDir, url: started.stdout.trim(), context, page, errors };
});

test.afterAll(async () => {
  if (!world) return;
  await world.context.close();
  try {
    process.kill(JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8')).pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  rmSync(world.root, { recursive: true, force: true });
});

test('Pair a phone: the QR is the offer\'s link, the digits are the offer\'s code, a countdown runs; the phone that redeems it joins the list', async () => {
  const { page } = world;
  await page.goto(`${world.url}#settings`);
  const block = page.locator('[data-settings-phones]');
  await expect(block.getByRole('heading', { name: 'Phones' })).toBeVisible();
  await expect(block.getByRole('switch', { name: 'Reach from my tailnet' })).toHaveAttribute('aria-checked', 'false');
  await expect(block.locator('[data-device]')).toHaveCount(0);
  await shot('settings-phones-empty');

  const made = page.waitForResponse((r) => r.url().endsWith('/api/inbox/pairing') && r.request().method() === 'POST');
  await block.getByRole('button', { name: 'Pair a phone' }).click();
  const response = await made;
  expect(response.status()).toBe(201);
  const offer = (await response.json()) as { offer: { code: string; expires_at: string }; link: string };
  const panel = block.locator('[data-pair-offer]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-pair-code]')).toHaveAttribute('data-pair-code', offer.offer.code);
  await expect(panel.locator('[data-pair-code]')).toHaveText(`${offer.offer.code.slice(0, 3)} ${offer.offer.code.slice(3)}`);
  expect(await panel.locator('[data-pair-qr] path').getAttribute('d')).toBe(qrModules(offer.link).d);
  await expect(panel.locator('[data-pair-left]')).toHaveText(/^Expires in (10:00|9:\d\d)$/);
  // With the tailnet and the Wi-Fi off, the panel offers the Wi-Fi switch in place (contract section 1).
  await expect(panel.locator('[data-pair-no-path]')).toContainText('Your phone needs a way to reach this computer.');
  await expect(panel.getByRole('button', { name: 'Turn on Reach from this Wi-Fi' })).toBeVisible();
  await shot('settings-phones-pair');

  // The phone scans the QR: the link's secret, redeemed at the door.
  const secret = new URL(offer.link.replace('plannotator://', 'https://x/')).searchParams.get('secret')!;
  const redeemed = await door('pair', { body: { secret, name: 'iPhone 15', platform: 'ios' } });
  expect(redeemed.status).toBe(201);
  const { token, device } = (await redeemed.json()) as { token: string; device: { id: string } };
  await expect(panel).toHaveCount(0, { timeout: 10_000 });
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
  expect(world.errors).toEqual([]);
});

test('a code closed by five wrong tries, and the tailnet switch\'s two error states (a mapping that is not the Inbox\'s on 8443; Tailscale stopped)', async () => {
  const { page } = world;
  await page.goto(`${world.url}#settings`);
  const block = page.locator('[data-settings-phones]');
  const made = page.waitForResponse((r) => r.url().endsWith('/api/inbox/pairing'));
  await block.getByRole('button', { name: 'Pair a phone' }).click();
  const offer = (await (await made).json()) as { offer: { code: string } };
  const wrong = offer.offer.code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) expect((await door('pair', { body: { code: wrong, name: 'x', platform: 'ios' } })).status).toBe(401);
  expect((await door('pair', { body: { code: offer.offer.code, name: 'x', platform: 'ios' } })).status).toBe(410);
  await shot('settings-phones-code-closed-by-wrong-tries');
  await block.getByRole('button', { name: 'Done' }).click();

  // A second Inbox whose `tailscale` is a script on PATH, so CI and this Mac show the same states without a tailnet.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-phones-tailscale-')));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'tailscale'),
    `#!/bin/sh\nif [ "$(cat '${join(root, 'mode')}')" = down ]; then echo 'Tailscale is stopped.' >&2; exit 1; fi\nif [ "$1" = serve ] && [ "$2" = status ]; then echo '{"TCP":{"8443":{"HTTPS":true}},"Web":{"x.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}'; exit 0; fi\nexit 1\n`,
  );
  chmodSync(join(bin, 'tailscale'), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: 'none' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const other = await world.context.newPage();
  try {
    world.page = other;
    await other.goto(`${started.stdout.trim()}#settings`);
    const phones = other.locator('[data-settings-phones]');
    const toggle = phones.getByRole('switch', { name: 'Reach from my tailnet' });
    for (const [mode, words, name] of [
      ['taken', 'Another tailscale serve mapping already uses port 8443', 'settings-phones-tailnet-port-taken'],
      ['down', 'Tailscale could not publish the Inbox', 'settings-phones-tailnet-unavailable'],
    ] as const) {
      writeFileSync(join(root, 'mode'), mode);
      await toggle.click();
      await expect(phones.locator('.ib-error')).toContainText(words);
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await shot(name);
    }
  } finally {
    world.page = page;
    await other.close();
    try {
      process.kill(JSON.parse(readFileSync(join(root, 'data', 'inbox', 'inbox.json'), 'utf8')).pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('Reach from this Wi-Fi: the panel turns it on, the row shows the address and the certificate SHA-256, a pinned phone pairs over the LAN, off closes it', async () => {
  const { page } = world;
  await page.goto(`${world.url}#settings`);
  const block = page.locator('[data-settings-phones]');
  const toggle = block.getByRole('switch', { name: 'Reach from this Wi-Fi' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(block.locator('[data-lan]')).toContainText('Phones on the same network, over an encrypted connection they check');

  // From the pairing panel: the note's button turns the Wi-Fi on and the code is made again with the address.
  const first = page.waitForResponse((r) => r.url().endsWith('/api/inbox/pairing'));
  await block.getByRole('button', { name: 'Pair a phone' }).click();
  await first;
  const remade = page.waitForResponse((r) => r.url().endsWith('/api/inbox/pairing'));
  await block.getByRole('button', { name: 'Turn on Reach from this Wi-Fi' }).click();
  const offer = (await (await remade).json()) as { offer: { code: string }; link: string; addresses: { lan: string; fingerprint: string } };
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const { lan, fingerprint } = offer.addresses;
  expect(lan).toMatch(/^\d{1,3}(\.\d{1,3}){3}:\d+$/);
  expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(offer.link).toContain(`lan=${encodeURIComponent(lan)}&fp=${fingerprint}&`);
  const panel = block.locator('[data-pair-offer]');
  expect(await panel.locator('[data-pair-qr] path').getAttribute('d')).toBe(qrModules(offer.link).d);
  await expect(panel.locator('[data-pair-no-path]')).toHaveCount(0);
  await expect(block.locator('[data-lan-address]')).toHaveText(lan);
  await expect(block.locator('[data-lan-fingerprint]')).toHaveAttribute('data-lan-fingerprint', fingerprint);
  await expect(block.locator('[data-lan-fingerprint] span')).toHaveText(fingerprint.match(/.{4}/g)!.join(' '));
  const bonjour = process.platform === 'darwin' || onPath('avahi-publish') !== null;
  await expect(block.locator('[data-lan-no-bonjour]')).toHaveCount(bonjour ? 0 : 1);
  await shot('settings-phones-lan-pair');

  // The phone scans the QR: it pins fp and redeems the secret at the LAN address.
  const secret = new URL(offer.link.replace('plannotator://', 'https://x/')).searchParams.get('secret')!;
  const paired = await pinnedRequest(lan, fingerprint, { method: 'POST', path: '/api/inbox/device/pair', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret, name: 'iPhone over Wi-Fi', platform: 'ios' }) });
  expect(paired.status).toBe(201);
  await expect(panel).toHaveCount(0, { timeout: 10_000 });
  await expect(block.locator('[data-paired]')).toHaveText(/Paired with iPhone over Wi-Fi\./);
  await shot('settings-phones-lan-paired');
  // A phone holding another fingerprint refuses the connection itself.
  await expect(pinnedRequest(lan, '0'.repeat(64), { path: '/api/inbox/device/health' })).rejects.toThrow(/does not match the pinned fingerprint/);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(block.locator('[data-lan-fingerprint]')).toHaveCount(0);
  expect(await pinnedRequest(lan, fingerprint, { path: '/api/inbox/device/health' }).then(() => 'answered', () => 'closed')).toBe('closed');
  await shot('settings-phones-lan-off');
  expect(world.errors).toEqual([]);
});

test('Reach from this Wi-Fi where nothing can announce it (no Bonjour) and where openssl fails', async () => {
  const { page } = world;
  // A second Inbox whose PATH holds only `openssl`: no dns-sd, no avahi-publish. The script fails while the mode file says so.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-phones-lan-')));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const real = onPath('openssl');
  expect(real, 'openssl on PATH').not.toBeNull();
  writeFileSync(join(root, 'mode'), 'ok');
  writeFileSync(join(bin, 'openssl'), `#!/bin/sh\nread mode < '${join(root, 'mode')}'\nif [ "$mode" = broken ]; then echo 'openssl: broken' >&2; exit 1; fi\nexec '${real!}' "$@"\n`);
  chmodSync(join(bin, 'openssl'), 0o755);
  const env = { PATH: bin, HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: 'none' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const other = await world.context.newPage();
  try {
    world.page = other;
    await other.goto(`${started.stdout.trim()}#settings`);
    const phones = other.locator('[data-settings-phones]');
    const toggle = phones.getByRole('switch', { name: 'Reach from this Wi-Fi' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(phones.locator('[data-lan-no-bonjour]')).toContainText('Scanning the code still pairs them.');
    await shot('settings-phones-lan-no-bonjour');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    // openssl fails and there is no certificate yet: the switch stays off and the window says why.
    rmSync(join(root, 'data', 'inbox', 'tls'), { recursive: true, force: true });
    writeFileSync(join(root, 'mode'), 'broken');
    await toggle.click();
    await expect(phones.locator('.ib-error')).toContainText('The Inbox could not make its certificate');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await shot('settings-phones-lan-unavailable');

    // On, then a stop; the certificate goes and openssl fails: the next start cannot open the listener.
    // The switch shows what the Inbox keeps (on), the reason under it, and one click turns it off.
    writeFileSync(join(root, 'mode'), 'ok');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    const kept = () => JSON.parse(readFileSync(join(root, 'data', 'inbox', 'inbox.json'), 'utf8'));
    const port = kept().lan.port;
    const pid = kept().pid;
    process.kill(pid, 'SIGTERM');
    await expect.poll(() => { try { process.kill(pid, 0); return 'running'; } catch { return 'gone'; } }).toBe('gone');
    rmSync(join(root, 'data', 'inbox', 'tls'), { recursive: true, force: true });
    writeFileSync(join(root, 'mode'), 'broken');
    const again = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(again.status, again.stderr).toBe(0);
    // Same port as before: leave the page first, or a same-URL goto keeps the old state.
    await other.goto('about:blank');
    await other.goto(`${again.stdout.trim()}#settings`);
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(phones.locator('[data-lan-address]')).toHaveText('Not reachable');
    await expect(phones.locator('.ib-error')).toContainText('The Inbox could not make its certificate');
    await shot('settings-phones-lan-start-failed');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(phones.locator('.ib-error')).toHaveCount(0);
    expect(kept().lan).toEqual({ port, on: false });
  } finally {
    world.page = page;
    await other.close();
    try {
      process.kill(JSON.parse(readFileSync(join(root, 'data', 'inbox', 'inbox.json'), 'utf8')).pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('Reach from my tailnet: the door answers at the MagicDNS name on 8443, nothing else does (run by hand on a tailnet)', async () => {
  test.skip(process.env.PLANNOTATOR_E2E_TAILNET !== '1', 'needs a Mac signed in to Tailscale (PLANNOTATOR_E2E_TAILNET=1)');
  const { page } = world;
  await page.goto(`${world.url}#settings`);
  const block = page.locator('[data-settings-phones]');
  const toggle = block.getByRole('switch', { name: 'Reach from my tailnet' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });
  const address = (await block.locator('[data-tailnet-address]').getAttribute('data-tailnet-address'))!;
  expect(address).toMatch(/\.ts\.net:8443$/);
  try {
    const made = page.waitForResponse((r) => r.url().endsWith('/api/inbox/pairing'));
    await block.getByRole('button', { name: 'Pair a phone' }).click();
    const offer = (await (await made).json()) as { offer: { code: string }; link: string };
    expect(offer.link).toContain(`tailnet=${encodeURIComponent(address)}`);
    await shot('settings-phones-pair-tailnet');
    const base = `https://${address}`;
    const redeemed = await door('pair', { base, body: { code: offer.offer.code, name: 'Tailnet proof', platform: 'ios' } });
    expect(redeemed.status).toBe(201);
    const { token } = (await redeemed.json()) as { token: string };
    expect((await door('health', { base, token })).status).toBe(200);
    // Only the door is served there (tailscale serve points at the door-only listener), whatever Host the peer sends.
    expect((await fetch(`${base}/api/inbox/threads`)).status).toBe(404);
    expect((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(`${base}/`)).status).toBe(404);
    await expect(block.locator('[data-device]')).toHaveCount(1, { timeout: 10_000 });
    await shot('settings-phones-tailnet-paired');
  } finally {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 20_000 });
  }
});
