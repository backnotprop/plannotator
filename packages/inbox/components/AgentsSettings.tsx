import { useId, useState, type ReactNode } from 'react';
import {
  INBOX_AGENT_LABELS,
  inboxToolCostText,
  type InboxAgentId,
  type InboxAgentRow,
  type InboxAgentsModel,
  type InboxHostSessions,
  type InboxOpenSession,
  type InboxToolHostId,
} from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { CURSOR_RULES_PLACE, noteCopiedByHand, noteWithoutMarkers } from '../agents';
import { HARNESSES, type ConnectContext } from '../harnesses';
import { HostMark, Icon } from '../icons';
import { ConnectPicker } from './ConnectPicker';
import { CommandLine, CopyCommand, Fold, OpenCodeQuiet, OpenCodeWords, openCodeCommand, ReloadCopy, ReloadLead, type ReloadSpec } from './RestartNote';
import type { InboxReloadRuntime } from '@plannotator/core/inbox-types';
import { clockTime, dayWords, formatCount } from '../format';

/** Whether any host has an open session that needs a restart or an update: Settings' Agents dot. */
export function agentsNeedRestart(model: InboxAgentsModel | null | undefined): boolean {
  return Object.values(model?.sessions ?? {}).some((host) => (host?.outdated ?? 0) > 0);
}

/** "9:14 AM" today, "yesterday, 6:02 PM", "Oct 3, 6:02 PM". */
function sinceText(iso: string): string {
  const day = dayWords(iso);
  const time = clockTime(iso);
  return day === 'today' ? time : `${day}, ${time}`;
}

/** The head's state when sessions need something: "Connected · 2 need a reload". */
function sessionsState(id: InboxToolHostId, sessions: InboxHostSessions | undefined): string | null {
  if (!sessions || sessions.outdated === 0) return null;
  const n = sessions.outdated;
  if (id === 'pi') return n === 1 ? '1 needs a reload' : `${n} need a reload`;
  if (sessions.sessions.some((s) => s.outdated?.fix === 'update_plugin' || (id === 'opencode' && s.outdated?.fix === 'update_extension'))) return 'plugin needs an update';
  return n === 1 ? '1 needs a reload' : `${n} need a reload`;
}

/**
 * Settings → Agents' "Open sessions" row. For Claude Code sessions on an older
 * plugin (simplified 2026-10-21, owner: "simple buttons win"): one large line,
 * "Type /reload-plugins in each of these N Claude Code sessions." with Copy;
 * then the sessions as a short list; the manual path (/exit and a restart
 * command per session) folded behind "Still listed after reloading?".
 */
function OpenSessions({ id, sessions }: { id: InboxToolHostId; sessions: InboxHostSessions }) {
  const stale = sessions.sessions.filter((s) => s.outdated);
  const versions = [...new Set(stale.map((s) => s.plugin))];
  const what = id === 'pi' ? 'extension' : 'plugin';
  // OpenCode reports its plugin since "reload-hosts"; an older OpenCode connection says nothing.
  const reports = id !== 'opencode' || sessions.sessions.some((s) => s.plugin);
  const older =
    stale.length === 0
      ? reports
        ? ' · up to date'
        : ''
      : versions.length === 1 && versions[0]
        ? ` · ${stale.length} on ${what} ${versions[0]}`
        : ` · ${stale.length} on an older ${what}`;
  const runningOnly = id !== 'claude-code' && stale.length === 0 && sessions.sessions[0]?.plugin ? ` · ${what} ${sessions.sessions[0].plugin}` : '';
  // Pi, Oh My Pi and OpenCode 2 sessions whose connection says which command loads the new code.
  const reloadable = stale.filter((s) => s.outdated?.runtime && s.outdated.runtime !== 'claude-code');
  // Pi sessions on a connection older than the on-disk report: the update line, for them alone (beside any reloadable ones).
  const legacy = id === 'pi' ? stale.filter((s) => !s.outdated?.runtime) : [];
  let sub: ReactNode = null;
  if (legacy.length > 0) {
    const first = legacy[0]!;
    sub = (
      <>
        Run <code>pi update --extensions</code>, then <code>/reload</code> in {legacy.length === 1 ? 'that session' : `each of those ${legacy.length}`}
        {legacy.length === 1 ? ` (${first.project ?? 'Pi'}, since ${sinceText(first.started_at)})` : ''}.
      </>
    );
  }
  const reload = id === 'claude-code' && stale.length > 0;
  const updating = stale.some((s) => s.outdated?.fix === 'update_plugin');
  return (
    <div className="ib-agrow" data-agent-sessions={id}>
      <span className="ib-agk">Open sessions</span>
      <span className="ib-agv">
        {formatCount(sessions.running)} running
        {older}
        {runningOnly}
      </span>
      <span className="ib-agr" />
      {sub && (
        <span className="ib-agsub ib-agwarn">
          <Icon name="refresh" />
          <span>{sub}</span>
        </span>
      )}
      {reloadable.length > 0 && <HostReload sessions={reloadable} />}
      {reload && (
        <div className="ib-rl" data-reload-sessions="">
          <ReloadLead
            where={stale.length === 1 ? 'in this Claude Code session' : `in each of these ${stale.length} Claude Code sessions`}
            updateCommand={updating ? (sessions.update_command ?? null) : null}
          />
          <ul className="ib-rw-sess" aria-label="Claude Code sessions on the older plugin">
            {stale.map((s) => (
              <li key={s.session}>
                <SessionRow session={s} />
              </li>
            ))}
          </ul>
          <Fold question="Still listed after reloading?">
            <p className="ib-rl-manual" data-restart-fallback="">
              Type <code>/exit</code> in any session still listed, then run its restart command. <span className="ib-rw-warn">/exit stops a turn it is working on.</span>
            </p>
            <ul className="ib-rw-sess" aria-label="Restart commands">
              {stale.map((s) => (
                <li key={s.session}>
                  <SessionRow session={s} restart />
                </li>
              ))}
            </ul>
          </Fold>
        </div>
      )}
    </div>
  );
}

