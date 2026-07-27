function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var normalizedUri = uri.length > 1 && uri.endsWith('/') ? uri.slice(0, -1) : uri;

  var redirects = {
    '/docs': 'https://docs.plannotator.ai/',
    '/docs/commands/annotate-last': 'https://docs.plannotator.ai/open-source/reference/cli#annotate-the-last-agent-message',
    '/docs/commands/annotate': 'https://docs.plannotator.ai/open-source/workflows/documents',
    '/docs/commands/code-review': 'https://docs.plannotator.ai/open-source/workflows/local-changes',
    '/docs/commands/plan-review': 'https://docs.plannotator.ai/open-source/workflows/plan-review',
    '/docs/getting-started/configuration': 'https://docs.plannotator.ai/open-source/reference/configuration',
    '/docs/getting-started/installation': 'https://docs.plannotator.ai/open-source/start/installation',
    '/docs/getting-started/quickstart': 'https://docs.plannotator.ai/open-source/start/quickstart',
    '/docs/getting-started/ui-settings': 'https://docs.plannotator.ai/open-source/reference/configuration#browser-ui-settings',
    '/docs/guides/ai-code-review': 'https://docs.plannotator.ai/open-source/workflows/agent-reviews',
    '/docs/guides/ai-features': 'https://docs.plannotator.ai/open-source/workflows/ask-ai',
    '/docs/guides/annotate-gates-and-json-responses': 'https://docs.plannotator.ai/open-source/reference/hooks#output-contracts',
    '/docs/guides/claude-code': 'https://docs.plannotator.ai/open-source/agents/claude-code',
    '/docs/guides/custom-feedback': 'https://docs.plannotator.ai/open-source/reference/custom-feedback',
    '/docs/guides/hook-integration': 'https://docs.plannotator.ai/open-source/reference/hooks',
    '/docs/guides/kiro-cli': 'https://docs.plannotator.ai/open-source/agents/kiro-cli',
    '/docs/guides/obsidian-integration': 'https://docs.plannotator.ai/open-source/agents/notes',
    '/docs/guides/opencode-migration-0-19-1': 'https://docs.plannotator.ai/open-source/agents/opencode',
    '/docs/guides/opencode': 'https://docs.plannotator.ai/open-source/agents/opencode',
    '/docs/guides/remote-and-devcontainers': 'https://docs.plannotator.ai/open-source/troubleshooting#remote-ssh-and-development-containers',
    '/docs/guides/self-hosting': 'https://docs.plannotator.ai/open-source/workflows/sharing#use-your-own-share-services',
    '/docs/guides/sharing-and-collaboration': 'https://docs.plannotator.ai/open-source/workflows/sharing',
    '/docs/guides/troubleshooting': 'https://docs.plannotator.ai/open-source/troubleshooting',
    '/docs/integrations/external-annotations-api': 'https://docs.plannotator.ai/open-source/reference/external-annotations',
    '/docs/reference/api-endpoints': 'https://docs.plannotator.ai/open-source/reference/local-api',
    '/docs/reference/environment-variables': 'https://docs.plannotator.ai/open-source/reference/environment-variables',
    '/docs/reference/keyboard-shortcuts': 'https://docs.plannotator.ai/open-source/reference/keyboard-shortcuts',
    '/docs/reference/prompts': 'https://docs.plannotator.ai/open-source/reference/custom-feedback',
    '/docs/reference/verifying-your-install': 'https://docs.plannotator.ai/open-source/start/installation#pin-or-verify-a-release',
    '/blog': 'https://docs.plannotator.ai/learn/',
    '/blog/annotate-any-web-page-or-html-file': 'https://docs.plannotator.ai/learn/annotate-any-web-page-or-html-file',
    '/blog/continuously-improve-claude-code-plans': 'https://docs.plannotator.ai/code-context/compound-with-plannotator',
    '/blog/local-diff-review-for-coding-agents': 'https://docs.plannotator.ai/learn/local-diff-review-for-coding-agents',
    '/blog/plan-diff-see-what-changed': 'https://docs.plannotator.ai/learn/plan-diff-see-what-changed',
    '/blog/plannotator-meets-pi': 'https://docs.plannotator.ai/open-source/agents/pi',
    '/blog/sharing-plans-with-your-team': 'https://docs.plannotator.ai/workspaces/review-plans-and-technical-decisions',
    '/blog/welcome': 'https://docs.plannotator.ai/open-source/'
  };

  if (redirects[normalizedUri]) {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: { value: redirects[normalizedUri] },
        'cache-control': { value: 'public, max-age=3600' }
      }
    };
  }

  if (uri.endsWith('/')) {
    request.uri += 'index.html';
  } else if (!uri.includes('.')) {
    request.uri += '/index.html';
  }

  return request;
}
