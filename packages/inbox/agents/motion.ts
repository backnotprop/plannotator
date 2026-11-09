/**
 * Animated agent marks (approval "inbox-agent-icon-motion"; ported from the icon-motion round 4 library). Each mark is
 * a little character: a rig of its own parts (rigs.ts), every part moving on its own.
 *
 * How it moves
 * - Every part has two layers: `.am-p` plays the mood loop, `.am-x` inside it plays one-off gestures (fidgets, the
 *   needs-you cue). Both animate only transform and opacity, through the Web Animations API, so the compositor runs them.
 * - A loop is a function of time, sampled into keyframes. A change of state never restarts or snaps a part: the part
 *   blends from the pose it is in to the new loop, on a spring, while the new loop already runs.
 * - Moods: idle is calm with an occasional fidget; working is busy; waiting perks up; ended falls asleep.
 * - Claude spins on its own layer; a state changes only the speed, never the angle, so the star never jumps.
 *
 * Its cost rules (the round 4 bench):
 * - Off screen (an IntersectionObserver, one for the page): every animation of the icon pauses and no fidget is
 *   scheduled; back on screen they play again.
 * - Reduced motion (or no Web Animations): no loops, no spin, no fidgets; each state holds a still pose. A swap of
 *   faces is a 160 ms fade.
 * - One fidget at a time across the page, so a list never fidgets in chorus; one fidget's gestures end on one frame.
 * - A face that is hidden stops (its spin is cancelled, not paused: a paused animation inside a `display: none` face
 *   still cost a layout every frame).
 * - `unmountAgentMark` cancels everything an icon runs: an animation left on a removed element keeps ticking.
 *
 * The click cycle: the agent's mark, then Glass, Yellow, Transparent and Face, then the agent again. Our faces are
 * the favicon art (faceArt.ts, loaded on the first click) and move as a whole.
 */
import { AGENT_RIGS, CLAUDE_RAY_ANGLES, type AgentRigKind } from './rigs';

export type AgentMood = 'idle' | 'working' | 'waiting' | 'ended';
export type AgentFace = 'agent' | 'glass' | 'yellow' | 'transparent' | 'totman';

/** The click cycle, in order (the owner, 2026-11-09): each stays until the next click. */
export const AGENT_FACES: readonly AgentFace[] = ['agent', 'glass', 'yellow', 'transparent', 'totman'];

/** The face after `face` in the cycle. */
export function nextAgentFace(face: AgentFace): AgentFace {
  return AGENT_FACES[(AGENT_FACES.indexOf(face) + 1) % AGENT_FACES.length]!;
}

/** The rig an agent host's mark has; null for a host drawn still (its plain mark). */
export function agentRigOf(host: string | null | undefined): AgentRigKind | null {
  if (host === 'claude-code' || host === 'claude' || host === 'claude-app') return 'claude';
  if (host === 'codex' || host === 'pi' || host === 'opencode') return host;
  return null;
}

/** Timers run at `clock` times their rate (a recorder that slows the page sets it); `fidgets` off: loops only. */
export const agentMotionOptions = { clock: 1, fidgets: true };

type Pose = { x: number; y: number; r: number; sx: number; sy: number; k: number; o: number };
type PoseIn = Partial<Pose>;
type Clip = { D: number; loop: boolean; f: (t: number) => PoseIn };
type Frame = { transform: string; opacity: number };

const TAU = Math.PI * 2;
const S = (t: number) => Math.sin(TAU * t);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (u: number) => {
  const c = clamp(u, 0, 1);
  return c * c * (3 - 2 * c);
};
/** A damped spring's response from 0 to 1 (t in ms). zeta < 1 overshoots. */
function rise(t: number, zeta: number, omega: number): number {
  if (t <= 0) return 0;
  const s = t / 1000;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega * s) * (Math.cos(wd * s) + ((zeta * omega) / wd) * Math.sin(wd * s));
}
/** A damped ring that starts at 1 and dies to 0 (t in ms). */
function ring(t: number, zeta: number, omega: number): number {
  if (t <= 0) return 1;
  const s = t / 1000;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  return Math.exp(-zeta * omega * s) * Math.cos(wd * s);
}
/** Pull back, then let go: dips to -1 over tIn ms, then springs past 0 and settles. */
const pull = (t: number, tIn: number, zeta: number, omega: number) => (t < tIn ? -smooth(t / tIn) : -ring(t - tIn, zeta, omega));
/** A soft square wave in -1..1: holds at each end, turns over quickly. */
const sq = (t: number, k = 3) => Math.tanh(k * S(t)) / Math.tanh(k);
/** A hop of height H with squash and stretch, for a part standing on its base. t and D in ms; it rests after `use` of D. */
function hop(t: number, D: number, H: number, Q: number, use = 1): PoseIn {
  const T = D * use;
  const a = 0.2 * T;
  const air = 0.45 * T;
  if (t < a) {
    const u = smooth(t / a);
    return { y: 0, sy: 1 - Q * u, sx: 1 + 0.6 * Q * u };
  }
  if (t < a + air) {
    const p = (t - a) / air;
    const st = 1 + 0.9 * Q * Math.abs(1 - 2 * p) - 0.15 * Q;
    const lift = Math.min(1, (t - a) / 50);
    return { y: -H * 4 * p * (1 - p), sy: (1 - Q) * (1 - lift) + st * lift, sx: (1 + 0.6 * Q) * (1 - lift) + (2 - st) * lift };
  }
  const r = ring(t - a - air, 0.32, 34);
  return { y: 0, sy: 1 - Q * r, sx: 1 + 0.6 * Q * r };
}
const ID: Pose = { x: 0, y: 0, r: 0, sx: 1, sy: 1, k: 0, o: 1 };
const KEYS = Object.keys(ID) as (keyof Pose)[];
const full = (p: PoseIn): Pose => ({ ...ID, ...p });
const mix = (a: Pose, b: Pose, w: number): Pose => {
  const o = { ...ID };
  for (const key of KEYS) o[key] = a[key] + (b[key] - a[key]) * w;
  return o;
};
const f3 = (v: number) => +v.toFixed(3);
function tf(p: Pose, a: number, k = 1): string {
  const t = `translate(${f3(p.x * k)}px,${f3(p.y * k)}px) rotate(${f3(p.r)}deg)`;
  const s = `scale(${f3(Math.max(p.sx, 0.01))},${f3(Math.max(p.sy, 0.01))})`;
  return `${t} rotate(${a}deg) ${s} rotate(${-a}deg) skewX(${f3(p.k)}deg)`;
}
const frame = (p: Pose, a: number, k: number): Frame => ({ transform: tf(p, a, k), opacity: f3(clamp(p.o, 0, 1)) });
const loop = (D: number, f: (t: number) => PoseIn): Clip => ({ D, loop: true, f });
const once = (D: number, f: (t: number) => PoseIn): Clip => ({ D, loop: false, f });
const same = (a: PoseIn, b: PoseIn) => KEYS.every((key) => full(a)[key] === full(b)[key]);

const reduceQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
/** Reduced motion, or a page that cannot animate (no Web Animations): every icon holds still poses. */
export function agentMotionStill(): boolean {
  return (reduceQuery?.matches ?? false) || typeof Element === 'undefined' || typeof Element.prototype.animate !== 'function';
}

/* ---------- one icon: every animation it runs, so off screen pauses them all and unmount cancels them all ---------- */
interface Icon {
  el: HTMLElement;
  rig: AgentRigKind | null;
  size: number;
  state: AgentMood;
  face: AgentFace;
  off: boolean;
  card: HTMLElement;
  faces: Map<AgentFace, HTMLElement>;
  inst: Map<AgentFace, Instance>;
  swap: Animation[];
  anims: Set<Animation>;
  /** Animations kept paused whatever the screen says (a spin at speed 0). */
  held: WeakSet<Animation>;
}

function animate(icon: Icon, node: Element, frames: Keyframe[], options: KeyframeAnimationOptions): Animation {
  const an = node.animate(frames, options);
  icon.anims.add(an);
  const drop = () => icon.anims.delete(an);
  an.finished?.then(drop, drop);
  if (icon.off) an.pause();
  return an;
}

/* ---------- a track: one node (or a few) playing a clip, blending in from wherever it is ---------- */
class Track {
  clip: Clip | null = null;
  anims: Animation[] = [];
  ref: Animation | null = null;
  t0 = 0;
  B = 0;
  from: Pose | null = null;
  still = false;
  held = false;
  w: (u: number) => number = (u) => u;
  constructor(
    readonly icon: Icon,
    readonly nodes: HTMLElement[],
    readonly a = 0,
    readonly k = 1,
  ) {}

  pose(): Pose {
    const c = this.clip;
    if (!c || !this.anims.length) return full({});
    const ct = Number(this.ref?.currentTime ?? 0) || 0;
    const blendIn = (p: Pose) => (this.from && ct < this.B ? mix(this.from, p, this.w(ct / this.B)) : p);
    if (c.loop && this.still) return blendIn(full(c.f(0)));
    if (c.loop) return blendIn(full(c.f((((this.t0 + ct) % c.D) + c.D) % c.D)));
    if (ct >= c.D) return full({});
    return blendIn(full(c.f(ct)));
  }

  /** Play a clip. blend: ms to blend in from the current pose; zeta and omega shape the blend (a spring). */
  play(clip: Clip, { phase = 0, blend = 0, zeta = 0.72, omega = 11 } = {}): void {
    const from = blend ? this.pose() : null;
    this.stop();
    this.clip = clip;
    this.t0 = phase;
    this.B = blend;
    this.from = from;
    const Bs = Math.max(blend, 1);
    const sB = rise(Bs, zeta, omega) || 1;
    this.w = (u) => rise(u * Bs, zeta, omega) / sB;
    const N = (D: number) => clamp(Math.round(D / 30), 16, 140);
    const at = (t: number) => full(clip.f(clip.loop ? ((t % clip.D) + clip.D) % clip.D : Math.min(t, clip.D)));
    const sample = (t0: number, D: number, n: number, wfn?: (u: number) => number) => {
      const out: Frame[] = [];
      for (let i = 0; i <= n; i++) {
        const p = at(t0 + (D * i) / n);
        out.push(frame(wfn && from ? mix(from, p, wfn(i / n)) : p, this.a, this.k));
      }
      return out;
    };
    // A loop that never changes (a held pose) blends in once and then holds, with nothing left ticking.
    this.still = clip.loop && same(clip.f(0), clip.f(clip.D / 3)) && same(clip.f(0), clip.f((2 * clip.D) / 3));
    for (const node of this.nodes) {
      if (this.still) {
        const p = full(clip.f(0));
        const fr = from && blend ? Array.from({ length: N(blend) + 1 }, (_, i) => frame(mix(from, p, this.w(i / N(blend))), this.a, this.k)) : [frame(p, this.a, this.k), frame(p, this.a, this.k)];
        const an = animate(this.icon, node, fr, { duration: from && blend ? blend : 1, fill: 'forwards' });
        this.anims.push(an);
        this.ref ??= an;
      } else if (clip.loop) {
        if (from && blend) {
          const br = animate(this.icon, node, sample(phase, blend, N(blend), this.w), { duration: blend });
          const lp = animate(this.icon, node, sample(phase + blend, clip.D, N(clip.D)), { duration: clip.D, delay: blend, iterations: Infinity });
          this.anims.push(br, lp);
          this.ref ??= lp;
        } else {
          const lp = animate(this.icon, node, sample(phase, clip.D, N(clip.D)), { duration: clip.D, iterations: Infinity });
          this.anims.push(lp);
          this.ref ??= lp;
        }
      } else {
        const n = N(clip.D);
        const fr: Frame[] = [];
        for (let i = 0; i <= n; i++) {
          const t = (clip.D * i) / n;
          const p = full(clip.f(t));
          fr.push(frame(from && blend && t < blend ? mix(from, p, this.w(t / blend)) : p, this.a, this.k));
        }
        const an = animate(this.icon, node, fr, { duration: clip.D });
        this.anims.push(an);
        this.ref ??= an;
      }
    }
    if (!clip.loop) {
      const mine = this.anims[0];
      mine?.finished?.then(
        () => {
          if (this.anims[0] === mine) {
            this.anims = [];
            this.clip = null;
          }
        },
        () => {},
      );
    }
  }

