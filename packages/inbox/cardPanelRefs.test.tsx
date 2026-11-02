/**
 * The opened card's words (You, notes, what was said) link issue and PR refs
 * as a thread message does: a bare `#123` into the card's own project's repo,
 * `owner/repo#123` and full URLs as written. What regresses: the panel drawing
 * them as plain text again, or linking `#123` into another project's repo.
 * And a linked Jira issue (link only): drawn as its key linking the full
 * URL, never with a forge's state icon.
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InboxAuthor, InboxCardHistoryEntry, InboxCardWire } from '@plannotator/core/inbox-types';
import { CardPanel, type CardPanelProps } from './board/CardPanel';

const CLAUDE: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_claude', name: 'Claude Code' };
const AT = '2026-10-21T09:00:00.000Z';

const card = {
  id: 'crd_1',
  project_id: 'prj_1',
  title: 'TUI hover cards',
  column: 'in_review',
  you: 'Merge backnotprop/plannotator-tui#104',
  said: 'Opened #12',
  threads: [],
  prs: [],
  refs: [],
  agent: CLAUDE,
  created_at: AT,
  created_by: CLAUDE,
  moved_at: AT,
  heard_at: AT,
  heard_by: CLAUDE,
  dropped: null,
  aside_from: null,
  idempotency_key: null,
  notes: 'Follows #7 here and backnotprop/plannotator-tui#104 there; see https://github.com/acme/widgets/pull/3',
  sent: null,
} as unknown as InboxCardWire;

const history: InboxCardHistoryEntry[] = [{ at: AT, by: CLAUDE, kind: 'said', text: 'Waiting on backnotprop/plannotator-tui#104' } as InboxCardHistoryEntry];

const noop = () => {};
const render = (repo: CardPanelProps['repo'], extra: Partial<CardPanelProps> = {}) =>
  renderToStaticMarkup(
    createElement(CardPanel, {
      card,
      history,
      refs: [],
      ...extra,
      projectName: 'herdr',
      repo,
      state: null,
      canAsk: false,
      rowOf: () => null,
      phone: false,
      now: Date.parse(AT),
      onClose: noop,
      onColumn: noop,
      onShip: noop,
      onRestore: noop,
      onDrop: noop,
      onSend: noop,
      onStart: async () => null,
      onAsk: async () => null,
      onNotes: async () => true,
      onLink: async () => null,
      onOpenThread: noop,
      onCreateThread: noop,
    }),
  );

const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

describe('opened card refs', () => {
  test("links the card's words: bare #N into the card's project, owner/repo#N and URLs as written", () => {
    const links = hrefs(render({ display: 'acme/herdr', host: 'github.com' }));
    // The You band, the notes and the history quote.
    expect(links.filter((h) => h === 'https://github.com/backnotprop/plannotator-tui/issues/104')).toHaveLength(3);
    expect(links).toContain('https://github.com/acme/herdr/issues/7');
    expect(links).toContain('https://github.com/acme/widgets/pull/3');
  });

  test("a GitLab project links its bare #N on its own host", () => {
    const links = hrefs(render({ display: 'group/app', host: 'gitlab.example.com' }));
    expect(links).toContain('https://gitlab.example.com/group/app/-/issues/7');
    expect(links).toContain('https://gitlab.example.com/backnotprop/plannotator-tui/-/issues/104');
  });

  test('without a repo a bare #N stays unlinked', () => {
    expect(hrefs(render(null)).some((h) => h.endsWith('/issues/7'))).toBe(false);
  });
});

describe('opened card links: a Jira issue (user feedback #9)', () => {
  test('shows the key as the link to the full URL, with the Jira mark and its site, never a forge state', () => {
    const jira = { kind: 'issue', source: 'jira', ref: 'DEMO-123', url: 'https://example.atlassian.net/browse/DEMO-123' };
    const html = render(null, {
      card: { ...card, refs: [jira] } as InboxCardWire,
      refs: [{ ref: jira, result: { ok: false, error: 'unsupported', fetchedAt: 0 } }],
    });
    // The Links row, as the window draws it (static markup: runs without a DOM).
    const row = /<li class="ib-crdp-ref"[^>]*data-card-ref="DEMO-123".*?<\/li>/.exec(html)?.[0] ?? '';
    expect(row).toContain('data-ref-source="jira"');
    expect(row).toMatch(/<a href="https:\/\/example\.atlassian\.net\/browse\/DEMO-123"[^>]*aria-label="Jira issue DEMO-123"[^>]*>DEMO-123<\/a>/);
    // Jira's own mark, one colour like the forge marks, hidden from screen readers (the link's name says Jira).
    expect(row).toMatch(/<svg class="ib-refmark ib-crdp-rjira" data-ref-mark="jira"[^>]*aria-hidden="true"/);
    expect(row).not.toContain('data-icon="link"');
    // No forge state icon: a Jira issue has no state to show.
    expect(row).not.toContain('data-ref-kind');
    expect(row).toContain('<span class="ib-crdp-rref">example.atlassian.net</span>');
  });
});
