/**
 * The small parts of reactions on every agent message (approval "inbox-reactions-every-message", items 3, 4, 5, 6, 9):
 * - `ReactFace`: each agent message's face at the end of the text's first line. Drawn always and shown by CSS alone
 *   (hover or focus inside the message, `inbox.css` `.ib-rface`), so a message adds no listener that measures and no
 *   layout read; React's own delegated handlers tell the one shared host which face the pointer reached.
 * - `FaceStrip`: what the face opens into the moment the pointer is on it: 👍, the person's saved emoji, then the face
 *   again, which opens the full tray. Drawn by the host into the face's own slot (a portal, no positioning).
 * - `MenuEmojiRow`: the same emoji as the first row of the message's menu; on a phone a skill emoji has its name under it.
 * - `SkillMark`: the small "/" at a skill emoji's lower right.
 */
import { useEffect, useRef, type FocusEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Menu } from '@base-ui/react/menu';
import type { InboxMessageWire, InboxReaction } from '@plannotator/core/inbox-types';
import { useSavedReactions } from '../reactions';
import { machineOf } from '../inboxUrl';
import { faceStrip, hasSkill, skillPreview, skillSaid, skillTip, type MessageReactApi } from './messageReact';

const LOOKS_GOOD = 'Looks good';

export function FaceIcon({ size = 18 }: { size?: number }) {
  return (
    <svg className="ib-ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9.25" />
      <path d="M8.5 14.25s1.3 1.75 3.5 1.75 3.5-1.75 3.5-1.75" />
      <path d="M9.25 9.5h.01M14.75 9.5h.01" strokeWidth={2.4} />
    </svg>
  );
}

export function SkillMark() {
  return (
    <span className="ib-skillmark" aria-hidden="true">
      /
    </span>
  );
}

/** One emoji's name, tooltip and accessible name: 👍 Looks good, a saved one's name, or its skill. */
function cellWords(reaction: InboxReaction | null): { tip: string | undefined; said: string } {
  if (!reaction) return { tip: LOOKS_GOOD, said: `👍 ${LOOKS_GOOD}` };
  if (hasSkill(reaction)) return { tip: skillTip(reaction), said: `${reaction.emoji} ${skillSaid(reaction)}` };
  return { tip: reaction.label || undefined, said: reaction.label ? `${reaction.emoji} ${reaction.label}` : reaction.emoji };
}

/** The handlers that show a skill emoji's card beside `container` (its top in line with theirs), and hide it. */
export function previewHandlers(
  reaction: InboxReaction | null,
  agent: string,
  container: () => Element | null,
  /** The message it reacts to: a linked machine's thread reads a skill this computer lacks from that machine. */
  messageId?: string,
): { onPointerEnter: (e: ReactPointerEvent) => void; onPointerLeave?: () => void; onFocus?: (e: FocusEvent) => void; onBlur?: () => void } {
  if (!hasSkill(reaction)) return { onPointerEnter: () => skillPreview.set(null) };
  const show = () => {
    const anchor = container();
    if (anchor) skillPreview.set({ reaction, agent, anchor, machine: machineOf(messageId) });
  };
  const hide = () => skillPreview.get()?.reaction === reaction && skillPreview.set(null);
  return {
    onPointerEnter: (e: ReactPointerEvent) => e.pointerType === 'mouse' && show(),
    onPointerLeave: hide,
    onFocus: (e: FocusEvent) => e.currentTarget.matches(':focus-visible, [data-highlighted]') && show(),
    onBlur: hide,
  };
}

/** Each agent message's face: hidden at rest, shown by CSS on hover; the pointer on it opens it (no click needed). */
export function ReactFace({ messageId }: { messageId: string }) {
  const open = (slot: HTMLElement | null) => slot && faceStrip.set({ messageId, slot });
  return (
    <span className="ib-rface-slot" data-react-face-slot={messageId}>
      <button
        type="button"
        className="ib-rface"
        tabIndex={-1}
        aria-hidden="true"
        data-react-face={messageId}
        onPointerEnter={(e) => e.pointerType === 'mouse' && open(e.currentTarget.parentElement)}
        onClick={(e) => open(e.currentTarget.parentElement)}
      >
        <FaceIcon />
      </button>
    </span>
  );
}

