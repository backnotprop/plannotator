/**
 * Where StartCutPath splits a path (DOM-gated). The last name is the part
 * that never shrinks, so a wrong split cuts the name the reader needs.
 * Failures to catch: a Windows path split at the wrong separator, a folder
 * given with a trailing separator showing an empty name, and a bare name
 * drawing an empty folders part (a blank "…" before it).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StartCutPath } from './StartCutPath';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

async function parts(path: string): Promise<{ folders: string | null; last: string | null }> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<StartCutPath path={path} />);
  });
  return {
    folders: host.querySelector('[data-start-cut-path-folders]')?.textContent ?? null,
    last: host.querySelector('[data-start-cut-path-last]')?.textContent ?? null,
  };
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

describe.skipIf(!hasDom)('StartCutPath', () => {
  test('a Windows path: the folders up to the last backslash, then the name', async () => {
    expect(await parts('C:\\repo\\docs\\proposal.md')).toEqual({ folders: 'C:\\repo\\docs\\', last: 'proposal.md' });
  });

  test('a POSIX folder given with a trailing separator keeps its name', async () => {
    expect(await parts('/repo/docs/')).toEqual({ folders: '/repo/', last: 'docs/' });
  });

  test('a bare name has no folders part', async () => {
    expect(await parts('notes.md')).toEqual({ folders: null, last: 'notes.md' });
  });
});
