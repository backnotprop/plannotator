/**
 * A thread's web links (threadLinks.ts). What this catches: a link the message
 * draws missing from the list or one it does not draw listed (a code block, a
 * code span, an image); a repository's links split or merged across hosts; a
 * look-alike host taken for a forge; the same item listed twice.
 */
import { describe, expect, test } from 'bun:test';
import { linksOfBody, threadLinks } from './threadLinks';

const repo = { display: 'acme/web', host: 'github.com' };
const hrefs = (body: string, r: { display: string; host?: string } | null = null) => linksOfBody(body, r).map((l) => l.href);
const one = (...bodies: string[]) => threadLinks(bodies.map((body, i) => ({ id: `m${i}`, body })), null);

describe('what the message draws as a link', () => {
  test('written links, autolinks, bare urls, tables, quotes, lists and raw HTML', () => {
    const body = [
      'See [the docs](https://docs.example.com/a) and <https://auto.example.com> and https://bare.example.com/x.',
      '',
      '> quoted https://quote.example.com',
      '',
      '- item **https://bold.example.com/y**',
      '',
      '| a | b |',
      '|---|---|',
      '| https://cell.example.com | [z](https://cell2.example.com) |',
      '',
      '<div><a href="https://html.example.com/p">page</a></div>',
    ].join('\n');
    expect(hrefs(body)).toEqual([
      'https://docs.example.com/a',
      'https://auto.example.com',
      'https://bare.example.com/x',
      'https://quote.example.com',
      'https://bold.example.com/y',
      'https://cell.example.com',
      'https://cell2.example.com',
      'https://html.example.com/p',
    ]);
  });

  test('not a code block, a code span, an image, a comment or a local file', () => {
    const body = [
      'Run `curl https://span.example.com` first.',
      '',
      '```sh',
      'curl https://fence.example.com',
      '```',
      '',
      '![shot](https://img.example.com/a.png) <!-- https://comment.example.com -->',
      '',
      '[spec](docs/spec.md) and [src](src/app.ts) and [mail](mailto:a@example.com)',
    ].join('\n');
    expect(hrefs(body)).toEqual([]);
  });

  test('a linked image is the link, not the image', () => {
    expect(hrefs('[![alt](https://img.example.com/a.png)](https://target.example.com)')).toEqual(['https://target.example.com']);
  });

  test('a question card carries its links', () => {
    expect(hrefs(':::question\nWhich one? See https://q.example.com\n\n- [ ] A\n- [ ] B\n:::')).toEqual(['https://q.example.com']);
  });

  test('refs link only where the project names its repo', () => {
    expect(hrefs('fixed in #12 and other/lib#7')).toEqual([]);
    expect(hrefs('fixed in #12 and other/lib#7, not a1#3 or `#4`', repo)).toEqual(['https://github.com/acme/web/issues/12', 'https://github.com/other/lib/issues/7']);
  });
});

