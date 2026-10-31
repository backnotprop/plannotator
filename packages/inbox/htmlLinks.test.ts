import { describe, expect, test } from 'bun:test';
import { folderOf, resolveInboxHtmlLink, type InboxHtmlLinkContext } from './htmlLinks';

const FOLDER = '/work/design/narrative';
const att = (id: string, path: string, named_path: string | null = null) => ({
  id,
  path,
  named_path,
  name: path.split('/').pop()!,
  kind: 'html' as const,
});

const context = (overrides: Partial<InboxHtmlLinkContext> = {}): InboxHtmlLinkContext => ({
  folder: FOLDER,
  baseDir: FOLDER,
  attachments: [
    att('att_sheet', `${FOLDER}/SHEET.html`),
    att('att_frame', `${FOLDER}/frames/A-1440-light.png`),
    // Attached through a symlink: the link may name the path the agent gave.
    att('att_notes', '/real/elsewhere/notes.md', `${FOLDER}/NOTES.md`),
  ],
  assetRoute: '/api/html-assets/tok123/',
  serverOrigin: 'http://localhost:4000',
  ...overrides,
});

describe('resolveInboxHtmlLink', () => {
  test('a link to an attachment of the thread opens it, fragment kept', () => {
    expect(resolveInboxHtmlLink('frames/A-1440-light.png', context())).toEqual({ kind: 'attachment', id: 'att_frame', name: 'A-1440-light.png', hash: '' });
    expect(resolveInboxHtmlLink('./SHEET.html?x=1#top', context())).toEqual({ kind: 'attachment', id: 'att_sheet', name: 'SHEET.html', hash: 'top' });
    expect(resolveInboxHtmlLink('NOTES.md', context())).toMatchObject({ kind: 'attachment', id: 'att_notes' });
  });

  test('a sibling page that is not attached opens read-only, by its path in the folder', () => {
    expect(resolveInboxHtmlLink('B-cards.html#pr1', context())).toEqual({
      kind: 'page',
      path: `${FOLDER}/B-cards.html`,
      relative: 'B-cards.html',
      name: 'B-cards.html',
      hash: 'pr1',
    });
    // From a linked page in a subfolder, `..` climbs back into the folder.
    expect(resolveInboxHtmlLink('../C%20between.htm', context({ baseDir: `${FOLDER}/sub` }))).toMatchObject({
      kind: 'page',
      relative: 'C between.htm',
    });
    // Root-relative means the page's own folder.
    expect(resolveInboxHtmlLink('/A-story.html', context())).toMatchObject({ kind: 'page', relative: 'A-story.html' });
  });

  test('an image in the folder that is not attached opens in the lightbox through the asset route', () => {
    expect(resolveInboxHtmlLink('frames/B 390.png', context())).toEqual({
      kind: 'image',
      url: '/api/html-assets/tok123/frames/B%20390.png',
      name: 'B 390.png',
    });
  });

  test('another site opens in a new tab', () => {
    expect(resolveInboxHtmlLink('https://example.com/a?b=1', context())).toEqual({ kind: 'external', url: 'https://example.com/a?b=1' });
  });

  test('everything else is refused with a reason', () => {
    const refused = (href: string, ctx = context()) => {
      const link = resolveInboxHtmlLink(href, ctx);
      expect(link.kind).toBe('refused');
      return link.kind === 'refused' ? link.note : '';
    };
    expect(refused('../outside.html')).toContain('outside this page');
    expect(refused('../../x.png')).toContain('outside this page');
    expect(refused('report.pdf')).toContain('not attached');
    expect(refused('notes.txt')).toContain('not attached');
    expect(refused('.private/a.html')).toContain('hidden');
    expect(refused('sub/.env.html')).toContain('hidden');
    expect(refused('mailto:me@example.com')).toContain('mailto:');
    expect(refused('frames/x.png', context({ assetRoute: null }))).toContain('not available');
  });

  test('an in-page fragment needs nothing', () => {
    expect(resolveInboxHtmlLink('#section', context())).toEqual({ kind: 'ignored' });
  });

  test('folderOf', () => {
    expect(folderOf('/a/b/c.html')).toBe('/a/b');
    expect(folderOf('C:\\a\\c.html')).toBe('c:/a');
  });
});


test('Markdown links resolve from the current document and retain fragments without widening HTML links', () => {
  const ctx = context({ markdown: true, assetRoute: null });
  expect(resolveInboxHtmlLink('peer%20notes.md?view=1#target', ctx)).toMatchObject({ kind: 'page', relative: 'peer notes.md', hash: 'target' });
  expect(resolveInboxHtmlLink('../peer.md', { ...ctx, baseDir: `${FOLDER}/sub` })).toMatchObject({ kind: 'page', relative: 'peer.md' });
  for (const href of ['../escape.md', '.hidden/secret.md', 'not-attached.html']) expect(resolveInboxHtmlLink(href, ctx).kind).toBe('refused');
  expect(resolveInboxHtmlLink('peer.md', context()).kind).toBe('refused');
  // A Markdown file has no asset route, so an image beside it does not open, and the note promises none.
  const image = resolveInboxHtmlLink('shot.png', ctx);
  expect(image.kind).toBe('refused');
  expect(image.kind === 'refused' && image.note).not.toContain('image');
});
