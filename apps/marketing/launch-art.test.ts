/**
 * The launch dialog's art (public/launch/<campaign>.webp, served as https://plannotator.ai/launch/<campaign>.webp):
 * the apps load the picture for the campaign that public/launch.json names. What regresses: the switch naming a
 * campaign whose picture is missing, is not a WebP, is not 16:9 at the size the dialog's band is drawn for (1760×990,
 * the 880-wide band at 2x), or is too heavy for a dialog that shows as the page opens. A missing picture still shows the words alone, but not the
 * dialog the owner approved.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAUNCH_CAMPAIGNS } from '../../packages/shared/launch-switch';

const doc = JSON.parse(readFileSync(join(import.meta.dir, 'public', 'launch.json'), 'utf8')) as { campaign: string };

/** A WebP's canvas size from its first chunk (VP8, VP8L or VP8X), or null when the bytes are not a WebP. */
function webpSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  return null;
}

describe('public/launch/<campaign>.webp', () => {
  // launch.json's campaign, and every campaign the release knows (launch-switch.ts `LAUNCH_CAMPAIGNS`).
  for (const campaign of new Set([doc.campaign, ...LAUNCH_CAMPAIGNS])) {
    test(`the picture for ${campaign}: a 16:9 WebP, 1760×990, under 300 KB`, () => {
      const file = join(import.meta.dir, 'public', 'launch', `${campaign}.webp`);
      expect(existsSync(file), `no art for campaign ${campaign}`).toBe(true);
      const bytes = readFileSync(file);
      expect(webpSize(bytes)).toEqual({ width: 1760, height: 990 });
      expect(bytes.byteLength).toBeLessThan(300 * 1024);
    });
  }
});
