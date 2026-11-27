/**
 * A PR description's own uploads, as the Summary tab renders it.
 *
 * What regresses if this fails:
 *  - a Forgejo description's `![shot](/attachments/<uuid>)` is read as a local
 *    file (`/api/image?path=…`) and shows broken;
 *  - an image from anywhere else is sent to the proxy;
 *  - a GitHub description's images change;
 *  - the text the description's annotations anchor to changes.
 *
 * DOM-gated (DOM_TESTS=1, listed in tests/dom-test-list.txt).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ForgejoPRMetadata, GithubPRMetadata, PRMetadata } from '@plannotator/shared/pr-types';
import { ReviewStateProvider, type ReviewState } from '../dock/ReviewStateContext';

const hasDom = typeof document !== 'undefined';

const { AnnotatableDescription } = (hasDom ? await import('./AnnotatableDescription') : {}) as typeof import('./AnnotatableDescription');

const UUID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';

const forgejo: ForgejoPRMetadata = {
  platform: 'forgejo',
  host: 'forgejo.example.com',
  owner: 'acme',
  repo: 'widgets',
  number: 5,
  title: 'Improve widgets',
  author: 'ada',
  baseBranch: 'main',
  headBranch: 'better-widgets',
  baseSha: 'base',
  headSha: 'head',
  url: 'https://forgejo.example.com/acme/widgets/pulls/5',
};

const github: GithubPRMetadata = {
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

const GITHUB_SHOT = 'https://github.com/user-attachments/assets/1111-shot';
const ELSEWHERE = 'https://example.com/elsewhere.png';
const DESCRIPTION = [
  'Before the picture.',
  `![shot](/attachments/${UUID})`,
  `![other](https://evil.example/attachments/${UUID})`,
  `![badge](${ELSEWHERE})`,
  `![gh](${GITHUB_SHOT})`,
  'After the picture.',
].join('\n\n');

const BASE = 'http://review.test';
const absolute = (value: string | null | undefined) =>
  new URL(value ?? '', typeof location !== 'undefined' && location.origin !== 'null' ? location.origin : BASE).href;
const proxied = (url: string) => absolute(`/api/pr-artifact-content?${new URLSearchParams({ url })}`);

function state(prMetadata: PRMetadata | null): ReviewState {
  return {
    prMetadata,
    descriptionAnnotations: [],
    selectedDescriptionAnnotationId: null,
    onAddDescriptionAnnotation: () => {},
    onSelectDescriptionAnnotation: () => {},
    onAskAIForDescription: () => {},
    prArtifacts: [],
    openPRArtifact: () => {},
  } as unknown as ReviewState;
}

describe.if(hasDom)('AnnotatableDescription: a PR\'s own uploads (DOM)', () => {
  let roots: Root[] = [];
  let hosts: HTMLElement[] = [];

  async function render(prMetadata: PRMetadata | null): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    hosts.push(host);
    await act(async () => root.render(
      <ReviewStateProvider value={state(prMetadata)}>
        <AnnotatableDescription markdown={DESCRIPTION} />
      </ReviewStateProvider>,
    ));
    return host;
  }

  /** The `src` of the picture written as `written` (happy-dom cannot load the proxy, so its alt moves to a placeholder). */
  const srcOf = (host: HTMLElement, written: string) =>
    Array.from(host.querySelectorAll('img')).find((img) => img.getAttribute('data-image-src') === written)?.getAttribute('src') ?? null;
  /** The text the annotation engine reads: placeholders are excluded from annotation. */
  const annotatableText = (host: HTMLElement) => {
    const copy = host.cloneNode(true) as HTMLElement;
    for (const excluded of copy.querySelectorAll('.annotation-exclude')) excluded.remove();
    return copy.textContent;
  };

  afterEach(async () => {
    for (const root of roots) await act(async () => root.unmount());
    for (const host of hosts) host.remove();
    roots = [];
    hosts = [];
  });

  test('a Forgejo description\'s relative upload loads through the proxy on the PR\'s origin; nothing else does', async () => {
    const host = await render(forgejo);
    expect(absolute(srcOf(host, `/attachments/${UUID}`))).toBe(proxied(`https://forgejo.example.com/attachments/${UUID}`));
    expect(srcOf(host, `https://evil.example/attachments/${UUID}`)).toBe(`https://evil.example/attachments/${UUID}`);
    expect(srcOf(host, ELSEWHERE)).toBe(ELSEWHERE);
    expect(srcOf(host, GITHUB_SHOT)).toBe(GITHUB_SHOT);
  });

  test('a GitHub description is unchanged: its attachment is proxied, a relative path is not', async () => {
    const host = await render(github);
    expect(absolute(srcOf(host, GITHUB_SHOT))).toBe(proxied(GITHUB_SHOT));
    expect(srcOf(host, `/attachments/${UUID}`) ?? '').not.toContain('/api/pr-artifact-content');
    expect(srcOf(host, ELSEWHERE)).toBe(ELSEWHERE);
  });

  test('the text annotations anchor to is the same with and without the Forgejo handling', async () => {
    const plain = await render(null);
    const handled = await render(forgejo);
    expect(annotatableText(handled)).toBe(annotatableText(plain));
    expect(annotatableText(handled)).toBe('Before the picture.After the picture.');
  });
});
