import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

const migratedLinks: Record<string, string> = {
  'annotate-any-web-page-or-html-file': 'https://docs.plannotator.ai/learn/annotate-any-web-page-or-html-file',
  'continuously-improve-claude-code-plans': 'https://docs.plannotator.ai/code-context/compound-with-plannotator',
  'local-diff-review-for-coding-agents': 'https://docs.plannotator.ai/learn/local-diff-review-for-coding-agents',
  'plan-diff-see-what-changed': 'https://docs.plannotator.ai/learn/plan-diff-see-what-changed',
  'plannotator-meets-pi': 'https://docs.plannotator.ai/open-source/agents/pi',
  'sharing-plans-with-your-team': 'https://docs.plannotator.ai/workspaces/review-plans-and-technical-decisions',
  welcome: 'https://docs.plannotator.ai/open-source/',
};

export async function GET(context: APIContext) {
  const posts = (await getCollection('blog'))
    .filter((post) => !post.data.draft)
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime());

  return rss({
    title: 'Plannotator Blog',
    description: 'News and updates from Plannotator',
    site: context.site!,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.date,
      link: migratedLinks[post.id] ?? `/blog/${post.id}/`,
    })),
  });
}
