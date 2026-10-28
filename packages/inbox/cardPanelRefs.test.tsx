/**
 * The opened card's words (You, notes, what was said) link issue and PR refs
 * as a thread message does: a bare `#123` into the card's own project's repo,
 * `owner/repo#123` and full URLs as written. What regresses: the panel drawing
 * them as plain text again, or linking `#123` into another project's repo.
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
  column: 'your_review',
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
const render = (repo: CardPanelProps['repo']) =>
  renderToStaticMarkup(
    createElement(CardPanel, {
      card,
      history,
      refs: [],
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
      onIcebox: noop,
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
