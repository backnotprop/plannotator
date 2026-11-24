/**
 * Settings → Capabilities on a linked computer (docs/agent-guides/inbox-machines.md, "Capabilities on a linked
 * computer"): under this computer's switches, one group per linked computer whose list takes them (mark
 * `capabilities`), headed by its name, with the same switches by the same names, read and turned there through this
 * Inbox's forward (`/api/inbox/m/<machine>/capabilities`). System and Chapter diagrams follow this computer's rule:
 * Chapter diagrams only while Code review is on there, System only while it is on there. A computer that is away shows
 * what it last gave this Inbox (kept there, so a reload keeps the group), said to be away; a switch turned while it is
 * away waits in the outbox and is shown turned, with the waiting toast's words under its name, until that computer
 * takes or refuses it (the Inbox reads that from its outbox). An older Plannotator there has no group.
 */
import { useEffect, useState } from 'react';
import { INBOX_CAPABILITY_SWITCHES, inboxCapabilitySwitchesOf, type InboxCapabilitySwitches, type InboxCapabilitySwitchKey } from '@plannotator/core/inbox-types';
import { apiGet, apiPost, heldWords, InboxHeldError, type MachineView } from '../api';
import { inboxUrl } from '../inboxUrl';
import { errorText } from '../toastError';
import { readScheduled } from '../scheduled/store';
import { timeFrom } from '../scheduled/words';
import { Switch } from './SoundRow';

/** The mark a linked computer's list carries when its switches can be read and turned from here. */
export const CAPABILITIES_MARK = 'capabilities';

/**
 * The forward's answer (inbox-capabilities-machines.ts in the server): the switches read now, or the last it gave while
 * it is away (`away`, `read_at`), with the person's turns that wait for it on them (`held`). Absent fields: an older Inbox.
 */
interface FarSwitches {
  switches: InboxCapabilitySwitches;
  away: boolean;
  readAt: string | null;
  held: readonly string[];
}

const farSwitchesOf = (answer: { capabilities?: unknown; away?: unknown; read_at?: unknown; held?: unknown }): FarSwitches => ({
  switches: inboxCapabilitySwitchesOf(answer.capabilities),
  away: answer.away === true,
  readAt: typeof answer.read_at === 'string' ? answer.read_at : null,
  held: Array.isArray(answer.held) ? answer.held.filter((key): key is string => typeof key === 'string') : [],
});

/** The switches a computer's group shows, in Settings' order, by its own rules. */
export function linkedSwitchRows(switches: InboxCapabilitySwitches): { key: InboxCapabilitySwitchKey; name: string; on: boolean }[] {
  return INBOX_CAPABILITY_SWITCHES.flatMap(({ key, name }) => {
    const value = switches[key];
    if (!value) return [];
    if (key === 'chapter_diagrams' && switches.code_review?.on !== true) return [];
    if (key === 'system' && (value.on !== true || switches.code_review?.on !== true)) return [];
    return [{ key, name, on: value.on }];
  });
}

function MachineSwitches({ machine }: { machine: MachineView }) {
  const [far, setFar] = useState<FarSwitches | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  // Read each time its link changes state (and after a held turn): away, the Inbox answers what it last gave.
  useEffect(() => {
    let live = true;
    apiGet<{ capabilities?: unknown }>(inboxUrl('/capabilities', undefined, machine.id)).then(
      (answer) => live && setFar(farSwitchesOf(answer)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [machine.id, machine.state, reads]);
  if (!far) return null;
  const rows = linkedSwitchRows(far.switches);
  if (rows.length === 0) return null;
  const turn = (key: InboxCapabilitySwitchKey, on: boolean) => {
    setLine(null);
    apiPost<Record<string, unknown>>(inboxUrl('/capabilities', undefined, machine.id), { [key]: { on } }).then(
      (answer) => {
        setFar({ ...far, switches: { ...far.switches, ...inboxCapabilitySwitchesOf(answer), [key]: { on } }, held: far.held.filter((k) => k !== key) });
        // Its routines join the Routines page, or leave it, at once.
        if (key === 'scheduled_threads') void readScheduled();
      },
      (cause: unknown) => {
        // Held for a computer that is away: shown as turned, waiting (the read lays the held turn on its switches).
        if (cause instanceof InboxHeldError) setReads((n) => n + 1);
        else setLine(errorText(cause, `${machine.name} did not change.`));
      },
    );
  };
  const heading = `ib-linked-cap-${machine.id}`;
  const waiting = far.held.length > 0 ? heldWords(machine) : null;
  return (
    <section className="ib-sgroup" aria-labelledby={heading} data-settings-linked-capabilities={machine.id} data-away={far.away ? '' : undefined}>
      <h2 id={heading}>{machine.name}</h2>
      <p>
        Each switch turns the feature on or off on {machine.name}.
        {far.away && (
          <span data-settings-linked-away="">
            {' '}
            {far.readAt ? `${machine.name} has been away since ${timeFrom(far.readAt)}.` : `${machine.name} is away.`} These switches are as it last said.
          </span>
        )}
      </p>
      <div className="ib-card">
        {rows.map((row) => (
          <div key={row.key} className="ib-prow" data-settings-linked-switch={row.key} data-held={far.held.includes(row.key) ? '' : undefined}>
            <span className="ib-txt">
              <span className="ib-l" id={`${heading}-${row.key}`}>
                {row.name}
              </span>
              {/* Turned here, waiting for that computer: shown as turned until it takes or refuses it. */}
              {waiting && far.held.includes(row.key) && <span className="ib-desc">{waiting}</span>}
            </span>
            <span className="ib-ctl">
              <Switch on={row.on} labelledBy={`${heading}-${row.key}`} onClick={() => turn(row.key, !row.on)} />
            </span>
          </div>
        ))}
      </div>
      {line && (
        <p role="status" data-settings-linked-line="">
          {line}
        </p>
      )}
    </section>
  );
}

/** Every linked computer that takes the switches, in the machines' order. */
export function LinkedCapabilities({ machines }: { machines: readonly MachineView[] }) {
  const linked = machines.filter((m) => !m.self && m.marks?.includes(CAPABILITIES_MARK));
  if (linked.length === 0) return null;
  return (
    <>
      {linked.map((machine) => (
        <MachineSwitches key={machine.id} machine={machine} />
      ))}
    </>
  );
}
