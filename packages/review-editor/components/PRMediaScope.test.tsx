/**
 * Pictures and videos in PR text open in the Artifacts panel at that item
 * (owner, 2026-11-11: "Artifacts panel for both").
 *
 * What regresses if this fails:
 *  - a click on an attachment picture in a comment does nothing again (the
 *    zoom cursor promising a viewer that never opens);
 *  - a keyboard user cannot reach it (no focus, Enter does nothing);
 *  - GitHub's pasted video (a bare link) opens the forge instead of the panel,
 *    or a Cmd/Ctrl-click on it no longer opens a new tab;
 *  - a picture the panel does not list (another host) promises a zoom and
 *    shows nothing, instead of opening in place;
 *  - the panel opens on the gallery, or keeps a hidden item hidden, instead
 *    of showing the item that was clicked.
 *
 * DOM-gated (DOM_TESTS=1, listed in tests/dom-test-list.txt).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GithubPRMetadata, PRContext } from '@plannotator/shared/pr-types';
import { ReviewStateProvider, type ReviewState } from '../dock/ReviewStateContext';
import { ReviewPRArtifactsPanel } from '../dock/panels/ReviewPRArtifactsPanel';
import { buildPRArtifacts } from '../utils/prArtifacts';
import { MarkdownBody } from './MarkdownBody';
import { artifactContentProxyUrl } from '../dock/panels/artifactDocument';
import { mediaArtifact } from '../utils/prMediaTarget';

const hasDom = typeof document !== 'undefined';

const SHOT = 'https://github.com/user-attachments/assets/1111-shot';
const CLIP = 'https://github.com/user-attachments/assets/2222-clip';
const ELSEWHERE = 'https://example.com/elsewhere.png';

const metadata: GithubPRMetadata = {
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

const COMMENT = [`![shot](${SHOT})`, CLIP, `![elsewhere](${ELSEWHERE})`].join('\n\n');

const context: PRContext = {
  body: '',
  state: 'OPEN',
  isDraft: false,
  labels: [],
  reviewDecision: '',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  comments: [{ id: 'c1', author: 'hubot', body: COMMENT, createdAt: '2026-11-01T00:00:00Z', url: '' }],
  reviews: [],
  reviewThreads: [],
  checks: [],
  linkedIssues: [],
};

const artifacts = buildPRArtifacts(metadata, context);
const idOf = (url: string) => artifacts.find((artifact) => artifact.url === url)!.id;

function state(overrides: Partial<ReviewState>): ReviewState {
  return {
    prMetadata: metadata,
    prContext: context,
    prArtifacts: artifacts,
    openPRArtifact: () => {},
    prArtifactFocus: null,
    onPRArtifactFocusHandled: () => {},
    isPRContextLoading: false,
    prContextError: null,
    fetchPRContext: () => {},
    descriptionAnnotations: [],
    selectedDescriptionAnnotationId: null,
    onAddDescriptionAnnotation: () => {},
    onSelectDescriptionAnnotation: () => {},
    onAskAIForDescription: () => {},
    commentAnnotations: [],
    selectedCommentAnnotationId: null,
    onAddCommentAnnotation: () => {},
    onSelectCommentAnnotation: () => {},
    onAskAIForComment: () => {},
    ...overrides,
  } as ReviewState;
}

describe.if(hasDom)('PR text pictures and videos open in Artifacts (DOM)', () => {
  let roots: Root[] = [];
  let hosts: HTMLElement[] = [];

  async function render(node: React.ReactElement): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    hosts.push(host);
    await act(async () => root.render(node));
    return host;
  }

  afterEach(async () => {
    for (const root of roots) await act(async () => root.unmount());
    for (const host of hosts) host.remove();
    roots = [];
    hosts = [];
    localStorage.clear();
  });

  test('a picture or video link in a comment opens its artifact by click and keyboard; another picture opens in place', async () => {
    const openPRArtifact = mock((_id: string) => {});
    const host = await render(
      <ReviewStateProvider value={state({ openPRArtifact })}>
        <MarkdownBody prMedia markdown={COMMENT} />
      </ReviewStateProvider>,
    );

    const shot = host.querySelector<HTMLImageElement>('img[alt="shot"]')!;
    expect(shot.getAttribute('role')).toBe('button');
    expect(shot.tabIndex).toBe(0);
    await act(async () => shot.click());
    expect(openPRArtifact.mock.calls).toEqual([[idOf(SHOT)]]);

    await act(async () => {
      shot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(openPRArtifact.mock.calls.length).toBe(2);

    const clip = host.querySelector<HTMLAnchorElement>(`a[href="${CLIP}"]`)!;
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await act(async () => clip.dispatchEvent(plain));
    expect(plain.defaultPrevented).toBe(true);
    expect(openPRArtifact.mock.calls.at(-1)).toEqual([idOf(CLIP)]);

    const newTab = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    await act(async () => clip.dispatchEvent(newTab));
    expect(newTab.defaultPrevented).toBe(false);
    expect(openPRArtifact.mock.calls.length).toBe(3);

    const elsewhere = host.querySelector<HTMLImageElement>('img[alt="elsewhere"]')!;
    expect(elsewhere.getAttribute('role')).toBe('button');
    await act(async () => elsewhere.click());
    expect(openPRArtifact.mock.calls.length).toBe(3);
    expect(document.body.querySelectorAll(`img[src="${ELSEWHERE}"]`).length).toBe(2);
  });

  test('a picture shown through the proxy still finds its artifact; a look-alike does not', () => {
    const img = document.createElement('img');
    img.setAttribute('src', artifactContentProxyUrl(SHOT));
    expect(mediaArtifact(img, artifacts, metadata)?.id).toBe(idOf(SHOT));
    img.setAttribute('src', 'https://github.com.evil.example/user-attachments/assets/1111-shot');
    expect(mediaArtifact(img, artifacts, metadata)).toBeNull();
  });

  test('the panel opens at the clicked item, un-hides it, and puts focus on its row', async () => {
    localStorage.setItem(`plannotator-pr-artifacts:hidden:${metadata.url}`, JSON.stringify([idOf(CLIP)]));
    const onPRArtifactFocusHandled = mock((_seq: number) => {});
    const host = await render(
      <ReviewStateProvider value={state({ prArtifactFocus: { id: idOf(CLIP), seq: 7 }, onPRArtifactFocusHandled })}>
        <ReviewPRArtifactsPanel {...({} as React.ComponentProps<typeof ReviewPRArtifactsPanel>)} />
      </ReviewStateProvider>,
    );

    const row = host.querySelector<HTMLElement>(`[data-artifact-row="${idOf(CLIP)}"]`)!;
    expect(row).not.toBeNull();
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(row);
    expect(host.querySelector('video')).not.toBeNull();
    expect(onPRArtifactFocusHandled.mock.calls).toEqual([[7]]);
  });
});
