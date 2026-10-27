import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { INBOX_SOUND_MAX_VOLUME, INBOX_SOUND_MIN_VOLUME, INBOX_TEXT_SIZES } from '@plannotator/core/inbox-types';
import type { InboxSound } from '../sound';
import type { AgentToolHost, InboxExperimentalSettings, SettingsModel } from '../api';
import { formatBytes, formatCount, plural, tildePath } from '../format';
import { HARNESSES, type ConnectContext } from '../harnesses';
import { HostMark, Icon, type IconName } from '../icons';
import { ConnectPicker } from './ConnectPicker';
import { AgentsSettings, agentsNeedRestart } from './AgentsSettings';
import { PromptsSection, promptsSummary } from './PromptsSettings';
import type { InboxPromptsSettings } from '@plannotator/core/inbox-types';
import type { InboxAgentsModel, InboxNotifyReach } from '@plannotator/core/inbox-types';
import type { TestResult } from '../notify';
import { blockedSteps, browserName, isMac, notifyStatusKind, notifyStatusText, reachText, testMissHint } from '../notifyStatus';
import { DevicesSection, devicesNeedAttention, usePhones } from './Devices';
import { SidebarTrigger } from '../shell/sidebar';
import { useInboxPalettes, useInboxTheme } from '../theme';
import { PaletteRow } from './Palettes';
import { DEFAULT_COLOR_THEME } from '@plannotator/ui/utils/themeRegistry';
import { chooseTextSize, useInboxTextSize } from '../textSize';
import { SETTINGS_SECTION_LABEL, SETTINGS_SECTIONS, settingsHash, type SettingsSection } from '../settingsRoute';

const TOOL_HOSTS: { host: AgentToolHost; name: string }[] = [
  { host: 'claude-code', name: 'Claude Code' },
  { host: 'pi', name: 'Pi' },
  { host: 'opencode', name: 'OpenCode' },
];

const SECTION_ICON: Record<SettingsSection, IconName> = {
  general: 'settings',
  agents: 'chip',
  prompts: 'prompt',
  devices: 'phone',
  archived: 'archive',
  storage: 'disk',
  about: 'info',
  capabilities: 'puzzle',
};

/** Projects listed before the rest fold under "N more projects". */
const SHOWN_PROJECTS = 2;

export interface SettingsPageProps {
  settings: SettingsModel | null;
  /**
   * Settings → General's first group, "Getting started" (approval
   * "inbox-onboarding-tour", returning users): Take the tour. Absent: none.
   */
  onTakeTour?: () => void;
  context: ConnectContext | null;
  error: string | null;
  onToggleTool: (host: AgentToolHost, next: boolean) => void;
  /** Settings → Capabilities → Experimental: decision mode's switch. Absent (or an Inbox that reports no experimental features): no Experimental group. */
  onToggleExperimental?: (next: boolean) => void;
  /** `#settings/experimental` (an old link): Capabilities scrolls to its Experimental group and focuses its heading. */
  landOnExperimental?: boolean;
  /** Settings → Capabilities → Board: the Board's switch. Absent (or an Inbox without the switch): no Board group. */
  onToggleBoard?: (next: boolean) => void;
  /** Over your tailnet: the switch, and whether a change is in flight. */
  onToggleTailscale: (next: boolean, replaceExposed?: boolean) => void;
  tailscaleBusy: boolean;
  permission: NotificationPermission | 'unsupported';
  onToggleNotifications: (next: boolean) => void;
  /** Whether any open Inbox tab can show a notification (the server's live report). */
  notifyReach?: InboxNotifyReach | null;
  /** Raise a test notice now (notify.ts `sendTest`). */
  onTestNotification?: () => Promise<TestResult>;
  /** Delete a thread or a project with its files as they were sent (blobs no other thread uses). */
  onDeleteThread: (threadId: string) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
  /** Settings → About: the version, Check now and the two update switches (components/Updates.tsx). */
  about?: ReactNode;
  /** The About nav row's dot: a new version is available, ready or failed, or checking has failed for hours. */
  aboutDot?: boolean | 'check-failing';
  /**
   * Settings → General's first row: the version and the sidebar's update
   * action, Check now (components/Updates.tsx GeneralUpdateRow). Absent: none
   * (a page opened over the tailnet).
   */
  updateRow?: ReactNode;
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
  /** Settings → Prompts saved a change: the server's model of it. */
  onPrompts?: (next: InboxPromptsSettings) => void;
}

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
 * Appearance (light, dark, or match this computer; the text size; and the
 * palette for each half, Plannotator's one theme preference, so plan review
 * follows it too), and how the Inbox gets your
 * attention when an agent asks: desktop notifications and the sound.
 */
