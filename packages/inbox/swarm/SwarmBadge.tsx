import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { SWARM_GATHER_MS, SWARM_SETTLE_AT_MS, SWARM_SETTLE_MS, swarmGather, swarmMotionStop, swarmReducedMotion, swarmRegather } from './swarmBadgeMotion';

/**
 * The Swarm badge (docs/agent-guides/inbox-swarm.md): a toggle whose state is "these words carry the `/swarm` skill"
 * (swarmSkillWords.ts). In New message it is there, quiet, once To holds an agent; a second agent added or a new agent
 * being started plays the Gather once (the icon's dots fly in and form the badge, stars spark out), then it rests OFF
 * until the person turns it on (the owner, 2026-11-24: "it appears, then rests off until I turn it on"). On, small
 * stars drift around it. A swarm thread's summary row shows its on look alone (`SwarmBadgeLook`), not a control.
 *
 * The badge's look and motion are this file's markup constants (the icon's dots, the particles, the stars),
 * swarmBadgeMotion.ts and swarmBadge.css: the designer's later round replaces those three, nothing else.
 */

/** The icon: loose round dots in a 16-unit box (the designer's round 3, "Drift"). Each: x, y, radius. */
const SWARM_DOTS: readonly (readonly [number, number, number])[] = [[4.4, 3.6, 1.8], [10.2, 2.6, 1.25], [13.0, 7.4, 1.5], [7.9, 8.2, 1.35], [2.8, 10.6, 1.3], [9.4, 13.2, 1.7]];
const TURN = [0.35, -0.3, 0.2, -0.25, 0.3, -0.2, 0.15];
const snap = (v: number) => Math.round(v * 2) / 2;
/** Where each dot starts the Gather from: out along its own direction from the centre, a little turned, 24-32 px. */
const scatter = (x: number, y: number, i: number): [number, number] => {
  const a = Math.atan2(y - 8, x - 8) + (TURN[i] ?? 0);
  const l = 24 + (i % 3) * 4;
  return [Math.round(Math.cos(a) * l), Math.round(Math.sin(a) * l)];
};

/** The icon as HTML dots, so each can move on the compositor. */
export function SwarmGlyph({ size = 14 }: { size?: number }) {
  const k = size / 16;
  return (
    <span className="ib-sw-g" aria-hidden="true" style={{ width: size, height: size }}>
      {SWARM_DOTS.map(([x, y, r], i) => {
        const d = Math.max(1, snap(2 * r * k));
        const [sx, sy] = scatter(x, y, i);
        return <i key={i} data-v={`${sx},${sy}`} style={{ left: snap(x * k - d / 2), top: snap(y * k - d / 2), width: d, height: d }} />;
      })}
    </span>
  );
}

/** The particles the Gather draws in (four hues, eight). */
const PARTICLES = [0, 1, 2, 3, 4, 5, 6, 7];
/** The stars around the badge while on: where, size, hue, drift path, drift period, twinkle period, twinkle phase. */
const STARS: readonly { at: React.CSSProperties; size: number; hue: number; path: string; drift: number; twinkle: number; phase: number }[] = [
  { at: { left: -14, top: -8 }, size: 9, hue: 0, path: 'ib-sw-st-a', drift: 6.2, twinkle: 3.1, phase: -0.4 },
  { at: { right: -13, top: 13 }, size: 7, hue: 2, path: 'ib-sw-st-b', drift: 5.4, twinkle: 2.6, phase: -1.3 },
  { at: { right: 7, top: -13 }, size: 6, hue: 3, path: 'ib-sw-st-c', drift: 7.1, twinkle: 3.7, phase: -2.2 },
  { at: { left: 34, bottom: -12 }, size: 5, hue: 1, path: 'ib-sw-st-b', drift: 6.6, twinkle: 4.2, phase: -0.9 },
  { at: { left: -8, bottom: -3 }, size: 4, hue: 2, path: 'ib-sw-st-a', drift: 5.0, twinkle: 2.9, phase: -1.8 },
];

/** The badge's on look alone, not a control (a swarm thread's line). */
export function SwarmBadgeLook() {
  return (
    <span className="ib-sw-look" aria-hidden="true">
      <SwarmGlyph />
      <span className="ib-sw-word">Swarm</span>
    </span>
  );
}

