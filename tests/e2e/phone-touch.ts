/**
 * A phone's finger for the e2e specs (inbox-phone-stepping.spec.ts,
 * inbox-image-swipe.spec.ts), and the small PNGs they attach.
 *
 * Chromium gets real touches through the DevTools protocol (the browser's own
 * gesture handling runs, and pointer events with it). WebKit has no such
 * channel, so its touch events are dispatched where the finger is, as iOS
 * sends them to the page (no pointer events: an image never pans under them).
 */
import type { Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';

/** A small PNG drawn here (a two-tone gradient with bands), `width` × `height`. */
export function png(width: number, height: number, hue: [number, number, number]): Buffer {
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
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const band = Math.floor(y / 120) % 2 === 0 ? 1 : 0.86;
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      const t = (x + y) / (width + height);
      rows[at] = Math.round(hue[0] * (0.45 + 0.55 * t) * band);
      rows[at + 1] = Math.round(hue[1] * (0.45 + 0.55 * t) * band);
      rows[at + 2] = Math.round(hue[2] * (0.45 + 0.55 * t) * band);
    }
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

export interface Finger {
  /** Put one finger down at (x, y) and move it by (dx, dy) in `moves` moves. */
  down(x: number, y: number, dx: number, dy: number, moves?: number): Promise<void>;
  /** Lift it. */
  up(): Promise<void>;
}

/** One finger, real (Chromium, the DevTools protocol) or as iOS sends its events to the page (WebKit). */
export async function finger(page: Page, browserName: 'chromium' | 'webkit'): Promise<Finger> {
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    let at = { x: 0, y: 0 };
    return {
      async down(x, y, dx, dy, moves = 10) {
        at = { x, y };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let i = 1; i <= moves; i++) {
          at = { x: x + (dx * i) / moves, y: y + (dy * i) / moves };
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at] });
          await page.waitForTimeout(16);
        }
      },
      async up() {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      },
    };
  }
  return {
    async down(x, y, dx, dy, moves = 10) {
      await page.evaluate(
        async ({ x, y, dx, dy, moves }) => {
          // The element under the finger, inside shadow roots too (iOS targets the innermost one; Pierre's code is in shadow roots).
          let target = document.elementFromPoint(x, y)!;
          while (target.shadowRoot) {
            const inner = target.shadowRoot.elementFromPoint(x, y);
            if (!inner || inner === target) break;
            target = inner;
          }
          const w = window as unknown as { __finger: { target: Element; x: number; y: number } };
          const fire = (type: string, px: number, py: number) => {
            const point = { identifier: 1, clientX: px, clientY: py, pageX: px, pageY: py, target };
            const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
            Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] });
            Object.defineProperty(event, 'changedTouches', { value: [point] });
            target.dispatchEvent(event);
          };
          fire('touchstart', x, y);
          for (let i = 1; i <= moves; i++) {
            fire('touchmove', x + (dx * i) / moves, y + (dy * i) / moves);
            await new Promise((done) => setTimeout(done, 16));
          }
          w.__finger = { target, x: x + dx, y: y + dy };
        },
        { x, y, dx, dy, moves },
      );
    },
    async up() {
      await page.evaluate(() => {
        const { target, x, y } = (window as unknown as { __finger: { target: Element; x: number; y: number } }).__finger;
        const point = { identifier: 1, clientX: x, clientY: y, pageX: x, pageY: y, target };
        const event = new Event('touchend', { bubbles: true, cancelable: true, composed: true });
        Object.defineProperty(event, 'touches', { value: [] });
        Object.defineProperty(event, 'changedTouches', { value: [point] });
        target.dispatchEvent(event);
      });
    },
  };
}

