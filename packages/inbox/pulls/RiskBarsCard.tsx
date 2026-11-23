/**
 * The risk bars' card (approval "review-risk-bars", the owner's q-070bc2a3: "a card on the bars; no row in the diff").
 * The diff shows only the bars on a named line; the reason is read from a small card on them, so the code is never
 * broken up by a row. The card says what the old row said open: Risk's gauge, "Risk", the level ("High" / "Medium"),
 * the person's rule the place touches when the check named one, and the check's reason for that place (two places
 * starting on one line share a mark: both are listed). A Medium place with no reason shows the level alone.
 *
 * How it opens, as the ref hover cards do (ui's RefHoverCard: the same delays): resting the pointer or keyboard focus
 * on the bars opens it, leaving closes it (the pointer may move into the card); a click or tap pins it, and Escape, a
 * press outside or a second click closes it. The header's "N places" opens each place's card in turn (`show`), pinned,
 * and closes the one before. It floats on ui's Popover (Base UI) anchored to the bars' button: nothing in the diff
 * moves. No shortcut, no setting.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Popover, PopoverContent } from '@plannotator/ui/components/Popover';
import { REF_CARD_CLOSE_MS, REF_CARD_DELAY_MS } from '@plannotator/ui/components/RefHoverCard';
import { RiskGauge } from '../contextNotes/ContextNotes';
import { inOverlay, isComposingKey, isEditableTarget, keyTarget, modalOpen } from '../shortcuts/guards';
import type { OnGuideLineMark } from '../guide/types';
import type { RiskBars, RiskBarsLevel, RiskBarsNote } from './riskBars';
import { riskBarsLabel } from './riskBarsMarks';

interface Open {
  id: string;
  anchor: HTMLButtonElement;
  via: 'hover' | 'focus' | 'press' | 'step';
  pinned: boolean;
}

const LEVEL: Record<RiskBarsLevel, string> = { high: 'High', medium: 'Medium' };

/** The bars' button for a place's first line, if the diff draws it (inside its file's shadow root). */
export function riskMarkButton(file: string, side: 'old' | 'new', line: number): HTMLButtonElement | null {
  for (const shell of document.querySelectorAll(`[data-guide-file-shell="${CSS.escape(file)}"]`)) {
    for (const host of shell.querySelectorAll('diffs-container')) {
      const button = host.shadowRoot?.querySelector<HTMLButtonElement>(`[data-host-line-mark="${side}:${Math.trunc(line)}"]`);
      if (button) return button;
    }
  }
  return null;
}

/** Where the card portals: the Inbox's own root (its theme), from the bars' file's host outside the shadow root. */
function containerOf(anchor: Element): HTMLElement | undefined {
  const root = anchor.getRootNode();
  const host = root instanceof ShadowRoot ? root.host : anchor;
  return host.closest<HTMLElement>('dialog[open], .pn-inbox') ?? undefined;
}

/**
 * The scroller the bars' line scrolls in (up from the file's host, out of the shadow root): the nearest element that
 * scrolls up and down; none (null) is the window's.
 */
export function scrollerOf(anchor: Element): Element | null {
  const root = anchor.getRootNode();
  let el: Element | null = root instanceof ShadowRoot ? root.host : anchor.parentElement;
  while (el) {
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') && el.scrollHeight > el.clientHeight) return el;
    const up: Node | null = el.parentElement ?? el.parentNode;
    el = up instanceof ShadowRoot ? up.host : up instanceof Element ? up : null;
  }
  return null;
}

/**
 * Whether an Escape from `from` belongs to something else than the card on `anchor`: a field being typed in, a
 * dialog or popover layer (shortcuts/guards.ts `inOverlay`) or a modal (`modalOpen`), unless that layer holds the
 * bars' diff itself (a review shown in a dialog).
 */
export function escapeIsOthers(from: Element | null, anchor: Element): boolean {
  const root = anchor.getRootNode();
  const host = root instanceof ShadowRoot ? root.host : anchor;
  if (modalOpen() && !host.closest('dialog[open]')) return true;
  if (!from) return false;
  if (isEditableTarget(from)) return true;
  return inOverlay(from) && !from.closest('dialog, [role="dialog"], [role="alertdialog"], [data-popover-layer]')?.contains(host);
}

