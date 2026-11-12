import type { APIRoute } from 'astro';
import { INBOX_LAUNCHED } from '../../lib/inbox-launch';
import prompt from '../../lib/inbox-prompt.md?raw';

export function getStaticPaths() {
  return INBOX_LAUNCHED ? [{ params: { inbox: 'inbox' } }] : [];
}

export const GET: APIRoute = () =>
  new Response(prompt, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