const RUNTIME_LABEL: Record<InboxReloadRuntime, string> = { 'claude-code': 'Claude Code', pi: 'Pi', 'oh-my-pi': 'Oh My Pi', opencode: 'OpenCode' };

/**
 * Pi, Oh My Pi and OpenCode 2 sessions on older code (owner approval
 * "reload-hosts"): per runtime and command, one large line with Copy
 * ("Type /reload in each of these 2 Pi sessions.", "Type /restart in this Oh
 * My Pi session.", "Run opencode2 reload."), the update first when the
 * package on disk is behind too (OpenCode 2: `opencode2 plugin update <its
 * spec>` alone, or the pin to change), then the sessions as a short list.
 * OpenCode's reload carries one quiet line on what it cancels; its server
 * restart is folded.
 */
function HostReload({ sessions }: { sessions: InboxOpenSession[] }) {
  const groups = new Map<string, InboxOpenSession[]>();
  for (const s of sessions) {
    const o = s.outdated!;
    const key = `${o.runtime}|${o.reload_command ?? ''}|${o.fix === 'update_extension' ? (o.update_command ?? '') : ''}|${o.pinned_spec ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return (
    <>
      {[...groups.entries()].map(([key, group]) => {
        const o = group[0]!.outdated!;
        const runtime = o.runtime!;
        const name = RUNTIME_LABEL[runtime];
        const reload: ReloadSpec = { command: o.reload_command ?? '/reload', where: o.reload_where ?? 'session' };
        const n = group.length;
        const where = n === 1 ? `in this ${name} session` : `in each of these ${n} ${name} sessions`;
        const what = "Plannotator's extension";
        // OpenCode 2: one short line with its command and Copy (an update reloads by itself), the pin first when there is one.
        const command =
          runtime === 'opencode'
            ? openCodeCommand({ fix: o.fix, updateCommand: o.update_command ?? null, reloadCommand: o.reload_command ?? 'opencode2 reload', pinnedSpec: o.pinned_spec ?? null })
            : null;
        return (
          <div className="ib-rl" data-reload-sessions={runtime} key={key}>
            {command ? (
              <>
                <p className="ib-rl-lead ib-rl-line" data-reload-lead={o.pinned_spec ? 'pin' : 'restart'} data-reload-command={command}>
                  <span>
                    <OpenCodeWords command={command} pinnedSpec={o.pinned_spec ?? null} pinTo={o.pin_to ?? null} />
                  </span>
                  {!o.pinned_spec && <ReloadCopy command={command} />}
                </p>
                <OpenCodeQuiet command={command} updatesAll={o.update_scope === 'all'} className="ib-rl-quiet" />
              </>
            ) : (
              <ReloadLead where={where} updateCommand={o.fix === 'update_extension' ? (o.update_command ?? null) : null} reload={reload} what={what} />
            )}
            <ul className="ib-rw-sess" aria-label={`${name} sessions on older code`}>
              {group.map((s) => (
                <li key={s.session}>
                  <SessionRow session={s} />
                </li>
              ))}
            </ul>
            {command === 'opencode2 reload' && o.fallback_command && (
              <Fold question="Still listed after reloading?">
                <div className="ib-rl-manual" data-restart-fallback="">
                  Restart OpenCode's background server:
                  <CommandLine text={o.fallback_command} label="Copy the command that restarts OpenCode's background server" />
                  <span className="ib-rw-warn">It stops any turn an OpenCode session is working on.</span>
                </div>
              </Fold>
            )}
          </div>
        );
      })}
    </>
  );
}

/** One session: its project, since when, idle or working. With `restart`, its Copy restart. */
function SessionRow({ session, restart }: { session: InboxOpenSession; restart?: boolean }) {
  const state = session.busy === true ? 'working' : session.busy === false ? 'idle' : null;
  const meta = [`since ${sinceText(session.started_at)}`, state].filter(Boolean).join(' · ');
  return (
    <div className="ib-rw-srow" {...(restart ? { 'data-session-restart': session.session } : { 'data-session-row': session.session })}>
      <span className="ib-rw-sw">
        <span className="ib-rw-sp" title={session.folder ?? undefined}>
          {session.project ?? 'A session'}
        </span>
        <span className="ib-rw-sm">{meta}</span>
      </span>
      {restart &&
        (session.restart_command ? (
          <CopyCommand text={session.restart_command} short="Copy restart" label={`Copy restart: the command that restarts the ${session.project ?? 'Claude Code'} session started ${sinceText(session.started_at)}`} />
        ) : (
          <span className="ib-rw-sm">
            run <code>claude --resume</code> in its folder
          </span>
        ))}
    </div>
  );
}

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
    case 'elsewhere':
      return { text: 'Connected in another folder', tone: 'off' };
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

/**
 * What happens to the person's reply, for an agent that reaches the Inbox:
 * Plannotator's own connection puts it into the session as a new turn; an
 * agent reached through MCP (or OpenCode 1, which has the tool but no wake)
 * reads it when it next checks. Null when the agent does not reach the Inbox,
 * or when it is not known (Claude Code on Windows).
 */
export function repliesOf(row: InboxAgentRow, platform?: ConnectContext['platform']): { text: string; wakes: boolean } | null {
  if (!row.reach.on) return null;
  if (row.reach.kind === 'tool') {
    if (row.tool?.mod_off) return null;
    // Claude Code's mod stands down on Windows (no /bin/sh), so nothing wakes it there: say no more than the Reaches row.
    if (row.id === 'claude-code' && platform === 'windows') return null;
    if (row.id === 'opencode' && row.plugin?.generation === '1') return { text: "seen when it checks the Inbox; OpenCode 1 can't be woken", wakes: false };
    return { text: 'arrive as a new turn', wakes: true };
  }
  // Codex: the Inbox wakes it itself (`codex queue`) when it found a Codex that can (the server's `wakes`).
  if (row.reach.kind === 'mcp' && row.wakes === true) return { text: 'arrive as a new turn', wakes: true };
  if (row.reach.kind === 'mcp') return { text: "seen when it checks the Inbox; it can't be woken", wakes: false };
  return null;
}

/** Agents whose instructions live in their own settings, not a file. */
const NO_NOTE_FILE: Partial<Record<InboxAgentId, string>> = {
  kiro: 'Kiro CLI has no global instructions file, so there is no file to add a note to.',
};

function Row({ k, v, r, sub, warn, na, data }: { k: string; v: ReactNode; r?: ReactNode; sub?: ReactNode; warn?: boolean; na?: boolean; data?: Record<`data-${string}`, string> }) {
  return (
    <div className={`ib-agrow${na ? ' ib-agna' : ''}`} {...data}>
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
  sessions,
  platform,
}: {
  row: InboxAgentRow;
  /** This computer's platform (the window's), for what wakes a session. */
  platform?: ConnectContext['platform'];
  noteText: string;
  onChange: (change: Change) => void;
  pending: Set<string>;
  busy: boolean;
  /** Its open sessions that poll the Inbox now (Claude Code, Pi, OpenCode). */
  sessions?: InboxHostSessions;
}) {
  const [show, setShow] = useState(false);
  const id = useId();
  const base = row.detected ? stateOf(row) : { text: 'Not found on this computer', tone: 'off' as const };
  const needs = row.id === 'claude-code' || row.id === 'pi' || row.id === 'opencode' ? sessionsState(row.id, sessions) : null;
  const state = needs ? { text: `${base.text} · ${needs}`, tone: 'bad' as const } : base;
  const next = `${row.label}'s next session`;
  const reach = row.reach;
  const reachValue =
    reach.kind === 'tool' ? (
      <>
        the <code>plannotator_inbox</code> tool
      </>
    ) : reach.kind === 'mcp' ? (
      reach.state === 'elsewhere' ? (
        <span data-reach-elsewhere="">
          Connected in <code>{reach.path}</code>. Turn on to move it here.
        </span>
      ) : reach.state === 'removed' ? (
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
  // Pi and OpenCode send the tool whole with every request (Claude Code defers it behind tool search): the measured cost.
  const cost = row.id === 'pi' || row.id === 'opencode' ? `Adds the tool to every ${row.label} request: ${inboxToolCostText(row.id)}.` : null;
  // Claude Code's mod off: its plugin gives no tool, so there is nothing to switch (the reason shows instead).
  const modOff = row.tool?.mod_off === true;
  // Claude Code's MCP entry is one the person added by hand (`claude mcp add`): Plannotator never writes or removes it.
  const handMcp = row.id === 'claude-code' && reach.kind === 'mcp';
  const replies = repliesOf(row, platform);
  const reachSwitchable = (reach.kind === 'tool' || reach.kind === 'mcp') && reach.state !== 'foreign' && reach.state !== 'unreadable' && !modOff && !handMcp;
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
        : note.state === 'manual'
          ? 'copy by hand'
          : note.state === 'unavailable'
          ? 'no file yet'
          : ''
    : '';
  const noteSub =
    noteOn && note?.reason
      ? note.reason
      : note?.state === 'edited'
      ? "You edited this note, so Plannotator won't update it. Turning it off removes it as you left it."
      : note?.state === 'manual' || note?.state === 'unavailable' || note?.state === 'damaged' || note?.state === 'refused'
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
        sub={modOff && reach.kind === 'tool' ? reach.reason : reach.kind === 'tool' ? cost : null}
        warn={modOff && reach.kind === 'tool'}
        r={
          reachSwitchable ? (
            <>
              {pending.has(`${row.id}:reach`) && <span className="ib-agpending">{next}</span>}
              <Switch on={reach.on} label={`Reaches the Inbox: ${row.label}`} disabled={reach.locked} busy={busy} onClick={() => onChange({ reach: !reach.on })} />
            </>
          ) : null
        }
      />
      {replies && <Row k="Your replies" v={replies.text} data={{ 'data-agent-replies': replies.wakes ? 'wake' : 'check' }} />}
      {row.tool && reach.kind !== 'tool' && (
        <Row
          k="The Inbox tool"
          sub={cost}
          v={
            <>
              the <code>plannotator_inbox</code> tool, with Plannotator&apos;s {row.id === 'pi' ? 'extension' : 'plugin'}
            </>
          }
          r={
            <>
              {pending.has(`${row.id}:tool`) && <span className="ib-agpending">{next}</span>}
              <Switch on={row.tool.on} label={`The Inbox tool: ${row.label}`} disabled={row.tool.locked || modOff} busy={busy} onClick={() => onChange({ tool: !row.tool!.on })} />
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
                {note.path ? <code>{note.path}</code> : noteCopiedByHand(row) ? `${CURSOR_RULES_PLACE} in ${row.label}` : null}
                {noteState && <> · {noteState}</>}
                <button type="button" className="ib-lnk" aria-expanded={show} aria-controls={`${id}-note`} onClick={() => setShow((open) => !open)}>
                  {show ? 'Hide' : noteCopiedByHand(row) ? 'Show note' : 'Show'}
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
                {noteCopiedByHand(row) && (
                  <p>
                    Copy this text into {CURSOR_RULES_PLACE} in {row.label}. Plannotator can't see, update or remove that copy.
                  </p>
                )}
                <pre>{noteCopiedByHand(row) ? noteWithoutMarkers(noteText) : noteText}</pre>
              </div>
            </div>
          )}
        </>
      ) : NO_NOTE_FILE[row.id] ? (
        <Row k="Note in its instructions" v={NO_NOTE_FILE[row.id]} na />
      ) : null}
      {sessions && sessions.running > 0 && (row.id === 'claude-code' || row.id === 'pi' || row.id === 'opencode') && (
        <OpenSessions id={row.id} sessions={sessions} />
      )}
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
          <AgentGroup
            key={row.id}
            row={row}
            noteText={model.note_text}
            pending={pending}
            busy={busy.has(row.id)}
            onChange={(input) => void change(row.id, input)}
            {...(context ? { platform: context.platform } : {})}
            {...(model.sessions && (row.id === 'claude-code' || row.id === 'pi' || row.id === 'opencode') && model.sessions[row.id] ? { sessions: model.sessions[row.id] } : {})}
          />
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
