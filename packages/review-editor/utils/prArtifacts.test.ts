import { describe, expect, it } from 'bun:test';
import type {
  GithubPRMetadata,
  GitlabMRMetadata,
  PRContext,
} from '@plannotator/shared/pr-types';
import { buildPRArtifacts } from './prArtifacts';

const SHOT_URL = 'https://github.com/user-attachments/assets/1234-shot';

const githubMetadata: GithubPRMetadata = {
  platform: 'github',
  host: 'github.com',
  owner: 'acme',
  repo: 'widgets',
  number: 42,
  title: 'Improve widgets',
  author: 'octocat',
  baseBranch: 'main',
  headBranch: 'better-widgets',
  baseSha: 'base',
  headSha: 'head',
  url: 'https://github.com/acme/widgets/pull/42',
};

const gitlabMetadata: GitlabMRMetadata = {
  platform: 'gitlab',
  host: 'gitlab.com',
  projectPath: 'acme/widgets',
  iid: 42,
  title: 'Improve widgets',
  author: 'gitlab-user',
  baseBranch: 'main',
  headBranch: 'better-widgets',
  baseSha: 'base',
  headSha: 'head',
  url: 'https://gitlab.com/acme/widgets/-/merge_requests/42',
};

const emptyContext: PRContext = {
  body: '',
  state: 'OPEN',
  isDraft: false,
  labels: [],
  reviewDecision: '',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  comments: [],
  reviews: [],
  reviewThreads: [],
  checks: [],
  linkedIssues: [],
};