  /** Reduced motion: the pose set as a style, nothing running. */
  hold(params: PoseIn): void {
    this.stop();
    this.held = true;
    const p = full(params);
    for (const n of this.nodes) {
      n.style.transform = tf(p, this.a, this.k);
      n.style.opacity = String(clamp(p.o, 0, 1));
    }
  }

  stop(): void {
    for (const an of this.anims) an.cancel();
    this.anims = [];
    this.clip = null;
    this.from = null;
    this.ref = null;
    if (this.held) {
      this.held = false;
      for (const n of this.nodes) {
        n.style.transform = '';
        n.style.opacity = '';
      }
    }
  }

  get busy(): boolean {
    return !!(this.clip && !this.clip.loop && this.anims.length);
  }
}

/* ---------- the rigs: what each part does in each mood ---------- */
interface Gestures {
  x: (part: string, clip: Clip) => void;
  spinKick: (peak: number, up: number, down: number) => void;
}
interface Rig {
  parts: Record<string, { sel: string; a?: number; vb?: number; all?: boolean }>;
  moods: Record<AgentMood, (part: string, index: number) => Clip | undefined>;
  blend: (state: AgentMood, part: string) => number;
  spin?: Record<AgentMood, number>;
  cue?: (state: AgentMood, I: Gestures) => void;
  fidget: (state: AgentMood, I: Gestures) => void;
  gap: Record<AgentMood, [number, number]>;
}

/* Claude (round 4): a star that spins. The rays only breathe and twinkle a little. Speeds in degrees per second. */
const claudeRig = (): Rig => {
  const n = CLAUDE_RAY_ANGLES.length;
  const parts: Rig['parts'] = { body: { sel: '[data-p="body"]' } };
  CLAUDE_RAY_ANGLES.forEach((a, i) => (parts[`r${i}`] = { sel: `[data-p="r${i}"]`, a }));
  const STEP = 30;
  const WORK = 150; // working: 150°/s with a slight ratchet at every ray (30°)
  const ratchetT = (STEP / WORK) * 1000;
  const easeIO = (f: number) => (f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2);
  const twinkle = (I: Gestures, k = 0.16) => {
    for (let i = 0; i < n; i++) I.x(`r${i}`, once(900, (t) => ({ sx: 1 + k * pull(t - i * 22, 100, 0.35, 26) })));
  };
  const jump = (I: Gestures, H = 3.2) =>
    I.x(
      'body',
      once(760, (t) => {
        const h = t < 90 ? -0.3 * smooth(t / 90) : Math.max(0, Math.sin(Math.PI * clamp((t - 90) / 300, 0, 1))) * H;
        const q = t < 90 ? -0.05 * smooth(t / 90) : 0.06 * ring(t - 90, 0.4, 20);
        return { y: -h, sx: 1 + q, sy: 1 + q };
      }),
    );
  return {
    parts,
    moods: {
      idle: (p, i) =>
        p === 'body' ? loop(5200, (t) => ({ sx: 1 + 0.015 * S(t / 5200), sy: 1 + 0.015 * S(t / 5200) })) : loop(5200, (t) => ({ sx: 1 + 0.04 * S(t / 5200 + i / n) })),
      working: (p, i) =>
        p === 'body'
          ? loop(ratchetT, (t) => {
              const f = t / ratchetT;
              return { r: 0.45 * STEP * (easeIO(f) - f) };
            })
          : loop(1200, (t) => ({ sx: 1 + 0.07 * sq(t / 1200 + (i % 2) * 0.5, 2), sy: 1 - 0.03 * sq(t / 1200 + (i % 2) * 0.5, 2) })),
      waiting: (p, i) => (p === 'body' ? loop(2200, (t) => ({ y: -1.1 + 0.35 * S(t / 2200), sx: 1.05, sy: 1.05 })) : loop(2200, (t) => ({ sx: 1.05 + 0.03 * S(t / 2200 + i / n) }))),
      ended: (p) =>
        p === 'body' ? loop(6000, (t) => ({ sx: 0.88 + 0.012 * S(t / 6000), sy: 0.88 + 0.012 * S(t / 6000), o: 0.55 })) : loop(6000, () => ({ sx: 0.86 })),
    },
    blend: (st, p) => (st === 'ended' ? (p === 'body' ? 1300 : 1500) : p === 'body' ? 360 : 460),
    spin: { idle: 24, working: WORK, waiting: 60, ended: 0 },
    cue: (st, I) => {
      if (st === 'waiting') {
        I.spinKick(720, 120, 900);
        jump(I);
      }
    },
    fidget: (st, I) => {
      if (st === 'idle') {
        if (Math.random() < 0.5) twinkle(I);
        else I.spinKick(150, 250, 900);
      }
      if (st === 'working') twinkle(I, 0.1);
      if (st === 'waiting') {
        I.spinKick(400, 100, 700);
        jump(I, 2.2);
      }
    },
    gap: { idle: [3200, 6500], working: [2600, 4600], waiting: [3400, 5000], ended: [1e9, 1e9] },
  };
};

