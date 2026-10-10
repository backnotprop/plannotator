import { useEffect, useState } from 'react';
import type { AgentToolHost, SettingsModel, TailscaleSettings } from '../api';
import { formatBytes, plural, tildePath } from '../format';
import { HARNESSES, type ConnectContext } from '../harnesses';
import { HostMark, Icon } from '../icons';
import { ConnectPicker } from './ConnectPicker';
import { PhonesBlock } from './Phones';
import { SidebarTrigger } from '../shell/sidebar';

const TOOL_HOSTS: { host: AgentToolHost; name: string }[] = [
  { host: 'claude-code', name: 'Claude Code' },
  { host: 'pi', name: 'Pi' },
  { host: 'opencode', name: 'OpenCode' },
];

/** Projects listed before the rest fold under "N more projects". */
const SHOWN_PROJECTS = 2;

export interface SettingsPageProps {
  settings: SettingsModel | null;
  context: ConnectContext | null;
  error: string | null;
  onToggleTool: (host: AgentToolHost, next: boolean) => void;
  /** Over your tailnet: the switch, and whether a change is in flight. */
  onToggleTailscale: (next: boolean) => void;
  tailscaleBusy: boolean;
  permission: NotificationPermission | 'unsupported';
  onToggleNotifications: (next: boolean) => void;
  /** Delete a thread or a project with its files as they were sent (blobs no other thread uses). */
  onDeleteThread: (threadId: string) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
}

const PERMISSION_LABEL: Record<NotificationPermission | 'unsupported', string> = {
  granted: 'Allowed in this browser',
  default: 'Not allowed in this browser yet',
  denied: 'Blocked in this browser',
  unsupported: 'This browser cannot show notifications',
};

/**
 * Notifications (record 7.2): one switch, for questions and stops. Turning it
 * on asks the browser when it has not decided yet.
 */
function NotificationsBlock({
  settings,
  permission,
  onToggle,
}: {
  settings: SettingsModel['notifications'];
  permission: NotificationPermission | 'unsupported';
  onToggle: (next: boolean) => void;
}) {
  const on = settings.enabled && permission === 'granted';
  return (
    <div className="ib-sblock" data-settings-notifications="">
      <h2>Notifications</h2>
      <div className="ib-srow" style={{ paddingTop: 0 }}>
        {PERMISSION_LABEL[permission]}
        <span className="ib-d">for questions and stops</span>
        <span className="ib-r">
          <button
            type="button"
            role="switch"
            className="ib-sw"
            aria-checked={on}
            aria-label="Desktop notifications"
            disabled={permission === 'unsupported' || permission === 'denied'}
            onClick={() => onToggle(!on)}
          />
        </span>
      </div>
      {permission === 'denied' && (
        <div className="ib-note">
          <Icon name="info" />
          This browser blocks notifications for this page: allow them in its site settings.
        </div>
      )}
    </div>
  );
}

/**
 * Over your tailnet: one switch, saved to config.json and applied at once.
 * The switch shows the person's choice even while publishing fails (the
 * error says why), so a click turns it off. It cannot be turned on from a
 * page that came through the tailnet, and the env var locks it.
 */
