import type { APIRoute } from 'astro';
import { buildLlmsInbox } from '../../lib/llms';

export const GET: APIRoute = () =>
  new Response(buildLlmsInbox(), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
