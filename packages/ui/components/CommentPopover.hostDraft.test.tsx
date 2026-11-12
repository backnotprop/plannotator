import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommentPopover } from './CommentPopover';
import { CommentDraftHostContext, type CommentDraftHost, type HostCommentDraft } from './CommentDraftHost';
import { CommentUploadContext, type UploadTransport } from '../utils/upload';
import { resetCommentCardPolicy, setCommentCardEnabled } from '../utils/commentCardPolicy';

const hasDom = typeof document !== 'undefined';
const ANCHOR = { top: 120, bottom: 140, left: 300, right: 420, width: 120 } as DOMRect;
let root: Root | null = null;
let mountedHost: HTMLElement | null = null;
let opened = 0;

const box = () => document.querySelector<HTMLElement>('[data-comment-popover]');
const field = () => box()?.querySelector<HTMLTextAreaElement>('textarea') ?? null;
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name) ?? null;
const settle = (ms = 0) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

function memoryHost(start: HostCommentDraft | null) {
  let stored = start;
  let version = 0;
  const seen = new Map<string, number>();
  const writes: (HostCommentDraft | null)[] = [];
  const host: CommentDraftHost = {
    read: async (key) => {
      seen.set(key, version);
      return stored;
    },
    write: async (key, draft, options) => {
      if (!options?.force && seen.get(key) !== version) {
        seen.set(key, version);
        return { conflict: stored };
      }
      writes.push(draft);
      stored = draft;
      version += 1;
      seen.set(key, version);
      return 'saved';
    },
  };
  return { host, writes, elsewhere: (draft: HostCommentDraft) => { stored = draft; version += 1; } };
}

async function open(host: CommentDraftHost, upload?: UploadTransport, onSubmit: (text: string, images?: unknown[]) => void = () => {}) {
  mountedHost = document.createElement('div');
  document.body.appendChild(mountedHost);
  root = createRoot(mountedHost);
  const card = <CommentPopover anchorRect={ANCHOR} contextText="" isGlobal draftKey={`guide-global:m${(opened += 1)}`} onSubmit={onSubmit} onClose={() => {}} />;
  await act(async () => root!.render(
    <CommentDraftHostContext.Provider value={host}>
      {upload ? <CommentUploadContext.Provider value={upload}>{card}</CommentUploadContext.Provider> : card}
    </CommentDraftHostContext.Provider>,
  ));
  await settle();
}

async function type(words: string) {
  const el = field()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, words);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  if (hasDom) setCommentCardEnabled(true);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  mountedHost?.remove();
  resetCommentCardPolicy();
  if (hasDom) document.body.replaceChildren();
});

describe.if(hasDom)('the comment card keeps its draft with the host', () => {
  test('a draft saved before a reload opens in the card, words and file', async () => {
    const { host } = memoryHost({ text: 'Keep the log with it', images: [{ path: 'upl_1/debug.log', name: 'debug.log', kind: 'file' }] });
    await open(host);
    expect(field()!.value).toBe('Keep the log with it');
    expect(box()!.querySelector('[aria-label="Attachments"]')?.textContent).toContain('1');
  });

  test('words typed are saved, and a change from another window is offered, never written over', async () => {
    const memory = memoryHost(null);
    await open(memory.host);
    await type('First words');
    await settle(450);
    expect(memory.writes.at(-1)).toEqual({ text: 'First words', images: [] });
    memory.elsewhere({ text: 'From the other window', images: [] });
    await type('First words, more');
    await settle(450);
    expect(memory.writes.length).toBe(1);
    expect(box()!.querySelector('[data-comment-draft-conflict]')).not.toBeNull();
    await act(async () => button('Use that one')!.click());
    expect(field()!.value).toBe('From the other window');
  });

  test('Comment clears the kept draft', async () => {
    const memory = memoryHost({ text: 'Ready', images: [] });
    let sent = '';
    await open(memory.host, undefined, (text) => { sent = text; });
    await act(async () => button('Comment')!.click());
    await settle();
    expect([sent, memory.writes.at(-1)]).toEqual(['Ready', null]);
  });

  test('under an upload that takes files, a log file is attached as a file, not opened for drawing', async () => {
    const memory = memoryHost(null);
    const upload: UploadTransport = { files: true, upload: async (file) => ({ path: `upl_9/${file.name}`, originalName: file.name }) };
    await open(memory.host, upload);
    await act(async () => button('Attachments')!.click());
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.hasAttribute('accept')).toBe(false);
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['500'], 'debug.log', { type: 'text/plain' })] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await settle(450);
    expect(document.querySelector('[data-image-annotator], [role="dialog"][aria-label*="nnotat"]')).toBeNull();
    expect(memory.writes.at(-1)).toEqual({ text: '', images: [{ path: 'upl_9/debug.log', name: 'debug.log', kind: 'file' }] });
  });
});