function TailscaleBlock({
  state,
  via,
  busy,
  onToggle,
}: {
  state: TailscaleSettings;
  via: 'local' | 'tailnet';
  busy: boolean;
  onToggle: (next: boolean) => void;
}) {
  const remote = via === 'tailnet';
  const who = state.allowed.length > 0 ? state.allowed.join(', ') : 'the Tailscale login that owns this computer';
  const locked = state.env !== null;
  return (
    <div className="ib-sblock" data-settings-tailscale={state.on ? 'on' : 'off'}>
      <h2>Over your tailnet</h2>
      <p>
        Open the Inbox from your other devices through Tailscale, over HTTPS, without opening this computer to the internet. Only{' '}
        {who} can open it there; agents stay on this computer.
      </p>
      <div className="ib-srow">
        Reach the Inbox over Tailscale
        <span className="ib-d" data-tailscale-url={state.url ?? ''}>
          {state.url ? (
            <a href={state.url} target="_blank" rel="noreferrer">
              {state.url}
            </a>
          ) : state.on ? (
            'Not published'
          ) : (
            'Off'
          )}
        </span>
        <span className="ib-r">
          <button
            type="button"
            role="switch"
            className="ib-sw"
            aria-checked={state.on}
            aria-label="Reach the Inbox over Tailscale"
            disabled={busy || locked || (remote && !state.on)}
            onClick={() => onToggle(!state.on)}
          />
        </span>
      </div>
      {state.on && state.error && (
        <div className="ib-error" data-tailscale-error="">
          {state.error}
        </div>
      )}
      <div className="ib-note">
        <Icon name="info" />
        {locked
          ? `PLANNOTATOR_INBOX_TAILSCALE is set in this Inbox's environment, so it stays ${state.env ? 'on' : 'off'}.`
          : remote
            ? 'You opened this page over your tailnet. Turning this off ends that connection; turn it on again from this computer.'
            : state.source === 'flag'
              ? (
                  <span>
                    On for this run (plannotator inbox --tailscale).{' '}
                    <button type="button" className="ib-fold" data-tailscale-keep="" disabled={busy} onClick={() => onToggle(true)}>
                      Keep it on at every start
                    </button>
                  </span>
                )
              : 'Applies now and at every start. Notifications are allowed per address, so each device asks once.'}
      </div>
    </div>
  );
}

/**
 * Delete thread / Delete project (record 7.1): a first click asks "Delete?
 * Click again" for a few seconds, a second one deletes. Nothing is undone
 * once deleted, so one stray click never removes a project.
 */
