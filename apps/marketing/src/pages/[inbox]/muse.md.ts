import type { APIRoute } from 'astro';
import { INBOX_LAUNCHED } from '../../lib/inbox-launch';
import page from '../../lib/inbox-muse.md?raw';

export function getStaticPaths() {
  return INBOX_LAUNCHED ? [{ params: { inbox: 'inbox' } }] : [];
}

export const GET: APIRoute = () =>
  new Response(page, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
