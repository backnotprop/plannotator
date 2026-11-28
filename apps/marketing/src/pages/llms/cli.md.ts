import type { APIRoute } from 'astro';
import { buildLlmsCli } from '../../lib/llms';
// The plannotator skill as /llms/cli.md, single-sourced at build time, so the
// CLI freshness guard in apps/hook/server/plannotator-skill-reference.test.ts
// transitively protects this page from drifting.
//
// Inlined by Vite via ?raw rather than read at runtime. Two other spellings
// are wrong here and both fail silently or late:
//   - resolve(process.cwd(), ...) breaks under any invocation whose cwd is not
//     apps/marketing, and `bun run build:marketing` from the repo root is one.
//   - new URL(..., import.meta.url) is rewritten to the emitted SSR chunk's
//     own location (dist/.prerender/chunks/), not this source file, so the
//     relative depth does not survive bundling.
// A ?raw specifier is resolved by the bundler relative to THIS file, the same
// source-relative reach src/lib/shortcutReference.ts uses for packages/*, and
// it fails the build loudly if the skill ever moves.
import skillMarkdown from '../../../../../apps/skills/core/plannotator/SKILL.md?raw';

export const GET: APIRoute = () =>
  new Response(buildLlmsCli(skillMarkdown), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
