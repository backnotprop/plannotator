import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { MentionMenuState } from '@plannotator/ui/hooks/useMentionAutocomplete';
import { inboxApi, type TaggableModel } from '../api';
import type { RecipientConnection } from '../deliveryLine';

const TAGGABLE_REFRESH_MS = 10_000;

export function useTaggable(threadId: string, enabled: boolean) {
  const [model, setModel] = useState<TaggableModel | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await inboxApi.taggable(threadId);
      setModel(next && Array.isArray(next.sessions) ? next : null);
    } catch {}
  }, [threadId]);
  useEffect(() => {
    if (!enabled) return;
    void load();
    const timer = setInterval(() => void load(), TAGGABLE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, enabled]);
  return model;
}

export function useTagConnections(threadId: string, sessions: readonly string[], enabled: boolean) {
  const key = sessions.join(',');
  const [connections, setConnections] = useState<Record<string, RecipientConnection | null>>({});
  const load = useCallback(async () => {
    if (!key) return;
    try {
      const model = await inboxApi.sessions(threadId, null, key.split(','));
      setConnections(model.recipients ?? {});
    } catch {}
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

/** iPhone with the keyboard up (`data-ib-keyboard-pin`): the thread's foot is a short scrolling box and a picker drawn above the field opened behind the header, so it is placed on the screen instead. */
function useKeyboardSpot(): { ref: RefObject<HTMLDivElement | null>; style: CSSProperties | undefined } {
  const ref = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    const menu = ref.current;
    const foot = menu?.closest('.ib-pfoot');
    const field = menu?.parentElement?.getBoundingClientRect();
    if (!menu || !foot || !field || !document.documentElement.hasAttribute('data-ib-keyboard-pin')) {
      setStyle((current) => (current === undefined ? current : undefined));
      return;
    }
    const headBottom = foot.closest('.ib-pane')?.querySelector('.ib-phead')?.getBoundingClientRect().bottom ?? 0;
    // With the keyboard up (~257 px left) the field starts under the header, so the list covers the box instead.
    const above = Math.round(field.top - 10);
    const row = foot.querySelector('[data-reply-row]')?.getBoundingClientRect();
    const top = above - headBottom - 8 >= 120 || !row ? above : Math.round(row.top - 6);
    const left = Math.round(field.left);
    const room = Math.max(88, top - headBottom - 8);
    setStyle((current) =>
      current && current.top === top && current.left === left && current.maxHeight === room
        ? current
        : { position: 'fixed', top, left, width: Math.round(field.width), right: 'auto', bottom: 'auto', margin: 0, transform: 'translateY(-100%)', maxHeight: room },
    );
  });
  return { ref, style };
}

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
  const spot = useKeyboardSpot();
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

export function TagNotes({
  id,
  tagged,
  owner,
  where = 'reply',
}: {
  id?: string;
  tagged: readonly TagOption[];
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
