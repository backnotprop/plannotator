/**
 * The picture at the top of the Routines intro (round 2's variant F, "The loop", approved 2026-11-17): the brand kit's
 * Static Storm palette and hash (codeReviewOfferArt.ts), the storm kept to the outer edges. A loop with three stations,
 * a clock labelled "Weekdays 9:00 AM", the agent ("agent runs") and a speech bubble ("reply lands"), with arrows for
 * the direction. The clock's hand sweeps to 9 and lets a bone token go; the token goes round by itself, each station
 * lights as it passes, and the count in the middle ("13 runs so far") goes up each lap. Then the token waits at the
 * clock for the next 9:00.
 *
 * Under reduced motion one still is drawn and nothing moves: the token on its way from the clock to the agent, the
 * arrows, the schedule's label and the count, so it still reads as scheduled and repeating. Decoration only (the
 * band is aria-hidden; the dialog carries a text equivalent); the same in light and dark.
 */
import { UV, hash } from './codeReviewOfferArt';

/** The clock's sweep to 9:00, ms, then one lap of the token. */
export const ROUTINES_LOOP_WAIT_MS = 1300;
export const ROUTINES_LOOP_GO_MS = 2500;
export const ROUTINES_LOOP_LAP_MS = ROUTINES_LOOP_WAIT_MS + ROUTINES_LOOP_GO_MS;
/** The run count before the first lap. */
export const ROUTINES_LOOP_FIRST_COUNT = 13;
/** The still (reduced motion): the token a fifth of the way round, from the clock towards the agent. */
export const ROUTINES_LOOP_STILL_MS = ROUTINES_LOOP_WAIT_MS + ROUTINES_LOOP_GO_MS * 0.2;

/** Where each station stands on the loop, degrees (0 is the right end, 90 the bottom). */
const STATIONS = { clock: -90, agent: 30, reply: 150 } as const;
/** Claude Code's mark, as the Inbox draws it (the agent). */
const AGENT_PATH = 'M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4';
const AGENT_ORANGE = '#D97757';

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const ease = (x: number) => 1 - Math.pow(1 - clamp(x), 3);

/** One frame of the loop, from one clock (ms since it started). Pure, so a test can read any moment. */
export interface RoutinesLoopFrame {
  /** The clock's hand, degrees from 12 (270 is 9 o'clock). */
  hand: number;
  /** The token's place on the loop, degrees (−90: at the clock). */
  token: number;
  /** The token is moving (its trail shows). */
  moving: boolean;
  /** The clock rings as it lets the token go (0..1). */
  ring: number;
  /** How lit the agent and the reply stations are as the token passes (0..1). */
  agent: number;
  reply: number;
  /** Runs so far. */
  count: number;
}

export function routinesLoopFrame(t: number): RoutinesLoopFrame {
  const lap = Math.floor(Math.max(0, t) / ROUTINES_LOOP_LAP_MS);
  const s = Math.max(0, t) - lap * ROUTINES_LOOP_LAP_MS;
  const moving = s >= ROUTINES_LOOP_WAIT_MS;
  const progress = moving ? (s - ROUTINES_LOOP_WAIT_MS) / ROUTINES_LOOP_GO_MS : 0;
  const token = -90 + 360 * progress;
  const near = (deg: number) => (moving ? clamp(1 - Math.abs(((token - deg + 540) % 360) - 180) / 28) : 0);
  return {
    hand: moving ? 270 : 270 * ease(s / ROUTINES_LOOP_WAIT_MS),
    token,
    moving,
    ring: moving ? clamp(1 - (s - ROUTINES_LOOP_WAIT_MS) / 400) : clamp((s - ROUTINES_LOOP_WAIT_MS + 200) / 200),
    agent: near(STATIONS.agent),
    reply: near(STATIONS.reply),
    count: ROUTINES_LOOP_FIRST_COUNT + lap + (moving ? 1 : 0),
  };
}