/* Codex (round 4: snappier): the cloud bobs crisply with a little squash; the prompt is its face (> an eye, _ the cursor). */
const codexRig = (): Rig => {
  const table: Record<AgentMood, Record<string, Clip>> = {
    idle: {
      body: loop(3000, (t) => ({ sy: 1 + 0.018 * S(t / 3000), sx: 1 - 0.012 * S(t / 3000) })),
      face: loop(3000, (t) => ({ y: -1.5 * S(t / 3000 - 0.06) })),
      chev: loop(3000, () => ({})),
      und: loop(3000, () => ({})),
    },
    working: {
      body: loop(600, (t) => hop(t, 600, 7, 0.05, 0.8)),
      face: loop(600, (t) => ({ y: 2 * S(t / 600 - 0.12) })),
      chev: loop(1000, (t) => {
        const e = Math.max(0, S(t / 1000));
        return { x: 6 * e * e };
      }),
      und: loop(800, (t) => ({ o: t / 800 < 0.5 ? 1 : 0.15, sx: 1 + 0.15 * S((t / 800) * 2) })),
    },
    waiting: {
      body: loop(1800, (t) => ({ sy: 1.05 + 0.012 * S(t / 1800), sx: 0.97, r: 2 * S(t / 1800) })),
      face: loop(1800, (t) => ({ y: -10 + 1 * S(t / 1800), x: 2 * S(t / 1800) })),
      chev: loop(1800, () => ({ r: -8, sy: 1.08 })),
      und: loop(1800, () => ({ sx: 0.85 })),
    },
    ended: {
      body: loop(5000, (t) => ({ sy: 0.94 + 0.012 * S(t / 5000), sx: 1.03 - 0.008 * S(t / 5000), o: 0.55 })),
      face: loop(5000, (t) => ({ y: 6 + 1 * S(t / 5000 - 0.1) })),
      chev: loop(5000, () => ({ sy: 0.22, r: 8 })),
      und: loop(5000, () => ({ o: 0.45, sx: 0.85 })),
    },
  };
  const blink = (I: Gestures, d = 0) =>
    I.x(
      'chev',
      once(140 + d, (t) => ({ sy: 1 - 0.9 * Math.sin(Math.PI * clamp((t - d) / 130, 0, 1)) })),
    );
  const glance = (I: Gestures) => {
    const s = Math.random() < 0.5 ? -1 : 1;
    I.x('face', once(950, (t) => ({ x: 8 * s * (t < 650 ? rise(t, 0.75, 30) : ring(t - 650, 0.75, 30)) })));
  };
  const bob = (I: Gestures, H = 12) => I.x('body', once(650, (t) => hop(t, 650, H, 0.07, 0.85)));
  const pick = (st: AgentMood) => (p: string) => table[st][p];
  return {
    parts: { body: { sel: '[data-p="body"]' }, face: { sel: '[data-p="face"]' }, chev: { sel: '[data-p="chev"]' }, und: { sel: '[data-p="und"]' } },
    moods: { idle: pick('idle'), working: pick('working'), waiting: pick('waiting'), ended: pick('ended') },
    blend: (st, p) => (st === 'ended' ? { body: 800, face: 1000, chev: 1200, und: 900 } : { body: 240, face: 300, chev: 320, und: 280 })[p] ?? 300,
    cue: (st, I) => {
      if (st === 'waiting') {
        bob(I, 18);
        blink(I, 340);
        blink(I, 510);
      }
    },
    fidget: (st, I) => {
      const r = Math.random();
      if (st === 'idle') {
        if (r < 0.4) blink(I);
        else if (r < 0.55) {
          blink(I);
          blink(I, 170);
        } else if (r < 0.8) glance(I);
        else bob(I);
      }
      if (st === 'working') blink(I);
      if (st === 'waiting') {
        if (r < 0.5) {
          blink(I);
          blink(I, 170);
        } else bob(I, 12);
      }
      if (st === 'ended') I.x('body', once(1600, (t) => ({ sy: 1 + 0.03 * Math.sin(Math.PI * clamp(t / 1600, 0, 1)), sx: 1 - 0.015 * Math.sin(Math.PI * clamp(t / 1600, 0, 1)) })));
    },
    gap: { idle: [2200, 4800], working: [2200, 3800], waiting: [2600, 4000], ended: [9000, 15000] },
  };
};

