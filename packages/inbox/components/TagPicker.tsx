/**
 * The `@` picker and the notes under a composer that tags agents (approval
 * "inbox-tag-agents", Lines variant). The picker is a listbox of the live
 * sessions grouped by agent (the owner first, "Owns this thread"), then the
 * agents that read the Inbox only ("Reads the Inbox, not woken"). It follows
 * the skill picker's rules, driven by ui's `useMentionAutocomplete`: nothing
 * is active until arrowed onto, so Enter, Tab and Mod+Enter keep their
 * meaning; Escape closes it before the reply box. `@` is a composer trigger,
 * never a shortcut.
 *
 * TagNotes: "Goes to" with a chip per recipient, and one heads-up per tag
 * that does not own the thread (a different one for an agent that can't be
 * woken). Plain text, linked to the field by `aria-describedby`; they never
 * block Send.
 */
import { useCallback, useEffect, useState } from 'react';
import type { MentionMenuState } from '@plannotator/ui/hooks/useMentionAutocomplete';
import { inboxApi, type TaggableModel } from '../api';
import type { RecipientConnection } from '../deliveryLine';

/** How often an open reply box reads who can be tagged, so a session that started or stopped shows. */
const TAGGABLE_REFRESH_MS = 10_000;

/** Who the person can tag in this thread, read while `enabled` (the reply box or a comment is open). */
export function useTaggable(threadId: string, enabled: boolean) {
  const [model, setModel] = useState<TaggableModel | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await inboxApi.taggable(threadId);
      // Only a well-formed answer: an older Inbox (or a stub) leaves nobody to tag.
      setModel(next && Array.isArray(next.sessions) ? next : null);
    } catch {
      // An older Inbox, or a failed read: nobody to tag; `@` stays text.
    }
  }, [threadId]);
  useEffect(() => {
    if (!enabled) return;
    void load();
    const timer = setInterval(() => void load(), TAGGABLE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, enabled]);
  return model;
}

/**
 * How each tagged session of the person's last reply is connected now (the
 * sessions route's `recipients`), read every few seconds while any of them
 * still waits: each line's "Queued", "Sending" and its own Send now.
 */
export function useTagConnections(threadId: string, sessions: readonly string[], enabled: boolean) {
  const key = sessions.join(',');
  const [connections, setConnections] = useState<Record<string, RecipientConnection | null>>({});
  const load = useCallback(async () => {
    if (!key) return;
    try {
      const model = await inboxApi.sessions(threadId, null, key.split(','));
      setConnections(model.recipients ?? {});
    } catch {
      // Unknown: the lines read "Queued … as its next turn".
    }
  }, [threadId, key]);
  useEffect(() => {
    if (!enabled || !key) return;
    void load();
    const timer = setInterval(() => void load(), 3_000);
    return () => clearInterval(timer);
  }, [load, enabled, key]);
  return { connections, load };
}
import { mentionGroups } from '@plannotator/ui/components/MentionPicker';
import { HostMark, Icon } from '../icons';
import { TAG_READERS_GROUP, TAG_UPDATE_WORDS, tagHeadsUp, tagModeLine, type TagOption } from '../tags';
import type { TagMode } from '../api';

export function TagPicker({
  id,
  menu,
  options,
  onSelect,
}: {
  id: string;
  menu: MentionMenuState;
  options: readonly TagOption[];
  onSelect: (index: number) => void;
}) {
  const byId = new Map(options.map((o) => [o.id, o]));
  return (
    <div className="ib-tg-menu" data-tag-picker="" id={id} role="listbox" aria-label="Tag an agent">
      {menu.items.length === 0 ? (
        <p className="ib-tg-empty">{menu.emptyNotice ?? 'No agent matches.'}</p>
      ) : (
        mentionGroups(menu.items).map((run) => {
          const headingId = `${id}-group-${run.start}`;
          return (
            <div key={`${run.group}-${run.start}`} className="ib-tg-group" role="group" aria-labelledby={headingId} data-tag-group={run.group}>
              <div className="ib-tg-gh" id={headingId}>
                {run.group}
              </div>
              {run.people.map((person, offset) => {
                const index = run.start + offset;
                const option = byId.get(person.id);
                const reader = option?.group === TAG_READERS_GROUP;
                const blocked = option?.taggable === false;
                return (
                  <div
                    key={person.id}
                    id={`${id}-option-${index}`}
                    role="option"
                    aria-selected={menu.activeIndex === index}
                    aria-disabled={blocked || undefined}
                    className={`ib-tg-opt${reader ? ' ib-tg-reader' : ''}${blocked ? ' ib-tg-blocked' : ''}`}
                    data-tag-option={person.id}
                    // The pick runs before the textarea loses focus, or the blur would close the menu.
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onSelect(index);
                    }}
                  >
                    <HostMark host={option?.host ?? null} big />
                    <span className="ib-tg-ol">
                      <span className="ib-tg-on">{person.label}</span>
                      <span className="ib-tg-od">{blocked ? TAG_UPDATE_WORDS : person.detail}</span>
                    </span>
                    {option?.owner && <span className="ib-tg-badge">Owns this thread</span>}
                    {reader && !option?.owner && <span className="ib-tg-badge ib-tg-quiet">Not woken</span>}
                    {blocked && <span className="ib-tg-badge ib-tg-quiet">Update</span>}
                  </div>
                );
              })}
            </div>
          );
        })
      )}
    </div>
  );
}