const NS = 'http://www.w3.org/2000/svg';
function el(parent: Element, tag: string, attrs: Record<string, string | number> = {}, text?: string): SVGElement {
  const node = document.createElementNS(NS, tag);
  for (const key in attrs) node.setAttribute(key, String(attrs[key]));
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}
function set(node: Element, attrs: Record<string, string | number>): void {
  for (const key in attrs) node.setAttribute(key, String(attrs[key]));
}

/** Draw the loop's fixed parts into `svg` (W×H), and give back the frame drawer. */
export function drawRoutinesLoop(svg: SVGSVGElement, W: number, H: number): (t: number) => void {
  const phone = W < 420;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.replaceChildren();
  // The storm at the edges: dithered cells in the kit's palette, thinning toward the middle.
  const u = 6;
  for (let y = 0; y < H; y += u)
    for (let x = 0; x < W; x += u) {
      const edge = Math.min(x, W - x) / W;
      const q = hash(5, x, y);
      if (edge > (phone ? 0.07 : 0.11) || q > 0.6 - edge * 5) continue;
      el(svg, 'rect', { x, y, width: u, height: u, fill: q < 0.18 ? UV.lilac : q < 0.38 ? UV.violet : UV.indigo, opacity: q < 0.18 ? 0.55 : 0.9 });
    }
  const cx = W / 2;
  const cy = H / 2 - 4;
  const rx = Math.min(W * (phone ? 0.32 : 0.3), 170);
  const ry = H * 0.3;
  const at = (deg: number): [number, number] => {
    const a = (deg * Math.PI) / 180;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  };
  el(svg, 'ellipse', { cx, cy, rx, ry, fill: 'none', stroke: UV.violet, 'stroke-width': 2.5 });
  // The arrows: the way round.
  for (const deg of [-30, 90, 210]) {
    const [x, y] = at(deg);
    const [x2, y2] = at(deg + 3);
    const ang = Math.atan2(y2 - y, x2 - x);
    el(svg, 'path', {
      d: `M${x} ${y}l${-7 * Math.cos(ang - 0.55)} ${-7 * Math.sin(ang - 0.55)}M${x} ${y}l${-7 * Math.cos(ang + 0.55)} ${-7 * Math.sin(ang + 0.55)}`,
      stroke: UV.lilac,
      'stroke-width': 2,
      'stroke-linecap': 'round',
      fill: 'none',
      'data-routines-loop-arrow': '',
    });
  }
  const station = (deg: number, r: number) => {
    const [x, y] = at(deg);
    const g = el(svg, 'g', { transform: `translate(${x} ${y})` });
    const bg = el(g, 'circle', { r, fill: UV.void, stroke: UV.lilac, 'stroke-width': 2 });
    return { g, bg, x, y };
  };
  // The clock: its hand sweeps to 9 and lets the token go.
  const clock = station(STATIONS.clock, 20);
  for (let i = 0; i < 12; i += 3) {
    const a = (i * Math.PI) / 6;
    el(clock.g, 'line', { x1: 14 * Math.sin(a), y1: -14 * Math.cos(a), x2: 17 * Math.sin(a), y2: -17 * Math.cos(a), stroke: UV.lilac, 'stroke-width': 1.5 });
  }
  el(clock.g, 'circle', { cx: -14, cy: 0, r: 3.2, fill: UV.bone });
  const hand = el(clock.g, 'line', { x1: 0, y1: 0, x2: 0, y2: -12, stroke: UV.bone, 'stroke-width': 2.4, 'stroke-linecap': 'round' });
  el(svg, 'text', { x: clock.x + 30, y: clock.y + 4, class: 'ib-rti-label ib-rti-when', fill: UV.bone }, 'Weekdays 9:00 AM');
  // The agent.
  const agent = station(STATIONS.agent, 18);
  el(agent.g, 'path', { d: AGENT_PATH, transform: 'translate(-8 -8) scale(.68)', stroke: AGENT_ORANGE, 'stroke-width': 3, 'stroke-linecap': 'round', fill: 'none' });
  el(svg, 'text', { x: agent.x, y: agent.y + 34, class: 'ib-rti-label', fill: UV.lilac, 'text-anchor': 'middle' }, 'agent runs');
  // The reply.
  const reply = station(STATIONS.reply, 18);
  el(reply.g, 'path', { d: 'M-8 -6h16v10h-9l-5 4v-4h-2z', fill: 'none', stroke: UV.bone, 'stroke-width': 1.6, 'stroke-linejoin': 'round' });
  el(svg, 'text', { x: reply.x, y: reply.y + 34, class: 'ib-rti-label', fill: UV.lilac, 'text-anchor': 'middle' }, 'reply lands');
  // The count in the middle.
  const count = el(svg, 'text', { x: cx, y: cy + 4, class: 'ib-rti-count', fill: UV.bone, 'text-anchor': 'middle', 'data-routines-loop-count': '' });
  el(svg, 'text', { x: cx, y: cy + 24, class: 'ib-rti-label ib-rti-small', fill: UV.lilac, 'text-anchor': 'middle' }, 'runs so far');
  const trail = [0, 1, 2, 3, 4].map((i) => el(svg, 'circle', { r: 6 - i, fill: UV.bone, opacity: 0 }));
  const token = el(svg, 'circle', { r: 7, fill: UV.bone, 'data-routines-loop-token': '' });
  return (t: number) => {
    const f = routinesLoopFrame(t);
    set(hand, { transform: `rotate(${f.hand})` });
    const [x, y] = at(f.token);
    set(token, { cx: x, cy: y });
    trail.forEach((dot, i) => {
      const [tx, ty] = at(f.token - (i + 1) * 5.2);
      set(dot, { cx: tx, cy: ty, opacity: f.moving ? 0.45 - i * 0.08 : 0 });
    });
    set(clock.bg, { fill: f.ring > 0 ? UV.violet : UV.void, 'stroke-width': 2 + 2 * f.ring });
    set(agent.g, { transform: `translate(${agent.x} ${agent.y}) scale(${1 + 0.25 * f.agent})` });
    set(agent.bg, { fill: f.agent > 0.2 ? UV.indigo : UV.void });
    set(reply.g, { transform: `translate(${reply.x} ${reply.y}) scale(${1 + 0.25 * f.reply})` });
    set(reply.bg, { fill: f.reply > 0.2 ? UV.indigo : UV.void });
    count.textContent = String(f.count);
  };
}

