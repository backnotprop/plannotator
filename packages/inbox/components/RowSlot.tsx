/** Same `.ib-p` element the project always used, so a name never changes a row's height. */
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { rowSlot, type SlotNames } from '../rowSlot';
import { labelOf, useSessionLabels } from '../sessionLabels';
import { useSessionTitles } from '../sessionTitles';
import { projectKey, useRowSessions } from '../severalSessions';
import { RowTip } from './RowTip';

export function RowSlot({ row, session, project, tip = true }: { row: InboxListRow; session: string | null; project: string; tip?: boolean }) {
  const labels = useSessionLabels();
  const titles = useSessionTitles();
  const sessions = useRowSessions();
  const key = projectKey(row.machine, row.project.id);
  const agents = sessions.agents.get(key) ?? [];
  // A conversation that went on under a new id: its rows are named as it is now.
  const now = session ? (sessions.heirs.get(`${row.machine ?? ''}|${session}`) ?? session) : null;
  const namesOf = (id: string): SlotNames => ({
    label: labelOf(labels, id) ?? agents.find((agent) => agent.session === id)?.label ?? null,
    title: labelOf(titles, id),
  });
  const own = now ? namesOf(now) : {};
  const names = now && now !== session && !own.label && !own.title ? namesOf(session!) : own;
  const slot = rowSlot({ project, session: now, names, several: sessions.several.has(key), peers: agents.map((agent) => ({ session: agent.session, ...namesOf(agent.session) })) });
  const text = (
    <span className="ib-p" dir="auto" {...(slot.kind === 'name' ? { 'data-session-slot': '' } : {})}>
      {slot.text}
    </span>
  );
  if (!tip) return text;
  return slot.kind === 'name' ? (
    <RowTip content={slot.tip}>{text}</RowTip>
  ) : (
    <RowTip content={slot.text} cut>
      {text}
    </RowTip>
  );
}
