import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { INBOX_SOUND_MAX_VOLUME, INBOX_SOUND_MIN_VOLUME } from '@plannotator/core/inbox-types';
import type { InboxSound } from '../sound';
import type { AgentToolHost, SettingsModel } from '../api';
import { formatBytes, plural, tildePath } from '../format';
import { HARNESSES, type ConnectContext } from '../harnesses';
import { HostMark, Icon, type IconName } from '../icons';
import { ConnectPicker } from './ConnectPicker';
import { AgentsSettings } from './AgentsSettings';
import type { InboxAgentsModel } from '@plannotator/core/inbox-types';
import { DevicesSection, devicesNeedAttention, usePhones } from './Devices';
import { SidebarTrigger } from '../shell/sidebar';
import { useInboxTheme } from '../theme';
import { SETTINGS_SECTION_LABEL, SETTINGS_SECTIONS, settingsHash, type SettingsSection } from '../settingsRoute';

const TOOL_HOSTS: { host: AgentToolHost; name: string }[] = [
  { host: 'claude-code', name: 'Claude Code' },
  { host: 'pi', name: 'Pi' },
  { host: 'opencode', name: 'OpenCode' },
];

const SECTION_ICON: Record<SettingsSection, IconName> = {
  general: 'settings',
  agents: 'chip',
  devices: 'phone',
  archived: 'archive',
  storage: 'disk',
  about: 'info',
};

/** Projects listed before the rest fold under "N more projects". */
const SHOWN_PROJECTS = 2;

export interface SettingsPageProps {
  settings: SettingsModel | null;
  context: ConnectContext | null;
  error: string | null;
  onToggleTool: (host: AgentToolHost, next: boolean) => void;
  /** Over your tailnet: the switch, and whether a change is in flight. */
  onToggleTailscale: (next: boolean, replaceExposed?: boolean) => void;
  tailscaleBusy: boolean;
  permission: NotificationPermission | 'unsupported';
  onToggleNotifications: (next: boolean) => void;
  /** Delete a thread or a project with its files as they were sent (blobs no other thread uses). */
  onDeleteThread: (threadId: string) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
  /** Settings → About: the version, Check now and the two update switches (components/Updates.tsx). */
  about?: ReactNode;
  /** The About nav row's dot: a new version is available, ready or failed. */
  aboutDot?: boolean;
  /** The question sound's row, under the notifications switch (sound.ts). */
  sound?: InboxSound;
  /** Settings → Archived: the archived threads (components/Archived.tsx). */
  archived?: ReactNode;
  /** How many threads are archived, for the nav's count; null while unknown. */
  archivedTotal?: number | null;
  /** The section on screen (`#settings/<section>`); null is `#settings` alone: General, or the list of sections on a phone. */
  section?: SettingsSection | null;
  /** `#settings/devices/pair`: Pair a phone is open. */
  pairing?: boolean;
  /** Open a section (null: the phone's list of sections). */
  onSection?: (section: SettingsSection | null) => void;
  onPairing?: (open: boolean) => void;
  /** "← Inbox": back to where the person was before Settings. */
  onBack?: () => void;
  /** Settings did not load: read it again. */
  onRetry?: () => void;
  /** One screen at a time (phone.ts): the list of sections, then a section with "‹ Settings". */
  phone?: boolean;
  /** Settings → Agents (components/AgentsSettings.tsx): the agents on this computer; null while unread. */
  agents?: InboxAgentsModel | null;
  onAgents?: (next: InboxAgentsModel) => void;
}

const PERMISSION_LABEL: Record<NotificationPermission | 'unsupported', string> = {
  granted: 'Allowed in this browser',
  default: 'Not allowed in this browser yet',
  denied: 'Blocked in this browser',
  unsupported: 'This browser cannot show notifications',
};

