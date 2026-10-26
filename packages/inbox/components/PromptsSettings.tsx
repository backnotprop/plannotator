import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  INBOX_PROMPT_HOSTS,
  type InboxPromptHost,
  type InboxPromptItem,
  type InboxPromptsChange,
  type InboxPromptsSettings,
} from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { tildePath } from '../format';
import { HostMark, Icon } from '../icons';
import { Tip } from './Tip';

/**
 * Settings → Prompts (design of record `.product/approved/inbox-prompts-page/`,
 * issue #2194): what Plannotator tells agents.
 *
 * The Inbox reminder first: the text in effect, always in full, marked
 * Default or Custom. Edit turns it into a field (Save, Cancel); once custom,
 * Reset to default and a "Show default" disclosure. Below it, in the same
 * card, each agent: the shared text, or its own (which wins). The page writes
 * only config.json `prompts.inbox` (Reset and Use shared delete the key);
 * whether the reminder is sent stays `inboxReminder`, in Settings → Agents.
 *
 * Then the plan, review and annotate prompts, read-only, folded into one row.
 */

const AGENT_NAME: Record<InboxPromptHost, string> = { 'claude-code': 'Claude Code', pi: 'Pi', opencode: 'OpenCode' };

/** The count shows from here; past `max` Save is refused. */
export const PROMPT_COUNT_FROM = 3700;

type Slot = 'shared' | InboxPromptHost;

/** The phone's list of sections: Default, or Custom once any reminder text is the person's own. */
export function promptsSummary(prompts: InboxPromptsSettings): string {
  const { shared, runtimes } = prompts.reminder;
  return shared !== null || INBOX_PROMPT_HOSTS.some((host) => runtimes[host] !== null) ? 'Custom' : 'Default';
}

function Chip({ custom }: { custom: boolean }) {
  return <span className={`ib-chip${custom ? ' pm-custom' : ''}`}>{custom ? 'Custom' : 'Default'}</span>;
}

function Chevron() {
  return <Icon name="chevR" />;
}