export function SwarmBadge({
  on,
  onToggle,
  appear = true,
  highlight = 0,
  tip,
}: {
  on: boolean;
  onToggle?: (on: boolean) => void;
  /** Play the Gather when it first appears; false: simply there, quiet (New message with one agent, a thread's line). */
  appear?: boolean;
  /**
   * Each new value plays the Gather once, then the badge rests as `on` says (New message: a second agent added, or a
   * new agent being started). 0: none yet.
   */
  highlight?: number;
  /** The first-time card at the badge (useSwarmTip), beside, over or under it while shown (swarmTipPlace.ts). */
  tip?: ReactNode;
}) {
  const slot = useRef<HTMLSpanElement>(null);
  // What it looks like now: on while the Gather plays, whatever `on` says; then `on`'s look.
  const [look, setLook] = useState<'on' | 'off'>(() => (on || (appear && !swarmReducedMotion()) ? 'on' : 'off'));
  const [rest, setRest] = useState(false);
  const [settling, setSettling] = useState(false);
  const gathering = useRef(look === 'on' && !on);
  const was = useRef(on);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    if ((first ? !appear : highlight === 0) || !slot.current) return;
    if (!first) {
      // A highlight: on for a moment, whatever `on` says, then it settles back (reduced motion: no motion, no change).
      if (swarmReducedMotion()) return;
      gathering.current = !was.current;
      setSettling(false);
      setRest(false);
      setLook('on');
    }
    swarmGather(slot.current);
    const rested = setTimeout(() => setRest(true), SWARM_GATHER_MS);
    if (!gathering.current) return () => clearTimeout(rested);
    // Round 3: it shows on for a moment, then settles off, a control the person turns on.
    const settle = setTimeout(() => {
      gathering.current = false;
      setSettling(true);
      setLook(was.current ? 'on' : 'off');
    }, SWARM_SETTLE_AT_MS);
    const settled = setTimeout(() => setSettling(false), SWARM_SETTLE_AT_MS + SWARM_SETTLE_MS);
    return () => {
      clearTimeout(rested);
      clearTimeout(settle);
      clearTimeout(settled);
      if (slot.current) swarmMotionStop(slot.current);
    };
    // When it appears, and again for each highlight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight]);

  useEffect(() => {
    if (on === was.current) return;
    was.current = on;
    gathering.current = false;
    setSettling(false);
    setLook(on ? 'on' : 'off');
    if (on && slot.current) swarmRegather(slot.current);
    setRest(false);
    if (!on) return;
    const rested = setTimeout(() => setRest(true), 500);
    return () => clearTimeout(rested);
  }, [on]);

  return (
    <span ref={slot} className="ib-sw-slot" data-state={look} data-rest={rest && look === 'on' ? '' : undefined} data-settling={settling ? '' : undefined}>
      <span className="ib-sw-halo" />
      <button type="button" className="ib-swarm-badge" aria-pressed={on} data-swarm-badge={on ? 'on' : 'off'} onClick={() => onToggle?.(!on)}>
        <span className="ib-sw-clip">
          <span className="ib-sw-offbg" />
          <span className="ib-sw-on" />
        </span>
        <span className="ib-sw-ring" />
        <span className="ib-sw-face">
          <span className="ib-sw-lab ib-sw-lab-on">
            <SwarmGlyph />
            <span className="ib-sw-word">Swarm</span>
          </span>
          <span className="ib-sw-lab ib-sw-lab-off" aria-hidden="true">
            <SwarmGlyph />
            <span className="ib-sw-word">Swarm</span>
          </span>
        </span>
      </button>
      <span className="ib-sw-fx" aria-hidden="true">
        {PARTICLES.map((i) => (
          <i key={i} className="ib-sw-p" data-hue={i % 4} />
        ))}
      </span>
      <span className="ib-sw-stars" aria-hidden="true">
        {STARS.map((s, i) => (
          <i key={i} className="ib-sw-st" style={{ ...s.at, width: s.size, height: s.size }}>
            <i className="ib-sw-st-d" style={{ animationName: s.path, animationDuration: `${s.drift}s` }}>
              <i className="ib-sw-st-t" data-hue={s.hue} style={{ animationDuration: `${s.twinkle}s`, animationDelay: `${s.phase}s` }} />
            </i>
          </i>
        ))}
      </span>
      {tip}
    </span>
  );
}
