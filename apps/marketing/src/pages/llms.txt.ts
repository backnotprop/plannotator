import type { APIRoute } from 'astro';
import { buildLlmsRoot } from '../lib/llms';

// /llms.txt (https://llmstxt.org/): routes an agent to the page for its task.
// Built in src/lib/llms.ts from the same agent list as /inbox/agents/.
export const GET: APIRoute = () =>
  new Response(buildLlmsRoot(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
