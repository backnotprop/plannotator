import type { APIRoute } from 'astro';
import { LLMS_AGENT_PAGES, buildLlmsAgent } from '../../../lib/llms';
import type { Agent } from '../../../lib/inbox-agents';

// One page per agent the site lists, from the same entry as /inbox/agents/<slug>/.
export function getStaticPaths() {
  return LLMS_AGENT_PAGES.map(({ slug, agent }) => ({ params: { agent: slug }, props: { agent } }));
}

export const GET: APIRoute = ({ props }) =>
  new Response(buildLlmsAgent((props as { agent: Agent }).agent), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
