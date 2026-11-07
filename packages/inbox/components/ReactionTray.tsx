/**
 * The person's reaction tray on an agent's message (approval "inbox-reaction-tray", the owner's design).
 *
 * The thread foot's 👍 Looks good is unchanged to one click: it marks the message, or takes the mark back.
 * Resting the pointer on it (a moment), holding it on a touch screen, or the keyboard's "More reactions"
 * button after it opens the tray above it: 👍, the person's saved emoji, then free + slots, then …. There is
 * always one free + until INBOX_SAVED_REACTIONS_MAX emoji are saved (two while none is). A + saves an emoji
 * (the picker, a little spring, then a light name field: Enter or a click away keeps what was typed, Escape
 * skips it). The row under that field is the tray itself: the emoji just saved reacts from it at once, with the
 * name typed or none, so a phone never has to name it, close and hold again. … reacts once with any emoji;
 * nothing is saved. On a phone, holding Reply opens the tray too (Thread.tsx, `openRequest`). A right-click or a hold on a saved emoji, or the pen
 * the arrow keys reach at the tray's end, edits it (its name, another emoji, Remove).
 *
 * No words on the tray (a name is a tooltip) and no toast: the picked emoji flies from where it was pressed
 * to the line under the message. Reduced motion: no flight, the line just appears. The reaction is the 👍's
 * ack (POST /api/inbox/messages/:id/ack, its Undo window); the agent gets the emoji it ends on, with its name,
 * and the emoji is shown on the message (the ack's `reaction`). Once sent the tray leaves the message (Thread.tsx
 * `ackSent`); the emoji stays shown under it.
 *
 * Keyboard (standard menu behaviour, no new Inbox shortcut): Tab reaches "More reactions" after the 👍;
 * Enter opens the tray; Left and Right move along it; Enter picks; Escape closes the tray, the picker and the
 * fields, and gives focus back.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import { INBOX_REACTION_LABEL_MAX, type InboxReaction } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { Tip } from './Tip';
import { EmojiPicker, emojiRow } from './EmojiPicker';
import type { EmojiRow } from './emojiData';
import { addSavedReaction, changeSavedReaction, freeSlots, nameSavedReaction, rememberEmoji, removeSavedReaction, savedReactions, useSavedReactions } from '../reactions';

const LOOKS_GOOD_LABEL = 'Looks good';
const HOVER_OPEN_MS = 320;
const HOVER_CLOSE_MS = 220;
const LONG_PRESS_MS = 380;

const capFirst = (t: string) => (t ? t[0]!.toUpperCase() + t.slice(1) : t);

/** An emoji's own name ("unicorn"), for the words a screen reader hears. */
export function emojiName(emoji: string): string {
  return emojiRow(emoji)[1];
}

/** What the window says for a reaction: its name, else "Reacted with unicorn". */
export function reactionSpeech(reaction: InboxReaction): string {
  return reaction.label || `Reacted with ${emojiName(reaction.emoji)}`;
}

/** Two reactions are the same emoji with the same name (null is 👍 Looks good). */
export function sameReaction(a: InboxReaction | null, b: InboxReaction | null): boolean {
  return (a?.emoji ?? null) === (b?.emoji ?? null) && (a?.label ?? '') === (b?.label ?? '');
}

const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

let flight: { el: HTMLElement; raf: number } | null = null;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 4); // close to cubic-bezier(0.23, 1, 0.32, 1)
const easeInOut = (t: number) => (t < 0.5 ? 8 * t ** 4 : 1 - Math.pow(-2 * t + 2, 4) / 2); // close to cubic-bezier(0.77, 0, 0.175, 1)

/**
 * The sent moment: the emoji leaves where it was pressed and lands on the line under the message it answers,
 * so the person sees where the reaction went. 520 ms, pointer-events none, never blocks. The landing spot is
 * read again every frame (the line, once drawn, else where it will be: the line itself moves the message).
 * When the message is off screen, the emoji only rises a little and fades where it was pressed. A new flight
 * cancels the one in the air. Reduced motion: no flight at all.
 */
