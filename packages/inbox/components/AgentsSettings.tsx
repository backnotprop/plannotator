import { useId, useState, type ReactNode } from 'react';
import { INBOX_AGENT_LABELS, type InboxAgentId, type InboxAgentRow, type InboxAgentsModel } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { HARNESSES, type ConnectContext } from '../harnesses';
import { HostMark, Icon } from '../icons';
import { ConnectPicker } from './ConnectPicker';

type Change = { reach?: boolean; tool?: boolean; reminder?: boolean; note?: boolean };

function Switch({ on, label, disabled, busy, onClick }: { on: boolean; label: string; disabled?: boolean; busy?: boolean; onClick: () => void }) {
  // While a change to this agent is saving, a second click is ignored (aria-busy), never queued.
  return (
    <button
      type="button"
      role="switch"
      className="ib-sw"
      aria-checked={on}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={() => !busy && onClick()}
    />
  );
}

/** How an agent reaches the Inbox, beside its name. */
function viaOf(row: InboxAgentRow): string {
  if (row.reach.kind === 'tool') return row.id === 'pi' ? "Plannotator's extension" : "Plannotator's plugin";
  if (row.reach.kind === 'mcp') return 'MCP server';
  return 'connected by hand';
}

function stateOf(row: InboxAgentRow): { text: string; tone: 'on' | 'off' | 'bad' } {
  switch (row.reach.state) {
    case 'connected':
      return { text: 'Connected', tone: 'on' };
    case 'removed':
      return { text: 'Removed outside Plannotator', tone: 'bad' };
    case 'foreign':
      return { text: 'Has its own entry', tone: 'bad' };
    case 'unreadable':
      return { text: "Can't read its config", tone: 'bad' };
    case 'manual':
      return { text: 'Connect by hand', tone: 'off' };
    case 'not_connected':
      return { text: 'Not connected', tone: 'off' };
    default:
      return { text: 'Off', tone: 'off' };
  }
}

/** Agents whose instructions live in their own settings, not a file. */
const NO_NOTE_FILE: Partial<Record<InboxAgentId, string>> = {
  cursor: 'Cursor keeps its rules in its own settings, so there is no file to add a note to.',
  kiro: 'Kiro CLI has no global instructions file, so there is no file to add a note to.',
};

function Row({ k, v, r, sub, warn, na }: { k: string; v: ReactNode; r?: ReactNode; sub?: ReactNode; warn?: boolean; na?: boolean }) {
  return (
    <div className={`ib-agrow${na ? ' ib-agna' : ''}`}>
      <span className="ib-agk">{k}</span>
      <span className="ib-agv">{v}</span>
      <span className="ib-agr">{r}</span>
      {sub && (
        <span className={`ib-agsub${warn ? ' ib-agwarn' : ''}`}>
          <Icon name={warn ? 'warn' : 'info'} />
          <span>{sub}</span>
        </span>
      )}
    </div>
  );
}

