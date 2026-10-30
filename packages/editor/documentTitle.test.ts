/**
 * The document's name in the tab, the desktop header and the compact header
 * (#2061), per session kind. Failures to catch: a session kind falling back
 * to the repository-only title, the header naming a file twice beside the
 * several-file switcher, plan review growing a header name, a URL or live
 * app tab claiming the repository, the compact title drifting (it is
 * deliberately unchanged), and the tab not following a linked document or
 * a plan revision. The `·` titles are the approved format and are pinned on
 * purpose (option B of the approval for #2061). A folder session's tab and
 * header name the folder whichever file is open: the tab by name (`docs/`, the
 * format #2061's approval gave a folder before a file is picked), the header
 * as a path cut from the start.
 */
import { describe, expect, test } from 'bun:test';
import {
  compactDocumentTitle,
  documentHeaderName,
  documentTabTitle,
  planHeadingText,
  scrubbedUrl,
  urlDisplayName,
  type DocumentTitleInput,
} from './documentTitle';

const repo = { display: 'acme/payments', branch: 'main', host: 'github.com' };

const base: DocumentTitleInput = {
  apiMode: true,
  annotateMode: false,
  archiveMode: false,
  goalSetupMode: false,
  annotateSource: null,
  repo,
};

const annotate = (extra: Partial<DocumentTitleInput>): DocumentTitleInput => ({
  ...base,
  annotateMode: true,
  annotateSource: 'file',
  ...extra,
});

describe('one file', () => {
  const input = annotate({ sourceFilePath: '/repo/docs/rollout-plan.md' });
  test('tab names the file first, then the repository', () => {
    expect(documentTabTitle(input)).toBe('rollout-plan.md · acme/payments');
  });
  test('header shows the name with the full path for the tooltip', () => {
    expect(documentHeaderName(input)).toEqual({ name: 'rollout-plan.md', title: '/repo/docs/rollout-plan.md' });
  });
  test('compact title is unchanged', () => {
    expect(compactDocumentTitle(input)).toBe('rollout-plan.md');
  });
  test('a linked document replaces it in every place', () => {
    const linked = { ...input, linkedPath: '/repo/docs/notes.md' };
    expect(documentTabTitle(linked)).toBe('notes.md · acme/payments');
    expect(documentHeaderName(linked)?.name).toBe('notes.md');
    expect(compactDocumentTitle(linked)).toBe('notes.md');
  });
  test('Windows separators', () => {
    expect(documentTabTitle(annotate({ sourceFilePath: 'C:\\repo\\spec.md' }))).toBe('spec.md · acme/payments');
  });
});

describe('several files (bundle)', () => {
  const input = annotate({
    annotateSource: 'folder',
    linkedPath: '/repo/spec.md',
    bundle: { index: 0, total: 2 },
  });
  test('tab names the file and its place', () => {
    expect(documentTabTitle(input)).toBe('spec.md (1 of 2) · acme/payments');
  });
  test('the header names nothing: the switcher already does', () => {
    expect(documentHeaderName(input)).toBeNull();
    expect(documentHeaderName({ ...input, linkedPath: '/repo/other.md', bundle: { index: -1, total: 2 } })).toBeNull();
  });
  test('the tab follows the switcher', () => {
    expect(documentTabTitle({ ...input, linkedPath: '/repo/mock.html', bundle: { index: 1, total: 2 } }))
      .toBe('mock.html (2 of 2) · acme/payments');
  });
  test('compact title is unchanged', () => {
    expect(compactDocumentTitle(input)).toBe('spec.md (1 of 2)');
  });
});