function DeleteLink({ label, what, onDelete }: { label: string; what: string; onDelete: () => Promise<void> }) {
  const [state, setState] = useState<'idle' | 'confirm' | 'busy'>('idle');
  useEffect(() => {
    if (state !== 'confirm') return;
    const timer = setTimeout(() => setState('idle'), 4000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className={`ib-del-l${state === 'confirm' ? ' ib-confirm' : ''}`}
      disabled={state === 'busy'}
      aria-label={state === 'confirm' ? `Delete ${what}: click again to delete` : `${label}: ${what}`}
      onClick={() => {
        if (state === 'idle') return setState('confirm');
        if (state !== 'confirm') return;
        setState('busy');
        onDelete().finally(() => setState('idle'));
      }}
    >
      {state === 'confirm' ? 'Delete? Click again' : label}
    </button>
  );
}

function StoreTable({
  store,
  threadCounts,
  onDeleteThread,
  onDeleteProject,
}: {
  store: SettingsModel['store'];
  threadCounts: (id: string) => number;
  onDeleteThread: (threadId: string) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState<string | null>(store.projects[0]?.id ?? null);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? store.projects : store.projects.slice(0, SHOWN_PROJECTS);
  const rest = store.projects.slice(SHOWN_PROJECTS);
  return (
    <table className="ib-stbl">
      <tbody>
        {shown.map((project) => {
          const isOpen = open === project.id;
          return [
            <tr key={project.id} data-store-project={project.name}>
              <td>
                <button type="button" className="ib-fold" onClick={() => setOpen(isOpen ? null : project.id)} aria-expanded={isOpen}>
                  <Icon name={isOpen ? 'chevD' : 'chevR'} size={13} /> {project.name}
                </button>
              </td>
              <td className="ib-n">{plural(threadCounts(project.id), 'thread')}</td>
              <td className="ib-n">{formatBytes(project.bytes)}</td>
              <td className="ib-a">
                <DeleteLink label="Delete project" what={project.name} onDelete={() => onDeleteProject(project.id)} />
              </td>
            </tr>,
            ...(isOpen
              ? project.threads.map((thread) => (
                  <tr key={thread.thread_id} className="ib-sub" data-store-thread={thread.thread_id}>
                    <td>{thread.subject ?? '(no subject)'}</td>
                    <td className="ib-n" />
                    <td className="ib-n">{formatBytes(thread.bytes)}</td>
                    <td className="ib-a">
                      <DeleteLink label="Delete thread" what={thread.subject ?? 'this thread'} onDelete={() => onDeleteThread(thread.thread_id)} />
                    </td>
                  </tr>
                ))
              : []),
          ];
        })}
        {!showAll && rest.length > 0 && (
          <tr>
            <td>
              <button type="button" className="ib-fold" onClick={() => setShowAll(true)}>
                <Icon name="chevR" size={13} /> {plural(rest.length, 'more project')}
              </button>
            </td>
            <td className="ib-n">{plural(rest.reduce((n, p) => n + threadCounts(p.id), 0), 'thread')}</td>
            <td className="ib-n">{formatBytes(rest.reduce((n, p) => n + p.bytes, 0))}</td>
            <td className="ib-a" />
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** Settings (record 7.1, 7.2): the agent tool knob, Connect an agent, phones (not in the record), the store on disk, notifications. */
export function SettingsPage({
  settings,
  context,
  error,
  onToggleTool,
  onToggleTailscale,
  tailscaleBusy,
  permission,
  onToggleNotifications,
  onDeleteThread,
  onDeleteProject,
}: SettingsPageProps) {
  const env = settings?.inbox_tool.env ?? null;
  return (
    <div className="ib-spage" aria-label="Settings">
      <div className="ib-spage-in">
        <div className="ib-shead">
          <SidebarTrigger />
          <h1>Settings</h1>
        </div>
        <div className="ib-sblock">
          <h2>The Inbox in your agent's tools</h2>
          <p>
            Lets an agent send, read and wait for replies from its own tool list. Pi and OpenCode send every tool's definition with
            each request, so they start off.
          </p>
          {TOOL_HOSTS.map(({ host, name }) => {
            const on = settings?.inbox_tool.hosts[host] ?? false;
            return (
              <div className="ib-srow" key={host}>
                <HostMark host={host} />
                {name}
                <span className="ib-r">
                  <button
                    type="button"
                    role="switch"
                    className="ib-sw"
                    aria-checked={on}
                    aria-label={`The Inbox tool in ${name}`}
                    disabled={!settings || env !== null}
                    onClick={() => onToggleTool(host, !on)}
                  />
                </span>
              </div>
            );
          })}
          <div className="ib-note">
            <Icon name="info" />
            {env !== null
              ? `PLANNOTATOR_INBOX_TOOL is set in this Inbox's environment, so every host is ${env ? 'on' : 'off'}.`
              : 'Applies to the next session. Sessions already running keep what they started with.'}
          </div>
          {error && <div className="ib-error">{error}</div>}
        </div>
        <div className="ib-sblock">
          <h2>Connect an agent</h2>
          <p>
            Agents on this computer reach the Inbox at 127.0.0.1, and it keeps its port between runs when it can.
            {settings?.phones && ' Phones reach it only on a path you turn on below.'}
          </p>
          {context && <ConnectPicker harnesses={HARNESSES} initial="other" context={context} compact />}
        </div>
        {settings?.tailscale && (
          <TailscaleBlock state={settings.tailscale} via={settings.via ?? 'local'} busy={tailscaleBusy} onToggle={onToggleTailscale} />
        )}
        {settings?.phones && <PhonesBlock />}
        {settings && (
          <div className="ib-sblock">
            <h2>Stored on this machine</h2>
            <p>
              <span data-store-bytes={settings.store.bytes}>{formatBytes(settings.store.bytes)}</span> in{' '}
              {tildePath(settings.store.dir, settings.home)}: messages, attached files as they were sent, and annotations.
            </p>
            {settings.store.projects.length > 0 && (
              <StoreTable
                store={settings.store}
                threadCounts={(id) => settings.store.projects.find((p) => p.id === id)?.threads.length ?? 0}
                onDeleteThread={onDeleteThread}
                onDeleteProject={onDeleteProject}
              />
            )}
          </div>
        )}
        {settings && (
          <NotificationsBlock
            settings={settings.notifications}
            permission={permission}
            onToggle={onToggleNotifications}
          />
        )}
      </div>
    </div>
  );
}