/* Pi: three blocks that hop and settle, each standing on its own base. */
const piRig = (): Rig => {
  const B = ['blue', 'coral', 'yellow'];
  const idx = (p: string) => B.indexOf(p);
  const jump = (I: Gestures, b: string, H = 80) => {
    I.x(b, once(1100, (t) => hop(t, 1100, H, 0.2, 0.6)));
    for (const o of B) {
      if (o === b) continue;
      I.x(
        o,
        once(1100, (t) => {
          const land = 1100 * 0.6 * 0.65;
          const r = t > land ? ring(t - land, 0.35, 30) * smooth((t - land) / 30) : 0;
          return { sy: 1 - 0.06 * r, sx: 1 + 0.03 * r };
        }),
      );
    }
  };
  return {
    parts: { body: { sel: '[data-p="body"]' }, blue: { sel: '[data-p="blue"]' }, coral: { sel: '[data-p="coral"]' }, yellow: { sel: '[data-p="yellow"]' } },
    moods: {
      idle: (p) => (p === 'body' ? loop(4800, () => ({})) : loop(4800, (t) => ({ y: -7 * S(t / 4800 + idx(p) / 3), sy: 1 + 0.012 * S(t / 4800 + idx(p) / 3 + 0.25) }))),
      // busy: the blocks hop in turn, a third of a beat apart
      working: (p) => (p === 'body' ? loop(1350, (t) => ({ r: 2 * S(t / 1350) })) : loop(1350, (t) => hop((((t - (idx(p) * 1350) / 3) % 1350) + 1350) % 1350, 1350, 95, 0.2, 0.62))),
      // perks up: stands tall, the top block lifts and looks from side to side
      waiting: (p) =>
        p === 'body'
          ? loop(2600, () => ({}))
          : p === 'coral'
            ? loop(2600, (t) => ({ y: -26, r: 7 * sq(t / 2600, 2), sy: 1.06 }))
            : loop(2600, (t) => ({ sy: 1.1 + 0.02 * S(t / 2600 + idx(p) / 3), sx: 0.96 })),
      // asleep: flattened, the top block drooping, the yellow one leaning in
      ended: (p) =>
        p === 'body'
          ? loop(6400, () => ({ o: 0.55 }))
          : loop(6400, (t) => {
              const u = t / 6400 + idx(p) / 5;
              if (p === 'blue') return { sy: 0.88 + 0.02 * S(u), sx: 1.03 };
              if (p === 'coral') return { y: 16, r: -4, sy: 0.86 + 0.02 * S(u), sx: 1.03 };
              return { r: -10, sy: 0.9 + 0.02 * S(u) };
            }),
    },
    blend: (st, p) => (st === 'ended' ? 1100 : 420) + Math.max(0, idx(p)) * 90,
    cue: (st, I) => {
      if (st === 'waiting') I.x('body', once(1100, (t) => hop(t, 1100, 70, 0.16, 0.8)));
    },
    fidget: (st, I) => {
      if (st === 'idle') jump(I, B[Math.floor(Math.random() * 3)]!, 70 + Math.random() * 30);
      if (st === 'waiting') I.x('body', once(1000, (t) => hop(t, 1000, 50, 0.14, 0.8)));
      if (st === 'ended') I.x('yellow', once(1600, (t) => ({ r: -5 * Math.sin(Math.PI * clamp(t / 1600, 0, 1)) })));
    },
    gap: { idle: [2400, 5200], working: [99999, 99999], waiting: [3000, 4600], ended: [10000, 16000] },
  };
};

/* OpenCode: the frame breathes and leans; the square inside rides along a beat late. */
const opencodeRig = (): Rig => {
  const lean = (I: Gestures) => {
    const s = Math.random() < 0.5 ? -1 : 1;
    I.x('body', once(1300, (t) => ({ k: 14 * s * pull(t, 160, 0.33, 14) })));
    I.x('inner', once(1400, (t) => ({ x: -2.2 * s * pull(t - 90, 160, 0.33, 14) })));
  };
  const peek = (I: Gestures) => I.x('inner', once(1300, (t) => ({ y: -5.6 * (t < 900 ? rise(t, 0.5, 16) : ring(t - 900, 0.4, 18)) })));
  return {
    parts: { body: { sel: '[data-p="body"]' }, inner: { sel: '[data-p="inner"]' } },
    moods: {
      idle: (p) =>
        p === 'body' ? loop(5000, (t) => ({ sy: 1 + 0.035 * S(t / 5000), sx: 1 - 0.025 * S(t / 5000), k: 3 * S(t / 5000 + 0.25) })) : loop(5000, (t) => ({ y: -1.4 * S(t / 5000 - 0.12) })),
      working: (p) =>
        p === 'body'
          ? loop(1000, (t) => ({ sy: 1 + 0.07 * S((2 * t) / 1000), sx: 1 - 0.05 * S((2 * t) / 1000), k: 10 * S(t / 1000) }))
          : loop(1000, (t) => {
              const h = hop(t % 500, 500, 5.5, 0.16, 0.95);
              return { y: h.y, sx: h.sx, sy: h.sy, x: -1.5 * S(t / 1000 - 0.15) };
            }),
      waiting: (p) => (p === 'body' ? loop(2400, (t) => ({ sy: 1.1 + 0.02 * S(t / 2400), sx: 0.95, k: -5 + 1.5 * S(t / 2400) })) : loop(2400, (t) => ({ y: -5.6 + 0.6 * S(t / 2400) }))),
      ended: (p) => (p === 'body' ? loop(6000, (t) => ({ sy: 0.9 + 0.02 * S(t / 6000), sx: 1.05, k: 7, o: 0.55 })) : loop(6000, () => ({ y: 0.6, o: 0.4 }))),
    },
    blend: (st, p) => (st === 'ended' ? 1100 : 420) + (p === 'inner' ? 180 : 0),
    cue: (st, I) => {
      if (st === 'waiting') I.x('body', once(1000, (t) => hop(t, 1000, 5, 0.16, 0.8)));
    },
    fidget: (st, I) => {
      if (st === 'idle') (Math.random() < 0.55 ? lean : peek)(I);
      if (st === 'working') lean(I);
      if (st === 'waiting') I.x('body', once(900, (t) => hop(t, 900, 3.5, 0.12, 0.8)));
      if (st === 'ended') I.x('body', once(1800, (t) => ({ sy: 1 + 0.05 * Math.sin(Math.PI * clamp(t / 1800, 0, 1)) })));
    },
    gap: { idle: [2800, 5800], working: [2800, 4600], waiting: [3200, 4800], ended: [10000, 16000] },
  };
};