function AgentGroup({
  row,
  noteText,
  onChange,
  pending,
  busy,
}: {
  row: InboxAgentRow;
  noteText: string;
  onChange: (change: Change) => void;
  pending: Set<string>;
  busy: boolean;
}) {
  const [show, setShow] = useState(false);
  const id = useId();
  const state = row.detected ? stateOf(row) : { text: 'Not found on this computer', tone: 'off' as const };
  const next = `${row.label}'s next session`;
  const reach = row.reach;
  const reachValue =
    reach.kind === 'tool' ? (
      <>
        the <code>plannotator_inbox</code> tool
      </>
    ) : reach.kind === 'mcp' ? (
      reach.state === 'removed' ? (
        <>
          <code>plannotator-inbox</code> is no longer in <code>{reach.path}</code>. Plannotator won't add it back on its own; turn this on to add it.
        </>
      ) : reach.state === 'foreign' ? (
        <>
          <code>{reach.path}</code> has its own <code>plannotator-inbox</code> entry, so Plannotator leaves it alone.
        </>
      ) : reach.state === 'unreadable' ? (
        <>
          <code>{reach.path}</code> can't be read ({reach.reason}), so Plannotator leaves it alone.
        </>
      ) : (
        <>
          <code>plannotator-inbox</code>
          {reach.path ? (
            <>
              {' '}
              in <code>{reach.path}</code>
            </>
          ) : null}
        </>
      )
    ) : (
      'Add it by hand: "Not found on this computer" below has its command.'
    );
  const reachSwitchable = (reach.kind === 'tool' || reach.kind === 'mcp') && reach.state !== 'foreign' && reach.state !== 'unreadable';
  const note = row.note;
  const noteOn = note?.state === 'added' || note?.state === 'edited';
  const noteState = note
    ? note.state === 'added' || note.state === 'edited'
      ? note.created
        ? 'created by Plannotator'
        : 'marked section'
      : note.state === 'absent'
        ? note.create
          ? 'would create'
          : 'no note yet'
        : note.state === 'unavailable'
          ? 'no file yet'
          : ''
    : '';
  const noteSub =
    noteOn && note?.reason
      ? note.reason
      : note?.state === 'edited'
      ? "You edited this note, so Plannotator won't update it. Turning it off removes it as you left it."
      : note?.state === 'unavailable' || note?.state === 'damaged' || note?.state === 'refused'
        ? note.reason
        : note?.shared_with && note.shared_with.length > 0
          ? `This file is shared with ${note.shared_with.map((id) => INBOX_AGENT_LABELS[id]).join(' and ')}: one section, kept while either has it on.`
          : note?.target
            ? `This file is a link to ${note.target}; the note goes there.`
            : null;

  return (
    <div className="ib-agent" data-agent={row.id}>
      <div className="ib-aghead">
        <HostMark host={row.id} big />
        <b>{row.label}</b>
        <span className="ib-agvia">{viaOf(row)}</span>
        <span className={`ib-agstate${state.tone === 'off' ? ' ib-agoff' : state.tone === 'bad' ? ' ib-agbad' : ''}`}>
          <span className="ib-agdot" />
          {state.text}
        </span>
      </div>
      <Row
        k="Reaches the Inbox"
        v={reachValue}
        r={
          reachSwitchable ? (
            <>
              {pending.has(`${row.id}:reach`) && <span className="ib-agpending">{next}</span>}
              <Switch on={reach.on} label={`Reaches the Inbox: ${row.label}`} disabled={reach.locked} busy={busy} onClick={() => onChange({ reach: !reach.on })} />
            </>
          ) : null
        }
      />
      {row.tool && reach.kind !== 'tool' && (
        <Row
          k="The Inbox tool"
          v={
            <>
              the <code>plannotator_inbox</code> tool, with Plannotator&apos;s {row.id === 'pi' ? 'extension' : 'plugin'}
            </>
          }
          r={
            <>
              {pending.has(`${row.id}:tool`) && <span className="ib-agpending">{next}</span>}
              <Switch on={row.tool.on} label={`The Inbox tool: ${row.label}`} disabled={row.tool.locked} busy={busy} onClick={() => onChange({ tool: !row.tool!.on })} />
            </>
          }
        />
      )}
      {row.reminder && (
        <Row
          k="Reminder at session start"
          v={row.reminder.needs_tool ? 'Needs the tool' : 'one line when a session starts'}
          r={
            <>
              {pending.has(`${row.id}:reminder`) && <span className="ib-agpending">{next}</span>}
              <Switch
                on={row.reminder.on}
                label={`Reminder at session start: ${row.label}`}
                disabled={row.reminder.locked || row.reminder.needs_tool}
                busy={busy}
                onClick={() => onChange({ reminder: !row.reminder!.on })}
              />
            </>
          }
        />
      )}
      {note ? (
        <>
          <Row
            k="Note in its instructions"
            v={
              <>
                <code>{note.path}</code>
                {noteState && <> · {noteState}</>}
                <button type="button" className="ib-lnk" aria-expanded={show} aria-controls={`${id}-note`} onClick={() => setShow((open) => !open)}>
                  {show ? 'Hide' : 'Show'}
                </button>
              </>
            }
            r={
              note.state === 'absent' || note.state === 'added' || note.state === 'edited' ? (
                <>
                  {pending.has(`${row.id}:note`) && <span className="ib-agpending">{next}</span>}
                  <Switch on={noteOn} label={`Note in its instructions: ${row.label}`} busy={busy} onClick={() => onChange({ note: !noteOn })} />
                </>
              ) : null
            }
            sub={noteSub}
            warn={(note.state === 'unavailable' || note.state === 'damaged' || note.state === 'refused') && noteSub !== null}
          />
          {show && (
            <div className="ib-agrow ib-agnote" id={`${id}-note`}>
              <span />
              <div className="ib-cbox">
                <pre>{noteText}</pre>
              </div>
            </div>
          )}
        </>
      ) : NO_NOTE_FILE[row.id] ? (
        <Row k="Note in its instructions" v={NO_NOTE_FILE[row.id]} na />
      ) : null}
    </div>
  );
}

