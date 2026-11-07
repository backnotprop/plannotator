// The marks the drawing has a picture for (draw/marks.tsx draws them). A mark
// with no picture is written as a small tag. Kept apart from the pictures so
// the layout can measure marks without loading React.
export const MARK_IDS = new Set([
  'cloudflare', 'ts', 'react', 'electron', 'swift', 'go', 'postgres', 'planetscale', 'r2', 'git', 'github', 'linear', 'slack',
  'figma', 'claude', 'codex', 'cursor', 'devin', 'openai', 'stripe', 'workos', 'hono', 'mermaid', 'mcp', 'workers', 'vite',
  'vitest', 'playwright', 'sentry', 'posthog', 'pnpm', 'python', 'node',
]);
export const hasMark = (id: string) => MARK_IDS.has(id);
/** Marks that are words, not drawings: left off a part whose own words say them. */
export const TEXT_MARKS = new Set(['go', 'github', 'openai', 'stripe', 'workos', 'mermaid', 'mcp']);
/** Word marks run wider than square ones. */
export const WIDE_MARKS = new Set(['go', 'stripe', 'workos', 'mermaid', 'mcp', 'openai', 'github']);
