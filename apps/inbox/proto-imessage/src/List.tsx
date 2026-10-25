/**
 * The conversation list, Messages-style. What waits on the person is pinned
 * at the top as large avatars with the question in a bubble over them (Messages'
 * pinned conversations); everything else is one list by recency, each row an
 * avatar, a bold name, a two-line preview and the time.
 */
import { useMemo, useState } from 'react';
import { Badge } from '@halftone/design-system/primitives/badge';
import { Button } from '@halftone/design-system/primitives/button/button';
import { Input } from '@halftone/design-system/primitives/input/input';
import { Menu } from '@halftone/design-system/primitives/menu';
import { Text } from '@halftone/design-system/typography/text';
import { Caption } from '@halftone/design-system/typography/caption';
import { shortTime } from '@inbox/format';
import { inboxAgentName, inboxRowWaitsOnPerson, type InboxThread } from '@plannotator/core/inbox-types';
import type { ListModel } from '@inbox/api';
import { AgentAvatar, Glyph } from './marks';
import { previewOf, type Row } from './data';

export type Filter = 'all' | 'waiting' | 'new' | 'sent' | 'quiet';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All conversations' },
  { id: 'waiting', label: 'Waiting on you' },
  { id: 'new', label: 'Unread' },
  { id: 'sent', label: 'Sent' },
  { id: 'quiet', label: 'Quiet' },
];

/** Waits on the person in the way that earns a pin: a question open, or answered and not sent. */
export function pinned(row: Row): boolean {
  return row.section === 'stopped' || row.section === 'holding' || row.section === 'waiting' || row.answered_not_sent;
}

function ring(row: Row): 'stopped' | 'holding' | 'waiting' | null {
  if (row.section === 'stopped') return 'stopped';
  if (row.section === 'holding') return 'holding';
  if (row.section === 'waiting' || row.answered_not_sent) return 'waiting';
  return null;
}

function rowAuthor(row: Row, thread: InboxThread | undefined) {
  const agent = thread?.messages.find((m) => m.author.kind === 'agent')?.author;
  if (agent) return agent;
  if (row.addressee) return { kind: 'agent' as const, host: row.addressee.host, session: row.addressee.session, name: null };
  return row.author;
}

function StatusBadge({ row, selected }: { row: Row; selected: boolean }) {
  if (selected) return null;
  if (row.section === 'stopped') return <Badge size="sm" variant="danger">Stopped</Badge>;
  if (row.section === 'holding') return <Badge size="sm" variant="warning">Holds up {row.questions.holds_up.length}</Badge>;
  if (row.answered_not_sent || row.unsent) return <Badge size="sm" variant="brand">Draft</Badge>;
  if (row.section === 'waiting') return <Badge size="sm" variant="default">{row.questions.open === 1 ? 'Question' : `${row.questions.open} questions`}</Badge>;
  return null;
}

function previewLine(row: Row, thread: InboxThread | undefined): string {
  const preview = thread ? previewOf(thread) : null;
  if (row.ack && row.section === 'quiet') return `You reacted 👍 ${row.ack.label}`;
  if (!preview) return row.questions.prompt ?? '';
  const who = preview.who === 'person' ? 'You' : inboxAgentName(rowAuthor(row, thread));
  const extra = preview.pictures > 0 ? ` · ${preview.pictures === 1 ? '1 picture' : `${preview.pictures} pictures`}` : preview.files > 0 ? ` · ${preview.files === 1 ? '1 file' : `${preview.files} files`}` : '';
  return `${who}: ${preview.text || 'Attachment'}${extra}`;
}

