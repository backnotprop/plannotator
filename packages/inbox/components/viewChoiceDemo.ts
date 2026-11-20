/**
 * The view choice's pictures (ListViewIntro.tsx): the made-up agents and threads the owner designed and approved
 * (2026-11-20, "C-r3"), shown to everyone, whatever their own list holds. Four agents drawn: Ops (Claude Code's own
 * mark, waiting on a question), Review (Codex's own mark, working), Tide (Blastoise, the window's bundled set icon,
 * iconSets.ts `BUNDLED_SETS`) and Search index (pink Glass). Times are offsets from the moment the dialog opens, so the
 * picture never shows a stale day. Ids are the demo's own, so nothing the person keeps by id (names, faces, folds,
 * pins) reaches the picture.
 */
import { INBOX_SECTIONS, type InboxAgent, type InboxAgentsGroup, type InboxListGroupId, type InboxListRow, type InboxListSection } from '@plannotator/core/inbox-types';
import { flatRows, type FlatRow } from '../listView';
import { VIEW_CHOICE_BLASTOISE_FACE } from '../agents/iconSets';
import type { AgentFace } from '../agents/faceChoices';
import type { PictureWorld } from '../pictureWorld';
import type { ListIntroGroup } from './ListLookIntro';

const PROJECTS = {
  harbor: { id: 'vc-demo-harbor', name: 'harbor-ops' },
  atlas: { id: 'vc-demo-atlas', name: 'atlas-web' },
  ledger: { id: 'vc-demo-ledger', name: 'ledger-api' },
} as const;
type Project = (typeof PROJECTS)[keyof typeof PROJECTS];

const OPS = 'vc-demo-ops';
const REVIEW = 'vc-demo-review';
const TIDE = 'vc-demo-tide';
const SEARCH = 'vc-demo-search';
const DOCS = 'vc-demo-docs';

const SECTION_IDS: InboxListGroupId[] = ['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet', 'snoozed'];
const labelOf = (id: InboxListGroupId) => INBOX_SECTIONS.find((section) => section.id === id)?.label ?? 'Snoozed';

export interface ViewChoiceDemo {
  world: PictureWorld;
  /** The Agents picture's list (the Agents view draws it under the world's agents). */
  sections: readonly InboxListSection[];
  /** The Smart groups picture (Quiet folded: its band only). */
  groups: readonly ListIntroGroup[];
  /** The Simple list picture, newest first. */
  flat: readonly FlatRow[];
  /** The two agents the Agents picture folds and opens in turn (viewChoiceFolds.ts); never Ops, which waits on the person. */
  folding: readonly [string, string];
}

/** The demo as of `now` (ms). */
export function viewChoiceDemo(now: number = Date.now()): ViewChoiceDemo {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const row = (id: string, subject: string, minutes: number, section: InboxListRow['section'], session: string, project: Project, extra: Record<string, unknown> = {}): InboxListRow => {
    const at = ago(minutes);
    return {
      thread_id: `vc-demo-${id}`,
      project_id: project.id,
      project,
      subject,
      thread_name: null,
      latest_preview: null,
      author: { kind: 'agent', host: 'claude-code', session, name: null },
      created_at: at,
      last_at: at,
      last_agent_at: at,
      last_author: 'agent',
      message_count: 2,
      section,
      unread: false,
      unseen: 0,
      answered_not_sent: false,
      waiting_since: null,
      waiting_on_person: false,
      questions: { open: 0, picked: 0, stopped: false, holds_up: [] },
      sent: null,
      resolved_at: null,
      ...extra,
    } as unknown as InboxListRow;
  };
  const codex = { author: { kind: 'agent', host: 'codex', session: REVIEW, name: null } };
  const rows: Partial<Record<InboxListGroupId, InboxListRow[]>> = {
    waiting: [row('t1', 'Pick a cache key for the price table', 6, 'waiting', OPS, PROJECTS.harbor, { unread: true, waiting_on_person: true, waiting_since: ago(6), questions: { open: 1, picked: 0, stopped: false, holds_up: [] } })],
    new: [
      row('t3', 'Review of the sign-in change', 21, 'new', REVIEW, PROJECTS.atlas, { unread: true, ...codex }),
      row('t6', 'Two findings in the export code', 33, 'new', REVIEW, PROJECTS.atlas, { unread: true, ...codex }),
      // Something new for the person: Tide starts open in the Agents view (agentsView/model.ts), its two threads under it.
      row('t7', 'Flaky sign-in test found', 40, 'new', TIDE, PROJECTS.ledger, { unread: true }),
    ],
    quiet: [
      row('t2', 'Search index rebuilt in 41 seconds', 44, 'quiet', SEARCH, PROJECTS.ledger),
      row('t9', 'Weekly dependency bumps', 70, 'quiet', TIDE, PROJECTS.ledger),
      row('t11', 'Nightly backup check passed', 96, 'quiet', SEARCH, PROJECTS.ledger),
      row('t8', 'Invoice rounding report', 185, 'quiet', SEARCH, PROJECTS.ledger),
    ],
  };
  const sections = SECTION_IDS.map((id) => ({ id, label: labelOf(id), threads: rows[id] ?? [] })) as unknown as InboxListSection[];
  const groups = sections.flatMap((section) => (section.id !== 'snoozed' && section.threads.length > 0 ? [{ id: section.id, label: section.label, count: section.threads.length, rows: section.threads }] : [])) as ListIntroGroup[];
  const agent = (id: string, label: string, state: InboxAgent['state'], project: Project, host = 'claude-code'): InboxAgent =>
    ({ id, session: id, host, label, project, state, waiting: state === 'waiting' ? 1 : 0, live: true, started_at: null, last_seen_at: ago(1) }) as unknown as InboxAgent;
  const agents: InboxAgentsGroup[] = [
    {
      agents: [
        agent(OPS, 'Ops', 'waiting', PROJECTS.harbor),
        agent(REVIEW, 'Review', 'working', PROJECTS.atlas, 'codex'),
        agent(TIDE, 'Tide', 'idle', PROJECTS.ledger),
        agent(SEARCH, 'Search index', 'idle', PROJECTS.ledger),
        // Live on atlas-web with no thread: never drawn (the Agents view lists agents by their threads), but atlas-web
        // then has two live agents, so its rows name theirs, "Review", as the approved picture does (severalSessions.ts).
        agent(DOCS, 'Docs pass', 'idle', PROJECTS.atlas),
      ],
      total: 5,
      ended_today: 0,
    },
  ];
  // Ops and Review wear their own marks; Tide and Search index the faces the picture was designed with.
  const faces = new Map<string, AgentFace>([
    [TIDE, VIEW_CHOICE_BLASTOISE_FACE],
    [SEARCH, 'glass-pink'],
  ]);
  return { world: { agents, faces }, sections, groups, flat: flatRows(sections, null, { epoch: 0, keep: null }).rows, folding: [REVIEW, TIDE] };
}