/** What the card says: the old row's head and words, for each place on the line. */
export function RiskBarsCardBody({ level, notes }: { level: RiskBarsLevel; notes: readonly RiskBarsNote[] }) {
  const said = notes.filter((note) => note.why || note.rule);
  const one = said.length === 1 ? said[0]! : null;
  return (
    <>
      <div className="ib-ctxn-h">
        <RiskGauge />
        <b>Risk</b>
        <span className="ib-risk ib-ctxn-risk" data-risk={level}>
          {LEVEL[level]}
        </span>
        {one?.rule && <RuleWords rule={one.rule} lead={'\u00a0· '} />}
      </div>
      {said.map((note, i) => (
        <div key={i} className="ib-riskcard-note" data-risk-card-note="">
          {!one && note.rule && <RuleWords rule={note.rule} lead="" />}
          {note.why && (
            <p className="ib-ctxn-t" dir="auto">
              {note.why}
            </p>
          )}
        </div>
      ))}
    </>
  );
}

function RuleWords({ rule, lead }: { rule: string; lead: string }) {
  return (
    <span className="ib-ctxn-by" dir="auto" data-risk-card-rule="">
      {lead}your rule <span className="ib-ctxn-q">“{rule}”</span>
    </span>
  );
}

/**
 * The card for the bars in `bars`: `onMark` goes to the reader's `onLineMark`, `show(id)` opens a mark's card from the
 * stepper (waiting for its line to be drawn, then bringing it into view), `node` is the card.
 */