function ConversationRow({ row, thread, selected, onOpen, phone }: { row: Row; thread: InboxThread | undefined; selected: boolean; onOpen: () => void; phone: boolean }) {
  const unread = row.unread && !selected;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      data-row={row.thread_id}
      className={`group relative flex w-full items-start gap-2.5 rounded-xl py-2.5 ps-5 pe-3 text-start transition-colors ${selected ? 'bg-brand-solid text-on-brand-solid-foreground' : 'hover:bg-transparent-hover'} ${phone ? 'py-3' : ''}`}
    >
      {unread && <span className="absolute top-1/2 left-1.5 size-2.5 -translate-y-1/2 rounded-full bg-brand-solid" aria-label="Unread" />}
      <AgentAvatar author={rowAuthor(row, thread)} size="2xl" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <Text size="sm" weight={unread ? 'semibold' : 'medium'} truncate className={`flex-1 ${selected ? 'text-on-brand-solid-foreground' : ''}`}>
            {row.subject ?? 'Untitled'}
          </Text>
          <Caption size="lg" className={`shrink-0 ${selected ? 'text-on-brand-solid-foreground/85' : 'text-tertiary-foreground'}`}>
            {shortTime(row.last_at)}
          </Caption>
        </span>
        <span className={`mt-0.5 line-clamp-2 text-body-sm ${selected ? 'text-on-brand-solid-foreground/90' : unread ? 'text-primary-foreground' : 'text-secondary-foreground'}`}>{previewLine(row, thread)}</span>
        <span className="mt-1 flex items-center gap-1.5">
          <StatusBadge row={row} selected={selected} />
          <Caption size="sm" className={`truncate ${selected ? 'text-on-brand-solid-foreground/80' : 'text-tertiary-foreground'}`}>
            {row.project.name}
            {row.thread_name ? ` · ${row.thread_name}` : ''}
          </Caption>
        </span>
      </span>
    </button>
  );
}

