import type { APIRoute } from 'astro';
// Serve the plannotator knowledge skill as /llms.txt (https://llmstxt.org/).
// Single-sourced at build time from the skill file, so the CLI freshness
// guard in apps/hook/server/plannotator-skill-reference.test.ts transitively
// protects this page from drifting: if the skill is current, so is llms.txt.
//
// Inlined by Vite via ?raw rather than read at runtime. Two other spellings
// are wrong here and both fail silently or late:
//   - resolve(process.cwd(), ...) breaks under any invocation whose cwd is not
//     apps/marketing, and `bun run build:marketing` from the repo root is one.
//   - new URL(..., import.meta.url) is rewritten to the emitted SSR chunk's
//     own location (dist/.prerender/chunks/), not this source file, so the
//     relative depth does not survive bundling.
// A ?raw specifier is resolved by the bundler relative to THIS file, which is
// the same source-relative reach src/lib/shortcutReference.ts already uses for
// packages/*, and it fails the build loudly if the skill ever moves.
import skillMarkdown from '../../../../apps/skills/core/plannotator/SKILL.md?raw';

function buildLlmsTxt(): string {
  // Strip YAML frontmatter.
  const body = skillMarkdown.replace(/^---\n[\s\S]*?\n---\n/, '').trimStart();
  // The skill's own H1 would duplicate the file H1 required by the spec;
  // everything after it (the ## sections) is the detail content.
  const withoutH1 = body.replace(/^# .*\n/, '').trimStart();
  // The skill's opening paragraph is the same summary as the `>` blockquote
  // below, which llmstxt.org requires; printing both reads as a stutter.
  const withoutSummary = withoutH1.replace(/^[^\n]+\n\n/, '');
  // "This skill is the knowledge layer." orients an agent that loaded a skill.
  // A reader of llms.txt did not load a skill, so drop just that sentence and
  // keep the rest of its paragraph (which explains the launcher skills).
  const intro = withoutSummary.replace(
    /^This skill is the knowledge layer\.\s*/,
    '',
  );

  const header = [
    '# Plannotator',
    '',
    '> Plannotator is a local, browser-based review layer for agent coding workflows: plan review, code review, and document or live-app annotation. A human marks things up in the UI and structured feedback returns to the agent on stdout. This file is the complete CLI reference, generated from the same source agents install as a skill.',
    '',
    '',
  ].join('\n');

  const docsSection = [
    '',
    '## Docs',
    '',
    '- [GitHub repository](https://github.com/backnotprop/plannotator): source, issues, and releases',
    '- [Releases](https://github.com/backnotprop/plannotator/releases): changelogs and binaries',
    '- [Install script](https://plannotator.ai/install.sh): macOS and Linux installer',
    '- [guides.show](https://guides.show): portable Guided Review viewer and share host',
    '',
  ].join('\n');

  return header + intro + docsSection;
}

export const GET: APIRoute = () => {
  return new Response(buildLlmsTxt(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
