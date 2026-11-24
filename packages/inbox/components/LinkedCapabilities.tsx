/**
 * Settings → Capabilities on a linked computer (docs/agent-guides/inbox-machines.md, "Capabilities on a linked
 * computer"): under this computer's switches, one group per linked computer whose list takes them (mark
 * `capabilities`), headed by its name, with the same switches by the same names, read and turned there through this
 * Inbox's forward (`/api/inbox/m/<machine>/capabilities`). System and Chapter diagrams follow this computer's rule:
 * Chapter diagrams only while Code review is on there, System only while it is on there. A computer that is away shows
 * what it last said in this window; a switch turned while it is away waits in the outbox, and the line under its
 * switches says so (the waiting toast's words). An older Plannotator there has no group.
 */
import { useEffect, useState } from 'react';
import { INBOX_CAPABILITY_SWITCHES, inboxCapabilitySwitchesOf, type InboxCapabilitySwitches, type InboxCapabilitySwitchKey } from '@plannotator/core/inbox-types';
import { apiGet, apiPost, type MachineView } from '../api';
import { inboxUrl } from '../inboxUrl';
import { errorText } from '../toastError';
import { readScheduled } from '../scheduled/store';
import { Switch } from './SoundRow';

/** The mark a linked computer's list carries when its switches can be read and turned from here. */
export const CAPABILITIES_MARK = 'capabilities';

/** Each linked computer's switches as it last said them, for as long as this window is open. */
const kept = new Map<string, InboxCapabilitySwitches>();

/** Tests: forget every computer's switches. */
export function resetLinkedCapabilitiesForTests(): void {
  kept.clear();
}

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
  const [switches, setSwitches] = useState<InboxCapabilitySwitches | null>(() => kept.get(machine.id) ?? null);
  const [line, setLine] = useState<string | null>(null);
  const online = machine.state === 'online';
  useEffect(() => {
    if (!online) return;
    let live = true;
    apiGet<{ capabilities?: unknown }>(inboxUrl('/capabilities', undefined, machine.id)).then(
      (answer) => {
        const read = inboxCapabilitySwitchesOf(answer.capabilities);
        kept.set(machine.id, read);
        if (live) setSwitches(read);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [machine.id, online]);
  if (!switches) return null;
  const rows = linkedSwitchRows(switches);
  if (rows.length === 0) return null;
  const turn = (key: InboxCapabilitySwitchKey, on: boolean) => {
    setLine(null);
    apiPost<Record<string, unknown>>(inboxUrl('/capabilities', undefined, machine.id), { [key]: { on } }).then(
      (answer) => {
        const next = { ...switches, ...inboxCapabilitySwitchesOf(answer), [key]: { on } };
        kept.set(machine.id, next);
        setSwitches(next);
        // Its routines join the Routines page, or leave it, at once.
        if (key === 'scheduled_threads') void readScheduled();
      },
      // Held for a computer that is away: it applies when that computer is back, as the line says.
      (cause: unknown) => setLine(errorText(cause, `${machine.name} did not change.`)),
    );
  };
  const heading = `ib-linked-cap-${machine.id}`;
  return (
    <section className="ib-sgroup" aria-labelledby={heading} data-settings-linked-capabilities={machine.id}>
      <h2 id={heading}>{machine.name}</h2>
      <p>Each switch turns the feature on or off on {machine.name}.</p>
      <div className="ib-card">
        {rows.map((row) => (
          <div key={row.key} className="ib-prow" data-settings-linked-switch={row.key}>
            <span className="ib-txt">
              <span className="ib-l" id={`${heading}-${row.key}`}>
                {row.name}
              </span>
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