/** The face opened: the person's emoji, then the face that opens the full tray. Leaving it closes it. */
export function FaceStrip({ message, api }: { message: InboxMessageWire; api: MessageReactApi }) {
  const saved = useSavedReactions();
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agent = api.agentOf(message);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const close = () => {
    skillPreview.set(null);
    faceStrip.set(null);
  };
  const cells: (InboxReaction | null)[] = [null, ...saved];
  return (
    <div
      ref={ref}
      className="ib-rstrip"
      role="toolbar"
      aria-label={`React to ${agent}'s message`}
      data-react-strip={message.id}
      onPointerEnter={() => timer.current && clearTimeout(timer.current)}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'mouse') return;
        timer.current = setTimeout(close, 140);
      }}
    >
      {cells.map((reaction, i) => {
        const { tip, said } = cellWords(reaction);
        return (
          <button
            key={reaction?.emoji ?? 'looks-good'}
            type="button"
            className="ib-rstrip-c"
            style={{ ['--i' as string]: i }}
            data-tip={hasSkill(reaction) ? undefined : tip}
            data-skill={hasSkill(reaction) ? reaction.skill : undefined}
            aria-label={said}
            {...previewHandlers(reaction, agent, () => ref.current, message.id)}
            onClick={(e) => {
              close();
              api.react(message, reaction, e.currentTarget.querySelector('.ib-react-e'));
            }}
          >
            <span className="ib-react-e">{reaction?.emoji ?? '👍'}</span>
            {hasSkill(reaction) && <SkillMark />}
          </button>
        );
      })}
      <button
        type="button"
        className="ib-rstrip-c ib-rstrip-face"
        aria-label="All reactions"
        data-react-all=""
        onPointerEnter={() => skillPreview.set(null)}
        onClick={() => {
          close();
          api.openTray(message);
        }}
      >
        <FaceIcon />
      </button>
    </div>
  );
}

/** The menu's first row: the same emoji, ending in the face. Arrow keys move along it (Base UI's menu items). */
export function MenuEmojiRow({ message, api, phone }: { message: InboxMessageWire; api: MessageReactApi; phone: boolean }) {
  const saved = useSavedReactions();
  const ref = useRef<HTMLDivElement>(null);
  const agent = api.agentOf(message);
  const container = () => ref.current?.closest('.ib-pm') ?? ref.current;
  useEffect(() => () => skillPreview.set(null), []);
  const cells: (InboxReaction | null)[] = [null, ...saved];
  return (
    <div ref={ref} className="ib-emrow" role="group" aria-label="Reactions" data-menu-reactions="">
      {cells.map((reaction) => {
        const { tip, said } = cellWords(reaction);
        return (
          <Menu.Item
            key={reaction?.emoji ?? 'looks-good'}
            className="ib-emrow-c"
            label={said}
            aria-label={said}
            title={!phone && !hasSkill(reaction) ? tip : undefined}
            data-menu-reaction={reaction?.emoji ?? '👍'}
            {...previewHandlers(reaction, agent, container, message.id)}
            onClick={(e) => api.react(message, reaction, e.currentTarget.querySelector('.ib-react-e'))}
          >
            <span className="ib-emrow-e">
              <span className="ib-react-e">{reaction?.emoji ?? '👍'}</span>
              {hasSkill(reaction) && <SkillMark />}
            </span>
            {phone && hasSkill(reaction) && <span className="ib-emrow-skill">/{reaction.skill}</span>}
          </Menu.Item>
        );
      })}
      <Menu.Item className="ib-emrow-c" label="All reactions" aria-label="All reactions" data-menu-reaction="all" onClick={() => api.openTray(message)}>
        <span className="ib-emrow-e">
          <FaceIcon size={20} />
        </span>
      </Menu.Item>
    </div>
  );
}