/** A row's switch, named by its visible title. */
function Switch({ on, labelledBy, label, disabled, onClick }: { on: boolean; labelledBy?: string; label?: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" role="switch" className="ib-sw" aria-checked={on} aria-labelledby={labelledBy} aria-label={label} disabled={disabled} onClick={onClick} />;
}

/**
 * The question sound (design of record: .product/approved/inbox-sound/): one
 * row, "Play a sound · when an agent asks you", then the volume, Play and
 * the switch. Off, the slider is disabled and Play still plays. Letting go of
 * the slider plays the sound once at the new level. Before the first click in
 * the tab, one line says Chrome needs it.
 */
function SoundRow({ sound }: { sound: InboxSound }) {
  const { enabled, volume } = sound.settings;
  const [live, setLive] = useState(volume);
  const slider = useRef<HTMLInputElement>(null);
  const soundRef = useRef(sound);
  soundRef.current = sound;
  useEffect(() => setLive(volume), [volume]);
  // React's onChange is the input event; letting go is the native change event.
  useEffect(() => {
    const el = slider.current;
    if (!el) return;
    const release = () => {
      const next = Number(el.value);
      soundRef.current.preview(next);
      void soundRef.current.setVolume(next);
    };
    el.addEventListener('change', release);
    return () => el.removeEventListener('change', release);
  }, []);
  return (
    <>
      <div className="ib-prow" data-settings-sound={enabled ? 'on' : 'off'}>
        <span className="ib-txt">
          <span className="ib-l" id="ib-sound-label">
            Play a sound
          </span>
          <span className="ib-desc">When an agent asks you, while no Inbox tab is in front</span>
        </span>
        <span className="ib-ctl">
          <input
            ref={slider}
            type="range"
            className="ib-vslider"
            min={INBOX_SOUND_MIN_VOLUME}
            max={INBOX_SOUND_MAX_VOLUME}
            step={10}
            value={live}
            aria-label="Volume"
            aria-valuetext={`${live} percent`}
            disabled={!enabled}
            onChange={(event) => setLive(Number(event.target.value))}
          />
          <button
            type="button"
            className="ib-btn ib-sm ib-icon"
            aria-label={sound.playing ? 'Playing…' : 'Play the sound'}
            data-sound-play=""
            onClick={() => sound.preview(live)}
          >
            <Icon name="play" />
          </button>
          <Switch on={enabled} labelledBy="ib-sound-label" onClick={() => void sound.setEnabled(!enabled)} />
        </span>
      </div>
      {enabled && !sound.armed && (
        <div className="ib-callout ib-in-card" role="status" data-sound-click-hint="">
          <Icon name="clickHere" />
          <span>Click once in this tab to allow sound.</span>
        </div>
      )}
    </>
  );
}

const THEME_CHOICES = [
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
  { id: 'system', label: 'Match system', icon: 'system' },
] as const;

/**
 * General (design of record `.product/approved/inbox-settings-tabs/`):
 * Appearance (light, dark, or match this computer; Plannotator's one theme
 * preference, so plan review follows it too), and how the Inbox gets your
 * attention when an agent asks: desktop notifications and the sound.
 */
function GeneralSection({
  settings,
  permission,
  onToggleNotifications,
  sound,
}: {
  settings: SettingsModel;
  permission: NotificationPermission | 'unsupported';
  onToggleNotifications: (next: boolean) => void;
  sound?: InboxSound;
}) {
  const { mode, shown, choose } = useInboxTheme();
  const notificationsOn = settings.notifications.enabled && permission === 'granted';
  return (
    <>
      <section className="ib-sgroup" data-settings-theme={mode} aria-labelledby="ib-g-appearance">
        <h2 id="ib-g-appearance">Appearance</h2>
        <div className="ib-card">
          <div className="ib-prow">
            <span className="ib-txt">
              <span className="ib-l" id="ib-theme-label">
                Theme
              </span>
              <span className="ib-desc">
                {mode === 'system' ? `Follows this computer, ${shown} now. Also plan review, code review and annotate.` : 'Also plan review, code review and annotate.'}
              </span>
            </span>
            <span className="ib-ctl">
              <span className="ib-seg" role="radiogroup" aria-labelledby="ib-theme-label">
                {THEME_CHOICES.map((choice) => (
                  <label key={choice.id} className="ib-seg-o" data-on={mode === choice.id ? '' : undefined}>
                    <input type="radio" name="ib-theme" value={choice.id} checked={mode === choice.id} onChange={() => choose(choice.id)} />
                    <Icon name={choice.icon} size={14} />
                    {choice.label}
                  </label>
                ))}
              </span>
            </span>
          </div>
        </div>
      </section>
      <section className="ib-sgroup" data-settings-notifications="" aria-labelledby="ib-g-attention">
        <h2 id="ib-g-attention">When an agent asks you</h2>
        <div className="ib-card">
          <div className="ib-prow">
            <span className="ib-txt">
              <span className="ib-l" id="ib-notify-label">
                Desktop notifications
              </span>
              <span className="ib-desc">For questions and stops · {PERMISSION_LABEL[permission]}</span>
            </span>
            <span className="ib-ctl">
              <Switch
                on={notificationsOn}
                labelledBy="ib-notify-label"
                disabled={permission === 'unsupported' || permission === 'denied'}
                onClick={() => onToggleNotifications(!notificationsOn)}
              />
            </span>
          </div>
          {permission === 'denied' && (
            <div className="ib-callout ib-warn ib-in-card" data-notifications-blocked="">
              <Icon name="warn" />
              <span>This browser blocks notifications for this page: allow them in its site settings, then reload.</span>
            </div>
          )}
          {sound && <SoundRow sound={sound} />}
        </div>
        <div className="ib-note">
          <Icon name="info" />
          Notifications are allowed per address, so a browser on another device asks once there.
        </div>
      </section>
    </>
  );
}

/**
 * Agents (the approved "inbox-agent-awareness" design, 08-09): one group per
 * agent found, with its reach, reminder and note (components/AgentsSettings.tsx).
 * Until the agents are read (or on an Inbox that cannot list them), the
 * tool switches and the harness picker as before.
 */
function AgentsSection({
  settings,
  context,
  onToggleTool,
  agents,
  onAgents,
}: {
  settings: SettingsModel;
  context: ConnectContext | null;
  onToggleTool: (host: AgentToolHost, next: boolean) => void;
  agents?: InboxAgentsModel | null;
  onAgents?: (next: InboxAgentsModel) => void;
}) {
  if (agents && onAgents) {
    return (
      <section className="ib-sgroup" aria-label="Agents">
        <AgentsSettings model={agents} onModel={onAgents} context={context} />
      </section>
    );
  }
  const env = settings.inbox_tool.env;
  return (
    <>
      <section className="ib-sgroup" aria-labelledby="ib-g-tool">
        <h2 id="ib-g-tool">The Inbox in your agent&apos;s tools</h2>
        <p>
          Lets an agent send, read and wait for replies from its own tool list. Pi and OpenCode send every tool&apos;s definition with each request, so they start
          off.
        </p>
        {env !== null && (
          <div className="ib-callout" data-tool-locked="">
            <Icon name="lock" />
            <span>PLANNOTATOR_INBOX_TOOL is set in this Inbox&apos;s environment, so every host is {env ? 'on' : 'off'}.</span>
          </div>
        )}
        <div className="ib-card">
          {TOOL_HOSTS.map(({ host, name }) => {
            const on = settings.inbox_tool.hosts[host] ?? false;
            return (
              <div className="ib-prow" key={host}>
                <HostMark host={host} big />
                <span className="ib-txt">
                  <span className="ib-l">{name}</span>
                </span>
                <span className="ib-ctl">
                  <Switch on={on} label={`The Inbox tool in ${name}`} disabled={env !== null} onClick={() => onToggleTool(host, !on)} />
                </span>
              </div>
            );
          })}
        </div>
        {env === null && (
          <div className="ib-note">
            <Icon name="info" />
            Applies to the next session. Sessions already running keep what they started with.
          </div>
        )}
      </section>
      <section className="ib-sgroup" aria-labelledby="ib-g-connect">
        <h2 id="ib-g-connect">Connect an agent</h2>
        <p>Agents on this computer reach the Inbox at 127.0.0.1, and it keeps its port between runs when it can.</p>
        <div className="ib-card ib-card-pad">{context && <ConnectPicker harnesses={HARNESSES} initial="other" context={context} compact />}</div>
      </section>
    </>
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
  onDeleteThread,
  onDeleteProject,
}: {
  store: SettingsModel['store'];
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
              <td className="ib-n ib-n-threads">{plural(project.threads.length, 'thread')}</td>
              <td className="ib-n">{formatBytes(project.bytes)}</td>
              <td className="ib-a">
                <DeleteLink label="Delete project" what={project.name} onDelete={() => onDeleteProject(project.id)} />
              </td>
            </tr>,
            ...(isOpen
              ? project.threads.map((thread) => (
                  <tr key={thread.thread_id} className="ib-sub" data-store-thread={thread.thread_id}>
                    <td>{thread.subject ?? '(no subject)'}</td>
                    <td className="ib-n ib-n-threads" />
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
            <td className="ib-n ib-n-threads">{plural(rest.reduce((n, p) => n + p.threads.length, 0), 'thread')}</td>
            <td className="ib-n">{formatBytes(rest.reduce((n, p) => n + p.bytes, 0))}</td>
            <td className="ib-a" />
          </tr>
        )}
      </tbody>
    </table>
  );
}

const LEDE: Record<SettingsSection, string> = {
  general: 'How the Inbox looks, and how it gets your attention.',
  agents: "How each agent on this computer reaches the Inbox and learns when to use it. A change applies to that agent's next session; sessions already running keep what they started with.",
  devices: 'Your phone, and browsers on your other devices.',
  archived: 'Threads you archived stay out of the list. Unarchive one to put it back and open it.',
  storage: '',
  about: 'The version, and how Plannotator keeps itself up to date.',
};

/**
 * Settings (design of record `.product/approved/inbox-settings-tabs/`,
 * Workspaces' SettingsFrame in the Inbox's scale): a focused page with
 * "← Inbox" on top, a section nav (General, Agents, Devices, Archived,
 * Storage, About) and one section per page at `#settings/<section>`. On a
 * phone, a list of the sections, then one section with "‹ Settings".
 */
export function SettingsPage(props: SettingsPageProps) {
  const {
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
    about,
    aboutDot,
    sound,
    archived,
    archivedTotal,
    pairing = false,
    onSection,
    onPairing,
    onBack,
    onRetry,
    phone = false,
  } = props;
  const section: SettingsSection | null = props.section ?? (phone ? null : 'general');
  const phonesOn = settings?.phones === true;
  const phones = usePhones(phonesOn);
  const via = settings?.via ?? 'local';
  const { mode } = useInboxTheme();
  const heading = useRef<HTMLHeadingElement>(null);
  const firstSection = useRef(true);

  // A new section takes focus to its heading, so a keyboard or screen reader starts at the top of it. Back to
  // a phone's list of sections ("‹ Settings"), focus goes to the row of the section just left.
  const lastSection = useRef<SettingsSection | null>(section);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const left = lastSection.current;
    lastSection.current = section;
    if (firstSection.current) {
      firstSection.current = false;
      return;
    }
    if (section === null) {
      if (left) list.current?.querySelector<HTMLElement>(`[data-settings-link="${left}"]`)?.focus();
      return;
    }
    heading.current?.focus();
  }, [section]);

  const devicesDot = devicesNeedAttention(phonesOn ? phones : null, settings?.tailscale);
  const loadFailed = !settings && error !== null;

  const go = (next: SettingsSection | null) => (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onSection?.(next);
  };

  const badge = (id: SettingsSection): ReactNode => {
    if (id === 'archived' && archivedTotal) return <span className="ib-scount">{archivedTotal}</span>;
    if (id === 'about' && aboutDot) return <span className="ib-dot" aria-label="A new version is available" role="img" />;
    if (id === 'devices' && devicesDot) return <span className="ib-dot ib-warn" aria-label="Something here is not working" role="img" />;
    return null;
  };

  /** The phone list's value beside each section. */
  const value = (id: SettingsSection): string => {
    if (!settings) return '';
    switch (id) {
      case 'general':
        return mode === 'system' ? 'Match system' : mode === 'light' ? 'Light' : 'Dark';
      case 'agents': {
        if (props.agents) {
          const connected = props.agents.agents.filter((row) => row.detected && row.reach.on).map((row) => row.label);
          return connected.length === 0 ? 'None' : connected.length === 1 ? connected[0]! : `${connected.length} agents`;
        }
        const on = TOOL_HOSTS.filter(({ host }) => settings.inbox_tool.hosts[host]).map(({ name }) => name);
        return on.length === 0 ? 'Off' : on.length === 1 ? on[0]! : `${on.length} agents`;
      }
      case 'devices':
        if (phonesOn && phones.devices && phones.devices.length > 0) return plural(phones.devices.length, 'phone');
        return settings.tailscale?.on ? 'Over your tailnet' : '';
      case 'archived':
        return archivedTotal ? String(archivedTotal) : '';
      case 'storage':
        return formatBytes(settings.store.bytes);
      case 'about':
        return settings.version;
    }
  };

  let body: ReactNode = null;
  if (section && settings) {
    switch (section) {
      case 'general':
        body = <GeneralSection settings={settings} permission={permission} onToggleNotifications={onToggleNotifications} sound={sound} />;
        break;
      case 'agents':
        body = <AgentsSection settings={settings} context={context} onToggleTool={onToggleTool} agents={props.agents} onAgents={props.onAgents} />;
        break;
      case 'devices':
        body = (
          <DevicesSection
            phones={phonesOn ? phones : null}
            tailscale={settings.tailscale}
            via={via}
            tailscaleBusy={tailscaleBusy}
            onToggleTailscale={onToggleTailscale}
            pairing={pairing && phonesOn}
            onPairing={(open) => onPairing?.(open)}
          />
        );
        break;
      case 'archived':
        body = archived ?? (
          <div className="ib-card ib-sempty">
            <Icon name="archive" />
            Archived threads are listed here.
          </div>
        );
        break;
      case 'storage':
        body = (
          <section className="ib-sgroup" aria-labelledby="ib-g-store">
            <h2 id="ib-g-store">By project</h2>
            <p>Delete asks twice. A deleted thread or project cannot be brought back.</p>
            {settings.store.projects.length > 0 ? (
              <div className="ib-card">
                <StoreTable store={settings.store} onDeleteThread={onDeleteThread} onDeleteProject={onDeleteProject} />
              </div>
            ) : (
              <div className="ib-card ib-sempty">
                <Icon name="disk" />
                Nothing stored yet.
              </div>
            )}
          </section>
        );
        break;
      case 'about':
        body = about;
        break;
    }
  }

  const lede =
    section === 'storage' && settings ? (
      <p className="ib-lede">
        <b data-store-bytes={settings.store.bytes}>{formatBytes(settings.store.bytes)}</b> in {tildePath(settings.store.dir, settings.home)}: messages, attached
        files as they were sent, and annotations.
      </p>
    ) : section === 'devices' && settings && !phonesOn ? (
      <p className="ib-lede">Browsers on your other devices.</p>
    ) : section ? (
      <p className="ib-lede">{LEDE[section]}</p>
    ) : null;

  const page =
    phone && section === null ? (
      <div className="ib-plist" data-settings-list="" ref={list}>
        <div className="ib-plist-h">
          <SidebarTrigger />
          <h1>Settings</h1>
        </div>
        {[SETTINGS_SECTIONS.slice(0, 3), SETTINGS_SECTIONS.slice(3)].map((group, i) => (
          <ul className="ib-card" key={i} aria-label={i === 0 ? 'Settings' : 'Your data and Plannotator'}>
            {group.map((id) => (
              <li key={id}>
                <a href={`#${settingsHash({ section: id })}`} onClick={go(id)} data-settings-link={id}>
                  <span className="ib-tile">
                    <Icon name={SECTION_ICON[id]} />
                  </span>
                  {SETTINGS_SECTION_LABEL[id]}
                  <span className="ib-v">{value(id)}</span>
                  {/* The archived count is the row's value here; only the dots add to it. */}
                  {id !== 'archived' && badge(id)}
                  <Icon name="chevR" size={15} className="ib-chev" />
                </a>
              </li>
            ))}
          </ul>
        ))}
        {loadFailed && <LoadError error={error} onRetry={onRetry} />}
      </div>
    ) : (
      <div className="ib-spg" data-settings-section={section ?? 'general'}>
        {phone && (
          <div className="ib-sphead">
            <a href="#settings" className="ib-pback" onClick={go(null)}>
              <Icon name="chevL" /> Settings
            </a>
          </div>
        )}
        <h1 ref={heading} tabIndex={-1}>
          {section ? SETTINGS_SECTION_LABEL[section] : 'General'}
        </h1>
        {loadFailed ? (
          <>
            <LoadError error={error} onRetry={onRetry} />
            <div className="ib-skel" aria-hidden="true" />
            <div className="ib-skel" aria-hidden="true" />
          </>
        ) : !settings ? (
          <>
            <div className="ib-skel" aria-hidden="true" />
            <div className="ib-skel" aria-hidden="true" />
          </>
        ) : (
          <>
            {lede}
            {error && settings && (
              <div className="ib-callout ib-err" role="alert" data-settings-error="">
                <Icon name="xCircle" />
                <span>{error}</span>
              </div>
            )}
            {body}
          </>
        )}
      </div>
    );

  return (
    <div className="ib-spage ib-sframe" aria-label="Settings">
      <div className="ib-sframe-in">
        {!phone && (
          <button type="button" className="ib-sback" onClick={onBack} data-settings-back="">
            <Icon name="back" size={15} /> Inbox
          </button>
        )}
        <div className="ib-scols">
          {!phone && (
            <nav className="ib-snav" aria-label="Settings sections">
              <div className="ib-eyebrow" aria-hidden="true">
                Settings
              </div>
              <ul>
                {SETTINGS_SECTIONS.map((id) => (
                  <li key={id}>
                    <a href={`#${settingsHash({ section: id })}`} aria-current={id === section ? 'page' : undefined} onClick={go(id)} data-settings-link={id}>
                      <Icon name={SECTION_ICON[id]} />
                      {SETTINGS_SECTION_LABEL[id]}
                      {badge(id)}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          {page}
        </div>
      </div>
    </div>
  );
}

function LoadError({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  return (
    <div className="ib-callout ib-err" role="alert" data-settings-load-error="">
      <Icon name="xCircle" />
      <span>
        <b>Settings did not load.</b> {error} It may have stopped: run <code>plannotator inbox</code>, then{' '}
        <button type="button" className="ib-lnk" onClick={onRetry}>
          Try again
        </button>
        .
      </span>
    </div>
  );
}
