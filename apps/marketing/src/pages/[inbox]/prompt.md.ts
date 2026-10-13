import type { APIRoute } from 'astro';
import { INBOX_LAUNCHED } from '../../lib/inbox-launch';
// The Inbox install prompt, served at /inbox/prompt.md. One source file:
// the /inbox/ page inlines the same ?raw import for its "Copy install prompt"
// button, so the copied text and this file can never differ. (?raw, not a
// runtime read: see llms.txt.ts for why.) Kept ASCII-only, because S3 serves
// .md as text/markdown with no charset.
import prompt from '../../lib/inbox-prompt.md?raw';

// Generated with the page, behind the same launch switch.
export function getStaticPaths() {
  return INBOX_LAUNCHED ? [{ params: { inbox: 'inbox' } }] : [];
}

export const GET: APIRoute = () =>
  new Response(prompt, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