/**
 * Several agents on one thread (Lines): their marks overlapping, the first
 * agent first. Decorative: the words beside it (or the row's label) name them.
 * At most four marks; more read as "+N". (A list row draws its agents with
 * `RowAgents`, approval "list-rows-mail-icons".)
 */
export function TagStack({ participants }: { participants: readonly { host: string | null; session: string }[] }) {
  const shown = participants.slice(0, 4);
  const more = participants.length - shown.length;
  return (
    <span className="ib-tg-stack" aria-hidden="true" data-tag-stack={participants.length}>
      {shown.map((p) => (
        <HostMark key={p.session} host={p.host} />
      ))}
      {more > 0 && <span className="ib-tg-plus">+{more}</span>}
    </span>
  );
}

/** "Goes to" and the heads-ups, for the tags a draft still carries. Nothing while it tags no one. */
export function TagNotes({
  id,
  tagged,
  owner,
  where = 'reply',
}: {
  id?: string;
  tagged: readonly TagOption[];
  /** The session the reply goes to anyway, when known. */
  owner: TagOption | null;
  where?: 'reply' | 'comment';
}) {
  const others = tagged.filter((t) => !t.owner);
  if (others.length === 0) return null;
  const recipients = [...(owner ? [owner] : []), ...others];
  return (
    <div className="ib-tg-notes" id={id} data-tag-notes="">
      <div className="ib-tg-goes" data-tag-goes="">
        <span className="ib-tg-goes-l">Goes to</span>
        {recipients.map((r) => (
          <span key={r.id} className="ib-tg-to" data-tag-recipient={r.id}>
            <HostMark host={r.host} />
            <span>
              {r.label}
              {r.owner && <i> owns this thread</i>}
            </span>
          </span>
        ))}
      </div>
      {others.map((t) => (
        <p key={t.id} className={`ib-tg-note${t.wakes ? '' : ' ib-tg-warn'}`} data-tag-heads-up={t.wakes ? 'non-owner' : 'not-woken'}>
          <Icon name={t.wakes ? 'info' : 'eyeOff'} size={14} />
          <span>
            <b>{t.label}</b> {tagHeadsUp(t, where).slice(t.label.length + 1)}
          </span>
        </p>
      ))}
    </div>
  );
}

/**
 * The reply box's one line once it tags agents that do not own the thread
 * (approval "inbox-tag-handoff", A2), in place of "Goes to" and the
 * heads-ups: what Send does with them, and the links that switch it ("Asks
 * Claude Code (herdr) · Add instead · Hand off instead"). Plain buttons in
 * the tab order after the field; no shortcut. The words are a polite live
 * region, so a switch is heard.
 */
export function TagModeNote({ id, tagged, mode, onMode }: { id?: string; tagged: readonly TagOption[]; mode: TagMode; onMode: (mode: TagMode) => void }) {
  const line = tagModeLine(tagged, mode);
  if (!line) return null;
  const icon = line.mode === 'handoff' ? 'forward' : line.mode === 'add' ? 'plus' : 'eye';
  return (
    <p className="ib-tg-mode" id={id} data-tag-mode={line.mode}>
      <Icon name={icon} size={14} />
      <span aria-live="polite" data-tag-mode-words="">
        {line.lead} <b>{line.names}</b>
        {line.after}
      </span>
      {line.links.map((link) => (
        <span key={link.mode} className="ib-tg-mode-opt">
          <span className="ib-tg-mode-sep" aria-hidden="true">
            ·
          </span>
          <button type="button" className="ib-tg-mode-link" data-tag-mode-to={link.mode} onClick={() => onMode(link.mode)}>
            {link.label}
          </button>
        </span>
      ))}
    </p>
  );
}
