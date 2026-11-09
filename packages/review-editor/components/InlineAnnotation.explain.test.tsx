import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffAnnotationMetadata } from '@plannotator/ui/types';
import { InlineAnnotation } from './InlineAnnotation';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const metadata: DiffAnnotationMetadata = {
  annotationId: 'finding-1',
  type: 'comment',
  text: 'The fallback invents an entry.',
  source: 'review-job-1',
};

async function render(props: { source?: string; sources?: ReadonlySet<string>; onExplain?: (id: string) => void }) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <InlineAnnotation
        metadata={{ ...metadata, source: props.source }}
        onSelect={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onExplain={props.onExplain}
        agentFindingSources={props.sources}
      />,
    );
  });
  return host.querySelector<HTMLButtonElement>('[aria-label="Explain finding"]');
}

describe('InlineAnnotation Explain', () => {
  test.skipIf(!hasDom)('a finding from a launched review job explains itself by id', async () => {
    const asked: string[] = [];
    const button = await render({ source: 'review-job-1', sources: new Set(['review-job-1']), onExplain: (id) => asked.push(id) });
    await act(async () => button?.click());
    expect(asked).toEqual(['finding-1']);
  });

  test.skipIf(!hasDom)('a comment whose source is not a launched job gets no Explain', async () => {
    expect(await render({ source: 'agent-spoofed', sources: new Set(['review-job-1']), onExplain: () => {} })).toBeNull();
  });

  test.skipIf(!hasDom)('no Explain when Ask AI is unavailable', async () => {
    expect(await render({ source: 'review-job-1', sources: new Set(['review-job-1']) })).toBeNull();
  });
});
