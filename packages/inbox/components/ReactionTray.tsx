import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import { INBOX_REACTION_LABEL_MAX, type InboxReaction } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { Tip } from './Tip';
import { EmojiPicker, emojiRow } from './EmojiPicker';
import type { EmojiRow } from './emojiData';
import { atEnd } from '../seenOnSight';
import { addSavedReaction, changeSavedReaction, freeSlots, nameSavedReaction, rememberEmoji, removeSavedReaction, savedReactions, useSavedReactions } from '../reactions';

const LOOKS_GOOD_LABEL = 'Looks good';
const HOVER_OPEN_MS = 320;
const HOVER_CLOSE_MS = 220;
const LONG_PRESS_MS = 380;

const capFirst = (t: string) => (t ? t[0]!.toUpperCase() + t.slice(1) : t);

export function emojiName(emoji: string): string {
  return emojiRow(emoji)[1];
}

export function reactionSpeech(reaction: InboxReaction): string {
  return reaction.label || `Reacted with ${emojiName(reaction.emoji)}`;
}

export function sameReaction(a: InboxReaction | null, b: InboxReaction | null): boolean {
  return (a?.emoji ?? null) === (b?.emoji ?? null) && (a?.label ?? '') === (b?.label ?? '');
}

const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

let flight: { el: HTMLElement; raf: number } | null = null;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 4);
const easeInOut = (t: number) => (t < 0.5 ? 8 * t ** 4 : 1 - Math.pow(-2 * t + 2, 4) / 2);
const progress = (now: number, start: number, ms: number) => Math.min(1, Math.max(0, (now - start) / ms));

export const FLIGHT_LAND_MS = 520;
export const FLIGHT_STAY_MS = 260;
export const KEEP_END_MS = 240;
const KEEP_END_WAIT_MS = 600;
const LAND_MARGIN = 12;

let keeping: { stop: () => void } | null = null;

function keepEnd(body: HTMLElement): void {
  keeping?.stop();
  if (typeof requestAnimationFrame !== 'function') return;
  const startedAt = performance.now();
  const gapAt = (b: HTMLElement) => b.scrollHeight - b.clientHeight - b.scrollTop;
  const before = Math.max(0, gapAt(body));
  let begun = -1;
  let from = 0;
  let last = 0;
  let raf = 0;
  const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
  const stop = () => {
    cancelAnimationFrame(raf);
    for (const type of events) body.removeEventListener(type, stop);
    if (keeping === mine) keeping = null;
  };
  const mine = { stop };
  keeping = mine;
  for (const type of events) body.addEventListener(type, stop, { passive: true });
  const frame = (now: number) => {
    if (!body.isConnected) return stop();
    const end = body.scrollHeight - body.clientHeight;
    const gap = gapAt(body) - before;
    if (begun < 0 || gap > last + 1) {
      if (gap <= 1) {
        if (now - startedAt > KEEP_END_WAIT_MS) return stop();
        raf = requestAnimationFrame(frame);
        return;
      }
      if (reduced()) {
        body.scrollTop = end - before;
        return stop();
      }
      begun = now;
      from = gap;
    }
    const p = progress(now, begun, KEEP_END_MS);
    const left = from * (1 - easeOut(p));
    body.scrollTop = end - before - left;
    last = left;
    if (p < 1) raf = requestAnimationFrame(frame);
    else stop();
  };
  raf = requestAnimationFrame(frame);
}

