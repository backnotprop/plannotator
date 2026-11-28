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
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { MentionMenuState } from '@plannotator/ui/hooks/useMentionAutocomplete';
import { inboxApi, type TaggableModel } from '../api';
import type { RecipientConnection } from '../deliveryLine';
import { useKeptState } from '../data/keptState';
import { pollWhileShown } from '../data/shownPoll';

/** How often an open reply box reads who can be tagged, so a session that started or stopped shows. */
const TAGGABLE_REFRESH_MS = 10_000;

/**
 * Who the person can tag in this thread, read while `enabled` (the reply box or a comment is open), never while the tab
 * is hidden or the pane `parked` (data/shownPoll.ts). The same answer keeps the held one.
 */
export function useTaggable(threadId: string, enabled: boolean, parked = false) {
  const [model, keepModel] = useKeptState<TaggableModel | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await inboxApi.taggable(threadId);
      // Only a well-formed answer: an older Inbox (or a stub) leaves nobody to tag.
      keepModel(next && Array.isArray(next.sessions) ? next : null);
    } catch {
      // An older Inbox, or a failed read: nobody to tag; `@` stays text.
    }
  }, [threadId]);
  useEffect(() => {
    if (!enabled || parked) return;
    return pollWhileShown(() => void load(), TAGGABLE_REFRESH_MS);
  }, [load, enabled, parked]);
  return model;
}

/**
 * How each tagged session of the person's last reply is connected now (the
 * sessions route's `recipients`), read every few seconds while any of them
 * still waits: each line's "Queued", "Sending" and its own Send now.
 */
export function useTagConnections(threadId: string, sessions: readonly string[], enabled: boolean, parked = false) {
  const key = sessions.join(',');
  const [connections, keepConnections] = useKeptState<Record<string, RecipientConnection | null>>({});
  const load = useCallback(async () => {
    if (!key) return;
    try {
      const model = await inboxApi.sessions(threadId, null, key.split(','));
      keepConnections(model.recipients ?? {});
    } catch {
      // Unknown: the lines read "Queued … as its next turn".
    }
  }, [threadId, key]);
  useEffect(() => {
    // Not while the tab is hidden or the pane parked; once the moment it shows again (data/shownPoll.ts).
    if (!enabled || !key || parked) return;
    return pollWhileShown(() => void load(), 3_000);
  }, [load, enabled, key, parked]);
  return { connections, load };
}
import { mentionGroups } from '@plannotator/ui/components/MentionPicker';
import { HostMark, Icon } from '../icons';
import { TAG_READERS_GROUP, TAG_UPDATE_WORDS, tagHeadsUp, tagModeLine, type TagOption } from '../tags';
import type { TagMode } from '../api';
import { seenBox, type VerticalBox } from '../caretMenu';

/** One whole row and the list's padding: the least list ever shown (a sliver of a row is never shown). */
const TAG_LIST_LEAST = 56;

/**
 * Where the menu sits (#3427): ComposerField draws it in FloatingSkillMenu's box, laid over the part of the field the
 * person sees and portaled out of the reply box's scroll region, so nothing cuts it and it hides while the field is out
 * of sight. It hangs above that box (inbox.css), or below it when the list fits only there or there is more room
 * there, and `--ib-tg-room` caps it to that room (`boundary`, the visual viewport under the thread's header) under
 * inbox.css's own caps. Without `boundary` it keeps inbox.css's place.
 *
 * An iPhone with the keyboard up (`data-ib-keyboard-pin`): the thread's foot is a short box that scrolls, and the
 * picker drawn above the field opened behind the header, cut off (approval "inbox-reply-recipient", "fix with it").
 * There it is placed on the screen instead: as wide as the field, above it up to the header, never past it; with no
 * room above the field, over the box from its row (Send's) up.
 */