describe('folder', () => {
  const folder = annotate({ annotateSource: 'folder', folderPath: '/repo/docs' });
  // The header names the folder as a path, cut from the start. Fails if it
  // shows only the folder's name, or loses the start cut that keeps that name whole.
  test('before a file is chosen: the folder', () => {
    expect(documentTabTitle(folder)).toBe('docs/ · acme/payments');
    expect(documentHeaderName(folder)).toEqual({ name: '/repo/docs', title: '/repo/docs', cutsFromStart: true });
    expect(compactDocumentTitle(folder)).toBe('Choose a file');
  });
  // Fails if the tab or the header goes back to naming the open file once one
  // is picked. The compact title still names the file (deliberately unchanged).
  test('the open file once chosen: the tab and the header still name the folder', () => {
    const open = { ...folder, activeFile: '/repo/docs/rollout-plan.md', linkedPath: '/repo/docs/rollout-plan.md' };
    expect(documentTabTitle(open)).toBe('docs/ · acme/payments');
    expect(documentHeaderName(open)).toEqual({ name: '/repo/docs', title: '/repo/docs', cutsFromStart: true });
    expect(compactDocumentTitle(open)).toBe('rollout-plan.md');
  });
  // Fails if a document linked from a folder file takes the tab or the
  // header: the session is still the folder's.
  test('a document linked from a folder file: the tab and the header still name the folder', () => {
    const linked = { ...folder, activeFile: '/repo/docs/rollout-plan.md', linkedPath: '/repo/shared/glossary.md' };
    expect(documentTabTitle(linked)).toBe('docs/ · acme/payments');
    expect(documentHeaderName(linked)).toEqual({ name: '/repo/docs', title: '/repo/docs', cutsFromStart: true });
  });
  // Fails if the folder's name loses its repository, or claims one outside a
  // git repository (#2075's rule for every tab).
  test('outside a git repository the folder sits beside Plannotator', () => {
    const outside = { ...folder, activeFile: '/scratch/docs/a.md', folderPath: '/scratch/docs', repo: { display: 'docs' } };
    expect(documentTabTitle(outside)).toBe('docs/ · Plannotator');
  });
  // Fails if Windows separators are rewritten in the header's path, or the
  // tab's folder name is taken at the wrong separator.
  test('Windows separators are kept as given', () => {
    const windows = annotate({ annotateSource: 'folder', folderPath: 'C:\\repo\\docs', activeFile: 'C:\\repo\\docs\\spec.md' });
    expect(documentHeaderName(windows)?.name).toBe('C:\\repo\\docs');
    expect(documentTabTitle(windows)).toBe('docs/ · acme/payments');
  });
});

describe('last message', () => {
  const input = annotate({ annotateSource: 'message' });
  test('tab and header say Last message, with no path to show', () => {
    expect(documentTabTitle(input)).toBe('Last message · acme/payments');
    expect(documentHeaderName(input)).toEqual({ name: 'Last message' });
  });
  test('compact title is unchanged', () => {
    expect(compactDocumentTitle(input)).toBe('Message');
  });
});

describe('URL and live app', () => {
  test('a URL names its host and path, never the repository', () => {
    const input = annotate({ sourceFilePath: 'https://docs.stripe.com/refunds/?token=secret#top' });
    expect(documentTabTitle(input)).toBe('docs.stripe.com/refunds · Plannotator');
    expect(documentHeaderName(input)).toEqual({ name: 'docs.stripe.com/refunds', title: 'docs.stripe.com/refunds?…' });
  });
  test('the tooltip never shows a query, a fragment or credentials', () => {
    const header = documentHeaderName(annotate({ sourceFilePath: 'https://user:pass@example.com/a/b?token=secret&x=1#frag' }));
    expect(header).toEqual({ name: 'example.com/a/b', title: 'example.com/a/b?…' });
    expect(JSON.stringify(header)).not.toMatch(/secret|pass|frag/);
    expect(scrubbedUrl('https://example.com/a#only-fragment')).toBe('example.com/a');
  });
  test('a site root is the host alone', () => {
    expect(urlDisplayName('https://example.com/')).toBe('example.com');
  });
  test('a live app names its host and port', () => {
    const input = annotate({ liveAppUrl: 'http://localhost:5173/admin?token=abc' });
    expect(documentTabTitle(input)).toBe('localhost:5173 · Plannotator');
    expect(documentHeaderName(input)).toEqual({ name: 'localhost:5173', title: 'localhost:5173/admin?…' });
  });
});