export function flyReaction(from: Element | null, emoji: string, messageId: string): void {
  const message = document.querySelector<HTMLElement>(`.ib-pbody [data-message-id="${CSS.escape(messageId)}"]`);
  const scroller = message?.closest<HTMLElement>('.ib-pbody') ?? null;
  const wasAtEnd = !!scroller && scroller.scrollHeight > 0 && atEnd(scroller);
  if (scroller && wasAtEnd) keepEnd(scroller);
  if (reduced() || typeof requestAnimationFrame !== 'function') return;
  let a = from?.getBoundingClientRect();
  if (!a || !a.width || a.bottom < 0 || a.top > innerHeight || a.right < 0 || a.left > innerWidth) {
    a = document.querySelector('.ib-pfoot [data-ack] .ib-ack-emoji')?.getBoundingClientRect();
  }
  if (!a) return;
  const x0 = a.left + a.width / 2;
  const y0 = a.top + a.height / 2;
  const band = () => {
    const pane = scroller?.getBoundingClientRect();
    return pane ? { top: pane.top + LAND_MARGIN, bottom: pane.bottom - LAND_MARGIN } : null;
  };
  const target = (): { x: number; y: number; inView: boolean } | null => {
    const chip = document.querySelector<HTMLElement>(`[data-ack-for="${CSS.escape(messageId)}"] .ib-ackemoji`);
    const body = message?.isConnected ? message : document.querySelector<HTMLElement>(`.ib-pbody [data-message-id="${CSS.escape(messageId)}"]`);
    let x: number;
    let y: number;
    if (chip) {
      const c = chip.getBoundingClientRect();
      x = c.left + c.width / 2;
      y = c.top + c.height / 2;
    } else if (body) {
      const b = body.getBoundingClientRect();
      x = b.left + 18;
      y = b.bottom + 25;
    } else return null;
    const view = band();
    return { x, y, inView: !!view && y >= view.top && y <= view.bottom };
  };
  const first = target();
  const land = !!first && (wasAtEnd || first.inView);
  if (flight) {
    cancelAnimationFrame(flight.raf);
    flight.el.remove();
  }
  const el = document.createElement('span');
  el.className = 'ib-react-flight';
  el.setAttribute('aria-hidden', 'true');
  el.dataset.reactionFlight = land ? 'land' : 'stay';
  const inner = document.createElement('span');
  inner.textContent = emoji;
  el.appendChild(inner);
  document.body.appendChild(el);
  const duration = land ? FLIGHT_LAND_MS : FLIGHT_STAY_MS;
  const start = performance.now();
  const mine = { el, raf: 0 };
  flight = mine;
  let landed = false;
  const frame = (now: number) => {
    const t = progress(now, start, duration);
    let x = x0;
    let y = y0;
    let scale: number;
    let opacity = 1;
    if (land) {
      const to = target() ?? first!;
      const view = band();
      const toY = view ? Math.min(view.bottom, Math.max(view.top, to.y)) : to.y;
      landed = to.inView;
      x = x0 + (to.x - x0) * easeInOut(t);
      y = y0 + (toY - y0) * easeOut(t);
      scale = t < 0.55 ? 1 + 0.45 * easeOut(t / 0.55) : 1.45 - 0.6 * easeOut((t - 0.55) / 0.45);
      opacity = t > 0.92 ? 1 - (t - 0.92) / 0.08 : 1;
    } else {
      y = y0 - 20 * easeOut(t);
      scale = 1 + 0.3 * easeOut(t);
      opacity = t < 0.35 ? 1 : 1 - (t - 0.35) / 0.65;
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
    if (land && landed) {
      document
        .querySelector<HTMLElement>(`[data-ack-for="${CSS.escape(messageId)}"] .ib-ackemoji`)
        ?.animate?.([{ transform: 'scale(0.7)' }, { transform: 'scale(1.2)', offset: 0.5 }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    }
  };
  frame(start);
}

let lastReacted: { id: string; at: number } | null = null;
export function justReacted(messageId: string): boolean {
  return !!lastReacted && lastReacted.id === messageId && Date.now() - lastReacted.at < 2000;
}

function popEmoji(el: Element | null | undefined) {
  if (!el || reduced()) return;
  el.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(0.82)', offset: 0.35 }, { transform: 'scale(1.16)', offset: 0.7 }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
}

export interface ReactionTrayProps {
  messageId: string;
  agent: string;
  on: boolean;
  current: InboxReaction | null;
  phone: boolean;
  onAck: (on: boolean, reaction: InboxReaction | null, was?: InboxReaction | null) => void;
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
  const [instant, setInstant] = useState(false);
  const mainRef = useRef<HTMLButtonElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(mainRef.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const heldAt = useRef(0);
  const reopenedAt = useRef(0);
  const handOff = useRef(false);
  const savedHeld = useRef(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const lastSaved = useRef<number | null>(null);
  const pickerKind = useRef<PickerFor['kind']>('once');
  const toField = useRef(false);
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
    onAck(true, reaction, on ? current : undefined);
  };

  const busy = () => picker !== null || naming !== null || editing !== null || between.current;
  const enter = (e: ReactPointerEvent) => {
    if (phone || e.pointerType !== 'mouse' || busy()) return;
    later(open ? 0 : HOVER_OPEN_MS, () => show());
  };
  const leave = (e: ReactPointerEvent) => {
    if (phone || e.pointerType !== 'mouse' || busy()) return;
    later(HOVER_CLOSE_MS, () => setOpen(false));
  };
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
  const seenRequest = useRef(openRequest);
  useEffect(() => {
    if (openRequest === seenRequest.current) return;
    seenRequest.current = openRequest;
    if (picker !== null || naming !== null || editing !== null || between.current) return;
    clear();
    heldAt.current = Date.now();
    show();
  }, [openRequest]);

  const openPicker = (next: PickerFor) => {
    handOff.current = true;
    clear();
    setOpen(false);
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
            if (!next && (reason === 'outside-press' || reason === 'focus-out') && Date.now() - heldAt.current < 700) return;
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
          {!phone && !on ? (
            main
          ) : (
            <Tip content={tip} when={() => !open && !busy()}>
              {main}
            </Tip>
          )}
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
          if (how === 'enter') reopenNow(true);
          else handOff.current = false;
        }}
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

type RowPress = 'looks-good' | number | 'add' | 'any';

function TrayRow({ highlight, fresh, onPick, onPress }: { highlight: number | null; fresh?: number | null; onPick?: (index: number) => void; onPress?: (what: RowPress, from: Element | null) => void }) {
  const saved = useSavedReactions();
  const free = freeSlots(saved.length);
  if (onPress) {
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

function NameField({ container, index, fresh, anchor, phone, onClose, onReact }: { container: HTMLElement | null; index: number | null; fresh: number | null; anchor: RefObject<HTMLButtonElement | null>; phone: boolean; onClose: (how: 'enter' | 'escape' | 'dismiss') => void; onReact: (what: RowPress, from: Element | null) => void }) {
  const saved = useSavedReactions();
  const last = useRef<number | null>(null);
  if (index !== null) last.current = index;
  const shown = index ?? last.current;
  const r = shown === null ? null : saved[shown];
  const [text, setText] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const closing = useRef<'enter' | 'escape' | 'dismiss'>('dismiss');
  useEffect(() => {
    if (index !== null) setText(saved[index]?.label ?? '');
  }, [index]);
  const close = (how: 'enter' | 'escape' | 'dismiss') => {
    if (index === null) return;
    closing.current = how;
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
  const byKeys = useRef(false);
  useEffect(() => setText(r?.label ?? ''), [index, r?.emoji]);
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