/** The band's size before layout (happy-dom, a first frame): the dialog's art band. */
const FALLBACK = { desktop: [560, 212], phone: [358, 196] } as const;

/**
 * Play the loop into `svg`: one clock from the first frame, redrawn at a new size. `still` (reduced motion): one
 * frame (`ROUTINES_LOOP_STILL_MS`) and no animation frame at all. Gives back the stop.
 */
export function playRoutinesLoop(svg: SVGSVGElement, o: { phone: boolean }, still: boolean): () => void {
  let draw: (t: number) => void = () => {};
  let last = still ? ROUTINES_LOOP_STILL_MS : 0;
  const build = () => {
    const box = svg.getBoundingClientRect();
    const [fw, fh] = o.phone ? FALLBACK.phone : FALLBACK.desktop;
    draw = drawRoutinesLoop(svg, Math.round(box.width) || fw, Math.round(box.height) || fh);
    draw(last);
  };
  build();
  let raf = 0;
  if (!still) {
    let start: number | null = null;
    const tick = (now: number) => {
      start ??= now;
      last = now - start;
      draw(last);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  let first = true;
  const observer =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          // The first notice is the observing itself.
          if (first) {
            first = false;
            return;
          }
          build();
        })
      : null;
  observer?.observe(svg);
  return () => {
    cancelAnimationFrame(raf);
    observer?.disconnect();
  };
}