export function flyReaction(from: Element | null, emoji: string, messageId: string): void {
  if (reduced() || typeof requestAnimationFrame !== 'function') return;
  let a = from?.getBoundingClientRect();
  // A picker still moving can report a stray box: start from the 👍 in the foot instead.
  if (!a || !a.width || a.bottom < 0 || a.top > innerHeight || a.right < 0 || a.left > innerWidth) {
    a = document.querySelector('.ib-pfoot [data-ack] .ib-ack-emoji')?.getBoundingClientRect();
  }
  if (!a) return;
  const x0 = a.left + a.width / 2;
  const y0 = a.top + a.height / 2;
  const target = (): { x: number; y: number; visible: boolean } | null => {
    const chip = document.querySelector<HTMLElement>(`[data-ack-for="${CSS.escape(messageId)}"] .ib-ackemoji`);
    const body = document.querySelector<HTMLElement>(`.ib-pbody [data-message-id="${CSS.escape(messageId)}"]`);
    const pane = body?.closest('.ib-pbody')?.getBoundingClientRect();
    let x: number;
    let y: number;
    if (chip) {
      const c = chip.getBoundingClientRect();
      x = c.left + c.width / 2;
      y = c.top + c.height / 2;
    } else if (body) {
      const b = body.getBoundingClientRect();
      // The line sits 12 px under the message; its emoji 18 px in.
      x = b.left + 18;
      y = b.bottom + 25;
    } else return null;
    return { x, y, visible: !!pane && y > pane.top + 8 && y < pane.bottom - 4 };
  };
  const first = target();
  const land = !!first?.visible;
  if (flight) {
    cancelAnimationFrame(flight.raf);
    flight.el.remove();
  }
  const el = document.createElement('span');
  el.className = 'ib-react-flight';
  el.setAttribute('aria-hidden', 'true');
  el.dataset.reactionFlight = '';
  const inner = document.createElement('span');
  inner.textContent = emoji;
  el.appendChild(inner);
  document.body.appendChild(el);
  const duration = land ? 520 : 480;
  const start = performance.now();
  const mine = { el, raf: 0 };
  flight = mine;
  const frame = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    let x = x0;
    let y = y0;
    let scale: number;
    let opacity = 1;
    if (land) {
      const to = target() ?? first!;
      // x eases in and out, y decelerates: it lifts first, then drifts over to the line.
      x = x0 + (to.x - x0) * easeInOut(t);
      y = y0 + (to.y - y0) * easeOut(t);
      scale = t < 0.55 ? 1 + 0.45 * easeOut(t / 0.55) : 1.45 - 0.6 * easeOut((t - 0.55) / 0.45);
      opacity = t > 0.92 ? 1 - (t - 0.92) / 0.08 : 1;
    } else {
      y = y0 - 36 * easeOut(t);
      scale = 1 + 0.35 * easeOut(t);
      opacity = 1 - easeOut(t);
    }
    el.style.transform = `translate(${x}px, ${y}px)`;
    inner.style.transform = `translate(-50%, -50%) scale(${scale})`;
    inner.style.opacity = String(opacity);
    if (t < 1) {
      mine.raf = requestAnimationFrame(frame);
      return;
    }
    el.remove();
    if (flight === mine) flight = null;
    // The landing: the line's emoji takes the hit.
    if (land) {
      document
        .querySelector<HTMLElement>(`[data-ack-for="${CSS.escape(messageId)}"] .ib-ackemoji`)
        ?.animate?.([{ transform: 'scale(0.7)' }, { transform: 'scale(1.2)', offset: 0.5 }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    }
  };
  frame(start);
}

/** The message a reaction was last sent to, and when: only its line under the message fades in (Thread.tsx AckPill). */
let lastReacted: { id: string; at: number } | null = null;
export function justReacted(messageId: string): boolean {
  return !!lastReacted && lastReacted.id === messageId && Date.now() - lastReacted.at < 2000;
}

/** The button's own emoji answers the press at once. */
function popEmoji(el: Element | null | undefined) {
  if (!el || reduced()) return;
  el.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(0.82)', offset: 0.35 }, { transform: 'scale(1.16)', offset: 0.7 }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
}

export interface ReactionTrayProps {
  messageId: string;
  agent: string;
  /** The message carries the person's mark (the ack). */
  on: boolean;
  /** The mark's emoji when it is one from the tray; null for 👍 Looks good. */
  current: InboxReaction | null;
  phone: boolean;
  /**
   * Mark the message with `reaction` (null: 👍 Looks good), or take the mark back (`on` false, `reaction` the one taken
   * back). `was`: only when the message already had the mark, the reaction it had (null: 👍): only the emoji changes.
   */
  onAck: (on: boolean, reaction: InboxReaction | null, was?: InboxReaction | null) => void;
  /** Opens the tray when it changes (a hold on Reply, on a phone); 0 or unchanged does nothing. */
  openRequest?: number;
}

type PickerFor = { kind: 'save' } | { kind: 'once' } | { kind: 'change'; index: number };

export function ReactionTray({ messageId, agent, on, current, phone, onAck, openRequest = 0 }: ReactionTrayProps) {
  const saved = useSavedReactions();
  const free = freeSlots(saved.length);
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState<PickerFor | null>(null);
  const [naming, setNaming] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [fresh, setFresh] = useState<number | null>(null);
  const [said, setSaid] = useState('');
  // Back after a name was kept: the tray is simply there again (no fade, no stagger), where the field's row was.
  const [instant, setInstant] = useState(false);
  const mainRef = useRef<HTMLButtonElement>(null);
  // The tray, the picker and the fields are drawn inside the window's root, so its styles, theme and text size reach them.
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(mainRef.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const heldAt = useRef(0);
  const reopenedAt = useRef(0);
  // The tray is closing to open the picker or a field: focus goes there, not back to "More reactions".
  const handOff = useRef(false);
  // A hold on a saved emoji (touch) edits it; the click that ends the hold is swallowed.
  const savedHeld = useRef(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const lastSaved = useRef<number | null>(null);
  // What the picker was last opened for: read as it closes, after its state is already gone.
  const pickerKind = useRef<PickerFor['kind']>('once');
  // A pick that goes on to a field (the name field, the editor): the closing picker gives focus to nobody.
  const toField = useRef(false);
  // Between the tray closing and the picker or a field opening (a frame, or the picker's exit): busy, so a pointer
  // crossing the 👍 then does not open the tray over the field, nor a leave close the one coming back.
  const between = useRef(false);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      for (const t of timers.current) clearTimeout(t);
    },
    [],
  );
  const after = (ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  };
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const later = (ms: number, fn: () => void) => {
    clear();
    timer.current = setTimeout(fn, ms);
  };
  const show = (instantly = false) => {
    setInstant(instantly);
    setOpen(true);
  };
  /**
   * The tray back after the picker or the name field: no close timer left from a pointer that left the 👍 meanwhile,
   * and no hand-off, so Escape gives focus back to "More reactions" as after any open.
   */
  const reopenNow = (instantly: boolean) => {
    clear();
    between.current = false;
    handOff.current = false;
    reopenedAt.current = Date.now();
    show(instantly);
  };
  const handTo = (ms: number | 'frame', fn: () => void) => {
    between.current = true;
    const run = () => {
      between.current = false;
      fn();
    };
    if (ms === 'frame') requestAnimationFrame(run);
    else after(ms, run);
  };

  const send = (reaction: InboxReaction | null, from: Element | null) => {
    clear();
    setOpen(false);
    setPicker(null);
    if (on && sameReaction(current, reaction)) {
      onAck(false, current);
      return;
    }
    popEmoji(mainRef.current?.querySelector('.ib-ack-emoji'));
    lastReacted = { id: messageId, at: Date.now() };
    flyReaction(from, reaction?.emoji ?? '👍', messageId);
    // Already marked: only the emoji changes (Z puts the one it had back).
    onAck(true, reaction, on ? current : undefined);
  };

  // Hover (a fine pointer only) opens after a short rest; leaving the button and the tray closes it.
  const busy = () => picker !== null || naming !== null || editing !== null || between.current;
  const enter = (e: ReactPointerEvent) => {
    if (phone || e.pointerType !== 'mouse' || busy()) return;
    later(open ? 0 : HOVER_OPEN_MS, () => show());
  };
  const leave = (e: ReactPointerEvent) => {
    if (phone || e.pointerType !== 'mouse' || busy()) return;
    later(HOVER_CLOSE_MS, () => setOpen(false));
  };
  // Touch: a hold opens the tray, and the click that follows the hold is swallowed.
  const down = (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') return;
    held.current = false;
    later(LONG_PRESS_MS, () => {
      held.current = true;
      heldAt.current = Date.now();
      navigator.vibrate?.(8);
      show();
    });
  };
  const up = () => {
    if (!open) clear();
  };
  // A hold elsewhere (Reply, on a phone) opens the tray as a hold on the 👍 does: the release does not close it.
  const seenRequest = useRef(openRequest);
  useEffect(() => {
    if (openRequest === seenRequest.current) return;
    seenRequest.current = openRequest;
    if (picker !== null || naming !== null || editing !== null || between.current) return;
    clear();
    heldAt.current = Date.now();
    show();
  }, [openRequest]); // eslint-disable-line react-hooks/exhaustive-deps -- only a new request opens it

  const openPicker = (next: PickerFor) => {
    handOff.current = true;
    clear();
    setOpen(false);
    // After the tray has closed (and not given focus back to its trigger): the picker takes it.
    pickerKind.current = next.kind;
    toField.current = false;
    handTo('frame', () => setPicker(next));
  };
  const openEditor = (index: number) => {
    handOff.current = true;
    clear();
    setOpen(false);
    handTo('frame', () => setEditing(index));
  };

  const pick = (row: EmojiRow) => {
    const what = picker;
    if (!what) return;
    const cell = document.querySelector(`.ib-emo [data-emo="${CSS.escape(row[0])}"]`);
    if (what.kind === 'once') {
      rememberEmoji(row[0]);
      // A saved emoji keeps its name; 👍 is Looks good; any other is the emoji alone.
      const known = savedReactions().find((r) => r.emoji === row[0]);
      send(row[0] === '👍' ? null : (known ?? { emoji: row[0] }), cell);
      return;
    }
    toField.current = true;
    if (what.kind === 'change') {
      changeSavedReaction(what.index, row[0]);
      rememberEmoji(row[0]);
      setPicker(null);
      handTo(140, () => setEditing(savedReactions().findIndex((r) => r.emoji === row[0])));
      return;
    }
    setPicker(null);
    // 👍 is already the tray's first: nothing to save.
    const at = row[0] === '👍' ? -1 : addSavedReaction(row[0]);
    if (at < 0) {
      toField.current = false;
      handTo(140, () => reopenNow(false));
      return;
    }
    rememberEmoji(row[0]);
    setFresh(at);
    after(1100, () => setFresh((f) => (f === at ? null : f)));
    setSaid(`${row[0]} saved to your tray.`);
    handTo(140, () => setNaming(at));
  };

  const label = on ? (current ? current.label || 'Reacted' : LOOKS_GOOD_LABEL) : LOOKS_GOOD_LABEL;
  const shownEmoji = on && current ? current.emoji : '👍';
  const spoken = on && current ? reactionSpeech(current) : LOOKS_GOOD_LABEL;
  const tip = on
    ? `Take back ${current ? (current.label ? current.label : `your ${current.emoji}`) : LOOKS_GOOD_LABEL}`
    : `Sends ${agent} 👍 Looks good. Moves to Quiet until it writes again.${phone ? ' Hold for more reactions.' : ''}`;
  const cells = 1 + saved.length + free + 1;

  const main = (
    <button
      type="button"
      ref={mainRef}
      className="ib-btn ib-ack"
      data-ack=""
      aria-pressed={on}
      aria-label={on && current && !current.label ? spoken : undefined}
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={clear}
      onContextMenu={(e) => phone && e.preventDefault()}
      onClick={(e) => {
        if (held.current) {
          held.current = false;
          return;
        }
        clear();
        if (on) {
          setOpen(false);
          onAck(false, current);
          return;
        }
        send(null, e.currentTarget.querySelector('.ib-ack-emoji'));
      }}
    >
      <span className="ib-ack-emoji" aria-hidden="true">
        {shownEmoji}
      </span>
      {label}
    </button>
  );

  return (
    <>
      <span className="ib-react" data-open={open ? '' : undefined} onPointerEnter={enter} onPointerLeave={leave}>
        <Menu.Root
          open={open}
          onOpenChange={(next, details) => {
            const reason = details?.reason;
            // The press or focus that ends a hold does not close the tray it opened; Escape always does.
            if (!next && (reason === 'outside-press' || reason === 'focus-out') && Date.now() - heldAt.current < 700) return;
            // Brought back after a save, the tray is not closed by the focus the closing field lets go of.
            if (!next && reason === 'focus-out' && Date.now() - reopenedAt.current < 300) return;
            if (next) {
              handOff.current = false;
              setInstant(false);
            }
            setOpen(next);
          }}
          modal={false}
          orientation="horizontal"
        >
          {/* With a mouse, resting on the 👍 opens the tray; a tooltip racing it would cover it. */}
          {!phone && !on ? (
            main
          ) : (
            <Tip content={tip} when={() => !open && !busy()}>
              {main}
            </Tip>
          )}
          {/* The keyboard's and screen reader's way in: hidden until it has focus. Not a <button>, so the foot's row of
              buttons stays Reply and Looks good. */}
          <Menu.Trigger className="ib-react-more" data-react-more="" nativeButton={false} render={<span />} aria-label={`More reactions for ${agent}'s message`}>
            <Icon name="plus" size={12} />
          </Menu.Trigger>
          <Menu.Portal container={portal ?? undefined}>
            <Menu.Positioner className="ib-react-pos" anchor={mainRef} side="top" align="start" sideOffset={10} alignOffset={-6} collisionPadding={12}>
              <Menu.Popup
                className="ib-react-pop"
                data-reaction-tray=""
                data-instant={instant ? '' : undefined}
                aria-label="Reactions"
                style={{ ['--n' as string]: cells }}
                // A pick with the pointer, or a hand-off to the picker or a field, does not move focus to the hidden "More reactions".
                finalFocus={(type) => !handOff.current && type === 'keyboard'}
                onPointerEnter={(e) => !phone && e.pointerType === 'mouse' && clear()}
                onPointerLeave={leave}
              >
                <div className="ib-react-cells">
                  <Menu.Item
                    className="ib-react-cell"
                    data-reaction="looks-good"
                    data-current={on && !current ? '' : undefined}
                    data-tip={LOOKS_GOOD_LABEL}
                    style={{ ['--i' as string]: 0 }}
                    label={LOOKS_GOOD_LABEL}
                    aria-label={`👍 ${LOOKS_GOOD_LABEL}`}
                    onClick={(e) => send(null, e.currentTarget.querySelector('.ib-react-e'))}
                  >
                    <span className="ib-react-e">👍</span>
                  </Menu.Item>
                  {saved.map((r, i) => {
                    const name = r.label || capFirst(emojiName(r.emoji));
                    return (
                      <Menu.Item
                        key={`saved-${r.emoji}`}
                        className="ib-react-cell"
                        data-reaction={`saved-${i}`}
                        data-current={on && sameReaction(current, r) ? '' : undefined}
                        data-tip={r.label || undefined}
                        style={{ ['--i' as string]: 1 + i }}
                        label={name}
                        aria-label={`${r.emoji} ${name}`}
                        onFocus={() => (lastSaved.current = i)}
                        onMouseEnter={() => (lastSaved.current = i)}
                        // Right-click (a mouse) or a hold (touch): edit this one.
                        onContextMenu={(e) => {
                          e.preventDefault();
                          openEditor(i);
                        }}
                        onPointerDown={(e) => {
                          if (e.pointerType === 'mouse') return;
                          savedHeld.current = false;
                          if (savedTimer.current) clearTimeout(savedTimer.current);
                          savedTimer.current = setTimeout(() => {
                            savedHeld.current = true;
                            heldAt.current = Date.now();
                            navigator.vibrate?.(8);
                            openEditor(i);
                          }, LONG_PRESS_MS + 70);
                        }}
                        onPointerUp={() => savedTimer.current && clearTimeout(savedTimer.current)}
                        onPointerCancel={() => savedTimer.current && clearTimeout(savedTimer.current)}
                        onPointerLeave={() => savedTimer.current && clearTimeout(savedTimer.current)}
                        onClick={(e) => {
                          if (savedHeld.current) {
                            savedHeld.current = false;
                            return;
                          }
                          send(r, e.currentTarget.querySelector('.ib-react-e'));
                        }}
                      >
                        <span className="ib-react-e">{r.emoji}</span>
                      </Menu.Item>
                    );
                  })}
                  {Array.from({ length: free }, (_, k) => (
                    <Menu.Item
                      key={`add-${k}`}
                      className="ib-react-cell ib-react-add"
                      data-reaction="add"
                      style={{ ['--i' as string]: 1 + saved.length + k }}
                      label="Save an emoji"
                      aria-label="Save an emoji to your tray"
                      aria-haspopup="dialog"
                      onClick={() => openPicker({ kind: 'save' })}
                    >
                      <span className="ib-react-e ib-react-hole" aria-hidden="true">
                        <Icon name="plus" size={14} />
                      </span>
                    </Menu.Item>
                  ))}
                  <Menu.Item
                    className="ib-react-cell"
                    data-reaction="any"
                    style={{ ['--i' as string]: 1 + saved.length + free }}
                    label="Any emoji"
                    aria-label="React with any emoji, once"
                    aria-haspopup="dialog"
                    onClick={() => openPicker({ kind: 'once' })}
                  >
                    <span className="ib-react-e ib-react-hole ib-react-dots" aria-hidden="true">
                      <Icon name="dots" size={16} />
                    </span>
                  </Menu.Item>
                </div>
                {/* The keyboard's way to edit a saved emoji (a Mac has no context-menu key): it shows only when the
                    arrows land on it (Left from 👍 wraps to it), beside the tray; the pointer never meets it. */}
                {saved.length > 0 && (
                  <Menu.Item
                    className="ib-react-kedit"
                    data-react-edit=""
                    label="Edit"
                    aria-label="Edit your saved emoji"
                    onClick={() => openEditor(lastSaved.current !== null && saved[lastSaved.current] ? lastSaved.current : 0)}
                  >
                    <Icon name="pen" size={14} />
                  </Menu.Item>
                )}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </span>
      {/* Outside the wrapper: React's pointer events follow portals, and the picker and the fields must not count as hovering the 👍. */}
      <EmojiPicker
        open={picker !== null}
        onOpenChange={(next) => {
          if (next) return;
          const was = picker;
          setPicker(null);
          handOff.current = false;
          if (was?.kind === 'change') after(140, () => setEditing(was.index));
        }}
        anchor={mainRef}
        container={portal}
        phone={phone}
        label={picker?.kind === 'once' ? `React to ${agent}'s message with any emoji` : 'Pick an emoji to save in your tray'}
        returnTo={() => (toField.current ? false : mainRef.current)}
        idle={picker?.kind === 'once' ? 'Pick one to react with it' : 'Pick one to save'}
        says={(row) => (picker?.kind === 'once' ? `React with ${row[0]}` : `Save ${row[0]} to your tray`)}
        onPick={pick}
      />
      <NameField
        container={portal}
        index={naming}
        fresh={fresh}
        anchor={mainRef}
        phone={phone}
        onClose={(how) => {
          setNaming(null);
          setFresh(null);
          // Enter: the tray is back in the same moment, its row where the field's row was (no gap, nothing fades in).
          if (how === 'enter') reopenNow(true);
          else handOff.current = false;
        }}
        // The row under the field is the tray: an emoji reacts at once (the name typed is already kept), + and … go on.
        onReact={(what, from) => {
          setNaming(null);
          setFresh(null);
          if (what === 'add' || what === 'any') {
            openPicker({ kind: what === 'add' ? 'save' : 'once' });
            return;
          }
          handOff.current = false;
          send(what === 'looks-good' ? null : (savedReactions()[what] ?? null), from);
        }}
      />
      <SavedEditor
        container={portal}
        index={editing}
        anchor={mainRef}
        phone={phone}
        onSwitch={setEditing}
        onChangeEmoji={(index) => {
          setEditing(null);
          pickerKind.current = 'change';
          toField.current = false;
          handTo('frame', () => setPicker({ kind: 'change', index }));
        }}
        onClose={() => setEditing(null)}
      />
      <span className="ib-sr" aria-live="polite">
        {said}
      </span>
    </>
  );
}

/** What a press in the name field's row does: 👍, a saved emoji (its index), a free +, or …. */
type RowPress = 'looks-good' | number | 'add' | 'any';

/** The tray's row as it is now, drawn under a field (not a menu: nothing in it is picked). */
function TrayRow({ highlight, fresh, onPick, onPress }: { highlight: number | null; fresh?: number | null; onPick?: (index: number) => void; onPress?: (what: RowPress, from: Element | null) => void }) {
  const saved = useSavedReactions();
  const free = freeSlots(saved.length);
  if (onPress) {
    // Under the name field: the tray itself, each cell a button (the same names as the tray's own cells).
    const cell = (what: RowPress, label: string, fresh: boolean, child: ReactNode, key: string) => (
      <button
        key={key}
        type="button"
        className="ib-react-cell"
        data-row-press={typeof what === 'number' ? `saved-${what}` : what}
        data-fresh={fresh ? '' : undefined}
        aria-label={label}
        onClick={(e) => onPress(what, e.currentTarget.querySelector('.ib-react-e'))}
      >
        {child}
      </button>
    );
    return (
      <div className="ib-react-cells" role="group" aria-label="Reactions">
        {cell('looks-good', `👍 ${LOOKS_GOOD_LABEL}`, false, <span className="ib-react-e">👍</span>, 'lg')}
        {saved.map((r, i) => cell(i, `${r.emoji} ${r.label || capFirst(emojiName(r.emoji))}`, i === fresh, <span className="ib-react-e">{r.emoji}</span>, `s-${r.emoji}`))}
        {Array.from({ length: free }, (_, k) =>
          cell(
            'add',
            'Save an emoji to your tray',
            false,
            <span className="ib-react-e ib-react-hole" aria-hidden="true">
              <Icon name="plus" size={14} />
            </span>,
            `a-${k}`,
          ),
        )}
        {cell(
          'any',
          'React with any emoji, once',
          false,
          <span className="ib-react-e ib-react-hole ib-react-dots" aria-hidden="true">
            <Icon name="dots" size={16} />
          </span>,
          'any',
        )}
      </div>
    );
  }
  return (
    <div className="ib-react-cells" role={onPick ? 'group' : undefined} aria-label={onPick ? 'Your saved emoji' : undefined} aria-hidden={onPick ? undefined : 'true'}>
      <span className="ib-react-cell ib-react-fixed">
        <span className="ib-react-e">👍</span>
      </span>
      {saved.map((r, i) =>
        onPick ? (
          <button
            key={`${i}-${r.emoji}`}
            type="button"
            className="ib-react-cell"
            data-saved-pick={i}
            data-highlighted={i === highlight ? '' : undefined}
            aria-pressed={i === highlight}
            aria-label={`Edit ${r.label || capFirst(emojiName(r.emoji))}`}
            onClick={() => onPick(i)}
          >
            <span className="ib-react-e">{r.emoji}</span>
          </button>
        ) : (
          <span key={`${i}-${r.emoji}`} className="ib-react-cell" data-fresh={i === fresh ? '' : undefined} data-highlighted={i === highlight ? '' : undefined}>
            <span className="ib-react-e">{r.emoji}</span>
          </span>
        ),
      )}
      {Array.from({ length: free }, (_, k) => (
        <span key={`p${k}`} className="ib-react-cell ib-react-fixed">
          <span className="ib-react-e ib-react-hole">
            <Icon name="plus" size={14} />
          </span>
        </span>
      ))}
      <span className="ib-react-cell ib-react-fixed">
        <span className="ib-react-e ib-react-hole ib-react-dots">
          <Icon name="dots" size={16} />
        </span>
      </span>
    </div>
  );
}

/**
 * Right after a save: a light name field over the tray (optional). The row under it is the tray as it now is,
 * the new emoji springing in, and it works: a press there reacts at once (or goes on to + or …), keeping what was
 * typed, so the new emoji is usable without naming it or opening the tray again. Enter keeps the name (or none)
 * and brings the tray back; a click or tap away keeps what was typed; only Escape skips it. A phone waits for a
 * tap on the field (no keyboard popping up for an optional name). Closing, it keeps its words and row while it fades.
 */
function NameField({ container, index, fresh, anchor, phone, onClose, onReact }: { container: HTMLElement | null; index: number | null; fresh: number | null; anchor: RefObject<HTMLButtonElement | null>; phone: boolean; onClose: (how: 'enter' | 'escape' | 'dismiss') => void; onReact: (what: RowPress, from: Element | null) => void }) {
  const saved = useSavedReactions();
  // The last emoji it named: drawn while the field fades out, so it never empties before it goes.
  const last = useRef<number | null>(null);
  if (index !== null) last.current = index;
  const shown = index ?? last.current;
  const r = shown === null ? null : saved[shown];
  const [text, setText] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const closing = useRef<'enter' | 'escape' | 'dismiss'>('dismiss');
  useEffect(() => {
    if (index !== null) setText(saved[index]?.label ?? '');
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps -- a fresh field per saved emoji
  const close = (how: 'enter' | 'escape' | 'dismiss') => {
    if (index === null) return;
    closing.current = how;
    // Enter keeps the name (or takes it away); a click away keeps only words typed; Escape keeps nothing.
    if (how === 'enter' || (how === 'dismiss' && text.trim())) nameSavedReaction(index, text);
    onClose(how);
  };
  return (
    <Popover.Root open={index !== null && !!saved[index]} onOpenChange={(next, details) => !next && close(details?.reason === 'escape-key' ? 'escape' : 'dismiss')} modal={false}>
      <Popover.Portal container={container ?? undefined}>
        <Popover.Positioner className="ib-react-pos" anchor={anchor} side="top" align="start" sideOffset={10} alignOffset={-6} collisionPadding={12}>
          <Popover.Popup
            className="ib-react-pop ib-react-namer"
            data-phone={phone ? '' : undefined}
            initialFocus={phone ? false : nameRef}
            finalFocus={() => (closing.current === 'escape' ? anchor.current : false)}
            aria-label={r ? `Name ${r.emoji} (optional)` : 'Name it'}
          >
            {r && (
              <>
                <input
                  ref={nameRef}
                  className="ib-namer-in"
                  data-name-field=""
                  type="text"
                  value={text}
                  placeholder="Name it (optional)"
                  maxLength={INBOX_REACTION_LABEL_MAX}
                  autoComplete="off"
                  enterKeyHint="done"
                  aria-label={`Name for ${r.emoji}, optional. Enter to keep it`}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      close('enter');
                    }
                  }}
                />
                <TrayRow
                  highlight={null}
                  fresh={fresh}
                  onPress={(what, from) => {
                    if (index === null) return;
                    // The name typed so far goes with it; nothing typed leaves it unnamed.
                    if (text.trim()) nameSavedReaction(index, text);
                    closing.current = 'dismiss';
                    onReact(what, from);
                  }}
                />
              </>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * A saved emoji's editor (a right-click or a hold on it, or the keyboard's pen): its name, another emoji, or
 * Remove. Enter or Done keeps the name; Escape closes it as it was. The row under it switches which one is
 * edited.
 */
function SavedEditor({
  container,
  index,
  anchor,
  phone,
  onSwitch,
  onChangeEmoji,
  onClose,
}: {
  container: HTMLElement | null;
  index: number | null;
  anchor: RefObject<HTMLButtonElement | null>;
  phone: boolean;
  onSwitch: (index: number) => void;
  onChangeEmoji: (index: number) => void;
  onClose: () => void;
}) {
  const saved = useSavedReactions();
  const r = index === null ? null : saved[index];
  const [text, setText] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  // How it closed decides where focus goes: with keys back to the 👍; with the pointer, nowhere.
  const byKeys = useRef(false);
  useEffect(() => setText(r?.label ?? ''), [index, r?.emoji]); // eslint-disable-line react-hooks/exhaustive-deps -- a fresh field per saved emoji
  const keep = () => {
    if (index !== null) nameSavedReaction(index, text);
  };
  const done = (keys: boolean) => {
    keep();
    byKeys.current = keys;
    onClose();
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      done(true);
    }
  };
  return (
    <Popover.Root
      open={index !== null && !!r}
      onOpenChange={(next, details) => {
        if (next) return;
        byKeys.current = details?.reason === 'escape-key';
        onClose();
      }}
      modal={false}
    >
      <Popover.Portal container={container ?? undefined}>
        <Popover.Positioner className="ib-react-pos" anchor={anchor} side="top" align="start" sideOffset={10} alignOffset={-6} collisionPadding={12}>
          <Popover.Popup
            className="ib-react-pop ib-react-ed"
            data-phone={phone ? '' : undefined}
            initialFocus={phone ? false : nameRef}
            finalFocus={() => (byKeys.current ? anchor.current : false)}
            aria-label={r ? `Edit ${r.emoji}` : 'Edit a saved emoji'}
          >
            {r && index !== null && (
              <>
                <div className="ib-react-form">
                  <input
                    ref={nameRef}
                    className="ib-namer-in"
                    data-edit-name=""
                    type="text"
                    value={text}
                    placeholder="Name it (optional)"
                    maxLength={INBOX_REACTION_LABEL_MAX}
                    autoComplete="off"
                    enterKeyHint="done"
                    aria-label={`Name for ${r.emoji}`}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={onKey}
                  />
                  <div className="ib-react-acts">
                    <button
                      type="button"
                      className="ib-react-a"
                      data-edit-change=""
                      onClick={() => {
                        keep();
                        onChangeEmoji(index);
                      }}
                    >
                      Change emoji
                    </button>
                    <button
                      type="button"
                      className="ib-react-a"
                      data-edit-remove=""
                      onClick={(e) => {
                        removeSavedReaction(index);
                        byKeys.current = e.detail === 0;
                        onClose();
                      }}
                    >
                      Remove
                    </button>
                    <span className="ib-react-sp" />
                    <button type="button" className="ib-react-done" data-edit-done="" onClick={(e) => done(e.detail === 0)}>
                      Done
                    </button>
                  </div>
                </div>
                <TrayRow
                  highlight={index}
                  onPick={(i) => {
                    keep();
                    onSwitch(i);
                  }}
                />
              </>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
