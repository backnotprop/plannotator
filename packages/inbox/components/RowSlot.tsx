/** Same `.ib-p` element the project always used, so a name never changes a row's height. */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { rowSlot, type SlotNames } from '../rowSlot';
import { labelOf, useSessionLabels, type SessionLabels } from '../sessionLabels';
import { useSessionTitles } from '../sessionTitles';
import { projectKey, useRowSessions, type RowSessions } from '../severalSessions';
import { RowTip } from './RowTip';
import { scheduledOf } from '../scheduled/rowLook';

interface SlotSources {
  labels: SessionLabels;
  titles: SessionLabels;
  sessions: RowSessions;
}

/**
 * The names every row's slot reads, read once for a whole list (`ListRows`, rowParts.tsx). A list mounts every row
 * of its open groups (about 2,200 on a large Inbox): three store subscriptions in each row's slot were 12 closures
 * and three listeners per row, all for the same three values.
 */
const RowSlotSources = createContext<SlotSources | null>(null);

export function RowSlotNames({ children }: { children: ReactNode }) {
  const labels = useSessionLabels();
  const titles = useSessionTitles();
  const sessions = useRowSessions();
  const sources = useMemo(() => ({ labels, titles, sessions }), [labels, titles, sessions]);
  return <RowSlotSources.Provider value={sources}>{children}</RowSlotSources.Provider>;
}

type RowSlotProps = { row: InboxListRow; session: string | null; project: string; tip?: boolean };

export function RowSlot(props: RowSlotProps) {
  const sources = useContext(RowSlotSources);
  return sources ? drawRowSlot(props, sources) : <OwnRowSlot {...props} />;
}

/** A row drawn outside a list (a settings preview, an intro): it reads the names itself. */
function OwnRowSlot(props: RowSlotProps) {
  const labels = useSessionLabels();
  const titles = useSessionTitles();
  const sessions = useRowSessions();
  return drawRowSlot(props, { labels, titles, sessions });
}

function drawRowSlot({ row, session, project, tip = true }: RowSlotProps, { labels, titles, sessions }: SlotSources) {
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
  // A routine's row (scheduled/rowLook.tsx): its name is the sender, where the project sits.
  const scheduled = scheduledOf(row);
  if (scheduled) {
    const name = (
      <span className="ib-p" dir="auto" data-scheduled-sender="">
        {scheduled.name}
      </span>
    );
    return tip ? (
      <RowTip content={scheduled.name} cut>
        {name}
      </RowTip>
    ) : (
      name
    );
  }
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
