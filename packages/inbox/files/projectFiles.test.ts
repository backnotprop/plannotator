/**
 * A project file in the viewers (files/projectFiles.ts) and its comments in
 * the Send (attachments.ts `projectFileFeedback`). What this catches: a
 * project file read or commented through the attachment routes (which know
 * no such id), a comment the pane cannot match to its file (keyed by the
 * store's realpath, not the relative path the state carries), the folders
 * listed for a change's dot, and project-file comments missing from the Send
 * or mixed into "the attached files".
 */
import { afterEach, expect, test } from 'bun:test';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { INBOX_FILE_SOURCE } from '../fileSource';
import { attachmentFeedback } from '../attachments';
import { changeFolders, listingPaths } from './FilesPanel';
import { fileCommentKey, isProjectFileId, projectFileId, projectFilePath, projectFileSource, projectFileState } from './projectFiles';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function record(extra: Partial<InboxAnnotationRecord>): InboxAnnotationRecord {
  return {
    id: 'ann_1',
    project_id: 'prj',
    thread_id: 'thr_1',
    message_id: 'msg_1',
    attachment_id: '',
    path: '/work/ledger/src/api/totals.ts',
    version: 'current',
    annotation: { id: 'ann_1', blockId: 'b', startOffset: 0, endOffset: 4, type: 'COMMENT', text: 'Round once', originalText: 'total', createdA: 1 },
    created_at: '2026-10-27T10:00:00.000Z',
    updated_at: '2026-10-27T10:00:00.000Z',
    removed_at: null,
    sent_reply_id: null,
    ...extra,
  };
}

test('a pf: id names a relative path; an attachment id is not one', () => {
  expect(projectFileId('src/api/totals.ts')).toBe('pf:src/api/totals.ts');
  expect(projectFilePath('pf:src/api/totals.ts')).toBe('src/api/totals.ts');
  expect(isProjectFileId('att_01K7AAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
  expect(isProjectFileId('pf:')).toBe(false);
  const state = projectFileState('docs/a.md');
  expect([state.id, state.path, state.name, state.kind, state.changed_since_sent]).toEqual(['pf:docs/a.md', 'docs/a.md', 'a.md', 'markdown', false]);
  expect(projectFileState('shots/x.png').kind).toBe('image');
});

test('a project file reads and saves through the Files routes; an attachment through its own', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.includes('/files/annotations')) return new Response(JSON.stringify({ annotation: record({ project_file: { path: 'docs/a.md' } }) }));
    return new Response(JSON.stringify({ serverSession: 's', path: 'docs/a.md', name: 'a.md', kind: 'markdown', size: 3, mtime: 'm', sha256: 'f'.repeat(64), text: '# a', html: null }));
  }) as typeof fetch;
  const heard: string[] = [];
  const source = projectFileSource('thr_1', INBOX_FILE_SOURCE, (c) => heard.push(c.path));
  const pf = projectFileState('docs/a.md');
  const view = await source.view(pf, 'current');
  expect(view.text).toBe('# a');
  expect(view.attachment.current?.sha256).toBe('f'.repeat(64));
  expect(heard).toEqual(['docs/a.md']);
  await source.saveAnnotation(pf, 'current', { id: 'x' });
  expect(source.imageUrl(projectFileState('shots/x.png'), 'current')).toBe('/api/inbox/threads/thr_1/files/raw?path=shots%2Fx.png');
  expect(source.downloadUrl(pf, 'current')).toContain('&download=1');
  // An attachment goes where it always went.
  const att = { ...pf, id: 'att_01K7AAAAAAAAAAAAAAAAAAAAAA' } as InboxAttachmentState;
  expect(source.imageUrl(att, 'current')).toBe(INBOX_FILE_SOURCE.imageUrl(att, 'current'));
  expect(calls).toEqual(['GET /api/inbox/threads/thr_1/files/content?path=docs%2Fa.md', 'POST /api/inbox/threads/thr_1/files/annotations']);
});

test("a project file's comment is keyed by its relative path, as its viewer state is", () => {
  const keyed = fileCommentKey(record({ project_file: { path: 'src/api/totals.ts' } }));
  expect(keyed.path).toBe(projectFileState('src/api/totals.ts').path);
  const attached = record({ attachment_id: 'att_1' });
  expect(fileCommentKey(attached)).toBe(attached);
});

test('the folders above each change are listed top first, so a closed folder shows its dot', () => {
  expect(changeFolders({ 'src/api/totals.ts': 'M', 'src/api/invoices.ts': 'U', 'docs/a.md': 'A', 'README.md': 'M' })).toEqual([['src', 'docs'], ['src/api']]);
  expect(changeFolders({ 'a/b/c/d.ts': 'M' }, 2).flat()).toEqual(['a', 'a/b']);
  expect(listingPaths({ dir: 'src', entries: [{ name: 'api', kind: 'dir', ignored: false, locked: null, size: null }, { name: 'main.tsx', kind: 'file', ignored: false, locked: null, size: 3 }] })).toEqual(['src/api/', 'src/main.tsx']);
  expect(listingPaths({ dir: '', entries: [{ name: '.env', kind: 'file', ignored: true, locked: 'dotenv', size: 3 }] })).toEqual(['.env']);
});

test("the Send carries project files' comments in their own section, by path, after the attached files'", () => {
  const attachment = { ...projectFileState('docs/spec.md'), id: 'att_1', path: '/work/ledger/docs/spec.md', message_id: 'msg_1' } as InboxAttachmentState;
  const onAttachment = record({ id: 'ann_a', attachment_id: 'att_1', path: attachment.path, annotation: { ...record({}).annotation, id: 'ann_a', text: 'On the spec' } });
  const onProject = record({ id: 'ann_p', project_file: { path: 'src/api/totals.ts' }, annotation: { ...record({}).annotation, id: 'ann_p', text: 'Round once' } });
  const text = attachmentFeedback([onAttachment, onProject], [attachment], new Map(), '/work/ledger');
  const attached = text.indexOf('Feedback on the attached files');
  const project = text.indexOf('Feedback on files in the project');
  expect(attached).toBeGreaterThanOrEqual(0);
  expect(project).toBeGreaterThan(attached);
  expect(text.slice(project)).toContain('src/api/totals.ts');
  expect(text.slice(project)).toContain('Round once');
  expect(text.slice(attached, project)).not.toContain('Round once');
  // Only project files: no attached-files section.
  expect(attachmentFeedback([onProject], [], new Map(), '/work/ledger')).not.toContain('Feedback on the attached files');
});
