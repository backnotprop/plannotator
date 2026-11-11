import { useEffect, useId, useRef, useState } from 'react';
import { INBOX_PROMPT_HOSTS, type InboxPromptHost, type InboxPromptsChange, type InboxPromptsSettings } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { RULE_EXAMPLES, RULES_COUNT_WITHIN, takeRulesEditorWish, withRuleExample } from '../agentRules';
import { HostMark, Icon } from '../icons';
import { usePhone } from '../phone';
import { Modal } from './Updates';

/**
 * Settings → Prompts, on top: "Rules for your agents" (#2194). The person's own rules, ADDED after the reminder
 * (Plannotator's text stays): one box for all agents, or an agent's own (it wins, as the reminder's own text does).
 * The card shows what is set; Add rules / Edit opens the editor, a dialog (at the bottom on a phone) with one text box,
 * examples a tap adds, "For" and Back to default. Writes only config.json `prompts.inbox` `rules`.
 */

type Rules = NonNullable<InboxPromptsSettings['rules']>;
type Slot = 'shared' | InboxPromptHost;

const AGENT_NAME: Record<InboxPromptHost, string> = { 'claude-code': 'Claude Code', pi: 'Pi', opencode: 'OpenCode' };
const SLOTS: Slot[] = ['shared', ...INBOX_PROMPT_HOSTS];
const slotName = (slot: Slot) => (slot === 'shared' ? 'All agents' : AGENT_NAME[slot]);

export function AgentRulesSection({
  rules,
  editable,
  onPrompts,
}: {
  rules: Rules;
  editable: boolean;
  onPrompts?: (next: InboxPromptsSettings) => void;
}) {
  const id = useId();
  const [editing, setEditing] = useState<Slot | null>(null);
  const textOf = (slot: Slot) => (slot === 'shared' ? rules.shared : rules.runtimes[slot]);
  const set = SLOTS.filter((slot) => textOf(slot) !== null);
  // "Add your rules" in the "Set the rules" dialog lands here with the editor open.
  useEffect(() => {
    if (editable && takeRulesEditorWish()) setEditing('shared');
  }, [editable]);

  return (
    <section className="ib-sgroup ib-sgroup-first" aria-labelledby={`${id}-h`} data-rules-section="">
      <h2 id={`${id}-h`}>Rules for your agents</h2>
      <p>Your own words, added to what agents are told. Plannotator's text stays.</p>
      <div className="ib-card">
        {set.length === 0 ? (
          <div className="ar-empty">
            <span className="ar-ic" aria-hidden="true">
              <Icon name="prompt" size={17} />
            </span>
            <span className="ar-t">
              <span className="ar-l">No rules yet</span>
              <span className="ar-d">Like “Only message me when you are blocked or done”</span>
            </span>
            {editable && (
              <button type="button" className="ib-btn ib-sm ib-pri" onClick={() => setEditing('shared')} data-rules-add="">
                Add rules
              </button>
            )}
          </div>
        ) : (
          set.map((slot) => (
            <div className="pm-shared ar-slot" key={slot} data-rules-slot={slot}>
              <div className="pm-head">
                {slot === 'shared' ? <span className="ib-chip pm-custom">All agents</span> : <span className="ar-who"><HostMark host={slot} />{AGENT_NAME[slot]}</span>}
                <span className="pm-sp" />
                {editable && (
                  <button type="button" className="ib-btn ib-sm" onClick={() => setEditing(slot)} data-rules-edit={slot} aria-label={`Edit the rules for ${slotName(slot).toLowerCase()}`}>
                    Edit
                  </button>
                )}
              </div>
              <p className="pm-text" data-rules-text={slot}>
                {textOf(slot)}
              </p>
              {slot !== 'shared' && rules.dropped.includes(slot) && <DroppedNote hosts={[slot]} />}
              {slot === 'shared' && <DroppedNote hosts={rules.dropped.filter((host) => rules.runtimes[host] === null)} />}
            </div>
          ))
        )}
      </div>
      {editing && <RulesEditor rules={rules} first={editing} onClose={() => setEditing(null)} onPrompts={onPrompts} />}
    </section>
  );
}

