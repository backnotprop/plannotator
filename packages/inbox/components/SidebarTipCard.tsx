/**
 * The Sidebar tip's card (rules in sidebarTip.ts): the Launch tip's card (`.ib-tour-coach.ib-ctip`, LaunchTipCard.tsx)
 * standing beside the sidebar, its arrow on the sidebar's edge, level with the Inbox row. It never takes focus: a
 * pointer press on Got it keeps focus where it was. It leaves by itself on Escape (only the tip closes), a right-click
 * on the sidebar (the menu the tip is about), and when `gone` turns true (the Customize panel, the sidebar going away).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { PAGE_OVERLAYS } from '../idleClock';
import { SIDEBAR_TIP_SAID, SIDEBAR_TIP_TIMES, SIDEBAR_TIP_WORDS, sidebarTipPlace, sidebarTipTarget, type SidebarTipPlace } from '../sidebarTip';

export function SidebarTipCard(props: {
  /** The tip no longer has its place (the Customize panel opened, the sidebar closed, something is over the page). */
  gone: boolean;
  /** The window's polite region says it once. */
  onSay: (text: string) => void;
  /** It left: closed for good (the claim stamped it). */
  onLeave: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<SidebarTipPlace | null>(null);
  const [leaving, setLeaving] = useState(false);
  const titleId = useId();
  const latest = useRef(props);
  latest.current = props;

  const leave = () => setLeaving(true);
  useEffect(() => {
    if (props.gone) setLeaving(true);
  }, [props.gone]);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => latest.current.onLeave(), SIDEBAR_TIP_TIMES.leaveMs);
    return () => clearTimeout(timer);
  }, [leaving]);

  useEffect(() => {
    latest.current.onSay(SIDEBAR_TIP_SAID);
  }, []);

  // Beside the sidebar, wherever its edge is now (its width is the person's to drag); no sidebar, or no room: it leaves.
  useLayoutEffect(() => {
    const measure = () => {
      const card = cardRef.current;
      const target = sidebarTipTarget(card?.closest('.pn-inbox') ?? document);
      if (!card || !target) return setLeaving(true);
      const next = sidebarTipPlace({
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        sidebar: target.sidebar.getBoundingClientRect(),
        row: target.row?.getBoundingClientRect() ?? null,
        cardHeight: card.offsetHeight,
      });
      if (!next) return setLeaving(true);
      setPlace((current) => (current && current.top === next.top && current.left === next.left && current.arrow === next.arrow ? current : next));
    };
    measure();
    window.addEventListener('resize', measure);
    const target = sidebarTipTarget(cardRef.current?.closest('.pn-inbox') ?? document);
    const observer = typeof ResizeObserver === 'function' && target ? new ResizeObserver(measure) : null;
    if (observer && target) observer.observe(target.sidebar);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    // Escape closes only the tip; with a menu or dialog open, Escape is theirs.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector(PAGE_OVERLAYS)) return;
      event.preventDefault();
      event.stopPropagation();
      leave();
    };
    // The sidebar's own menu (a right-click, Shift+F10, the menu key): what the tip is about.
    const onMenu = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('aside.ib-side')) leave();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('contextmenu', onMenu, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('contextmenu', onMenu, true);
    };
  }, []);

  return (
    <div
      ref={cardRef}
      className="ib-tour-coach ib-ctip ib-st"
      role="group"
      aria-labelledby={titleId}
      aria-hidden={leaving || undefined}
      data-sidebar-tip=""
      data-side="right"
      data-leaving={leaving ? '' : undefined}
      style={place ? { top: place.top, left: place.left } : { visibility: 'hidden' }}
    >
      <span className="ib-ctip-arrow" data-side="left" style={place ? { top: place.arrow - 5 } : undefined} aria-hidden="true" />
      <div className="ib-tc-eb">{SIDEBAR_TIP_WORDS.eyebrow}</div>
      <h2 id={titleId}>{SIDEBAR_TIP_WORDS.title}</h2>
      <p>{SIDEBAR_TIP_WORDS.line}</p>
      <div className="ib-tc-acts">
        <span className="ib-sp" />
        <button
          type="button"
          className="ib-tc-next"
          data-sidebar-tip-ok=""
          tabIndex={leaving ? -1 : undefined}
          // A pointer press never takes focus from the list or the thread.
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={leave}
        >
          {SIDEBAR_TIP_WORDS.ok}
        </button>
      </div>
    </div>
  );
}
