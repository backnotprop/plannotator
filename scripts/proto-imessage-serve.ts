/**
 * Design prototype only: serve the Messages-style Inbox (apps/inbox/proto-imessage)
 * at `/` on loopback and hand every other request to a running Inbox, so the
 * prototype reads and writes the real store through the real routes. The
 * Inbox's own window stays at its own address, untouched.
 *
 *   bun scripts/proto-imessage-serve.ts --inbox http://localhost:<port> [--port 0]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const inbox = new URL(flag('--inbox') ?? '');
if (!/^(localhost|127\.0\.0\.1)$/.test(inbox.hostname)) throw new Error('--inbox must be a loopback Inbox');
// Read on every load, so a rebuild shows on the next reload.
const html = () =>
  readFileSync(flag('--html') ?? join(import.meta.dir, '../apps/inbox/proto-imessage/dist/index.html'), 'utf8').replace(
    '<head>',
    `<head><script>window.__INBOX_WINDOW__=${JSON.stringify(inbox.origin + '/')}</script>`,
  );

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(flag('--port') ?? 0),
  idleTimeout: 0, // the event stream stays open
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(html(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    const headers = new Headers(req.headers);
    // The page is this proxy's own origin; the Inbox sees a same-site request from a client without one.
    headers.delete('origin');
    headers.delete('host');
    const upstream = await fetch(new URL(url.pathname + url.search, inbox), {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      redirect: 'manual',
    });
    const out = new Headers(upstream.headers);
    out.delete('content-encoding'); // Bun's fetch already decoded the body
    out.delete('content-length');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
});

process.stdout.write(`Messages prototype: http://localhost:${server.port}/  (Inbox: ${inbox.origin}/)\n`);