describe('the list', () => {
  test('a repository: its kinds together, whatever order they came in', () => {
    const { repos, others, count } = one(
      [
        'https://github.com/acme/web/blob/main/src/cart/total.ts#L42',
        'https://github.com/acme/web/commit/3f2a1bc9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3',
        'https://github.com/acme/web/issues/98',
        '[Fix the drawer](https://github.com/acme/web/pull/412)',
        'https://github.com/acme/web/actions/runs/77',
      ].join(' '),
    );
    expect(others).toEqual([]);
    expect(count).toBe(5);
    expect(repos.map((r) => r.path)).toEqual(['acme/web']);
    expect(repos[0]!.links.map((l) => [l.kind, l.lead, l.text, l.path])).toEqual([
      ['pull', '#412', 'Fix the drawer', null],
      ['issue', null, '#98', null],
      ['file', null, 'total.ts:42', 'src/cart/total.ts'],
      ['commit', null, '3f2a1bc', null],
      ['page', null, 'actions/runs/77', null],
    ]);
  });

  test('duplicates show once: a PR by its link, its files, a comment on it, an /issues/ alias; the words kept', () => {
    const { repos, count } = threadLinks(
      [
        { id: 'old', body: '[Fix the drawer](https://github.com/acme/web/pull/412)' },
        { id: 'new', body: 'https://github.com/acme/web/pull/412/files and https://github.com/acme/web/pull/412#issuecomment-9 and https://github.com/acme/web/issues/412 and #412' },
      ],
      repo,
    );
    expect(count).toBe(1);
    expect(repos[0]!.links[0]).toMatchObject({ kind: 'pull', lead: '#412', text: 'Fix the drawer' });
  });

  test('a written url beats one built from #12: it knows it is a pull request', () => {
    const { repos } = threadLinks(
      [
        { id: 'a', body: 'https://github.com/acme/web/pull/7' },
        { id: 'b', body: 'see #7' },
      ],
      repo,
    );
    expect(repos[0]!.links[0]).toMatchObject({ kind: 'pull', href: 'https://github.com/acme/web/pull/7' });
  });

  test('words that only repeat the row are dropped', () => {
    const { repos } = one('[#412](https://github.com/acme/web/pull/412) [acme/web#9](https://github.com/acme/web/issues/9) [PR #5](https://github.com/acme/web/pull/5)');
    expect(repos[0]!.links.map((l) => [l.lead, l.text])).toEqual([
      [null, '#412'],
      [null, '#5'],
      [null, '#9'],
    ]);
  });

  test('hosts: Enterprise and GitLab are forges, a look-alike or an opaque host is a plain site', () => {
    const { repos, others } = one(
      [
        'https://github.acme.dev/acme/web/pull/1',
        'https://github.com/acme/web/pull/2',
        'https://gitlab.com/group/sub/tool/-/merge_requests/7',
        'https://gitlab.com/group/sub/tool/-/blob/main/README.md',
        'https://github.com.evil.example/acme/web/pull/3',
        'https://github.com-evil.example/acme/web/pull/4',
        'https://git.acme.dev/acme/web/pull/5',
        'https://github.com/settings/tokens',
        'https://gist.github.com/someone/abc',
      ].join(' '),
    );
    expect(repos.map((r) => [r.host, r.path, r.platform])).toEqual([
      ['github.acme.dev', 'acme/web', 'github'],
      ['github.com', 'acme/web', 'github'],
      ['gitlab.com', 'group/sub/tool', 'gitlab'],
    ]);
    expect(repos[2]!.links.map((l) => [l.kind, l.lead, l.text])).toEqual([
      ['pull', null, '!7'],
      ['file', null, 'README.md'],
    ]);
    expect(others.map((l) => l.tail)).toEqual(['github.com.evil.example', 'github.com-evil.example', 'git.acme.dev', 'github.com', 'gist.github.com']);
    expect(others[3]!.platform).toBe('github');
    expect(others[0]!.platform).toBeNull();
  });

  test("a site's name is its real host, whatever the words say", () => {
    const { repos, others } = one('[github.com/acme/web](https://evil.example/login)');
    expect(repos).toEqual([]);
    expect(others[0]).toMatchObject({ text: 'github.com/acme/web', tail: 'evil.example' });
  });

  test('a repository link alone is its group; it counts once', () => {
    const { repos, count } = one('https://github.com/acme/web and https://github.com/ACME/web/');
    expect(count).toBe(1);
    expect(repos[0]!.links).toEqual([]);
  });

  test('other links: words, else the path; non-Latin paths read; a bidi override does not survive', () => {
    const { others } = one(
      [
        '[価格](https://shop.example.com/a)',
        'https://shop.example.com/%E6%96%99%E9%87%91',
        'https://www.example.org/',
        'http://localhost:3000/preview',
        'https://x.example.com/%E2%80%AEevil',
      ].join(' '),
    );
    expect(others.map((l) => [l.text, l.tail])).toEqual([
      ['価格', 'shop.example.com'],
      ['料金', 'shop.example.com'],
      ['example.org', null],
      ['preview', 'localhost:3000'],
      ['evil', 'x.example.com'],
    ]);
  });

  test('the count is what the list shows: a repository with links under it is not counted again', () => {
    const { repos, others, count } = one('https://github.com/acme/web and https://github.com/acme/web/pull/412', 'https://github.com/acme/tokens', 'https://docs.example.com/a');
    const shown = repos.reduce((n, group) => n + (group.links.length || 1), 0) + others.length;
    expect(count).toBe(3);
    expect(count).toBe(shown);
  });

  test('raw HTML: unquoted and entity-written hrefs read as the browser reads them; an unknown entity is left out', () => {
    expect(
      hrefs(
        [
          '<p><a href="https://html.example.com/a?x=1&amp;y=2">a</a></p>',
          '<p><a href=https://html.example.com/b>b</a></p>',
          '<p><a href="https://html.example.com/&#99;">c</a></p>',
          '<p><a href="https://html.example.com/d&nbsp;x">d</a></p>',
        ].join('\n\n'),
      ),
    ).toEqual(['https://html.example.com/a?x=1&y=2', 'https://html.example.com/b', 'https://html.example.com/c']);
  });

  test('zero-width characters and direction marks never reach the shown text', () => {
    const { others } = one('https://shop.example.com/a%E2%80%8Bb%E2%80%8Fc%D8%9Cd%E2%81%A0e%EF%BB%BFf');
    expect(others[0]!.text).toBe('abcdef');
  });

  test('a message whose text changes is read again', () => {
    const before = threadLinks([{ id: 'same', body: 'https://a.example.com' }], null);
    const after = threadLinks([{ id: 'same', body: 'https://b.example.com' }], null);
    expect(before.others[0]!.href).toBe('https://a.example.com');
    expect(after.others[0]!.href).toBe('https://b.example.com');
  });

  test('a thread with no links has none', () => {
    expect(one('Nothing here. Not even `https://code.example.com`.', 'Or #12, with no repo.').count).toBe(0);
  });
});