function GeneralSection({
  settings,
  permission,
  onToggleNotifications,
  notifyReach,
  onTestNotification,
  sound,
  onTakeTour,
  updateRow,
}: {
  onTakeTour?: () => void;
  updateRow?: ReactNode;
  settings: SettingsModel;
  permission: NotificationPermission | 'unsupported';
  onToggleNotifications: (next: boolean) => void;
  notifyReach?: InboxNotifyReach | null;
  onTestNotification?: () => Promise<TestResult>;
  sound?: InboxSound;
}) {
  const { mode, shown, choose } = useInboxTheme();
  const textSize = useInboxTextSize();
  const notificationsOn = settings.notifications.enabled && permission === 'granted';
  const status = notifyStatusKind(settings.notifications.enabled, permission);
  const browser = browserName();
  const address = typeof window !== 'undefined' ? window.location.host : '';
  const [tested, setTested] = useState<TestResult | null>(null);
  const reach = notifyReach ?? settings.notify_reach ?? null;
  const reachLine =
    permission === 'unsupported'
      ? null
      : reachText({ here: notificationsOn, enabled: settings.notifications.enabled, reach, origin: typeof window !== 'undefined' ? window.location.origin : '' });
  return (
    <>
      {updateRow}
      {onTakeTour && (
        <section className="ib-sgroup" data-settings-tour="" aria-labelledby="ib-g-start">
          <h2 id="ib-g-start">Getting started</h2>
          <div className="ib-card">
            <div className="ib-prow">
              <span className="ib-txt">
                <span className="ib-l">Tour</span>
                <span className="ib-desc">See how the Inbox works through real threads from building Plannotator · 2 min</span>
              </span>
              <span className="ib-ctl">
                <button type="button" className="ib-btn" onClick={onTakeTour} data-settings-take-tour="">
                  <Icon name="play" size={14} />
                  Take the tour
                </button>
              </span>
            </div>
          </div>
        </section>
      )}
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
          <div className="ib-prow" data-settings-text-size={textSize}>
            <span className="ib-txt">
              <span className="ib-l" id="ib-text-size-label">
                Text size
              </span>
              <span className="ib-desc">{textSize === 14 ? 'The default. Applies to the whole Inbox.' : 'Applies to the whole Inbox; 14 is the default.'}</span>
            </span>
            <span className="ib-ctl">
              <span className="ib-seg" role="radiogroup" aria-labelledby="ib-text-size-label">
                {INBOX_TEXT_SIZES.map((size) => (
                  <label key={size} className="ib-seg-o" data-on={textSize === size ? '' : undefined}>
                    <input
                      type="radio"
                      name="ib-text-size"
                      value={size}
                      checked={textSize === size}
                      aria-label={`${size} px`}
                      onChange={() => void chooseTextSize(size)}
                    />
                    {size}
                  </label>
                ))}
              </span>
            </span>
          </div>
          <PaletteRow />
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
              <span className="ib-desc" data-notify-status={status} aria-live="polite">
                {notifyStatusText(status, browser)} ({address}) · new threads and questions
              </span>
            </span>
            <span className="ib-ctl">
              {status === 'not-allowed' && settings.notifications.enabled && (
                <button type="button" className="ib-btn ib-pri ib-sm" data-notify-allow="" onClick={() => onToggleNotifications(true)}>
                  Allow
                </button>
              )}
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
              <span>
                <b>Blocked in {browser} for {address}.</b> {blockedSteps(browser, address)}
              </span>
            </div>
          )}
          {status === 'on' && (
            <div className="ib-prow" data-notify-test="">
              <span className="ib-txt">
                <span className="ib-l">Test notification</span>
                <span className="ib-desc" aria-live="polite">
                  {tested === 'sent'
                    ? testMissHint(browser, isMac())
                    : tested === 'failed'
                      ? 'The browser would not show it. Reload this page and try again.'
                      : tested === 'not-allowed'
                        ? `Not allowed in ${browser} for this address any more.`
                        : `${browser} can say it allows notifications while your system hides them: send one to see.`}
                </span>
              </span>
              <span className="ib-ctl">
                <button
                  type="button"
                  className="ib-btn ib-sm"
                  data-notify-test-send=""
                  disabled={!onTestNotification}
                  onClick={() => void onTestNotification?.().then(setTested)}
                >
                  Send a test notification
                </button>
              </span>
            </div>
          )}
          {reachLine && (
            <div className="ib-prow" data-notify-reach={reachLine.yes ? 'yes' : 'no'}>
              <span className="ib-txt">
                <span className="ib-l">Notifications reach you</span>
                <span className="ib-desc">{reachLine.text} With no Inbox tab open, nothing can notify you.</span>
              </span>
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
 * Capabilities (the owner, 2026-10-27): the switches that turn a whole
 * feature on or off, moved out of General. First the main ones, today the
 * Board (config.json `inboxBoard`, POST /api/inbox/settings `{ board: { on } }`),
 * then the Experimental group ("Experimental just needs to be within
 * Capabilities, under the main list"): each experimental feature's switch,
 * off unless turned on, locked while PLANNOTATOR_EXPERIMENTAL decides; today
 * decision mode. Same words as each had before.
 */
function CapabilitiesSection({
  board,
  onToggleBoard,
  experimental,
  onToggleExperimental,
  experimentalHeading,
}: {
  board: { on: boolean } | null;
  onToggleBoard?: (next: boolean) => void;
  experimental: InboxExperimentalSettings | null;
  onToggleExperimental?: (next: boolean) => void;
  /** The Experimental group's heading, where `#settings/experimental` lands. */
  experimentalHeading: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <>
      {board && onToggleBoard && (
        <section className="ib-sgroup" data-settings-board="" aria-label="Capabilities">
          <div className="ib-card">
            <div className="ib-prow">
              <span className="ib-txt">
                <span className="ib-l" id="ib-board-label">
                  Board
                </span>
                <span className="ib-desc">
                  A page of the work in flight, one card per piece, that your agents keep current. Off, there is no Board page and agents are not offered cards; every card is kept. Agents pick this up in their next session.
                </span>
              </span>
              <span className="ib-ctl">
                <Switch on={board.on} labelledBy="ib-board-label" onClick={() => onToggleBoard(!board.on)} />
              </span>
            </div>
          </div>
        </section>
      )}
      {experimental && onToggleExperimental && (
        <section className="ib-sgroup" data-settings-experimental="" aria-labelledby="ib-g-experimental">
          <h2 id="ib-g-experimental" ref={experimentalHeading} tabIndex={-1}>
            Experimental
          </h2>
          <p>Features still being tried. Each stays off until you turn it on.</p>
          <div className="ib-card">
            <div className="ib-prow">
              <span className="ib-txt">
                <span className="ib-l" id="ib-decision-mode-label">
                  Decision mode
                </span>
                <span className="ib-desc">
                  {experimental.decision_mode.env !== null
                    ? `PLANNOTATOR_EXPERIMENTAL turns it ${experimental.decision_mode.env ? 'on' : 'off'}.`
                    : 'Answer what agents ask in a thread one decision at a time, from its open questions; each agent gets one reply.'}
                </span>
              </span>
              <span className="ib-ctl">
                <Switch
                  on={experimental.decision_mode.on}
                  labelledBy="ib-decision-mode-label"
                  disabled={experimental.decision_mode.env !== null}
                  onClick={() => onToggleExperimental(!experimental.decision_mode.on)}
                />
              </span>
            </div>
          </div>
        </section>
      )}
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
  prompts: "What Plannotator tells your agents. A change applies to each agent's next session.",
  devices: 'Your phone, and browsers on your other devices.',
  archived: 'Threads you archived stay out of the list. Unarchive one to put it back and open it.',
  storage: '',
  about: 'The version, and how Plannotator keeps itself up to date.',
  capabilities: 'What the Inbox does beyond your messages. Each switch turns a whole feature on or off.',
};

/**
 * Settings (design of record `.product/approved/inbox-settings-tabs/`,
 * Workspaces' SettingsFrame in the Inbox's scale): a focused page with
 * "← Inbox" on top, a section nav (General, Agents, Prompts, Devices,
 * Capabilities, Archived, Storage, About) and one
 * section per page at `#settings/<section>`. On a phone, a list of the
 * sections, then one
 * section with "‹ Settings".
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
    notifyReach,
    onTestNotification,
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
  const palettes = useInboxPalettes();
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

  // `#settings/experimental` (an old link): once the group is drawn (the settings may still be loading), bring it into
  // view and focus its heading, after the section's own heading took focus above. The landing is kept until it
  // happens, even if the route is read again meanwhile, and dropped when another section opens.
  const experimentalHeading = useRef<HTMLHeadingElement | null>(null);
  const landing = useRef(false);
  const landAsked = useRef(false);
  if (props.landOnExperimental && !landAsked.current) landing.current = true;
  landAsked.current = props.landOnExperimental === true;
  if (section !== 'capabilities') landing.current = false;
  const experimentalShown = section === 'capabilities' && !!settings?.experimental && !!props.onToggleExperimental;
  useEffect(() => {
    if (!landing.current || !experimentalShown || !experimentalHeading.current) return;
    landing.current = false;
    experimentalHeading.current.scrollIntoView?.({ block: 'start' });
    experimentalHeading.current.focus({ preventScroll: true });
  }, [props.landOnExperimental, experimentalShown]);

  // Capabilities holds the Board and, below it, the Experimental group. Its row shows only while the Inbox has one
  // of them (an older Inbox has neither, and an empty page is worse than no row); its address still opens.
  const experimental = settings?.experimental && props.onToggleExperimental ? settings.experimental : null;
  const board = settings?.board && props.onToggleBoard ? settings.board : null;
  const sections = SETTINGS_SECTIONS.filter((id) => id !== 'capabilities' || board !== null || experimental !== null);
  /** The phone's list of sections, in its groups: settings (Capabilities last of them), then your data and Plannotator. */
  const phoneGroups: { label: string; ids: SettingsSection[] }[] = [
    { label: 'Settings', ids: sections.filter((id) => SETTINGS_SECTIONS.indexOf(id) <= SETTINGS_SECTIONS.indexOf('capabilities')) },
    { label: 'Your data and Plannotator', ids: sections.filter((id) => id === 'archived' || id === 'storage' || id === 'about') },
  ].filter((group) => group.ids.length > 0);

  const devicesDot = devicesNeedAttention(phonesOn ? phones : null, settings?.tailscale);
  const loadFailed = !settings && error !== null;

  const go = (next: SettingsSection | null) => (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onSection?.(next);
  };

  const badge = (id: SettingsSection): ReactNode => {
    if (id === 'archived' && archivedTotal) return <span className="ib-scount">{formatCount(archivedTotal)}</span>;
    if (id === 'about' && aboutDot)
      return <span className="ib-dot" aria-label={aboutDot === 'check-failing' ? 'Checking for updates is failing' : 'A new version is available'} role="img" />;
    if (id === 'devices' && devicesDot) return <span className="ib-dot ib-warn" aria-label="Something here is not working" role="img" />;
    if (id === 'agents' && agentsNeedRestart(props.agents)) return <span className="ib-dot ib-warn" aria-label="Sessions need a reload" role="img" data-agents-dot="" />;
    return null;
  };

  /** The phone list's value beside each section. */
  const value = (id: SettingsSection): string => {
    if (!settings) return '';
    switch (id) {
      case 'general': {
        const modeLabel = mode === 'system' ? 'Match system' : mode === 'light' ? 'Light' : 'Dark';
        // The palette on screen, unless both halves are still the default one.
        const shownPalette = palettes.pair[palettes.shown];
        const defaults = palettes.pair.light === DEFAULT_COLOR_THEME && palettes.pair.dark === DEFAULT_COLOR_THEME;
        return defaults ? modeLabel : `${modeLabel} · ${palettes.nameOf(shownPalette)}`;
      }
      case 'agents': {
        if (props.agents) {
          const connected = props.agents.agents.filter((row) => row.detected && row.reach.on).map((row) => row.label);
          return connected.length === 0 ? 'None' : connected.length === 1 ? connected[0]! : `${connected.length} agents`;
        }
        const on = TOOL_HOSTS.filter(({ host }) => settings.inbox_tool.hosts[host]).map(({ name }) => name);
        return on.length === 0 ? 'Off' : on.length === 1 ? on[0]! : `${on.length} agents`;
      }
      case 'prompts':
        return settings.prompts ? promptsSummary(settings.prompts) : '';
      case 'devices':
        if (phonesOn && phones.devices && phones.devices.length > 0) return plural(phones.devices.length, 'phone');
        return settings.tailscale?.on ? 'Over your tailnet' : '';
      case 'archived':
        return archivedTotal ? formatCount(archivedTotal) : '';
      case 'storage':
        return formatBytes(settings.store.bytes);
      case 'about':
        return settings.version;
      case 'capabilities': {
        // What is on, by name: "Off", "Board", "Decision mode", or "2 on".
        const on = [board?.on ? 'Board' : null, experimental?.decision_mode.on ? 'Decision mode' : null].filter((name): name is string => name !== null);
        return on.length === 0 ? 'Off' : on.length === 1 ? on[0]! : `${on.length} on`;
      }
    }
  };

  let body: ReactNode = null;
  if (section && settings) {
    switch (section) {
      case 'general':
        body = (
          <GeneralSection
            settings={settings}
            permission={permission}
            onToggleNotifications={onToggleNotifications}
            notifyReach={notifyReach}
            onTestNotification={onTestNotification}
            sound={sound}
            onTakeTour={props.onTakeTour}
            updateRow={props.updateRow}
          />
        );
        break;
      case 'agents':
        body = <AgentsSection settings={settings} context={context} onToggleTool={onToggleTool} agents={props.agents} onAgents={props.onAgents} />;
        break;
      case 'prompts':
        body = settings.prompts ? (
          <PromptsSection prompts={settings.prompts} onPrompts={props.onPrompts} configFile={`${settings.data_dir}/config.json`} home={settings.home} />
        ) : (
          <div className="ib-card ib-sempty">
            <Icon name="prompt" />
            This Inbox is older than Settings → Prompts. Restart it to update.
          </div>
        );
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
      case 'capabilities':
        body =
          (board && props.onToggleBoard) || experimental ? (
            <CapabilitiesSection
              board={board}
              onToggleBoard={props.onToggleBoard}
              experimental={experimental}
              onToggleExperimental={props.onToggleExperimental}
              experimentalHeading={experimentalHeading}
            />
          ) : (
            <div className="ib-card ib-sempty" data-settings-capabilities-none="">
              <Icon name="puzzle" />
              This Inbox is older than Settings → Capabilities. Restart it to update.
            </div>
          );
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
        {phoneGroups.map((group) => (
          <ul className="ib-card" key={group.label} aria-label={group.label}>
            {group.ids.map((id) => (
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
                {sections.map((id) => (
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
