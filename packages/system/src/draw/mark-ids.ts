export const MARK_IDS = new Set([
  'cloudflare', 'ts', 'react', 'electron', 'swift', 'go', 'postgres', 'planetscale', 'r2', 'git', 'github', 'linear', 'slack',
  'figma', 'claude', 'codex', 'cursor', 'devin', 'openai', 'stripe', 'workos', 'hono', 'mermaid', 'mcp', 'workers', 'vite',
  'vitest', 'playwright', 'sentry', 'posthog', 'pnpm', 'python', 'node',
]);
export const hasMark = (id: string) => MARK_IDS.has(id);
export const TEXT_MARKS = new Set(['go', 'github', 'openai', 'stripe', 'workos', 'mermaid', 'mcp']);
export const WIDE_MARKS = new Set(['go', 'stripe', 'workos', 'mermaid', 'mcp', 'openai', 'github']);