/**
 * Settings → Agents (the approved "inbox-agent-awareness" design, 08-09):
 * one group per agent found on this computer with up to three switches,
 * Reaches the Inbox, Reminder at session start (Claude Code, Pi, OpenCode)
 * and Note in its instructions; the agents not found folded behind the
 * harness picker. Every change applies to that agent's next session.
 */
export function AgentsSettings({ model, onModel, context }: { model: InboxAgentsModel; onModel: (next: InboxAgentsModel) => void; context: ConnectContext | null }) {
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  // The three Plannotator hosts stay listed (their Inbox tool switch) even when not found on this computer.
  const shown = model.agents.filter((row) => row.detected || row.tool);
  const detected = model.agents.filter((row) => row.detected);
  const undetected = model.agents.filter((row) => !row.detected && !row.tool);

  const change = async (agent: InboxAgentId, input: Change) => {
    if (busy.has(agent)) return;
    setError(null);
    setBusy((current) => new Set([...current, agent]));
    try {
      const next = await inboxApi.saveAgent(agent, input);
      onModel(next);
      if (next.error) setError(next.error);
      else setPending((current) => new Set([...current, ...Object.keys(input).map((key) => `${agent}:${key}`)]));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(agent);
        return next;
      });
    }
  };

  return (
    <div data-settings-agents="">
      {model.tool_env !== null && (
        <div className="ib-callout" role="note" data-tool-locked="">
          <Icon name="lock" />
          <span>
            <code>PLANNOTATOR_INBOX_TOOL={model.tool_env ? '1' : '0'}</code> is set in this Inbox's environment, so the Inbox tool stays{' '}
            {model.tool_env ? 'on' : 'off'} in Claude Code, Pi and OpenCode, and so does their reminder. Notes and MCP servers are not affected.
          </span>
        </div>
      )}
      {model.connect_env_off && (
        <div className="ib-callout" role="note">
          <Icon name="info" />
          <span>
            <code>PLANNOTATOR_INBOX_CONNECT=0</code> is set, so <code>plannotator inbox</code> doesn't connect agents by itself. The switches below still work.
          </span>
        </div>
      )}
      {model.notes_env_off && (
        <div className="ib-callout" role="note">
          <Icon name="info" />
          <span>
            <code>PLANNOTATOR_INBOX_NOTES=0</code> is set, so Plannotator offers no notes and adds none. A note already written is listed below, where you can turn it off.
          </span>
        </div>
      )}
      {error && (
        <p className="ib-error" role="alert">
          {error}
        </p>
      )}
      <div className="ib-agents">
        {shown.map((row) => (
          <AgentGroup key={row.id} row={row} noteText={model.note_text} pending={pending} busy={busy.has(row.id)} onChange={(input) => void change(row.id, input)} />
        ))}
        {detected.length === 0 && (
          <div className="ib-agrow ib-agna">
            <span className="ib-agk">No agent found on this computer</span>
          </div>
        )}
        <button type="button" className="ib-amore" aria-expanded={more} aria-controls="ib-aundet" onClick={() => setMore((open) => !open)}>
          <Icon name="chevR" />
          Not found on this computer
          <span className="ib-mut">
            {undetected.length} agent{undetected.length === 1 ? '' : 's'} · connect one by hand
          </span>
        </button>
        {more && context && (
          <div className="ib-aundet" id="ib-aundet">
            <ConnectPicker harnesses={HARNESSES} initial="vscode" context={context} icons />
          </div>
        )}
      </div>
      <p className="ib-note">
        <Icon name="info" />
        <span>
          Plannotator never overwrites a note you edited, and <code>plannotator uninstall</code> removes everything it added here.
        </span>
      </p>
    </div>
  );
}
