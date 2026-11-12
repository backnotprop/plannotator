import type { APIRoute } from 'astro';
import skillMarkdown from '../../../../apps/skills/core/plannotator/SKILL.md?raw';

function buildLlmsTxt(): string {
  const body = skillMarkdown.replace(/^---\n[\s\S]*?\n---\n/, '').trimStart();
  const withoutH1 = body.replace(/^# .*\n/, '').trimStart();
  const withoutSummary = withoutH1.replace(/^[^\n]+\n\n/, '');
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
