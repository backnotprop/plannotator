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

const gitlabMetadata: GitlabMRMetadata = {
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

/** GitLab mints upload secrets as 32 lowercase hex characters; the rewrite requires that shape. */
const uploadSecret = '0123456789abcdef0123456789abcdef';

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

  // #2328: the browser asks for the attachment by the URL the browser
  // normalized, while the PR text may write the host in another case or with
  // the default port. Failure caught: a referenced private image refused.
  // (A host other than the PR's own: there the full URL is the only needle.)
  test('a reference with another host case or the default port still names the requested URL', () => {
    const attachment = 'https://private-user-images.githubusercontent.com/1/shot.png?jwt=abc';
    for (const written of [
      'https://Private-User-Images.githubusercontent.com/1/shot.png?jwt=abc',
      'https://private-user-images.githubusercontent.com:443/1/shot.png?jwt=abc',
    ]) {
      expect(isPRArtifactDocumentUrlAllowed(attachment, github, { ...context, body: `![shot](${written})` })).toBe(true);
    }
  });

  // Failure caught: the reviewer's token sent to a host the PR's provider
  // does not own, because the text referenced it.
  test('refuses a referenced URL on a host that is not one of the provider artifact hosts', () => {
    for (const url of [
      'https://evil.example/user-attachments/assets/0f1e2d3c',
      'https://gist.github.com/user-attachments/assets/0f1e2d3c',
      'https://objects.githubusercontent.com/acme/widgets/shot.png',
    ]) {
      expect(isPRArtifactDocumentUrlAllowed(url, github, { ...context, body: `![shot](${url})` })).toBe(false);
    }
  });

  // A github.com attachment is a provider artifact only for a PR on
  // github.com: a GitLab MR or a GitHub Enterprise PR that embeds one is
  // refused here, which is why the client loads those images directly.
  test('refuses a github.com attachment for a GitLab MR or a GitHub Enterprise PR', () => {
    const attachment = 'https://github.com/user-attachments/assets/0f1e2d3c';
    const body = { ...context, body: `![shot](${attachment})` };
    const enterprise: GithubPRMetadata = { ...github, host: 'github.example.com', url: 'https://github.example.com/acme/widgets/pull/1' };
    expect(isPRArtifactDocumentUrlAllowed(attachment, gitlabMetadata, body)).toBe(false);
    expect(isPRArtifactDocumentUrlAllowed(attachment, enterprise, body)).toBe(false);
  });

  // Failure caught: "referenced" meaning "resolves to". A comment holding
  // `…/main/docs/../secret.txt` must not authorize `…/main/secret.txt`, a URL
  // the text never names. (The written paths keep the target's path out of
  // the text: the same-origin path needle matches it literally anywhere.)
  test('a reference with dot segments or a backslash does not authorize the URL it resolves to', () => {
    const target = 'https://github.com/acme/widgets/blob/main/secret.txt';
    for (const written of [
      'https://github.com/acme/widgets/blob/main/docs/../secret.txt',
      'https://github.com/acme/widgets/blob/main/docs/%2e%2e/secret.txt',
      'https://github.com/acme/widgets/blob/main/./secret.txt',
      'https://github.com/acme/widgets/blob/main/docs\\..\\secret.txt',
    ]) {
      expect(isPRArtifactDocumentUrlAllowed(target, github, { ...context, body: `[x](${written})` })).toBe(false);
    }
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

  test('refuses a github.com redirect to another port, before sending anything there', async () => {
    const artifactUrl = 'https://github.com/user-attachments/files/123/explainer.html';
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: 'test-token\n', stderr: '', exitCode: 0 };
      },
    };
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      requested.push(String(input));
      return new Response(null, { status: 302, headers: { location: 'https://github.com:8443/download/explainer.html' } });
    };
    try {
      await expect(fetchPRArtifactDocument(runtime, github, context, artifactUrl)).rejects.toMatchObject({ status: 403 });
      expect(requested).toEqual([artifactUrl]);
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
        { ...context, body: `[review](/uploads/${uploadSecret}/review.md)` },
        `https://gitlab.example.com/uploads/${uploadSecret}/review.md`,
      );
      expect(result.content).toBe('# Review');
      expect(receivedToken).toBe('test-token');
      expect(commands).toEqual(['glab config get token --host gitlab.example.com']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetches GitLab uploads through the token-readable uploads API', async () => {
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: 'test-token\n', stderr: '', exitCode: 0 };
      },
    };
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response('# Review', { headers: { 'content-type': 'text/markdown' } });
    };
    try {
      for (const rawUrl of [
        `https://gitlab.example.com/uploads/${uploadSecret}/review.md`,
        `https://gitlab.example.com/acme/widgets/uploads/${uploadSecret}/review.md`,
      ]) {
        const result = await fetchPRArtifactDocument(
          runtime,
          gitlabMetadata,
          {
            ...context,
            body: [
              `[a](/uploads/${uploadSecret}/review.md)`,
              `[b](/acme/widgets/uploads/${uploadSecret}/review.md)`,
            ].join('\n'),
          },
          rawUrl,
        );
        expect(result.content).toBe('# Review');
      }
      expect(requestedUrls).toEqual([
        `https://gitlab.example.com/api/v4/projects/acme%2Fwidgets/uploads/${uploadSecret}/review.md`,
        `https://gitlab.example.com/api/v4/projects/acme%2Fwidgets/uploads/${uploadSecret}/review.md`,
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rewrites only real upload paths, so a crafted MR link cannot steer the credentialed GET', async () => {
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: 'test-token\n', stderr: '', exitCode: 0 };
      },
    };
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response('# Review', { headers: { 'content-type': 'text/markdown' } });
    };
    const crafted = [
      // Secrets GitLab could never have minted: too short, and not lowercase hex.
      'https://gitlab.example.com/uploads/hash/review.md',
      `https://gitlab.example.com/uploads/${uploadSecret.toUpperCase()}/review.md`,
      // A multi-segment remainder would otherwise append an attacker-chosen path
      // to the /api/v4 URL the token is sent to.
      `https://gitlab.example.com/uploads/${uploadSecret}/nested/review.md`,
    ];
    try {
      for (const rawUrl of crafted) {
        await fetchPRArtifactDocument(
          runtime,
          gitlabMetadata,
          { ...context, body: `[review](${rawUrl})` },
          rawUrl,
        );
      }
      // Left alone: fetched verbatim as the ordinary web route, never rewritten.
      expect(requestedUrls).toEqual(crafted);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('refines the opaque content type the GitLab uploads API returns', async () => {
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: 'test-token\n', stderr: '', exitCode: 0 };
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(Uint8Array.from([137, 80, 78, 71]), {
      headers: { 'content-type': 'application/octet-stream' },
    });
    try {
      const result = await fetchPRArtifactContent(
        runtime,
        gitlabMetadata,
        { ...context, body: `![shot](/uploads/${uploadSecret}/screenshot.png)` },
        `https://gitlab.example.com/uploads/${uploadSecret}/screenshot.png`,
      );
      expect(result.contentType).toBe('image/png');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('never refines an opaque upload into an active content type', async () => {
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: 'test-token\n', stderr: '', exitCode: 0 };
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('<script>alert(1)</script>', {
      headers: { 'content-type': 'application/octet-stream' },
    });
    try {
      // An HTML artifact is read through the document route, which always serves
      // text/plain, so refining these here would only put an active type on the media
      // route and leave its safety resting on a CSP header.
      for (const filename of ['payload.html', 'payload.js']) {
        await expect(fetchPRArtifactContent(
          runtime,
          gitlabMetadata,
          { ...context, body: `[x](/uploads/${uploadSecret}/${filename})` },
          `https://gitlab.example.com/uploads/${uploadSecret}/${filename}`,
        )).rejects.toMatchObject({ status: 415 });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('retries the original upload route once when the uploads API route is absent', async () => {
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: 'test-token\n', stderr: '', exitCode: 0 };
      },
    };
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      // Pre-17.4 self-hosted GitLab: the uploads API route does not exist, while the
      // original web route serves a public project without a session.
      return url.includes('/api/v4/')
        ? new Response('{"error":"404 Not Found"}', { status: 404 })
        : new Response('# Review', { headers: { 'content-type': 'text/markdown' } });
    };
    try {
      const result = await fetchPRArtifactDocument(
        runtime,
        gitlabMetadata,
        { ...context, body: `[review](/uploads/${uploadSecret}/review.md)` },
        `https://gitlab.example.com/uploads/${uploadSecret}/review.md`,
      );
      expect(result.content).toBe('# Review');
      expect(requestedUrls).toEqual([
        `https://gitlab.example.com/api/v4/projects/acme%2Fwidgets/uploads/${uploadSecret}/review.md`,
        `https://gitlab.example.com/uploads/${uploadSecret}/review.md`,
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('reports the transport status when the fallback route also 404s, without retrying again', async () => {
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: 'test-token\n', stderr: '', exitCode: 0 };
      },
    };
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return new Response('missing', { status: 404 });
    };
    try {
      const promise = fetchPRArtifactDocument(
        runtime,
        gitlabMetadata,
        { ...context, body: `[review](/uploads/${uploadSecret}/review.md)` },
        `https://gitlab.example.com/uploads/${uploadSecret}/review.md`,
      );
      await expect(promise).rejects.toMatchObject({ status: 502 });
      expect(requests).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('diagnoses a direct 401 or 403 from the GitLab API as a missing login', async () => {
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: '', stderr: '', exitCode: 1 };
      },
    };
    const originalFetch = globalThis.fetch;
    try {
      for (const status of [401, 403]) {
        globalThis.fetch = async () => new Response('{"message":"401 Unauthorized"}', {
          status,
          headers: { 'content-type': 'application/json' },
        });
        const promise = fetchPRArtifactDocument(
          runtime,
          gitlabMetadata,
          { ...context, body: `[review](/uploads/${uploadSecret}/review.md)` },
          `https://gitlab.example.com/uploads/${uploadSecret}/review.md`,
        );
        // The actionable outcome: the reader is told to log in, not that HTTP 401 happened.
        await expect(promise).rejects.toMatchObject({ status: 401 });
        await expect(promise).rejects.toThrow(/glab auth login --hostname gitlab\.example\.com/);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('leaves a GitHub 403 as a transport status, since it also covers rate limits', async () => {
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: 'test-token\n', stderr: '', exitCode: 0 };
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('rate limited', { status: 403 });
    try {
      const promise = fetchPRArtifactDocument(
        runtime,
        github,
        context,
        'https://github.com/acme/widgets/blob/main/docs/review.html',
      );
      await expect(promise).rejects.toMatchObject({ status: 502 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not forward the GitLab token to a cross-origin redirect after the upload rewrite', async () => {
    // The module-global auth cache is keyed by platform and host with a 5 minute TTL, so
    // this deliberately resolves the same `test-token` every other gitlab test in this file
    // does: whether the cache is cold or warm, request one carries that exact token.
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: 'test-token\n', stderr: '', exitCode: 0 };
      },
    };
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    const tokens: string[] = [];
    const signedUrl = 'https://objects.example.net/gitlab/review.md?signature=abc';
    globalThis.fetch = async (input, init) => {
      requestedUrls.push(String(input));
      tokens.push(new Headers(init?.headers).get('private-token') ?? '');
      // Object storage hands an upload off to a signed URL on an unrelated host.
      return requestedUrls.length === 1
        ? new Response(null, { status: 302, headers: { location: signedUrl } })
        : new Response('# Review', { headers: { 'content-type': 'text/markdown' } });
    };
    try {
      const result = await fetchPRArtifactDocument(
        runtime,
        gitlabMetadata,
        { ...context, body: `[review](/uploads/${uploadSecret}/review.md)` },
        `https://gitlab.example.com/uploads/${uploadSecret}/review.md`,
      );
      expect(result.content).toBe('# Review');
      expect(requestedUrls[0]).toContain('/api/v4/projects/acme%2Fwidgets/uploads/');
      expect(requestedUrls[1]).toBe(signedUrl);
      // The invariant: routing uploads through the API must not widen where the
      // credential travels. The token stops at the provider's own origin.
      expect(tokens).toEqual(['test-token', '']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fails loudly instead of rendering a provider sign-in page', async () => {
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: '', stderr: '', exitCode: 1 };
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      return String(input).includes('/api/v4/')
        ? new Response(null, {
          status: 302,
          headers: { location: 'https://gitlab.example.com/users/auth/saml' },
        })
        : new Response('<form action="/users/auth/saml">', {
          headers: { 'content-type': 'text/html' },
        });
    };
    try {
      const promise = fetchPRArtifactDocument(
        runtime,
        gitlabMetadata,
        { ...context, body: `[review](/uploads/${uploadSecret}/review.md)` },
        `https://gitlab.example.com/uploads/${uploadSecret}/review.md`,
      );
      await expect(promise).rejects.toThrow(/requires authentication/);
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

  const tokenRuntime: PRRuntime = {
    async runCommand() {
      return { stdout: 'test-token\n', stderr: '', exitCode: 0 };
    },
  };

  // A private attachment as GitHub serves it to a token (checked live): github.com needs the token,
  // then 302 to a signed S3 URL that needs none.
  test('sends the token to github.com only; the S3 upload bucket gets none', async () => {
    const attachment = 'https://github.com/user-attachments/assets/0f1e2d3c';
    const bucket = 'https://github-production-user-asset-6210df.s3.amazonaws.com/1/shot.png?X-Amz-Signature=x';
    const originalFetch = globalThis.fetch;
    const seen: Array<[string, string]> = [];
    globalThis.fetch = async (input, init) => {
      seen.push([new URL(String(input)).host, new Headers(init?.headers).get('authorization') ?? '']);
      return seen.length === 1
        ? new Response(null, { status: 302, headers: { location: bucket } })
        : new Response(Uint8Array.from([137, 80]), { headers: { 'content-type': 'image/png' } });
    };
    try {
      const result = await fetchPRArtifactContent(tokenRuntime, github, { ...context, body: `![shot](${attachment})` }, attachment);
      expect(result.contentType).toBe('image/png');
      expect(seen).toEqual([
        ['github.com', 'Bearer test-token'],
        ['github-production-user-asset-6210df.s3.amazonaws.com', ''],
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('the token never crosses a redirect, even to private-user-images', async () => {
    const attachment = 'https://github.com/user-attachments/assets/0f1e2d3c';
    const signed = 'https://private-user-images.githubusercontent.com/1/shot.png?jwt=abc';
    const originalFetch = globalThis.fetch;
    const tokens: string[] = [];
    globalThis.fetch = async (_input, init) => {
      tokens.push(new Headers(init?.headers).get('authorization') ?? '');
      return tokens.length === 1
        ? new Response(null, { status: 302, headers: { location: signed } })
        : new Response(Uint8Array.from([137, 80]), { headers: { 'content-type': 'image/png' } });
    };
    try {
      await fetchPRArtifactContent(tokenRuntime, github, { ...context, body: `![shot](${attachment})` }, attachment);
      expect(tokens).toEqual(['Bearer test-token', '']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a github.com redirect off GitHub and its bucket is refused', async () => {
    const attachment = 'https://github.com/user-attachments/assets/0f1e2d3c';
    for (const location of [
      'https://evil.example/shot.png',
      'https://objects.githubusercontent.com/shot.png',
      'https://github-production-user-asset-6210df.s3.amazonaws.com.evil.example/shot.png',
      'https://other-bucket.s3.amazonaws.com/shot.png',
    ]) {
      const originalFetch = globalThis.fetch;
      const requested: string[] = [];
      globalThis.fetch = async (input) => {
        requested.push(String(input));
        return new Response(null, { status: 302, headers: { location } });
      };
      try {
        await expect(
          fetchPRArtifactContent(tokenRuntime, github, { ...context, body: `![shot](${attachment})` }, attachment),
        ).rejects.toMatchObject({ status: 403 });
        expect(requested).toEqual([attachment]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  test('Git LFS media only as raw.githubusercontent.com hands off this repository\'s file, without the token', async () => {
    const blob = 'https://github.com/acme/widgets/blob/main/assets/demo.png';
    const lfs = 'https://media.githubusercontent.com/media/acme/widgets/main/assets/demo.png?token=signed';
    const originalFetch = globalThis.fetch;
    const seen: Array<[string, string]> = [];
    globalThis.fetch = async (input, init) => {
      seen.push([String(input), new Headers(init?.headers).get('authorization') ?? '']);
      return seen.length === 1
        ? new Response(null, { status: 302, headers: { location: lfs } })
        : new Response(Uint8Array.from([137, 80]), { headers: { 'content-type': 'image/png' } });
    };
    try {
      await fetchPRArtifactContent(tokenRuntime, github, context, blob);
      expect(seen).toEqual([
        ['https://raw.githubusercontent.com/acme/widgets/main/assets/demo.png', 'Bearer test-token'],
        [lfs, ''],
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
    for (const [from, location] of [
      ['https://github.com/user-attachments/assets/0f1e2d3c', lfs],
      [blob, 'https://media.githubusercontent.com/media/other/repo/main/x.png'],
    ]) {
      const requested: string[] = [];
      globalThis.fetch = async (input) => {
        requested.push(String(input));
        return new Response(null, { status: 302, headers: { location } });
      };
      try {
        await expect(fetchPRArtifactContent(tokenRuntime, github, { ...context, body: `${context.body}\n![x](${from})` }, from)).rejects.toMatchObject({ status: 403 });
        expect(requested).toHaveLength(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  test('a picture or video request answered with another type is refused', async () => {
    const attachment = 'https://github.com/user-attachments/assets/0f1e2d3c';
    for (const type of ['text/html', 'image/svg+xml', 'application/javascript']) {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response('<svg onload=alert(1)>', { headers: { 'content-type': type } });
      try {
        await expect(
          fetchPRArtifactContent(tokenRuntime, github, { ...context, body: `![shot](${attachment})` }, attachment),
        ).rejects.toMatchObject({ status: 415 });
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  test('loads public user-images without the token', async () => {
    const image = 'https://user-images.githubusercontent.com/1/shot.png';
    const originalFetch = globalThis.fetch;
    let authorization: string | null = 'unset';
    globalThis.fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization');
      return new Response(Uint8Array.from([137, 80]), { headers: { 'content-type': 'image/png' } });
    };
    try {
      await fetchPRArtifactContent(tokenRuntime, github, { ...context, body: `![shot](${image})` }, image);
      expect(authorization).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Failure caught: a provider redirect steering the server (with or without
  // the token) at the reviewer's own machine or network, or downgrading to
  // plain http.
  test('refuses a redirect to a private-network address or to plain http', async () => {
    const attachment = 'https://github.com/user-attachments/assets/0f1e2d3c';
    for (const location of [
      'https://127.0.0.1/shot.png',
      'https://localhost:8080/shot.png',
      'https://192.168.1.20/shot.png',
      'https://10.0.0.5/shot.png',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/shot.png',
      'https://printer.local/shot.png',
      'http://objects.githubusercontent.com/shot.png',
    ]) {
      const originalFetch = globalThis.fetch;
      const requested: string[] = [];
      globalThis.fetch = async (input) => {
        requested.push(String(input));
        return new Response(null, { status: 302, headers: { location } });
      };
      try {
        await expect(
          fetchPRArtifactContent(tokenRuntime, github, { ...context, body: `![shot](${attachment})` }, attachment),
        ).rejects.toMatchObject({ status: 403 });
        expect(requested).toEqual([attachment]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });
});