/** Rules that, with the reminder they follow, are over the cap: said, never cut. */
function DroppedNote({ hosts }: { hosts: InboxPromptHost[] }) {
  if (hosts.length === 0) return null;
  return (
    <p className="pm-over" data-rules-dropped="">
      Not sent to {hosts.map((host) => AGENT_NAME[host]).join(', ')}: with the reminder they are too long. Shorten one.
    </p>
  );
}

function RulesEditor({ rules, first, onClose, onPrompts }: { rules: Rules; first: Slot; onClose: () => void; onPrompts?: (next: InboxPromptsSettings) => void }) {
  const phone = usePhone();
  const [slot, setSlot] = useState<Slot>(first);
  const saved = (which: Slot) => (which === 'shared' ? rules.shared : rules.runtimes[which]) ?? '';
  const [draft, setDraft] = useState(saved(first));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const room = slot === 'shared' ? rules.room.shared : rules.room.runtimes[slot];
  const length = draft.trim().length;
  const over = length > room;
  const own = saved(slot) !== '';
  const can = !saving && !over && draft.trim() !== saved(slot).trim() && draft.trim() !== '';

  const write = async (text: string | null) => {
    setSaving(true);
    setError(null);
    const change: InboxPromptsChange = slot === 'shared' ? { inbox: { rules: text } } : { inbox: { runtimes: { [slot]: { rules: text } } } };
    try {
      const next = await inboxApi.savePrompts(change);
      onPrompts?.(next.prompts);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The rules were not saved.');
      setSaving(false);
    }
  };
  const pick = (next: Slot) => {
    setSlot(next);
    setDraft(saved(next));
    setError(null);
  };
  const add = (example: string) => {
    setDraft((text) => withRuleExample(text, example));
    field.current?.focus();
  };

  return (
    <Modal labelledBy="ar-ed-title" describedBy="ar-ed-desc" testId="rules-editor" onClose={onClose} ownKeys initialFocus=".pm-area" className={`ib-bi ar-ed${phone ? ' ib-bi-phone' : ''}`}>
      <div className="ib-bi-text">
        <h2 id="ar-ed-title">Rules for your agents</h2>
        <p id="ar-ed-desc">Added to what agents are told about your Inbox. Plannotator's own text stays.</p>
        <textarea
          ref={field}
          className="pm-area ar-area"
          value={draft}
          rows={4}
          placeholder="Write your rules in your own words, one per line"
          aria-label={`Rules for ${slotName(slot).toLowerCase()}`}
          aria-invalid={over || undefined}
          onChange={(event) => setDraft(event.target.value)}
          data-rules-field=""
        />
        <div className="ar-lbl" id="ar-ex">Tap to add</div>
        <div className="ar-chips" role="group" aria-labelledby="ar-ex">
          {RULE_EXAMPLES.map((example) => (
            <button type="button" className="ar-chip" key={example} data-used={draft.includes(example) || undefined} onClick={() => add(example)} data-rules-example="">
              <b aria-hidden="true">+</b>
              {example.replace(/\.$/, '')}
            </button>
          ))}
        </div>
        <div className="ar-lbl" id="ar-for">For</div>
        <div className="ar-seg" role="group" aria-labelledby="ar-for">
          {SLOTS.map((which) => (
            <button type="button" key={which} aria-pressed={which === slot} onClick={() => pick(which)} data-rules-for={which}>
              {slotName(which)}
            </button>
          ))}
        </div>
        <p className="ar-quiet">
          {slot === 'shared' ? 'Each agent gets them from its next session.' : `${AGENT_NAME[slot]} gets these instead of the ones for all agents, from its next session.`}
          {length >= room - RULES_COUNT_WITHIN && (
            <span className="pm-count" data-over={over || undefined} data-rules-count="">
              {' '}
              {length.toLocaleString('en-US')} / {room.toLocaleString('en-US')}
            </span>
          )}
        </p>
        {error && (
          <p className="pm-err" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="ib-bi-acts">
        {own && (
          <button type="button" className="ib-btn ib-ghost" disabled={saving} onClick={() => void write(null)} data-rules-reset="">
            Back to default
          </button>
        )}
        <span className="ib-bsp" />
        <button type="button" className="ib-btn ib-ghost" onClick={onClose} data-rules-cancel="">
          Cancel
        </button>
        <button type="button" className="ib-btn ib-pri" disabled={!can} onClick={() => void write(draft.trim())} data-rules-save="">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
