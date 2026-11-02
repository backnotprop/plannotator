/**
 * Relative Markdown links inside an attached Markdown file (#2230), proved in
 * a real browser against the compiled binary. An agent attaches
 * `docs/guide.md`; its links name a sibling (`peer.md#far-section`), a nested
 * file (`sub/deep.md`, whose own `../peer.md` leads back), a file outside the
 * folder and a hidden one. A click on the sibling opens it read-only in the
 * pane at its fragment, with its own image; a reload keeps it; its links
 * follow; the browser's Back steps back one document at a time to the
 * attached file; the thread stays open throughout. The outside and hidden
 * links open nothing and say why.
 *
 * Screenshots (light and dark) go to PLANNOTATOR_MD_LINKS_SHOTS when it is set.
 * Build the binary first (see inbox.spec.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { forgetFileViewChoice } from './file-view';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '.local/plannotator');
const shots = process.env.PLANNOTATOR_MD_LINKS_SHOTS ?? '';

/** A one-colour PNG, `size` px square, so the linked document's image has something to load. */
function png(size: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x60)]);
  const rows = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(shots, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const hashParams = (page: Page) => new URLSearchParams(new URL(page.url()).hash.slice(1));

test('a relative .md link in an attached Markdown file opens the linked document in the pane', async ({ browser }) => {
  const root = inboxScratch('plannotator-markdown-links-');
  const home = join(root, 'home');
  mkdirSync(home);
  const env = {
    PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_NOTES: '0',
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  let agent: SimAgent | undefined;
  try {
    const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(started.status, started.stderr).toBe(0);
    const url = started.stdout.trim();
    const project = scratchProject(join(root, 'src'), 'mdlinks');
    const docs = join(project, 'docs');
    mkdirSync(join(docs, 'sub'), { recursive: true });
    mkdirSync(join(docs, 'shots'));
    mkdirSync(join(docs, '.private'));
    writeFileSync(join(docs, 'guide.md'), [
      '# Guide',
      '[Peer notes](peer.md#far-section)',
      '[Outside notes](../outside.md)',
      '[Secret notes](.private/secret.md)',
    ].join('\n\n'));
    writeFileSync(join(docs, 'peer.md'), [
      '# Peer notes',
      '![Peer shot](shots/peer.png)',
      ...Array.from({ length: 60 }, (_, i) => `Filler paragraph ${i + 1}.`),
      '## Far section',
      '[Down to deep](sub/deep.md)',
    ].join('\n\n'));
    writeFileSync(join(docs, 'sub', 'deep.md'), ['# Deep doc', '[Up to peer](../peer.md)', ...Array.from({ length: 60 }, (_, i) => `Deep line ${i + 1}.`)].join('\n\n'));
    writeFileSync(join(docs, 'shots', 'peer.png'), png(64));
    writeFileSync(join(docs, '.private', 'secret.md'), '# Secret\n');
    writeFileSync(join(project, 'outside.md'), '# Outside\n');
    agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
    const sent = await agent.send({ project_path: project, subject: 'Read the guide', body: 'The guide links its notes.', attachments: ['docs/guide.md'] });
    const thread = sent.thread_id as string;
    const guide = (sent.attachments as { id: string }[])[0]!.id;

    const page = await context.newPage();
    await page.goto(`${url}#thread=${thread}&file=${guide}&view=side`);
    const pane = page.locator(`[data-attachment-pane="${guide}"]`);
    await expect(pane.locator('.ib-docscroll h1')).toHaveText('Guide');
    const note = pane.locator('[data-link-note="shown"]');

    // Outside the attached file's folder, and hidden: nothing opens, a note says why, the thread stays.
    await pane.getByRole('link', { name: 'Outside notes', exact: true }).click();
    await expect(note).toContainText('outside.md is outside this page');
    await pane.getByRole('link', { name: 'Secret notes', exact: true }).click();
    await expect(note).toContainText('secret.md is a hidden file');
    await expect(page.locator('[data-linked-page]')).toHaveCount(0);
    expect(hashParams(page).get('thread')).toBe(thread);

    // The sibling: read-only over the file, at its fragment, its image loaded from its own folder.
    await pane.getByRole('link', { name: 'Peer notes', exact: true }).click();
    const linked = page.locator('.ib-linkedframe');
    const peer = page.locator('[data-linked-page="peer.md"]');
    await expect(peer).toBeVisible();
    await expect(page.locator('[data-linked-note]')).toHaveText('peer.md is not attached, so comments are off.');
    await expect(linked.locator('h1')).toHaveText('Peer notes');
    expect(hashParams(page).get('thread')).toBe(thread);
    expect(hashParams(page).get('linked')).toBe('peer.md#far-section');
    const inView = async () => {
      const frame = (await linked.boundingBox())!;
      const heading = await linked.locator('#far-section').boundingBox();
      return !!heading && heading.y >= frame.y && heading.y < frame.y + frame.height;
    };
    await expect.poll(inView).toBe(true);
    await expect.poll(() => linked.locator('img[alt="Peer shot"]').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(64);
    await shot(page, '1-linked-sibling');

    // A reload keeps the thread, the file and the linked document.
    await page.reload();
    await expect(peer).toBeVisible();
    await expect(linked.locator('h1')).toHaveText('Peer notes');
    expect(hashParams(page).get('thread')).toBe(thread);

    // Its own links follow: a nested document, and from there `../peer.md` back up.
    await linked.getByRole('link', { name: 'Down to deep', exact: true }).click();
    await expect(page.locator('[data-linked-page="deep.md"]')).toBeVisible();
    expect(hashParams(page).get('linked')).toBe('sub/deep.md');
    // It opens at its own top, not at the scroll the previous document was left at.
    await expect(linked.locator('h1')).toHaveText('Deep doc');
    expect(await linked.locator('.ib-docscroll').evaluate((el) => el.scrollTop)).toBe(0);
    await linked.getByRole('link', { name: 'Up to peer', exact: true }).click();
    await expect(peer).toBeVisible();
    expect(hashParams(page).get('linked')).toBe('peer.md');

    // The browser's Back steps back one document at a time, to the attached file, in the same thread.
    await page.goBack();
    await expect(page.locator('[data-linked-page="deep.md"]')).toBeVisible();
    await page.goBack();
    await expect(peer).toBeVisible();
    await page.goBack();
    await expect(page.locator('[data-linked-page]')).toHaveCount(0);
    await expect(pane.locator('.ib-docscroll h1')).toBeVisible();
    expect(hashParams(page).get('thread')).toBe(thread);
    expect(hashParams(page).get('linked')).toBeNull();
    await shot(page, '2-back-on-attached');
    await forgetFileViewChoice(page);
  } finally {
    try {
      await agent?.close();
      await context.close();
    } finally {
      await removeInboxScratch(root);
    }
  }
});
