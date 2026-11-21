import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { BUILT_IN_THEMES } from '@plannotator/ui/utils/themeRegistry';
import { STAR_ASK_DISPLAY_FONT, STAR_ASK_FONT_FACES } from '@plannotator/ui/utils/starAskFonts';
import {
  THEME_CHOOSER_CARDS,
  THEME_CHOOSER_MOTION as MOTION,
  THEME_CHOOSER_OWN,
  THEME_CHOOSER_THEMES,
  THEME_CHOOSER_TILES,
  THEME_CHOOSER_WORDS as WORDS,
  otherHalf,
  themeChooserButton,
  themeChooserCardAt,
  themeChooserGeometry,
  themeChooserInUse,
  themeChooserKeeps,
  themeChooserLine,
  themeChooserMove,
  themeChooserPick,
  themeChooserPose,
  themeChooserTimeAt,
  themeChooserTransform,
  type ThemeChooserHalf,
  type ThemeChooserInUse,
  type ThemeChooserThemeId,
} from '../themeChooser';
import { loadThemeChooserArt, type ThemeChooserArt } from '../themeChooserArt';
import { Modal } from './Updates';

export interface ThemeChooserProps {
  /** What is in use now (ThemeProvider): the palettes of both halves and the saved mode. */
  inUse: ThemeChooserInUse;
  /** A theme card's button: save this theme on both halves and this mode, as Settings does. */
  onPick: (pick: { light: string; dark: string; mode: 'light' | 'dark' | 'system' }) => void;
  /** "Open Settings": the dialog closes and Settings opens at its Colors row. */
  onOwn: () => void;
  /** The close button, Escape or a click outside: nothing changes. */
  onDismiss: () => void;
  /** The pictures' loader (themeChooserArt.ts); a test passes its own. */
  loadArt?: (deck: boolean) => Promise<ThemeChooserArt>;
}

type Modes = Record<ThemeChooserThemeId, ThemeChooserHalf>;

const HALVES: readonly ThemeChooserHalf[] = ['light', 'dark'];
const ICON = {
  sun: 'M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z',
  moon: 'M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z',
  x: 'M6 18 18 6M6 6l12 12',
} as const;

const media = (query: string): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;

/**
 * The one-time "themes" dialog (approval "inbox-theme-chooser", 2026-11-10; mock, stills and build notes in
 * `.product/approved/inbox-theme-chooser/`). The title is "themes" lettered as six swatches, each a real theme. Below
 * it, a fan of three cards: Plannotator Original (in front on open), Plannotator Modern and "Choose your own". A theme
 * card holds two real screenshots, its light and its dark: the system's mode in front, the other out at the top right
 * corner under a small label. Pointing at that corner, tapping it, or Enter on its button brings that sheet forward;
 * pointing at another card, tapping it, focusing one of its buttons or the arrow keys bring that card forward. The one
 * button of a theme card saves the theme and the mode: without a shuffle the mode follows the system, after one it is
 * the mode in front, fixed. On a phone the cards are a deck that swipes.
 *
 * Motion (the build notes): 600 ms forward, the others back a beat apart like a hand of cards, only transform and
 * opacity, redirectable mid-move; with reduced motion everything is instant and nothing else differs.
 *
 * The pictures load when this mounts (the claim is spent), each decoded before the dialog draws. Focus starts on the
 * front card's button, stays inside the dialog and goes back where it was. No keyboard shortcut.
 */
export function ThemeChooser({ inUse, onPick, onOwn, onDismiss, loadArt = loadThemeChooserArt }: ThemeChooserProps) {
  const [geometry] = useState(() => themeChooserGeometry(typeof window === 'undefined' ? 1440 : window.innerWidth));
  const [art, setArt] = useState<ThemeChooserArt | null | undefined>(undefined);
  useEffect(() => {
    let gone = false;
    loadArt(geometry.deck).then(
      (loaded) => !gone && setArt(loaded),
      // The pictures never came (a script that failed to load): the dialog still opens, its sheets plain.
      () => !gone && setArt(null),
    );
    return () => {
      gone = true;
    };
  }, [loadArt, geometry.deck]);
  return (
    <>
      {/* The title's face (the star ask's Archivo subset), in the page before the pictures' loader asks for it. */}
      <style>{STAR_ASK_FONT_FACES}</style>
      {art !== undefined && <ThemeChooserDialog inUse={inUse} onPick={onPick} onOwn={onOwn} onDismiss={onDismiss} art={art} geometry={geometry} />}
    </>
  );
}