describe('plan review', () => {
  test('tab names the plan by its first heading', () => {
    expect(documentTabTitle({ ...base, planHeading: 'Add partial refunds' })).toBe('Add partial refunds (plan) · acme/payments');
  });
  test('a revision with a new heading renames the tab', () => {
    expect(documentTabTitle({ ...base, planHeading: 'Add partial and full refunds' }))
      .toBe('Add partial and full refunds (plan) · acme/payments');
  });
  test('no heading keeps today\'s title', () => {
    expect(documentTabTitle({ ...base, planHeading: null })).toBe('acme/payments · Plannotator');
    expect(documentTabTitle({ ...base, planHeading: null, repo: null })).toBe('Plannotator');
  });
  test('the header shows nothing extra', () => {
    expect(documentHeaderName({ ...base, planHeading: 'Add partial refunds' })).toBeNull();
  });
  test('compact title is unchanged', () => {
    expect(compactDocumentTitle(base)).toBe('Plan');
  });
});

describe('outside a git repository', () => {
  test('the name sits beside Plannotator, not the folder name', () => {
    const input = annotate({ sourceFilePath: '/tmp/scratch/notes.md', repo: { display: 'scratch' } });
    expect(documentTabTitle(input)).toBe('notes.md · Plannotator');
    expect(documentTabTitle({ ...base, planHeading: 'Fix it', repo: { display: 'scratch' } })).toBe('Fix it (plan) · Plannotator');
  });
  test('a repository with no remote still counts (it has a branch)', () => {
    const input = annotate({ sourceFilePath: '/r/a.md', repo: { display: 'local-repo', branch: 'main' } });
    expect(documentTabTitle(input)).toBe('a.md · local-repo');
  });
});

describe('sessions that keep today\'s title', () => {
  test('archive, goal setup and share links', () => {
    expect(documentTabTitle({ ...base, archiveMode: true, planHeading: 'X' })).toBe('acme/payments · Plannotator');
    expect(documentTabTitle({ ...base, goalSetupMode: true, planHeading: 'X' })).toBe('acme/payments · Plannotator');
    expect(documentTabTitle({ ...base, apiMode: false, planHeading: 'X', repo: null })).toBe('Plannotator');
    expect(documentHeaderName({ ...annotate({ sourceFilePath: '/r/a.md' }), apiMode: false })).toBeNull();
  });
  test('archive keeps its compact title', () => {
    expect(compactDocumentTitle({ ...base, archiveMode: true, archiveTitle: 'Old plan' })).toBe('Old plan');
  });
});

describe('planHeadingText', () => {
  test('drops inline markdown and a Plan: prefix', () => {
    expect(planHeadingText('Plan: Add `refunds` to **checkout**')).toBe('Add refunds to checkout');
    expect(planHeadingText('Implementation Plan: [Refunds](https://x.y) v2')).toBe('Refunds v2');
  });
  test('strips real HTML only: generics keep their angle brackets', () => {
    expect(planHeadingText('Return Result<T> from parse')).toBe('Return Result<T> from parse');
    expect(planHeadingText('Vec<String> and Map<K, V>')).toBe('Vec<String> and Map<K, V>');
    expect(planHeadingText('Ship <code>refunds</code> <!-- todo --> now')).toBe('Ship refunds now');
  });
  test('cuts by character, never inside an emoji or a combined letter', () => {
    const cut = planHeadingText('👩‍💻'.repeat(100));
    expect(cut).toBe(`${'👩‍💻'.repeat(79)}…`);
    expect(planHeadingText('é'.repeat(80))).toBe('é'.repeat(80));
  });
  test('keeps snake_case and a heading that is only "Plan:"', () => {
    expect(planHeadingText('Rename user_id')).toBe('Rename user_id');
    expect(planHeadingText('Plan:')).toBe('Plan:');
  });
  test('cuts a long heading', () => {
    const cut = planHeadingText('a'.repeat(200));
    expect(cut.length).toBe(80);
    expect(cut.endsWith('…')).toBe(true);
  });
});
