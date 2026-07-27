import { describe, expect, test } from 'bun:test';
import type { GithubPRMetadata, GitlabMRMetadata, PRContext, PRRuntime } from './pr-types';
import {
  fetchPRArtifactContent,
  fetchPRArtifactDocument,
  isPRArtifactDocumentUrlAllowed,
} from './pr-artifact-document';

const context: PRContext = {
  body: [
    '[explainer](https://github.com/user-attachments/files/123/explainer.html)',
    '[source](https://raw.githubusercontent.com/acme/widgets/main/review.md)',
    '[committed](https://github.com/acme/widgets/blob/main/docs/review.html)',
    '![media](https://github.com/acme/widgets/blob/main/assets/demo.png)',
  ].join('\n'),
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

const github: GithubPRMetadata = {
  platform: 'github',
  host: 'github.com',
  owner: 'acme',
  repo: 'widgets',
  number: 1,
  title: 'Artifacts',
  author: 'reviewer',
  baseBranch: 'main',
  headBranch: 'feature',
  baseSha: 'base',
  headSha: 'head',
  url: 'https://github.com/acme/widgets/pull/1',
};

describe('isPRArtifactDocumentUrlAllowed', () => {
  test('allows referenced GitHub uploads and raw files from the active repository', () => {
    expect(isPRArtifactDocumentUrlAllowed(
      'https://github.com/user-attachments/files/123/explainer.html',
      github,
      context,
    )).toBe(true);
    expect(isPRArtifactDocumentUrlAllowed(
      'https://github.com/acme/widgets/blob/main/docs/review.html',
      github,
      context,
    )).toBe(true);
    expect(isPRArtifactDocumentUrlAllowed(
      'https://raw.githubusercontent.com/acme/widgets/main/review.md',
      github,
      context,
    )).toBe(true);
  });

  test('matches GitHub owner and repository casing without weakening the origin check', () => {
    const mixedCaseUrl = 'https://github.com/ACME/Widgets/blob/main/docs/review.html';
    expect(isPRArtifactDocumentUrlAllowed(
      mixedCaseUrl,
      github,
      { ...context, body: `[review](${mixedCaseUrl})` },
    )).toBe(true);
    expect(isPRArtifactDocumentUrlAllowed(
      'https://github.com:8443/ACME/Widgets/blob/main/docs/review.html',
      github,
      {
        ...context,
        body: '[review](https://github.com:8443/ACME/Widgets/blob/main/docs/review.html)',
      },
    )).toBe(false);
  });

  test('rejects unreferenced URLs and raw files from a different repository', () => {
    expect(isPRArtifactDocumentUrlAllowed(
      'https://github.com/user-attachments/files/999/private.html',
      github,
      context,
    )).toBe(false);
    expect(isPRArtifactDocumentUrlAllowed(
      'https://raw.githubusercontent.com/other/widgets/main/review.md',
      github,
      {
        ...context,
        body: '[source](https://raw.githubusercontent.com/other/widgets/main/review.md)',
      },
    )).toBe(false);
    expect(isPRArtifactDocumentUrlAllowed(
      'http://github.com/user-attachments/files/123/explainer.html',
      github,
      {
        ...context,
        body: '[explainer](http://github.com/user-attachments/files/123/explainer.html)',
      },
    )).toBe(false);
  });

  test('allows a relative GitLab upload only when the active MR references it', () => {
    const gitlab: GitlabMRMetadata = {
      platform: 'gitlab',
      host: 'gitlab.example.com',
      projectPath: 'acme/widgets',
      iid: 7,
      title: 'Artifacts',
      author: 'reviewer',
      baseBranch: 'main',
      headBranch: 'feature',
      baseSha: 'base',
      headSha: 'head',
      url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/7',
    };
    expect(isPRArtifactDocumentUrlAllowed(
      'https://gitlab.example.com/uploads/hash/explainer.html',
      gitlab,
      { ...context, body: '[explainer](/uploads/hash/explainer.html)' },
    )).toBe(true);
  });
});

describe('fetchPRArtifactDocument', () => {
  test('fetches a GitHub blob link from its raw-content URL', async () => {
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: 'test-token\n', stderr: '', exitCode: 0 };
      },
    };
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return new Response('<main>Review</main>', { headers: { 'content-type': 'text/html' } });
    };
    try {
      const result = await fetchPRArtifactDocument(
        runtime,
        github,
        context,
        'https://github.com/acme/widgets/blob/main/docs/review.html',
      );
      expect(result.content).toBe('<main>Review</main>');
      expect(requestedUrl).toBe('https://raw.githubusercontent.com/acme/widgets/main/docs/review.html');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('supports an exact self-hosted provider origin including its port', async () => {
    const enterprise: GithubPRMetadata = {
      ...github,
      host: 'github.example.com:8443',
      url: 'https://github.example.com:8443/acme/widgets/pull/1',
    };
    const artifactUrl = 'https://github.example.com:8443/acme/widgets/blob/main/review.md';
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: 'enterprise-token\n', stderr: '', exitCode: 0 };
      },
    };
    const originalFetch = globalThis.fetch;
    let receivedToken = '';
    let requestedUrl = '';
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      receivedToken = new Headers(init?.headers).get('authorization') ?? '';
      return new Response('# Review', { headers: { 'content-type': 'text/markdown' } });
    };
    try {
      const result = await fetchPRArtifactDocument(
        runtime,
        enterprise,
        { ...context, body: `[review](${artifactUrl})` },
        artifactUrl,
      );
      expect(result.content).toBe('# Review');
      expect(requestedUrl).toBe(
        'https://github.example.com:8443/acme/widgets/raw/main/review.md',
      );
      expect(receivedToken).toBe('Bearer enterprise-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not forward provider credentials to a redirect on another port', async () => {
    const artifactUrl = 'https://github.com/user-attachments/files/123/explainer.html';
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: 'test-token\n', stderr: '', exitCode: 0 };
      },
    };
    const originalFetch = globalThis.fetch;
    const authorizations: string[] = [];
    globalThis.fetch = async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '');
      if (authorizations.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://github.com:8443/download/explainer.html' },
        });
      }
      return new Response('<main>Review</main>', { headers: { 'content-type': 'text/html' } });
    };
    try {
      const result = await fetchPRArtifactDocument(runtime, github, context, artifactUrl);
      expect(result.content).toBe('<main>Review</main>');
      expect(authorizations).toEqual(['Bearer test-token', '']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('reads GitLab credentials with the supported per-host config command', async () => {
    const gitlab: GitlabMRMetadata = {
      platform: 'gitlab',
      host: 'gitlab.example.com',
      projectPath: 'acme/widgets',
      iid: 7,
      title: 'Artifacts',
      author: 'reviewer',
      baseBranch: 'main',
      headBranch: 'feature',
      baseSha: 'base',
      headSha: 'head',
      url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/7',
    };
    const commands: string[] = [];
    const runtime: PRRuntime = {
      async runCommand(command, args) {
        commands.push([command, ...args].join(' '));
        return { stdout: 'test-token\n', stderr: '', exitCode: 0 };
      },
    };
    const originalFetch = globalThis.fetch;
    let receivedToken = '';
    globalThis.fetch = async (_input, init) => {
      receivedToken = new Headers(init?.headers).get('PRIVATE-TOKEN') ?? '';
      return new Response('# Review', { headers: { 'content-type': 'text/markdown' } });
    };
    try {
      const result = await fetchPRArtifactDocument(
        runtime,
        gitlab,
        { ...context, body: '[review](/uploads/hash/review.md)' },
        'https://gitlab.example.com/uploads/hash/review.md',
      );
      expect(result.content).toBe('# Review');
      expect(receivedToken).toBe('test-token');
      expect(commands).toEqual(['glab config get token --host gitlab.example.com']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('fetchPRArtifactContent', () => {
  test('normalizes provider blob media, preserves bytes, and forwards a valid range', async () => {
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: 'test-token\n', stderr: '', exitCode: 0 };
      },
    };
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    let receivedRange = '';
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      receivedRange = new Headers(init?.headers).get('range') ?? '';
      return new Response(Uint8Array.from([0, 1, 2, 255]), {
        status: 206,
        headers: {
          'content-type': 'image/png',
          'content-range': 'bytes 0-3/4',
          'accept-ranges': 'bytes',
        },
      });
    };
    try {
      const result = await fetchPRArtifactContent(
        runtime,
        github,
        context,
        'https://github.com/acme/widgets/blob/main/assets/demo.png',
        { range: 'bytes=0-3' },
      );
      expect(requestedUrl).toBe('https://raw.githubusercontent.com/acme/widgets/main/assets/demo.png');
      expect(receivedRange).toBe('bytes=0-3');
      expect([...result.content]).toEqual([0, 1, 2, 255]);
      expect(result).toMatchObject({
        status: 206,
        contentType: 'image/png',
        contentRange: 'bytes 0-3/4',
        acceptRanges: 'bytes',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('allows a provider resource derived from a referenced document and rewrites CSS assets', async () => {
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: 'test-token\n', stderr: '', exitCode: 0 };
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      [
        '.hero { background: url(../images/hero.png); }',
        '.icon { background: url(https://cdn.example.com/icon.svg); }',
      ].join('\n'),
      { headers: { 'content-type': 'text/css' } },
    );
    try {
      const result = await fetchPRArtifactContent(
        runtime,
        github,
        context,
        'https://raw.githubusercontent.com/acme/widgets/main/styles/review.css',
        { sourceUrl: 'https://github.com/acme/widgets/blob/main/docs/review.html' },
      );
      const css = new TextDecoder().decode(result.content);
      expect(css).toContain('/api/pr-artifact-content?');
      expect(css).toContain('hero.png');
      expect(css).toContain('source=');
      expect(css).toContain('url(https://cdn.example.com/icon.svg)');
      expect(css).not.toContain('url=https%3A%2F%2Fcdn.example.com');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('buffers the complete bounded response before returning it', async () => {
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: 'test-token\n', stderr: '', exitCode: 0 };
      },
    };
    const originalFetch = globalThis.fetch;
    let finishBody: (() => void) | undefined;
    let markBodyStarted: (() => void) | undefined;
    const bodyStarted = new Promise<void>((resolve) => {
      markBodyStarted = resolve;
    });
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        finishBody = () => {
          controller.enqueue(Uint8Array.from([3, 4]));
          controller.close();
        };
        markBodyStarted?.();
      },
    }), { headers: { 'content-type': 'video/mp4' } });
    try {
      let settled = false;
      const pending = fetchPRArtifactContent(
        runtime,
        github,
        context,
        'https://github.com/acme/widgets/blob/main/assets/demo.png',
      ).then((result) => {
        settled = true;
        return result;
      });
      await bodyStarted;
      expect(settled).toBe(false);
      if (finishBody === undefined) throw new Error('Expected response body controller');
      finishBody();
      const result = await pending;
      expect([...result.content]).toEqual([1, 2, 3, 4]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects an unreferenced provider resource without a referenced source document', async () => {
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: '', stderr: '', exitCode: 1 };
      },
    };
    await expect(fetchPRArtifactContent(
      runtime,
      github,
      context,
      'https://raw.githubusercontent.com/acme/widgets/main/private/secret.png',
    )).rejects.toMatchObject({ status: 403 });
  });
});