function PinnedTile({ row, thread, selected, onOpen }: { row: Row; thread: InboxThread | undefined; selected: boolean; onOpen: () => void }) {
  const kind = ring(row);
  const prompt = row.questions.prompt ?? row.subject ?? '';
  return (
    <button type="button" onClick={onOpen} data-pinned={row.thread_id} className={`flex min-w-0 flex-col items-center gap-1 rounded-2xl px-1 pt-1 pb-2 ${selected ? 'bg-brand-subtle' : 'hover:bg-transparent-hover'}`} aria-label={`${row.subject}: ${kind === 'stopped' ? 'stopped on you' : kind === 'holding' ? 'holding up work' : 'waiting on you'}`}>
      <span className="relative mt-9">
        {/* The question, in a small bubble over the avatar (Messages' pinned preview). */}
        <span className="absolute -top-9 left-1/2 z-10 w-[6.5rem] -translate-x-1/2 rounded-xl bg-container px-1.5 py-1 text-center shadow-default">
          <span className="line-clamp-2 text-caption-sm leading-[1.25] text-secondary-foreground">{prompt}</span>
        </span>
        <AgentAvatar author={rowAuthor(row, thread)} size="3xl" ring={kind} />
        {kind === 'stopped' && <span className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full border-2 border-shell bg-danger-solid text-[11px] font-bold text-on-danger-solid-foreground">!</span>}
        {kind !== 'stopped' && row.questions.open > 0 && (
          <span className="absolute -right-1 -bottom-1 flex min-w-5 items-center justify-center rounded-full border-2 border-shell bg-brand-solid px-1 text-[11px] font-semibold text-on-brand-solid-foreground">{row.questions.open}</span>
        )}
      </span>
      <Text size="sm" weight="medium" truncate className="w-full text-center">
        {row.subject}
      </Text>
    </button>
  );
}

export function ConversationList({
  list,
  threads,
  selectedId,
  onOpen,
  phone,
  mode,
  onMode,
}: {
  list: ListModel | null;
  threads: Record<string, InboxThread>;
  selectedId: string | null;
  onOpen: (id: string) => void;
  phone: boolean;
  mode: 'light' | 'dark' | 'system';
  onMode: (m: 'light' | 'dark' | 'system') => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [project, setProject] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const rows = useMemo(() => (list ? list.sections.flatMap((s) => s.threads) : []), [list]);
  const q = query.trim().toLowerCase();
  const matches = (row: Row) =>
    (!project || row.project.id === project) &&
    (!q || `${row.subject ?? ''} ${row.project.name} ${row.thread_name ?? ''} ${previewLine(row, threads[row.thread_id])}`.toLowerCase().includes(q));
  const visible = rows.filter(matches);
  const pins = filter === 'all' && !q ? visible.filter(pinned) : [];
  const rest = visible
    .filter((row) => !pins.includes(row))
    .filter((row) => {
      if (filter === 'waiting') return inboxRowWaitsOnPerson(row);
      if (filter === 'new') return row.unread;
      if (filter === 'sent') return row.section === 'sent';
      if (filter === 'quiet') return row.section === 'quiet';
      return true;
    })
    .sort((a, b) => b.last_at.localeCompare(a.last_at));
  const needs = rows.filter(pinned).length;
  const unread = rows.filter((r) => !pinned(r) && r.unread).length;

  return (
    <nav className="flex h-full min-h-0 flex-col" aria-label="Conversations">
      <div className={`flex items-center gap-2 px-3 ${phone ? 'pt-3' : 'pt-2.5'}`}>
        {phone ? (
          <Text size="lg" weight="semibold" className="flex-1 text-heading-3">
            Inbox
          </Text>
        ) : (
          <Caption color="secondary" size="lg" weight="medium" className="flex-1 ps-2">
            {needs > 0 || unread > 0
              ? [needs > 0 ? `${needs} need you` : '', unread > 0 ? `${unread} unread` : ''].filter(Boolean).join(' · ')
              : 'Nothing waits on you'}
          </Caption>
        )}
        <Menu>
          <Menu.Trigger render={<Button variant="transparent" shape="pill" icon="only" size="md" aria-label="Filter and appearance"><Glyph name="stack" size={17} /></Button>} />
          <Menu.Content align="end" className="min-w-56">
            <Menu.Group title="Show">
              {FILTERS.map((f) => (
                <Menu.Item key={f.id} onClick={() => setFilter(f.id)}>
                  <span className="flex w-4 justify-center">{filter === f.id && <Glyph name="check" size={14} />}</span>
                  {f.label}
                </Menu.Item>
              ))}
            </Menu.Group>
            <Menu.Separator />
            <Menu.Group title="Project">
              <Menu.Item onClick={() => setProject(null)}>
                <span className="flex w-4 justify-center">{project === null && <Glyph name="check" size={14} />}</span>
                Every project
              </Menu.Item>
              {(list?.projects ?? []).map((p) => (
                <Menu.Item key={p.id} onClick={() => setProject(p.id)}>
                  <span className="flex w-4 justify-center">{project === p.id && <Glyph name="check" size={14} />}</span>
                  {p.name}
                </Menu.Item>
              ))}
            </Menu.Group>
            <Menu.Separator />
            <Menu.Group title="Appearance">
              {(['light', 'dark', 'system'] as const).map((m) => (
                <Menu.Item key={m} onClick={() => onMode(m)}>
                  <span className="flex w-4 justify-center">{mode === m && <Glyph name="check" size={14} />}</span>
                  {m === 'system' ? 'Match system' : m === 'light' ? 'Light' : 'Dark'}
                </Menu.Item>
              ))}
            </Menu.Group>
          </Menu.Content>
        </Menu>
      </div>
      <div className="px-3 pt-2 pb-2">
        <Input size="md" icon={<Glyph name="search" size={15} />} placeholder="Search" aria-label="Search conversations" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {pins.length > 0 && (
          <section aria-label="Waiting on you" className="mb-1 grid grid-cols-3 gap-x-1 gap-y-1 px-1 pb-2">
            {pins.map((row) => (
              <PinnedTile key={row.thread_id} row={row} thread={threads[row.thread_id]} selected={row.thread_id === selectedId} onOpen={() => onOpen(row.thread_id)} />
            ))}
          </section>
        )}
        {filter !== 'all' && (
          <Caption color="tertiary" size="lg" className="px-3 pb-1">
            {FILTERS.find((f) => f.id === filter)?.label}
          </Caption>
        )}
        <div className="flex flex-col">
          {rest.map((row, i) => (
            <div key={row.thread_id} className={i > 0 && row.thread_id !== selectedId && rest[i - 1]?.thread_id !== selectedId ? 'border-t border-border-subtle ms-[4.25rem]' : ''}>
              <div className={i > 0 && row.thread_id !== selectedId && rest[i - 1]?.thread_id !== selectedId ? '-ms-[4.25rem]' : ''}>
                <ConversationRow row={row} thread={threads[row.thread_id]} selected={row.thread_id === selectedId} onOpen={() => onOpen(row.thread_id)} phone={phone} />
              </div>
            </div>
          ))}
          {rest.length === 0 && pins.length === 0 && (
            <Caption color="tertiary" size="lg" className="px-3 py-6 text-center">
              {q ? `No conversation matches “${query}”.` : 'No conversations here.'}
            </Caption>
          )}
        </div>
      </div>
    </nav>
  );
}
