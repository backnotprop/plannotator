import type { APIRoute } from 'astro';
import { INBOX_LAUNCHED } from '../../lib/inbox-launch';
import { buildInboxPrompt } from '../../lib/llms';
// The Inbox install prompt, served at /inbox/prompt.md: inbox-prompt.md with the
// per-agent steps from inbox-agents.ts in its slot. The /inbox/ page inlines the
// same buildInboxPrompt() for its "Copy install prompt" button, so the copied
// text and this file can never differ. (?raw, not a runtime read: see
// llms/cli.md.ts for why.) Kept ASCII-only, as pasted text.
import source from '../../lib/inbox-prompt.md?raw';

// Generated with the page, behind the same launch switch.
export function getStaticPaths() {
  return INBOX_LAUNCHED ? [{ params: { inbox: 'inbox' } }] : [];
}

export const GET: APIRoute = () =>
  new Response(buildInboxPrompt(source), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