function useMenuSpot(field: HTMLTextAreaElement | null, boundary?: () => VerticalBox | null) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  // Every commit (the field grows as the person types, the list filters); the equality guard converges.
  useLayoutEffect(() => {
    const menu = ref.current;
    const box = menu?.parentElement?.getBoundingClientRect();
    const foot = field?.closest('.ib-pfoot');
    const wrap = field?.closest('.ib-cfield')?.getBoundingClientRect();
    let next: CSSProperties | undefined;
    if (menu && foot && wrap && document.documentElement.hasAttribute('data-ib-keyboard-pin')) {
      const headBottom = foot.closest('.ib-pane')?.querySelector('.ib-phead')?.getBoundingClientRect().bottom ?? 0;
      // Room above the field: there. With the keyboard leaving ~257 px the field starts under the header, so the list
      // covers the box instead, from just above the box's row (Send's) up to the header (as the recipient list does).
      const above = Math.round(wrap.top - 10);
      const row = foot.querySelector('[data-reply-row]')?.getBoundingClientRect();
      const top = above - headBottom - 8 >= 120 || !row ? above : Math.round(row.top - 6);
      const room = Math.max(88, top - headBottom - 8);
      next = { position: 'fixed', top, left: Math.round(wrap.left), width: Math.round(wrap.width), right: 'auto', bottom: 'auto', margin: 0, transform: 'translateY(-100%)', maxHeight: room };
    } else if (menu && box && boundary) {
      const room = boundary() ?? seenBox(menu.ownerDocument.defaultView ?? window);
      // Each side less the list's 6 px gap, 8 px from the room's edge and its border (FloatingSkillMenu's SIDE_CHROME).
      const above = box.top - room.top - 16;
      const below = room.bottom - box.bottom - 16;
      // The list's own height, under the cap inbox.css gives it now.
      const cap = parseFloat(getComputedStyle(menu).maxHeight);
      const need = Math.min(menu.scrollHeight + 2, Number.isFinite(cap) ? cap : Infinity);
      const down = need > above && (need <= below || below > above);
      const space = Math.round(Math.max(TAG_LIST_LEAST, down ? below : above));
      if (Number.isFinite(space)) next = { '--ib-tg-room': `${space}px`, ...(down ? { top: '100%', bottom: 'auto', margin: '6px 0 0' } : {}) } as CSSProperties;
    }
    setStyle((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  });
  return { ref, style };
}

export function TagPicker({
  id,
  menu,
  options,
  onSelect,
  field = null,
  boundary,
}: {
  id: string;
  menu: MentionMenuState;
  options: readonly TagOption[];
  onSelect: (index: number) => void;
  /** The field the menu belongs to (the keyboard-up placement reads its foot). */
  field?: HTMLTextAreaElement | null;
  /** The room the menu stays inside, in viewport coordinates (FloatingSkillMenu's). */
  boundary?: () => VerticalBox | null;
}) {
  const byId = new Map(options.map((o) => [o.id, o]));
  const spot = useMenuSpot(field, boundary);
  return (
    <div ref={spot.ref} className="ib-tg-menu" data-tag-picker="" id={id} role="listbox" aria-label="Tag an agent" style={spot.style}>
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
                    <HostMark host={option?.host ?? null} big agent={person.id} />
                    <span className="ib-tg-ol">
                      <span className="ib-tg-on" title={option?.full ?? undefined}>
                        {option?.name ?? person.label}
                      </span>
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
 * At most four marks; more read as "+N". (A list row draws its agents its
 * own way: `RowAgents` on a wide row, approval "list-rows-mail-icons", and
 * `RowAgentTiles`, one tile per agent, on a three-line or phone row, approval
 * "inbox-list-row-v2".)
 */
export function TagStack({ participants }: { participants: readonly { host: string | null; session: string }[] }) {
  const shown = participants.slice(0, 4);
  const more = participants.length - shown.length;
  return (
    <span className="ib-tg-stack" aria-hidden="true" data-tag-stack={participants.length}>
      {shown.map((p) => (
        <HostMark key={p.session} host={p.host} agent={p.session} />
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
            <HostMark host={r.host} agent={r.id} />
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
