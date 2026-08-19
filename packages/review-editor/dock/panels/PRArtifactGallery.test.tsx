import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PRArtifact } from '../../utils/prArtifacts';
import { PRArtifactGallery } from './PRArtifactGallery';

const hasDom = typeof document !== 'undefined';

const artifacts: readonly PRArtifact[] = [
  {
    id: 'image-artifact',
    kind: 'image',
    name: 'Rendered diff',
    url: 'https://example.com/diff.png',
    sourceMarkdown: '![Rendered diff](https://example.com/diff.png)',
    provenance: {
      surface: 'description',
      authorLogin: 'reviewer',
      sourceUrl: 'https://example.com/pull/1',
    },
  },
  {
    id: 'video-artifact',
    kind: 'video',
    name: 'Interaction recording',
    url: 'https://example.com/review.mp4',
    sourceMarkdown: '[Interaction recording](https://example.com/review.mp4)',
    provenance: {
      surface: 'comment',
      authorLogin: 'reviewer',
      sourceUrl: 'https://example.com/pull/1#comment-1',
      createdAt: '2026-07-16T12:00:00Z',
      refId: 'comment-1',
    },
  },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

describe('PRArtifactGallery', () => {
  test.skipIf(!hasDom)('renders visual tiles and opens the selected artifact', async () => {
    const selected: string[] = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(
        <PRArtifactGallery
          artifacts={artifacts}
          provider={{ platform: 'github', host: 'github.com' }}
          onSelectArtifact={(artifactId) => selected.push(artifactId)}
        />,
      );
    });

    const imageButton = document.querySelector<HTMLButtonElement>('[aria-label="Open Rendered diff"]');
    const videoButton = document.querySelector<HTMLButtonElement>('[aria-label="Open Interaction recording"]');
    expect(imageButton).not.toBeNull();
    expect(videoButton).not.toBeNull();
    expect(document.querySelectorAll('button')).toHaveLength(2);

    await act(async () => {
      videoButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(selected).toEqual(['video-artifact']);
  });
});