/* Our faces (the favicon art): the whole face bounces and tilts, in a 64-unit grid. */
const faceRig = (): Rig => {
  const tilt = (I: Gestures) => {
    const s = Math.random() < 0.5 ? -1 : 1;
    I.x('body', once(1600, (t) => ({ r: 10 * s * (t < 900 ? rise(t, 0.45, 13) : ring(t - 900, 0.45, 13)) })));
  };
  const bounce = (I: Gestures, H = 6) => I.x('body', once(1000, (t) => hop(t, 1000, H, 0.14, 0.85)));
  return {
    parts: { body: { sel: '[data-p="body"]', vb: 64 } },
    moods: {
      idle: () => loop(4000, (t) => ({ y: -0.6 * S(t / 4000), sy: 1 + 0.012 * S(t / 4000), sx: 1 - 0.008 * S(t / 4000) })),
      working: () =>
        loop(760, (t) => {
          const h = hop(t, 760, 3, 0.07, 0.92);
          return { y: h.y, sx: h.sx, sy: h.sy, r: 3 * S(t / 1520) };
        }),
      waiting: () => loop(2400, (t) => ({ y: -1.2 + 0.3 * S(t / 2400), sy: 1.04, sx: 0.98, r: -3 + 2 * S(t / 2400) })),
      ended: () => loop(6000, (t) => ({ y: 1.4, sy: 0.95 + 0.015 * S(t / 6000), sx: 1.02, r: 7, o: 0.6 })),
    },
    blend: (st) => (st === 'ended' ? 1000 : 380),
    cue: (st, I) => {
      if (st === 'waiting') bounce(I, 7);
    },
    fidget: (st, I) => {
      if (st === 'idle') (Math.random() < 0.5 ? tilt : bounce)(I);
      if (st === 'waiting') bounce(I, 4);
      if (st === 'ended') I.x('body', once(2000, (t) => ({ sy: 1 + 0.04 * Math.sin(Math.PI * clamp(t / 2000, 0, 1)) })));
    },
    gap: { idle: [2200, 5000], working: [99999, 99999], waiting: [2600, 4200], ended: [10000, 16000] },
  };
};

const RIGS: Record<AgentRigKind | 'face', Rig> = { claude: claudeRig(), codex: codexRig(), pi: piRig(), opencode: opencodeRig(), face: faceRig() };

/** One fidget at a time across the page: when the last one started. */
let lastFidget = -1e9;

/* ---------- an instance: one rig mounted in one face element ---------- */
interface Instance {
  setMood: (state: AgentMood, options?: { blend?: boolean }) => void;
  /** Off screen: no fidget is scheduled; back on screen the schedule starts again. */
  resume: () => void;
  stop: () => void;
}

function instance(icon: Icon, kind: AgentRigKind | 'face', root: HTMLElement): Instance {
  const rig = RIGS[kind];
  const T: Record<string, Track> = {};
  const X: Record<string, Track> = {};
  const glyph = root.querySelector<HTMLElement>('.am-rig');
  const vb = Number(glyph?.dataset.vb) || icon.size;
  for (const [name, def] of Object.entries(rig.parts)) {
    const nodes = def.all ? [...root.querySelectorAll<HTMLElement>(def.sel)] : [root.querySelector<HTMLElement>(def.sel)].filter((n): n is HTMLElement => n !== null);
    if (!nodes.length) continue;
    // An HTML part moves in px; the rig speaks in its svg's units.
    const k = def.vb ? icon.size / def.vb : icon.size / vb;
    T[name] = new Track(icon, nodes, def.a ?? 0, k);
    X[name] = new Track(icon, nodes.map((n) => n.firstElementChild as HTMLElement).filter(Boolean), def.a ?? 0, k);
  }
  // One fidget's gestures are padded to one length, so they all end on the same frame (one style pass, not ten).
  let batch: [string, Clip][] | null = null;
  const go1 = (name: string, clip: Clip) => {
    const tr = X[name] ?? T[name];
    tr?.play(clip, { blend: tr.busy ? 160 : 0, zeta: 0.9, omega: 24 });
  };
  const run = (fn: () => void) => {
    batch = [];
    try {
      fn();
    } finally {
      const b = batch;
      batch = null;
      const D = Math.max(0, ...b.map(([, c]) => c.D));
      for (const [n, c] of b) go1(n, c.D === D ? c : once(D, (t) => c.f(Math.min(t, c.D))));
    }
  };
  let mood: AgentMood | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rampT: ReturnType<typeof setTimeout> | undefined;
  const phase = Math.random();
  // A spinning rig (Claude): one endless turn on its own layer. A state changes only its speed, in small steps, so the
  // angle never jumps; at speed 0 it is paused. Made on the first mood and cancelled on stop.
  const spinEl = rig.spin ? root.querySelector<HTMLElement>('.am-spin') : null;
  let spin: Animation | null = null;
  const holdSpin = (on: boolean) => {
    if (!spin) return;
    if (on) {
      spin.pause();
      icon.held.add(spin);
    } else icon.held.delete(spin);
  };
  const mkSpin = () => {
    if (!spinEl) return;
    spin = animate(icon, spinEl, [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 1000, iterations: Infinity });
    spin.currentTime = phase * 1000;
    holdSpin(true);
  };
  const playSpin = (rate: number) => {
    if (!spin) return;
    holdSpin(false);
    spin.playbackRate = rate;
    if (!icon.off) spin.play();
  };
  const rampTo = (dps: number, ms: number, shape: (k: number) => number = smooth, then?: () => void) => {
    if (!spin) return;
    clearTimeout(rampT);
    const from = icon.held.has(spin) ? 0 : spin.playbackRate;
    const to = dps / 360;
    if (to > 0 && icon.held.has(spin)) playSpin(Math.max(from, 1e-4));
    const t0 = performance.now();
    const tick = () => {
      if (!spin) return;
      const k = Math.min(1, ((performance.now() - t0) * agentMotionOptions.clock) / Math.max(ms, 1));
      spin.playbackRate = from + (to - from) * shape(k);
      if (k < 1) rampT = setTimeout(tick, 40 / agentMotionOptions.clock);
      else {
        if (to === 0) holdSpin(true);
        then?.();
      }
    };
    tick();
  };
  const I: Gestures = {
    x: (name, clip) => (batch ? batch.push([name, clip]) : go1(name, clip)),
    spinKick: (peak, up, down) => {
      if (!spin || agentMotionStill() || !rig.spin || !mood) return;
      const back = rig.spin[mood];
      rampTo(peak, up, (k) => 1 - (1 - k) * (1 - k), () => rampTo(back, down, smooth));
    },
  };
  function schedule() {
    clearTimeout(timer);
    timer = undefined;
    if (agentMotionStill() || !mood || icon.off) return;
    const [lo, hi] = rig.gap[mood];
    if (lo > 60000) return;
    timer = setTimeout(
      () => {
        const live = !icon.off && !(typeof document !== 'undefined' && document.hidden);
        if (live && agentMotionOptions.fidgets && mood) {
          const now = performance.now();
          if (now - lastFidget < 380 / agentMotionOptions.clock) {
            timer = setTimeout(schedule, (300 + Math.random() * 900) / agentMotionOptions.clock);
            return;
          }
          lastFidget = now;
          const m = mood;
          run(() => rig.fidget(m, I));
        }
        schedule();
      },
      (lo + Math.random() * (hi - lo)) / agentMotionOptions.clock,
    );
  }
  return {
    setMood(state, { blend = true } = {}) {
      const first = mood === null;
      mood = state;
      clearTimeout(timer);
      const still = agentMotionStill();
      if (still) {
        clearTimeout(rampT);
        spin?.cancel();
        spin = null;
        for (const [name, tr] of Object.entries(T)) {
          const c = rig.moods[state](name, name[0] === 'r' ? Number(name.slice(1)) : 0);
          tr.hold(c ? c.f(0) : {});
        }
        return;
      }
      if (spinEl && !spin) mkSpin();
      if (spin && rig.spin) {
        const v = rig.spin[state];
        if (first || !blend) {
          clearTimeout(rampT);
          if (v > 0) playSpin(v / 360);
          else holdSpin(true);
        } else rampTo(v, state === 'ended' ? 2200 : 520, state === 'ended' ? (k) => k : smooth);
      }
      for (const [name, tr] of Object.entries(T)) {
        const c = rig.moods[state](name, kind === 'claude' && name[0] === 'r' ? Number(name.slice(1)) : 0);
        if (!c) {
          tr.stop();
          continue;
        }
        const ph = (phase * c.D) % c.D;
        tr.play(c, first || !blend ? { phase: ph } : { phase: ph, blend: rig.blend(state, name), zeta: state === 'ended' ? 0.95 : 0.62, omega: state === 'ended' ? 7 : 12 });
      }
      if (!first && blend && rig.cue) {
        const cue = rig.cue;
        run(() => cue(state, I));
      }
      schedule();
    },
    resume: schedule,
    stop() {
      clearTimeout(timer);
      clearTimeout(rampT);
      timer = undefined;
      if (spin) {
        icon.held.delete(spin);
        spin.cancel();
        spin = null;
      }
      for (const t of Object.values(T)) t.stop();
      for (const t of Object.values(X)) t.stop();
    },
  };
}