interface DialogProps extends Omit<ThemeChooserProps, 'loadArt'> {
  art: ThemeChooserArt | null;
  geometry: ReturnType<typeof themeChooserGeometry>;
}

function ThemeChooserDialog({ inUse, onPick, onOwn, onDismiss, art, geometry: g }: DialogProps) {
  const [system] = useState<ThemeChooserHalf>(() => (media('(prefers-color-scheme: dark)') ? 'dark' : 'light'));
  const [reduced] = useState(() => media('(prefers-reduced-motion: reduce)'));
  const [front, setFrontState] = useState(0);
  /** The sheet each theme would show: what its button and line read, changed the moment a shuffle starts. */
  const [modes, setModes] = useState<Modes>({ plannotator: system, 'plannotator-modern': system });
  /** The sheet drawn in front (`data-pos`): it follows `modes` once the shuffle's motion ends. */
  const [settled, setSettled] = useState<Modes>({ plannotator: system, 'plannotator-modern': system });
  const settledRef = useRef(settled);
  settledRef.current = settled;
  const frontRef = useRef(front);
  frontRef.current = front;
  /** The first layout is placed, not moved. */
  const placed = useRef(false);
  const stage = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const cards = useRef<(HTMLElement | null)[]>([]);
  const sheets = useRef<Partial<Record<string, HTMLDivElement | null>>>({});
  const corners = useRef<Partial<Record<string, HTMLButtonElement | null>>>({});
  const running = useRef<Partial<Record<ThemeChooserThemeId, Animation[] | null>>>({});
  const count = THEME_CHOOSER_CARDS.length;

  // The stage is as tall as the tallest card at rest plus the fan's drop; on a desktop it is scaled to fit the dialog.
  // Measured once the dialog is open (a closed dialog has no boxes; Modal opens it in its own effect, before this one).
  const estimate = (g.deck ? 10 : 14) * 2 + 2 + g.sheetH + g.peekY + (g.deck ? 10 + 36 + 46 + 26 : 12 + 36 + 48);
  const [size, setSize] = useState({ stageH: estimate, k: 1 });
  useEffect(() => {
    const measure = () => {
      const tallest = Math.max(0, ...cards.current.map((card) => card?.offsetHeight ?? 0));
      if (tallest === 0) return;
      const stageH = tallest + (g.deck ? 26 : 48);
      const dialog = wrap.current?.closest('dialog');
      const k = g.deck || !dialog ? 1 : Math.min(1, (dialog.clientWidth - 40) / g.width, (window.innerHeight - 24 - 150) / stageH);
      setSize((now) => (now.stageH === stageH && Math.abs(now.k - k) < 0.001 ? now : { stageH, k: Number(k.toFixed(3)) }));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [g]);

  // `will-change` only while the cards move, dropped a moment after the longest move.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const instant = reduced || !placed.current;
    placed.current = true;
    if (instant) return;
    el.classList.add('ib-thc-moving');
    const longest = Math.max(...THEME_CHOOSER_CARDS.map((_, i) => themeChooserMove(i, front, false)).map((move) => move.ms + move.delayMs));
    const timer = setTimeout(() => el.classList.remove('ib-thc-moving'), longest + MOTION.settleMs);
    return () => clearTimeout(timer);
  }, [front, reduced]);

  const setFront = useCallback(
    (i: number) => {
      const next = Math.max(0, Math.min(count - 1, i));
      if (next !== frontRef.current) setFrontState(next);
    },
    [count],
  );

  // Timers and running shuffles end with the dialog.
  const intent = useRef<{ timer: ReturnType<typeof setTimeout> | null; card: number }>({ timer: null, card: -1 });
  const corner = useRef<Partial<Record<ThemeChooserThemeId, { armed: boolean; timer: ReturnType<typeof setTimeout> | null }>>>({});
  useEffect(
    () => () => {
      if (intent.current.timer) clearTimeout(intent.current.timer);
      for (const state of Object.values(corner.current)) if (state?.timer) clearTimeout(state.timer);
      for (const anims of Object.values(running.current)) anims?.forEach((anim) => anim.cancel());
    },
    [],
  );

  /** The light/dark shuffle inside a theme card. A shuffle during a shuffle turns round from where everything is. */
  const shuffle = useCallback(
    (id: ThemeChooserThemeId) => {
      setModes((now) => ({ ...now, [id]: otherHalf(now[id]) }));
      const moving = running.current[id];
      if (moving) {
        moving.forEach((anim) => anim.reverse());
        return;
      }
      const from = settledRef.current[id];
      const out = sheets.current[`${id}:${from}`];
      const inn = sheets.current[`${id}:${otherHalf(from)}`];
      const commit = () => setSettled((now) => ({ ...now, [id]: otherHalf(from) }));
      if (reduced || !out || !inn || typeof inn.animate !== 'function') {
        commit();
        return;
      }
      const frontAt = `translate3d(0px, ${g.peekY}px, 0px) rotate(0deg)`;
      const backAt = `translate3d(${g.peekX}px, 0px, 0px) rotate(1.4deg)`;
      // Where the two sheets coincide: there the front one dissolves into the back one, trades stacking while it
      // cannot be seen, then reappears behind.
      const meet = themeChooserTimeAt(MOTION.shuffleEase, 0.5);
      const a = Math.max(0.05, meet - 0.14);
      const b = Math.min(0.95, meet + 0.04);
      const z = b + 0.005;
      const back = Math.min(1, b + 0.22);
      const easing = `cubic-bezier(${MOTION.shuffleEase.join(',')})`;
      const opt = { duration: MOTION.shuffleMs, fill: 'forwards' as const };
      const card = inn.closest('.ib-thc-card');
      card?.classList.add('ib-thc-shuffling');
      const anims = [
        inn.animate([{ transform: backAt }, { transform: frontAt }], { ...opt, easing }),
        out.animate([{ transform: frontAt }, { transform: backAt }], { ...opt, easing }),
        out.animate(
          [
            { opacity: 1, zIndex: 2 },
            { opacity: 1, zIndex: 2, offset: a },
            { opacity: 0, zIndex: 2, offset: b },
            { opacity: 0, zIndex: 1, offset: z },
            { opacity: 1, zIndex: 1, offset: back },
            { opacity: 1, zIndex: 1 },
          ],
          opt,
        ),
        inn.animate([{ zIndex: 1 }, { zIndex: 1, offset: b }, { zIndex: 2, offset: z }, { zIndex: 2 }], opt),
      ];
      const innCorner = inn.querySelector('.ib-thc-corner');
      const outCorner = out.querySelector('.ib-thc-corner');
      if (innCorner) anims.push(innCorner.animate([{ opacity: 1 }, { opacity: 0, offset: 0.18 }, { opacity: 0 }], opt));
      if (outCorner) anims.push(outCorner.animate([{ opacity: 0 }, { opacity: 0, offset: 0.7 }, { opacity: 1 }], opt));
      running.current[id] = anims;
      Promise.all(anims.map((anim) => anim.finished))
        .then(() => {
          // Ended forward: the sheets trade places in the page, in the same frame the animations let go.
          if ((anims[0]?.playbackRate ?? 1) > 0) flushSync(commit);
          anims.forEach((anim) => anim.cancel());
          running.current[id] = null;
          card?.classList.remove('ib-thc-shuffling');
        })
        .catch(() => {});
    },
    [g.peekX, g.peekY, reduced],
  );

  /** The card a pointer means, by where the cards are going. */
  const cardAt = (clientX: number, clientY: number): number => {
    const el = stage.current;
    const cardH = cards.current[0]?.offsetHeight ?? 0;
    if (!el || cardH === 0) return -1;
    const box = el.getBoundingClientRect();
    const k = g.deck ? 1 : box.width / g.width || 1;
    return themeChooserCardAt((clientX - (box.left + box.width / 2)) / k, (clientY - box.top) / k, frontRef.current, count, cardH, g);
  };

  // Hover intent: the card under the pointer comes forward after a short rest on it. Never for touch.
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return;
    const i = cardAt(event.clientX, event.clientY);
    const state = intent.current;
    if (i < 0 || i === frontRef.current) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.card = -1;
      return;
    }
    if (i === state.card) return;
    if (state.timer) clearTimeout(state.timer);
    state.card = i;
    state.timer = setTimeout(() => {
      state.card = -1;
      state.timer = null;
      setFront(i);
    }, MOTION.intentMs);
  };
  const onPointerLeave = () => {
    const state = intent.current;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.card = -1;
  };

  // The corner: pointing at it shuffles once; it re-arms only after the pointer leaves both bands, so a still pointer never ping-pongs.
  const cornerOf = (id: ThemeChooserThemeId) => (corner.current[id] ??= { armed: true, timer: null });
  const onCornerEnter = (id: ThemeChooserThemeId, index: number) => (event: PointerEvent<HTMLElement>) => {
    const state = cornerOf(id);
    if (event.pointerType === 'touch' || !state.armed || index !== frontRef.current) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      state.armed = false;
      shuffle(id);
    }, MOTION.intentMs);
  };
  const onCornerLeave = (id: ThemeChooserThemeId) => (event: PointerEvent<HTMLElement>) => {
    const to = event.relatedTarget;
    if (to instanceof Element && to.closest('.ib-thc-hit') && event.currentTarget.parentElement?.contains(to)) return;
    const state = cornerOf(id);
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.armed = true;
  };

  // A swipe across the stage on a touch screen moves one card.
  const touch = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);
  const lastPointer = useRef('');
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    lastPointer.current = event.pointerType;
    if (event.pointerType !== 'touch') return;
    touch.current = { x: event.clientX, y: event.clientY };
    swiped.current = false;
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const from = touch.current;
    touch.current = null;
    if (!from) return;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    if (Math.abs(dx) < MOTION.swipePx || Math.abs(dx) < Math.abs(dy)) return;
    swiped.current = true;
    setTimeout(() => {
      swiped.current = false;
    }, 60);
    setFront(frontRef.current + (dx < 0 ? 1 : -1));
  };

  // Clicks and taps: a card not in front comes forward; on the front card its corner shuffles and its button acts.
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (swiped.current) return;
    const target = event.target instanceof Element ? event.target : null;
    const act = target?.closest<HTMLElement>('[data-act]');
    // A real pointer's click (a key's has no click count): the card it means comes forward and nothing else happens.
    if (event.detail > 0) {
      const i = cardAt(event.clientX, event.clientY);
      if (i >= 0 && i !== frontRef.current) {
        event.preventDefault();
        setFront(i);
        return;
      }
    }
    if (!act) return;
    const index = Number(act.closest<HTMLElement>('[data-card-index]')?.dataset.cardIndex ?? -1);
    if (index !== frontRef.current) return;
    const id = THEME_CHOOSER_CARDS[index];
    const kind = act.dataset.act;
    if (kind === 'own') {
      onOwn();
      return;
    }
    if (!id || id === 'own') return;
    if (kind === 'pick') {
      onPick(themeChooserPick(id, modes[id], system));
      return;
    }
    if (kind !== 'shuffle') return;
    const byKey = event.detail === 0;
    // A mouse already shuffled by pointing at the corner; a tap, a pen or a key shuffles here.
    if (!byKey && !g.deck && lastPointer.current === 'mouse') return;
    const was = modes[id];
    flushSync(() => shuffle(id));
    // A key stays on the corner, which now names the other mode.
    if (byKey) corners.current[`${id}:${was}`]?.focus({ preventScroll: true });
  };

  // Left and Right on a card's button go to the neighbour's main button (its focus brings that card forward).
  const onButtonKey = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    cards.current[index + (event.key === 'ArrowRight' ? 1 : -1)]?.querySelector<HTMLElement>('[data-theme-main]')?.focus();
  };

  const instant = reduced || !placed.current;
  const vars = {
    '--thc-w': `${g.width}px`,
    '--thc-cw': `${g.cardW}px`,
    '--thc-sw': `${g.sheetW}px`,
    '--thc-sh': `${g.sheetH}px`,
    '--thc-px': `${g.peekX}px`,
    '--thc-py': `${g.peekY}px`,
    '--thc-stage-h': `${size.stageH}px`,
    '--thc-k': String(size.k),
  } as CSSProperties;
  const more = BUILT_IN_THEMES.length - THEME_CHOOSER_THEMES.length;

  return (
    <Modal labelledBy="ib-thc-title" testId="theme-chooser" onClose={onDismiss} ownKeys initialFocus="[data-front] [data-theme-main]" className="ib-thc">
      <div className="ib-thc-head">
        <h2 id="ib-thc-title">
          <span className="ib-sr">{WORDS.title}</span>
          <span className="ib-thc-wm" aria-hidden="true">
            {WORDS.lettering.split('').map((letter, i) => (
              <span key={i} className={`ib-thc-t theme-${THEME_CHOOSER_TILES[i]!.theme}${THEME_CHOOSER_TILES[i]!.light ? ' light' : ''}`}>
                <span style={{ fontFamily: `"${STAR_ASK_DISPLAY_FONT}", sans-serif`, fontSize: 34 }}>{letter}</span>
              </span>
            ))}
          </span>
        </h2>
        <span className="ib-bsp" />
        <button type="button" className="ib-thc-x" aria-label={WORDS.close} onClick={onDismiss} data-theme-close="">
          <Glyph d={ICON.x} />
        </button>
      </div>
      <div ref={wrap} className="ib-thc-wrap" style={vars}>
        <div ref={stage} className="ib-thc-stage" data-theme-stage="" data-theme-front={THEME_CHOOSER_CARDS[front]} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onClickCapture={onClick}>
          {THEME_CHOOSER_CARDS.map((id, i) => {
            const move = themeChooserMove(i, front, instant);
            const style = {
              transform: themeChooserTransform(themeChooserPose(i, front, g)),
              '--thc-d': `${move.ms}ms`,
              '--thc-dl': `${move.delayMs}ms`,
              '--thc-e': move.ease,
            } as CSSProperties;
            const shared = {
              className: 'ib-thc-card',
              style,
              'data-card-index': i,
              'data-theme-card': id,
              'data-front': i === front ? '' : undefined,
              ref: (el: HTMLElement | null) => {
                cards.current[i] = el;
              },
            };
            const focus = () => setFront(i);
            if (id === 'own') {
              return (
                <section key={id} {...shared} aria-label={WORDS.own}>
                  <div className="ib-thc-own">
                    {THEME_CHOOSER_OWN.map((own) => (
                      <div key={own.id} className="ib-thc-sheet">
                        {art && <img src={art.own[own.id]} alt={WORDS.ownAlt(own.name)} draggable={false} />}
                        <span className="ib-thc-own-name">{own.name}</span>
                      </div>
                    ))}
                  </div>
                  <div className="ib-thc-foot">
                    <span className="ib-thc-name">
                      <b>{WORDS.own}</b>
                    </span>
                    <span className="ib-thc-line">{WORDS.ownLine(more)}</span>
                    <span className="ib-bsp" />
                    <button type="button" className="ib-btn" data-act="own" data-theme-main="" onFocus={focus} onKeyDown={onButtonKey(i)}>
                      {WORDS.openSettings}
                    </button>
                  </div>
                </section>
              );
            }
            const theme = THEME_CHOOSER_THEMES.find((t) => t.id === id)!;
            const keep = themeChooserKeeps(id, modes[id], system, inUse);
            return (
              <section key={id} {...shared} aria-label={`${WORDS.brand} ${theme.name}`}>
                <div className="ib-thc-pair">
                  <i className="ib-thc-hit" data-band="top" data-act="shuffle" onPointerEnter={onCornerEnter(id, i)} onPointerLeave={onCornerLeave(id)} />
                  <i className="ib-thc-hit" data-band="right" data-act="shuffle" onPointerEnter={onCornerEnter(id, i)} onPointerLeave={onCornerLeave(id)} />
                  {HALVES.map((half) => {
                    // The corner of the sheet behind is the button; the one in front has none to show.
                    const behind = modes[id] !== half;
                    return (
                      <div
                        key={half}
                        className="ib-thc-sheet"
                        data-half={half}
                        data-pos={settled[id] === half ? 'front' : 'back'}
                        ref={(el) => {
                          sheets.current[`${id}:${half}`] = el;
                        }}
                      >
                        {art && <img src={art.sheets[id][half]} width={g.sheetW} height={g.sheetH} alt={WORDS.sheetAlt(theme.name, half)} decoding="sync" draggable={false} />}
                        <button
                          type="button"
                          className="ib-thc-corner"
                          data-act="shuffle"
                          data-theme-corner={half}
                          aria-label={WORDS.cornerLabel(theme.name, half)}
                          aria-hidden={behind ? undefined : true}
                          tabIndex={behind ? 0 : -1}
                          onFocus={focus}
                          onKeyDown={onButtonKey(i)}
                          ref={(el) => {
                            corners.current[`${id}:${half}`] = el;
                          }}
                        >
                          <Glyph d={half === 'dark' ? ICON.moon : ICON.sun} />
                          {WORDS.corner(half)}
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="ib-thc-foot">
                  <span className="ib-thc-name">
                    <span>{WORDS.brand}</span>
                    <b>{theme.name}</b>
                  </span>
                  {themeChooserInUse(id, inUse) && <span className="ib-lvc-tag ib-lvc-inuse">{WORDS.inUse}</span>}
                  <span className="ib-thc-line" data-theme-line="">
                    {themeChooserLine(id, modes[id], system)}
                  </span>
                  <span className="ib-bsp" />
                  <button type="button" className={keep ? 'ib-btn' : 'ib-btn ib-pri'} data-act="pick" data-theme-main="" data-theme-pick={id} onFocus={focus} onKeyDown={onButtonKey(i)}>
                    {themeChooserButton(id, modes[id], system, inUse)}
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      </div>
      <div className="ib-thc-dots" aria-hidden="true">
        {THEME_CHOOSER_CARDS.map((id, i) => (
          <span key={id} data-on={i === front ? '' : undefined} />
        ))}
      </div>
    </Modal>
  );
}

function Glyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