describe('buildPRArtifacts', () => {
  it('harvests supported markdown and raw HTML attachments but ignores ordinary links and code', () => {
    const context: PRContext = {
      ...emptyContext,
      body: [
        `![architecture](${SHOT_URL})`,
        '[notes](https://github.com/acme/widgets/blob/main/notes.md)',
        '<video src="https://github.com/acme/widgets/blob/main/repro.webm"></video>',
        '[ordinary link](https://example.com/docs)',
        `inline \`![not real](${SHOT_URL}?inside=code-span)\` code`,
        `\`\`\`md\n![not real](${SHOT_URL}?inside=code)\n\`\`\``,
      ].join('\n\n'),
    };

    const artifacts = buildPRArtifacts(githubMetadata, context);

    expect(artifacts.map((artifact) => [artifact.kind, artifact.name])).toEqual([
      ['image', 'architecture'],
      ['markdown', 'notes'],
      ['video', 'repro.webm'],
    ]);
  });

  it('keeps description provenance when a signed attachment URL is repeated in comments', () => {
    const context: PRContext = {
      ...emptyContext,
      body: `![canonical](${SHOT_URL}?token=first)`,
      comments: [
        {
          id: 'comment-1',
          author: 'reviewer',
          body: `![duplicate](${SHOT_URL}?token=second)`,
          createdAt: '2026-07-15T11:00:00Z',
          url: `${githubMetadata.url}#issuecomment-1`,
        },
      ],
    };

    const artifacts = buildPRArtifacts(githubMetadata, context);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.name).toBe('canonical');
    expect(artifacts[0]?.provenance).toEqual({
      surface: 'description',
      authorLogin: 'octocat',
      sourceUrl: githubMetadata.url,
    });
    expect(artifacts[0]?.sourceMarkdown).toBe(context.body);
  });

  it('keeps semantically distinct query variants while ignoring signing parameters', () => {
    const context: PRContext = {
      ...emptyContext,
      body: [
        '![before](https://github.com/acme/widgets/blob/main/render.png?variant=before&X-Amz-Signature=old)',
        '![after](https://github.com/acme/widgets/blob/main/render.png?variant=after&X-Amz-Signature=new)',
        '![before duplicate](https://github.com/acme/widgets/blob/main/render.png?X-Amz-Signature=renewed&variant=before)',
      ].join('\n\n'),
    };

    expect(buildPRArtifacts(githubMetadata, context).map((artifact) => artifact.name)).toEqual([
      'before',
      'after',
    ]);
  });

  it('decodes HTML entities in attachment attributes before resolving URLs', () => {
    const context: PRContext = {
      ...emptyContext,
      body: '<img alt="quality &amp; diff" src="https://github.com/acme/widgets/blob/main/render.png?left=1&amp;right=2">',
    };

    expect(buildPRArtifacts(githubMetadata, context)).toMatchObject([
      {
        kind: 'image',
        name: 'quality & diff',
        url: 'https://github.com/acme/widgets/blob/main/render.png?left=1&right=2',
      },
    ]);
  });

  it('decodes HTML entities in Markdown token destinations', () => {
    const artifacts = buildPRArtifacts(githubMetadata, {
      ...emptyContext,
      body: '![quality](https://github.com/acme/widgets/blob/main/render.png?left=1&amp;right=2)',
    });

    expect(artifacts).toMatchObject([
      {
        kind: 'image',
        url: 'https://github.com/acme/widgets/blob/main/render.png?left=1&right=2',
      },
    ]);
  });

  it('excludes external artifacts that the authenticated provider proxy cannot render', () => {
    expect(buildPRArtifacts(githubMetadata, {
      ...emptyContext,
      body: [
        '![image](https://example.com/render.png)',
        '[notes](https://example.com/notes.md)',
        '<video src="https://example.com/repro.webm"></video>',
      ].join('\n'),
    })).toEqual([]);
  });

  it('recognizes an extensionless GitHub upload authored as a bare video URL', () => {
    const videoUrl = 'https://github.com/user-attachments/assets/1234-video';
    const context: PRContext = {
      ...emptyContext,
      body: videoUrl,
    };

    expect(buildPRArtifacts(githubMetadata, context)).toMatchObject([
      {
        kind: 'video',
        url: videoUrl,
      },
    ]);
  });

  it('uses an authored filename to recognize an extensionless GitHub GIF upload', () => {
    const gifUrl = 'https://github.com/user-attachments/assets/1234-gif';
    const context: PRContext = {
      ...emptyContext,
      body: `![demo.gif](${gifUrl})`,
    };

    expect(buildPRArtifacts(githubMetadata, context)).toMatchObject([
      {
        kind: 'gif',
        name: 'demo.gif',
        url: gifUrl,
      },
    ]);
  });

  it('does not treat arbitrary githubusercontent files as extensionless video uploads', () => {
    const context: PRContext = {
      ...emptyContext,
      body: 'https://raw.githubusercontent.com/acme/widgets/main/LICENSE',
    };

    expect(buildPRArtifacts(githubMetadata, context)).toEqual([]);
  });

  it('sorts conversation sources newest-first and carries review-thread resolution state', () => {
    const context: PRContext = {
      ...emptyContext,
      comments: [
        {
          id: 'late',
          author: 'late-reviewer',
          body: '![late](https://github.com/acme/widgets/blob/main/late.png)',
          createdAt: '2026-07-15T12:00:00Z',
          url: `${githubMetadata.url}#issuecomment-late`,
        },
      ],
      reviews: [
        {
          id: 'early',
          author: 'early-reviewer',
          state: 'COMMENTED',
          body: '![early](https://github.com/acme/widgets/blob/main/early.png)',
          submittedAt: '2026-07-15T10:00:00Z',
          url: `${githubMetadata.url}#pullrequestreview-early`,
        },
      ],
      reviewThreads: [
        {
          id: 'thread-1',
          isResolved: true,
          isOutdated: false,
          path: 'src/widget.ts',
          line: 10,
          startLine: null,
          diffSide: 'RIGHT',
          comments: [
            {
              id: 'middle',
              author: 'thread-reviewer',
              body: '![middle](https://github.com/acme/widgets/blob/main/middle.png)',
              createdAt: '2026-07-15T11:00:00Z',
              url: `${githubMetadata.url}#discussion-middle`,
            },
          ],
        },
      ],
    };

    const artifacts = buildPRArtifacts(githubMetadata, context);

    expect(artifacts.map((artifact) => artifact.name)).toEqual(['late', 'middle', 'early']);
    expect(artifacts[1]?.provenance).toMatchObject({
      surface: 'review-thread',
      resolved: true,
      refId: 'middle',
    });
  });

  it('returns stable ids across recomputes', () => {
    const context = { ...emptyContext, body: `![](${SHOT_URL})` };

    expect(buildPRArtifacts(githubMetadata, context)[0]?.id).toBe(
      buildPRArtifacts(githubMetadata, context)[0]?.id,
    );
  });

  it('resolves and harvests relative GitLab upload URLs', () => {
    const artifacts = buildPRArtifacts(gitlabMetadata, {
      ...emptyContext,
      body: [
        '![upload](/uploads/secret/screenshot.png)',
        '[explainer](/uploads/secret/explainer.html)',
      ].join('\n\n'),
    });

    expect(artifacts).toMatchObject([
      {
        kind: 'image',
        name: 'upload',
        url: 'https://gitlab.com/uploads/secret/screenshot.png',
      },
      {
        kind: 'html',
        name: 'explainer',
        url: 'https://gitlab.com/uploads/secret/explainer.html',
      },
    ]);
  });

  it('does not expose the gallery catalog without PR metadata', () => {
    expect(
      buildPRArtifacts(null, {
        ...emptyContext,
        body: `![local image](${SHOT_URL})`,
      }),
    ).toEqual([]);
  });
});