/* ---------- the icon element ---------- */
const icons = new Map<HTMLElement, Icon>();

function setOff(icon: Icon, off: boolean): void {
  if (icon.off === off) return;
  icon.off = off;
  icon.el.toggleAttribute('data-off', off);
  for (const an of icon.anims) {
    if (off) an.pause();
    else if (!icon.held.has(an)) an.play();
  }
  if (!off) for (const inst of icon.inst.values()) inst.resume();
}

let observer: IntersectionObserver | null | undefined;
function screenWatch(): IntersectionObserver | null {
  if (observer !== undefined) return observer;
  observer =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const icon = icons.get(entry.target as HTMLElement);
            if (icon) setOff(icon, !entry.isIntersecting);
          }
        })
      : null;
  return observer;
}

// Reduced motion turned on or off while icons show: each takes its new kind of pose.
reduceQuery?.addEventListener?.('change', () => {
  for (const icon of icons.values()) icon.inst.get(icon.face)?.setMood(icon.state, { blend: false });
});

/** Our faces' art (faceArt.ts), set once it is loaded. Until then a swap waits for it. */
let faceArt: Readonly<Record<Exclude<AgentFace, 'agent'>, string>> | null = null;
export function setAgentFaceArt(art: Readonly<Record<Exclude<AgentFace, 'agent'>, string>>): void {
  faceArt = art;
}
export function agentFaceArtReady(): boolean {
  return faceArt !== null;
}

function faceEl(icon: Icon, face: AgentFace): HTMLElement {
  const known = icon.faces.get(face);
  if (known) return known;
  const f = document.createElement('span');
  f.className = `am-face am-f-${face}`;
  // Our art is a picture moved as a whole; `faceArt` holds markup from our own assets only.
  if (face !== 'agent') f.innerHTML = `<span class="am-p am-fb" data-p="body"><span class="am-x am-fb">${faceArt?.[face] ?? ''}</span></span>`;
  f.hidden = true;
  icon.card.append(f);
  icon.faces.set(face, f);
  return f;
}

function startFace(icon: Icon, face: AgentFace): void {
  if (icon.inst.has(face)) return;
  const kind = face === 'agent' ? icon.rig : 'face';
  if (!kind) return;
  const inst = instance(icon, kind, faceEl(icon, face));
  icon.inst.set(face, inst);
  inst.setMood(icon.state, { blend: false });
}

function stopFace(icon: Icon, face: AgentFace): void {
  icon.inst.get(face)?.stop();
  icon.inst.delete(face);
}

/**
 * Draws a mark in `el` (an empty `.am` box React owns no children of): the agent's rig when its host has one, then
 * `face` when it is one of ours. Returns the agent face's tile: empty for a host with no rig, where the caller draws
 * its plain mark (a portal), which never moves.
 */