export function useRiskBarsCard(bars: RiskBars | null): { onMark: OnGuideLineMark; show: (id: string) => void; node: ReactNode } {
  const [card, setCard] = useState<Open | null>(null);
  const current = useRef<Open | null>(null);
  current.current = card;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const stepTimer = useRef<number | null>(null);
  const byId = useMemo(() => new Map((bars?.ranges ?? []).map((range) => [range.id, range] as const)), [bars]);

  const clearOpen = () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    openTimer.current = null;
  };
  const clearClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const close = useCallback(() => {
    clearOpen();
    clearClose();
    setCard(null);
  }, []);
  const openNow = useCallback((next: Open) => {
    clearOpen();
    clearClose();
    setCard(next);
  }, []);
  const scheduleClose = useCallback(() => {
    clearClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      if (!current.current?.pinned) setCard(null);
    }, REF_CARD_CLOSE_MS);
  }, []);
  const later = (fn: () => void) => {
    clearOpen();
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      fn();
    }, REF_CARD_DELAY_MS);
  };

  const onMark = useCallback<OnGuideLineMark>(
    (id, event, anchor, related) => {
      const c = current.current;
      const intoCard = related instanceof Node && !!cardRef.current?.contains(related);
      if (event === 'press') {
        if (c?.id === id && c.pinned) close();
        else openNow({ id, anchor, via: 'press', pinned: true });
        return;
      }
      if (event === 'enter' || event === 'focus') {
        if (c?.id === id) {
          clearClose();
          return;
        }
        // A pinned card stays until it is closed.
        if (c?.pinned) return;
        later(() => openNow({ id, anchor, via: event === 'enter' ? 'hover' : 'focus', pinned: false }));
        return;
      }
      // leave, blur: what has not opened yet never will; an open card it opened closes (the pointer may go into it).
      clearOpen();
      if (!c || c.id !== id || c.pinned || intoCard) return;
      if (event === 'leave' && c.via === 'hover') scheduleClose();
      if (event === 'blur' && c.via === 'focus') close();
    },
    [close, openNow, scheduleClose], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const show = useCallback(
    (id: string) => {
      if (stepTimer.current !== null) window.clearTimeout(stepTimer.current);
      setCard(null);
      let tries = 0;
      const look = () => {
        stepTimer.current = null;
        const range = byIdRef.current.get(id);
        const anchor = range ? riskMarkButton(range.file, range.side, range.line) : null;
        if (anchor) {
          anchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
          openNow({ id, anchor, via: 'step', pinned: true });
        } else if (tries++ < 60) stepTimer.current = window.setTimeout(look, 100);
      };
      stepTimer.current = window.setTimeout(look, 60);
    },
    [openNow],
  );

  // Other bars (another layer, a new judgment): a card on a mark that is gone closes.
  useEffect(() => {
    if (card && !byId.has(card.id)) close();
  }, [byId, card, close]);

  // The bars gone or out of sight close their card: the file's diff let its element go (its button is made again
  // when the file comes back, so the card would point at nothing), or the line scrolled out of the diff's scroller
  // (a card left open would float over the header or the rail). Back in view, no card opens until asked. A line drawn
  // again keeps its button (hostLineMarks.ts), so that closes nothing. The stepper's line may start out of view: only
  // leaving the view after being in it closes.
  const anchor = card?.anchor ?? null;
  useEffect(() => {
    if (!anchor) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      if (!anchor.isConnected) close();
    };
    const soon = () => {
      if (!frame) frame = window.requestAnimationFrame(check);
    };
    const watch = new MutationObserver(soon);
    watch.observe(document.body, { childList: true, subtree: true });
    const home = anchor.getRootNode();
    if (home instanceof ShadowRoot) watch.observe(home, { childList: true, subtree: true });
    let seen = false;
    const view =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(
            (entries) => {
              const last = entries[entries.length - 1];
              if (!last) return;
              if (!anchor.isConnected) close();
              else if (last.isIntersecting) seen = true;
              else if (seen) close();
            },
            { root: scrollerOf(anchor) },
          )
        : null;
    view?.observe(anchor);
    check();
    return () => {
      watch.disconnect();
      view?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [anchor, close]);

  // The bars say whether their card is open (they carry `aria-haspopup="dialog"`, riskBarsMarks.ts).
  useEffect(() => {
    if (!anchor) return;
    anchor.setAttribute('aria-expanded', 'true');
    return () => anchor.setAttribute('aria-expanded', 'false');
  }, [anchor]);

  // While open: Escape and a press outside close it (the window's own Escape does not also run). Escape is the card's
  // only while it shows and the key comes from the bars or the card, or from nowhere that has its own Escape: a field
  // being typed in (a comment box), a dialog or another popover layer, or a modal keeps it.
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isComposingKey(e)) return;
      const shown = cardRef.current;
      if (!shown?.isConnected || !card.anchor.isConnected) return;
      const from = keyTarget(e);
      const ours = !!from && (from === card.anchor || shown.contains(from));
      if (!ours && escapeIsOthers(from, card.anchor)) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    const onDown = (e: PointerEvent) => {
      const path = e.composedPath();
      if (path.includes(card.anchor) || (cardRef.current && path.includes(cardRef.current))) return;
      close();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [card, close]);

  useEffect(
    () => () => {
      clearOpen();
      clearClose();
      if (stepTimer.current !== null) window.clearTimeout(stepTimer.current);
    },
    [],
  );

  const range = card ? byId.get(card.id) : undefined;
  const node =
    card && range && bars ? (
      <Popover open modal={false}>
        <PopoverContent
          ref={cardRef}
          anchor={card.anchor}
          container={containerOf(card.anchor)}
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          initialFocus={false}
          finalFocus={false}
          aria-label={riskBarsLabel(bars.level, range.notes)}
          className="ib-riskcard"
          data-risk-card={bars.level}
          data-risk-card-pinned={card.pinned ? '' : undefined}
          onPointerEnter={clearClose}
          onPointerLeave={(e) => {
            if (e.pointerType !== 'touch' && !current.current?.pinned) scheduleClose();
          }}
          onPointerDown={() => {
            if (!current.current?.pinned) setCard((c) => (c ? { ...c, pinned: true } : c));
          }}
        >
          <RiskBarsCardBody level={bars.level} notes={range.notes} />
        </PopoverContent>
      </Popover>
    ) : null;

  return { onMark, show, node };
}