export function PromptsSection({
  prompts,
  onPrompts,
  configFile = '~/.plannotator/config.json',
  home = null,
}: {
  prompts: InboxPromptsSettings;
  onPrompts?: (next: InboxPromptsSettings) => void;
  /** Where config.json is, in full. */
  configFile?: string;
  /** The home folder, shown as `~` in the config.json path (the full path in a tooltip). */
  home?: string | null;
}) {
  const { reminder } = prompts;
  const id = useId();
  const [editing, setEditing] = useState<Slot | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ slot: Slot; text: string } | null>(null);
  const [showDefault, setShowDefault] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  /** After Save, Cancel, Reset or Use shared: the control focus goes back to. */
  const focusAfter = useRef<string | null>(null);

  const defaultText = reminder.defaults.wake;
  const sharedText = reminder.shared ?? defaultText;
  /** An agent's default: the no-wake line where its reply does not come back by itself (OpenCode 1). */
  const wakes = (host: InboxPromptHost) => reminder.wakes?.[host] !== false;
  const agentDefault = (host: InboxPromptHost) => (wakes(host) ? defaultText : reminder.defaults.no_wake);
  /** What an agent gets now: its own text, else the shared text, else its own default. */
  const effectiveOf = (host: InboxPromptHost) => reminder.runtimes[host] ?? reminder.shared ?? agentDefault(host);
  const currentOf = (slot: Slot) => (slot === 'shared' ? sharedText : effectiveOf(slot));
  const overShared = reminder.over?.shared ?? null;
  /** A calm line for text config.json holds over the limit (ignored, so the next text in line goes). */
  const overNote = (length: number, slot: Slot) => (
    <p className="pm-over" data-prompt-over={slot}>
      The text in config.json is {length.toLocaleString('en-US')} characters, over the {reminder.max.toLocaleString('en-US')} limit, so it is ignored.
    </p>
  );

  // A field that opens takes focus with the caret at its end, sized to its text.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 320)}px`;
  }, [editing, draft]);
  useEffect(() => {
    const el = field.current;
    if (!editing || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);
  useEffect(() => {
    if (!focusAfter.current) return;
    const target = root.current?.querySelector<HTMLElement>(focusAfter.current);
    focusAfter.current = null;
    target?.focus();
  });

  const save = async (slot: Slot, text: string | null, refocus: string) => {
    setSaving(true);
    setError(null);
    const change: InboxPromptsChange = slot === 'shared' ? { inbox: { reminder: text } } : { inbox: { runtimes: { [slot]: { reminder: text } } } };
    try {
      const saved = await inboxApi.savePrompts(change);
      onPrompts?.(saved.prompts);
      setEditing(null);
      focusAfter.current = refocus;
    } catch (cause) {
      setError({ slot, text: cause instanceof Error ? cause.message : 'The reminder was not saved.' });
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (slot: Slot) => {
    setError(null);
    setDraft(currentOf(slot));
    setEditing(slot);
  };
  const cancel = (slot: Slot) => {
    setEditing(null);
    setError(null);
    focusAfter.current = `[data-prompt-edit="${slot}"]`;
  };

  const errorLine = (slot: Slot): ReactNode =>
    error?.slot === slot ? (
      <p className="pm-err" role="alert" data-prompt-error={slot}>
        {error.text}
      </p>
    ) : null;

  const editor = (slot: Slot) => {
    const length = draft.length;
    const over = length > reminder.max;
    const own = slot === 'shared' ? reminder.shared : reminder.runtimes[slot];
    const changed = draft !== currentOf(slot) || (slot !== 'shared' && own === null);
    const can = draft.trim() !== '' && !over && changed && !saving;
    const countId = `${id}-count-${slot}`;
    const submit = () => {
      if (!can) return;
      const text = draft.trim() ? draft : null;
      // Saving Plannotator's own text as the shared text is the default again: the key goes.
      void save(slot, slot === 'shared' && text === defaultText ? null : text, `[data-prompt-edit="${slot}"]`);
    };
    return (
      <>
        <textarea
          ref={field}
          className="pm-area"
          value={draft}
          aria-label={slot === 'shared' ? 'Inbox reminder' : `Inbox reminder for ${AGENT_NAME[slot]}`}
          aria-describedby={length >= PROMPT_COUNT_FROM ? countId : undefined}
          aria-invalid={over || undefined}
          data-prompt-field={slot}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="pm-acts">
          <button type="button" className="ib-btn ib-sm ib-pri" disabled={!can} onClick={submit} data-prompt-save={slot}>
            Save
          </button>
          <button type="button" className="ib-btn ib-sm ib-ghost pm-ghost" onClick={() => cancel(slot)} data-prompt-cancel={slot}>
            Cancel
          </button>
          <span className="pm-sp" />
          {length >= PROMPT_COUNT_FROM && (
            <span className="pm-count" id={countId} data-over={over || undefined} data-prompt-count="">
              {length.toLocaleString('en-US')} / {reminder.max.toLocaleString('en-US')}
            </span>
          )}
        </div>
        {errorLine(slot)}
      </>
    );
  };

  const sharedCustom = reminder.shared !== null;
  const sharedEditing = editing === 'shared';
  const defaultId = `${id}-default`;

  const shared = (
    <div className="pm-shared" data-prompt-slot="shared">
      <div className="pm-head">
        <Chip custom={sharedCustom} />
        <span className="pm-sp" />
        {reminder.editable && !sharedEditing && (
          <>
            {(sharedCustom || overShared !== null) && (
              <Tip content="Delete prompts.inbox.reminder: every agent gets Plannotator's text again">
                <button
                  type="button"
                  className="ib-btn ib-sm ib-ghost pm-ghost"
                  disabled={saving}
                  onClick={() => {
                    setShowDefault(false);
                    void save('shared', null, '[data-prompt-edit="shared"]');
                  }}
                  data-prompt-reset=""
                >
                  Reset to default
                </button>
              </Tip>
            )}
            <button type="button" className="ib-btn ib-sm" onClick={() => startEdit('shared')} data-prompt-edit="shared" aria-label="Edit the Inbox reminder">
              Edit
            </button>
          </>
        )}
      </div>
      {sharedEditing ? (
        editor('shared')
      ) : (
        <>
          <p className="pm-text" data-prompt-text="shared">
            {sharedText}
          </p>
          {!sharedCustom && overShared !== null && overNote(overShared, 'shared')}
          {sharedCustom && (
            <>
              <button type="button" className="pm-disc" aria-expanded={showDefault} aria-controls={defaultId} onClick={() => setShowDefault((open) => !open)} data-prompt-show-default="">
                <Chevron />
                Show default
              </button>
              {showDefault && (
                <p className="pm-text pm-faint" id={defaultId} aria-label="Default text" data-prompt-default="">
                  {defaultText}
                </p>
              )}
            </>
          )}
          {errorLine('shared')}
        </>
      )}
    </div>
  );

  const agent = (host: InboxPromptHost) => {
    const own = reminder.runtimes[host];
    const isEditing = editing === host;
    const name = AGENT_NAME[host];
    const over = own === null ? (reminder.over?.runtimes[host] ?? null) : null;
    // OpenCode 1 with nothing custom: its own default (the no-wake line), shown, since it differs from the one above.
    const ownDefault = own === null && reminder.shared === null && !wakes(host);
    const status = own !== null ? 'Own text' : ownDefault ? 'Uses the default for OpenCode 1' : 'Uses the shared text';
    return (
      <div className="pm-ag" data-agent={host} data-prompt-slot={host} key={host}>
        <div className="ib-prow">
          <HostMark host={host} big />
          <span className="ib-txt">
            <span className="ib-l">{name}</span>
            <span className="ib-desc" data-prompt-status={host}>
              {status}
              {!reminder.on[host] && (
                <>
                  {' · Reminder off in '}
                  <a href="#settings/agents" data-prompt-agents-link="">
                    Agents
                  </a>
                </>
              )}
            </span>
          </span>
          <span className="ib-ctl">
            {reminder.editable && !isEditing && (
              <>
                {(own !== null || over !== null) && (
                  <Tip content={`Delete ${name}'s own text: it gets the shared text again`}>
                    <button
                      type="button"
                      className="ib-btn ib-sm ib-ghost pm-ghost"
                      disabled={saving}
                      onClick={() => void save(host, null, `[data-prompt-edit="${host}"]`)}
                      data-prompt-use-shared={host}
                    >
                      Use shared
                    </button>
                  </Tip>
                )}
                <button
                  type="button"
                  className={`ib-btn ib-sm${own !== null ? '' : ' ib-ghost pm-ghost'}`}
                  onClick={() => startEdit(host)}
                  data-prompt-edit={host}
                  aria-label={`Edit the Inbox reminder for ${name}`}
                >
                  Edit
                </button>
              </>
            )}
          </span>
        </div>
        {isEditing ? (
          <div className="pm-ag-body">{editor(host)}</div>
        ) : own !== null || ownDefault ? (
          <div className="pm-ag-body">
            <p className={`pm-text${ownDefault ? ' pm-faint' : ''}`} data-prompt-text={host}>
              {own ?? agentDefault(host)}
            </p>
            {over !== null && overNote(over, host)}
            {errorLine(host)}
          </div>
        ) : over !== null || error?.slot === host ? (
          <div className="pm-ag-body">
            {over !== null && overNote(over, host)}
            {errorLine(host)}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div ref={root} data-prompts-page="">
      <section className="ib-sgroup ib-sgroup-first" aria-labelledby={`${id}-rem`}>
        <h2 id={`${id}-rem`}>Inbox reminder</h2>
        <p>{reminder.editable ? 'Sent once, when a session starts.' : 'Sent once, when a session starts. Change it on this computer.'}</p>
        <div className="ib-card">
          {shared}
          {INBOX_PROMPT_HOSTS.map(agent)}
        </div>
      </section>
      <OtherPrompts others={prompts.others} open={otherOpen} onToggle={() => setOtherOpen((open) => !open)} configFile={configFile} home={home} />
    </div>
  );
}

function OtherPrompts({ others, open, onToggle, configFile, home }: { others: InboxPromptItem[]; open: boolean; onToggle: () => void; configFile: string; home: string | null }) {
  const shown = tildePath(configFile, home);
  const id = useId();
  const customs = others.filter((item) => item.custom).length;
  const groups: { label: string; items: InboxPromptItem[] }[] = [];
  for (const item of others) {
    const last = groups[groups.length - 1];
    if (last && last.label === item.group_label) last.items.push(item);
    else groups.push({ label: item.group_label, items: [item] });
  }
  const agents = (runtimes: string[]) =>
    runtimes.map((runtime) => AGENT_NAME[runtime as InboxPromptHost] ?? runtime).join(', ');
  return (
    <section className="ib-sgroup" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Plan, review and annotate</h2>
      <p>
        Read-only here. Set them in{' '}
        {shown === configFile ? (
          <code className="pm-path" data-prompts-config-path="">{shown}</code>
        ) : (
          <Tip content={configFile}>
            <code className="pm-path" data-prompts-config-path="">{shown}</code>
          </Tip>
        )}
        .
      </p>
      <div className="ib-card">
        <button type="button" className="pm-fold" aria-expanded={open} aria-controls={`${id}-list`} onClick={onToggle} data-prompts-fold="">
          <Chevron />
          {others.length} prompts
          <span className="ib-mut">{customs ? `· ${customs} custom` : '· all default'}</span>
        </button>
        {open && (
          <div id={`${id}-list`} data-prompts-list="">
            {groups.map((group) => (
              <div className="pm-osec" key={group.label}>
                <h3>{group.label}</h3>
                {group.items.map((item) => (
                  <div className="pm-oitem" key={item.key} data-prompt-key={item.key}>
                    <div className="pm-ohead">
                      <b>{item.label}</b>
                      <Chip custom={item.custom} />
                      <code>{item.key}</code>
                    </div>
                    <pre className="pm-otext">{item.text}</pre>
                    {item.runtimes.length > 0 && <p className="pm-onote">{agents(item.runtimes)}: own text in config.json.</p>}
                    {item.note && !item.custom && <p className="pm-onote">{item.note}</p>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