export function mountAgentMark(el: HTMLElement, options: { rig: AgentRigKind | null; state: AgentMood; face: AgentFace; size: number }): HTMLElement {
  const known = icons.get(el);
  if (known) return known.faces.get('agent')!.firstElementChild as HTMLElement;
  el.innerHTML = `<span class="am-card"><span class="am-face am-f-agent"><span class="am-tile">${options.rig ? AGENT_RIGS[options.rig] : ''}</span></span></span>`;
  const card = el.firstElementChild as HTMLElement;
  const icon: Icon = {
    el,
    rig: options.rig,
    size: options.size,
    state: options.state,
    face: 'agent',
    off: false,
    card,
    faces: new Map([['agent', card.firstElementChild as HTMLElement]]),
    inst: new Map(),
    swap: [],
    anims: new Set(),
    held: new WeakSet(),
  };
  icons.set(el, icon);
  el.dataset.state = options.state;
  el.dataset.face = 'agent';
  startFace(icon, 'agent');
  screenWatch()?.observe(el);
  if (options.face !== 'agent' && faceArt) showFace(icon, options.face, false);
  return icon.faces.get('agent')!.firstElementChild as HTMLElement;
}

/** The agent's state changed: each part blends into the new mood, and a waiting agent gets its cue. */
export function setAgentMarkState(el: HTMLElement, state: AgentMood): void {
  const icon = icons.get(el);
  if (!icon || icon.state === state) return;
  icon.state = state;
  el.dataset.state = state;
  icon.inst.get(icon.face)?.setMood(state);
}

/** Show a face (the click cycle, or the face kept for this agent). `animate`: the swap's little show. */
export function showAgentFace(el: HTMLElement, face: AgentFace, withMotion = true): void {
  const icon = icons.get(el);
  if (!icon || icon.face === face) return;
  if (face !== 'agent' && !faceArt) return;
  showFace(icon, face, withMotion);
}

const OUT = 'cubic-bezier(0.4, 0, 1, 1)';
function spring(zeta: number, omega: number): { easing: string; duration: number; at: (u: number) => number } {
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const settle = Math.min(4 / (zeta * omega), 1.6);
  const pts: number[] = [];
  for (let i = 0; i <= 48; i++) {
    const t = (settle * i) / 48;
    pts.push(+(1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t))).toFixed(4));
  }
  pts[pts.length - 1] = 1;
  const at = (u: number) => {
    const k = u * (pts.length - 1);
    const i = Math.floor(k);
    return i >= pts.length - 1 ? 1 : pts[i]! + (pts[i + 1]! - pts[i]!) * (k - i);
  };
  return { easing: `linear(${pts.join(',')})`, duration: Math.round(settle * 1000), at };
}

function showFace(icon: Icon, to: AgentFace, withMotion: boolean): void {
  const from = icon.face;
  for (const an of icon.swap) an.cancel();
  icon.swap = [];
  const a = faceEl(icon, from);
  const b = faceEl(icon, to);
  icon.face = to;
  icon.el.dataset.face = to;
  b.hidden = false;
  startFace(icon, to);
  const done = () => {
    a.hidden = true;
    a.style.cssText = '';
    b.style.cssText = '';
    icon.card.style.transform = '';
    for (const an of icon.swap) an.cancel();
    icon.swap = [];
    // A hidden face stops: nothing it ran keeps costing a frame.
    stopFace(icon, from);
  };
  const play = (node: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) => {
    const an = animate(icon, node, frames, options);
    icon.swap.push(an);
    return an;
  };
  if (!withMotion || typeof Element.prototype.animate !== 'function') {
    done();
    return;
  }
  if (agentMotionStill()) {
    play(a, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    play(b, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 }).finished.then(done, () => {});
  } else if (from === 'agent' || to === 'agent') {
    // The agent shrinks away and ours lands with a squash (or the agent comes back with a soft pop).
    const ours = to !== 'agent';
    play(a, [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.62)', opacity: 0 }], { duration: 170, easing: OUT, fill: 'forwards' });
    play(b, [{ opacity: 0 }, { opacity: 1 }], { duration: 140, delay: 40, easing: 'linear', fill: 'backwards' });
    let land: Animation;
    if (ours) {
      const SX = spring(0.62, 24);
      const SY = spring(0.7, 30);
      const D = Math.max(SX.duration, SY.duration);
      const frames: Keyframe[] = [];
      for (let i = 0; i <= 40; i++) {
        const t = (D * i) / 40;
        const x = 0.62 + 0.38 * SX.at(Math.min(t / SX.duration, 1));
        const y = 0.62 + 0.38 * SY.at(Math.min(t / SY.duration, 1));
        frames.push({ transform: `scale(${x.toFixed(4)}, ${y.toFixed(4)})`, offset: i / 40 });
      }
      b.style.transformOrigin = '50% 90%';
      land = play(b, frames, { duration: D, delay: 40, fill: 'backwards' });
    } else {
      const SOFT = spring(0.9, 20);
      land = play(b, [{ transform: 'scale(0.7)' }, { transform: 'scale(1)' }], { duration: SOFT.duration, delay: 40, easing: SOFT.easing, fill: 'backwards' });
    }
    land.finished.then(done, () => {});
  } else {
    // One of ours to another: a card turning over.
    const FLIP = spring(0.78, 17);
    b.style.transform = 'rotateY(180deg)';
    play(icon.card, [{ transform: 'perspective(160px) rotateY(0deg)' }, { transform: 'perspective(160px) rotateY(180deg)' }], { duration: FLIP.duration, easing: FLIP.easing }).finished.then(done, () => {});
  }
}

/** Call before the icon leaves the page: every animation and timer it runs stops. */
export function unmountAgentMark(el: HTMLElement): void {
  const icon = icons.get(el);
  if (!icon) return;
  for (const an of icon.swap) an.cancel();
  for (const inst of icon.inst.values()) inst.stop();
  for (const an of icon.anims) an.cancel();
  icon.anims.clear();
  observer?.unobserve(el);
  icons.delete(el);
  el.innerHTML = '';
}

/** What an icon runs now (tests, the perf guards): live animations, and how many of them play. */
export function agentMarkActivity(el: HTMLElement): { animations: number; playing: number; off: boolean } | null {
  const icon = icons.get(el);
  if (!icon) return null;
  const all = [...icon.anims];
  return { animations: all.length, playing: all.filter((an) => an.playState === 'running').length, off: icon.off };
}
