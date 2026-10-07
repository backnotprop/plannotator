import { useState } from 'react';
import type { AgentToolHost, NotifySection, SettingsModel } from '../api';
import { NOTIFY_SECTIONS } from '../notify';
import { formatBytes, plural, tildePath } from '../format';
import { HARNESSES, type ConnectContext } from '../harnesses';
import { HostMark, Icon } from '../icons';
import { ConnectPicker } from './ConnectPicker';

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
  permission: NotificationPermission | 'unsupported';
  onToggleNotifications: (next: boolean) => void;
  onToggleSection: (section: NotifySection, next: boolean) => void;
}

const PERMISSION_LABEL: Record<NotificationPermission | 'unsupported', string> = {
  granted: 'Allowed in this browser',
  default: 'Not allowed in this browser yet',
  denied: 'Blocked in this browser',
  unsupported: 'This browser cannot show notifications',
};

/**
 * Notifications (record 7.2): on or off for this browser, and which sections
 * notify. Turning it on asks the browser when it has not decided yet.
 */
function NotificationsBlock({
  settings,
  permission,
  onToggle,
  onToggleSection,
}: {
  settings: SettingsModel['notifications'];
  permission: NotificationPermission | 'unsupported';
  onToggle: (next: boolean) => void;
  onToggleSection: (section: NotifySection, next: boolean) => void;
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
      {on &&
        NOTIFY_SECTIONS.map(({ id, label }) => {
          const checked = settings.sections.includes(id);
          return (
            <div className="ib-srow ib-sub" key={id}>
              {label}
              <span className="ib-r">
                <button
                  type="button"
                  role="switch"
                  className="ib-sw"
                  aria-checked={checked}
                  aria-label={`Notify for ${label}`}
                  onClick={() => onToggleSection(id, !checked)}
                />
              </span>
            </div>
          );
        })}
      {permission === 'denied' && (
        <div className="ib-note">
          <Icon name="info" />
          This browser blocks notifications for this page: allow them in its site settings.
        </div>
      )}
    </div>
  );
}

function StoreTable({ store, threadCounts }: { store: SettingsModel['store']; threadCounts: (id: string) => number }) {
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
                <button type="button" className="ib-del-l" disabled title="Deleting comes in the next step">
                  Delete project
                </button>
              </td>
            </tr>,
            ...(isOpen
              ? project.threads.map((thread) => (
                  <tr key={thread.thread_id} className="ib-sub">
                    <td>{thread.subject ?? '(no subject)'}</td>
                    <td className="ib-n" />
                    <td className="ib-n">{formatBytes(thread.bytes)}</td>
                    <td className="ib-a">
                      <button type="button" className="ib-del-l" disabled title="Deleting comes in the next step">
                        Delete thread
                      </button>
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

/** Settings (record 7.1, 7.2): the agent tool knob, Connect an agent, the store on disk, notifications. */
export function SettingsPage({
  settings,
  context,
  error,
  onToggleTool,
  permission,
  onToggleNotifications,
  onToggleSection,
}: SettingsPageProps) {
  const env = settings?.inbox_tool.env ?? null;
  return (
    <div className="ib-spage" aria-label="Settings">
      <div className="ib-spage-in">
        <h1>Settings</h1>
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
          <p>Local only: the Inbox listens on 127.0.0.1 and keeps its port between runs when it can.</p>
          {context && <ConnectPicker harnesses={HARNESSES} initial="other" context={context} compact />}
        </div>
        {settings && (
          <div className="ib-sblock">
            <h2>Stored on this machine</h2>
            <p>
              {formatBytes(settings.store.bytes)} in {tildePath(settings.store.dir, settings.home)}: messages and your answers.
            </p>
            {settings.store.projects.length > 0 && (
              <StoreTable store={settings.store} threadCounts={(id) => settings.store.projects.find((p) => p.id === id)?.threads.length ?? 0} />
            )}
            <div className="ib-note">
              <Icon name="info" />
              Delete thread and delete project come in the next step.
            </div>
          </div>
        )}
        {settings && (
          <NotificationsBlock
            settings={settings.notifications}
            permission={permission}
            onToggle={onToggleNotifications}
            onToggleSection={onToggleSection}
          />
        )}
      </div>
    </div>
  );
}
