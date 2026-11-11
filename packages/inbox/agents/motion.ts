/**
 * Animated agent marks (approval "inbox-agent-icon-motion"). Each mark is a little character: a rig of its own parts
 * (rigs.ts), every part moving on its own. They are always alive and never show the agent's state (the owner,
 * 2026-11-09: "I'd rather just be animated. They always move around. … they can follow my mouse … but only subtly.
 * Otherwise it should seem like they have their own autonomy").
 *
 * How it moves
 * - Every part has two layers: `.am-p` plays the part's life (a long calm loop), `.am-x` inside it plays one-off
 *   gestures. Both animate only transform and opacity, through the Web Animations API, so the compositor runs them.
 * - Its own life: each icon has a seed (the agent's id), and from it its own tempo, loop lengths (a different one for
 *   every part, so the whole never lines up again), phases and choice of gestures. A gesture comes after a gap that
 *   is never the same twice, now and then a longer rest or a quick second one, and never the same gesture twice
 *   running. Gestures start one at a time across the page, so a list never moves in chorus.
 * - Claude is mostly at rest (the owner, 2026-11-09: it "spins too much"; "a little bit more random and subtle"): it
 *   never turns on and on. Now and then, after a gap drawn from its own seeded chances, it makes one small gesture: a
 *   slow part turn that eases in and out and settles, a soft breath of a few percent, or a ray's shimmer. How small
 *   and how often: CLAUDE_CALM (the owner chose this level, 2026-11-09).
 * - Attention: while the pointer is in the sidebar the section is in, each icon leans a little toward it (the `.am-look`
 *   layer: at most AGENT_LOOK.shift px and AGENT_LOOK.turn degrees) and a rig's eyes (the `.am-e` layer: Codex's
 *   prompt, OpenCode's square, Pi's top block) look that way too. Each icon follows on its own critically damped
 *   spring, so they never snap together, and the lean is added to its own life, never in place of it. The pointer gone,
 *   or still for AGENT_LOOK.stillMs, they drift back. Touch never counts as a pointer.
 *
 * Its cost rules
 * - Off screen (an IntersectionObserver, one for the page): every animation of the icon pauses, no gesture is
 *   scheduled and it does not follow the pointer; back on screen they play again.
 * - Reduced motion (or no Web Animations): no loops, no turn, no gestures, no following; each part holds its rest
 *   pose. A swap of faces is a 160 ms fade.
 * - The pointer: one passive `pointermove` listener for the page while any icon shows, handled once a frame. A frame
 *   reads no layout: the icons' centres are measured once and again only after a resize, a scroll or a change of the
 *   list. The frames stop when every icon has settled.
 * - A face that is hidden stops (its turn is cancelled, not paused: a paused animation inside a `display: none` face
 *   still cost a layout every frame).
 * - `unmountAgentMark` cancels everything an icon runs: an animation left on a removed element keeps ticking.
 *
 * The faces (faceChoices.ts): the agent's mark, the Glass colours, Transparent and Face, chosen in the picker
 * (FaceFan.tsx) or stepped through by a click (the agent, Glass, Yellow, Transparent, Face). Our faces (faceArt.ts,
 * loaded on the first click or the first look at the picker) move as a whole; so does a host with no rig of its own.
 */
import type { AgentFace, OurFace } from './faceChoices';
import { ownIconSrc } from './ownIcons';
import { AGENT_RIGS, CLAUDE_RAY_ANGLES, type AgentRigKind } from './rigs';

export { AGENT_FACES, nextAgentFace, type AgentFace } from './faceChoices';

/** The rig an agent host's mark has; null for a host with none (its plain mark, moved as a whole). */
export function agentRigOf(host: string | null | undefined): AgentRigKind | null {
  if (host === 'claude-code' || host === 'claude' || host === 'claude-app') return 'claude';
  if (host === 'codex' || host === 'pi' || host === 'opencode') return host;
  return null;
}

/**
 * Claude's rare gestures: the gap before the next (ms, drawn evenly from the range, each mark from its own seed), a
 * part turn's size (degrees, either way) and length (ms), a breath's swell and a ray's shimmer (fractions of its
 * size), and how often each comes ([turn, breath, shimmer, ripple]).
 */
export const CLAUDE_CALM: Readonly<{ gap: [number, number]; turn: [number, number]; turnMs: [number, number]; breath: number; shimmer: number; weights: [number, number, number, number] }> = {
  gap: [4000, 12000],
  turn: [18, 40],
  turnMs: [1800, 2400],
  breath: 0.025,
  shimmer: 0.09,
  weights: [3, 2, 2, 1],
};

/**
 * Timers and the pointer's spring run at `clock` times their rate (a recorder that slows the page sets it; the tests
 * speed it up); `fidgets` off: no gestures; `simulatedDom`: move in a simulated DOM too (the marks' own tests, which
 * stand in for Web Animations).
 */
export const agentMotionOptions: { clock: number; fidgets: boolean; simulatedDom: boolean } = { clock: 1, fidgets: true, simulatedDom: false };

/**
 * How far an icon follows the pointer: `shift` px of lean and `turn` degrees at most, its eyes `eyes` px more; the
 * lean is full from `reach` px away and less the nearer the pointer is; `stillMs` without a move and it lets go.
 */
export const AGENT_LOOK = { shift: 1.5, turn: 4, eyes: 1.6, reach: 56, stillMs: 3000 } as const;

type Pose = { x: number; y: number; r: number; sx: number; sy: number; k: number; o: number };
type PoseIn = Partial<Pose>;
/** `step`: ms between sampled keyframes (a slow smooth loop needs few). */
type Clip = { D: number; loop: boolean; f: (t: number) => PoseIn; step?: number };
type Frame = { transform: string; opacity: number };
type Rand = () => number;

/** A seed from text (FNV-1a), and a small seeded generator (mulberry32). */
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
function seeded(seed: number): Rand {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Mixed into every seed, so a reload never replays the last one's show. */
const LOAD_SALT = Math.floor(Math.random() * 0xffffffff);

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
/** A smooth bump: 0, up to 1 at the middle of `w` ms, 0 again; 0 outside. */
const bell = (t: number, w: number) => (t <= 0 || t >= w ? 0 : Math.sin((Math.PI * t) / w) ** 2);
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
const loop = (D: number, f: (t: number) => PoseIn, step?: number): Clip => ({ D, loop: true, f, step });
const once = (D: number, f: (t: number) => PoseIn): Clip => ({ D, loop: false, f });
const same = (a: PoseIn, b: PoseIn) => KEYS.every((key) => full(a)[key] === full(b)[key]);

// A simulated DOM (the DOM tests' happy-dom) runs Web Animations on timers, a loop finishing at once: the marks hold
// still there, so the window's other tests never pay for them. The marks' own tests turn motion on (`simulatedDom`).
const simulated = typeof navigator !== 'undefined' && /HappyDOM\//.test(navigator.userAgent ?? '');
const reduceQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
/** Reduced motion, or a page that cannot animate (no Web Animations): every icon holds still, and follows nothing. */
export function agentMotionStill(): boolean {
  return (reduceQuery?.matches ?? false) || typeof Element === 'undefined' || typeof Element.prototype.animate !== 'function' || (simulated && !agentMotionOptions.simulatedDom);
}

/* ---------- one icon: every animation it runs, so off screen pauses them all and unmount cancels them all ---------- */
interface Icon {
  el: HTMLElement;
  rig: AgentRigKind | null;
  size: number;
  seed: number;
  face: AgentFace;
  off: boolean;
  card: HTMLElement;
  faces: Map<AgentFace, HTMLElement>;
  inst: Map<AgentFace, Instance>;
  swap: Animation[];
  anims: Set<Animation>;
  /** Its attention: where it leans (x and y in -1..1, on a spring), its centre and the zone it attends to (measured). */
  look: { layer: HTMLElement; x: number; y: number; vx: number; vy: number; omega: number; cx: number; cy: number; zone: Box | null; shown: boolean };
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
    const N = (D: number) => clamp(Math.round(D / (clip.step ?? 30)), 16, 140);
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

/* ---------- the rigs: each part's own life, and the little things the character does now and then ---------- */
interface Gestures {
  x: (part: string, clip: Clip) => void;
  /** A part turn of the whole star (Claude's `.am-spin` layer): `deg` more, over `ms`, easing in and out and settling. */
  rotate: (deg: number, ms: number) => void;
}
interface Rig {
  parts: Record<string, { sel: string; a?: number; vb?: number }>;
  /** A part's life: a calm loop, as long as it likes. None: the part rests. */
  life: (part: string, index: number) => Clip | undefined;
  /** The repertoire: [how often, the gesture]. */
  acts: [number, (I: Gestures) => void][];
  /** The wait before its next gesture (ms), when the rig sets its own; `first`: the first after it starts. */
  gap?: (first: boolean) => number;
  /** The part whose inside looks toward the pointer. */
  eyes?: string;
  /** How much of AGENT_LOOK.turn the body leans (a star that turns anyway: none). */
  lean: number;
}

/** A rig speaks in its svg's units; `px(vb)` is one screen pixel of a 24 px icon in them. Nothing under 1 px reads as motion. */
const px = (vb: number) => vb / 24;
/** Go there, stay, come back: 0 to 1 on a spring, held until `stay` ms, then released. */
const visit = (t: number, stay: number, zeta: number, omega: number) => (t < stay ? rise(t, zeta, omega) : ring(t - stay, Math.max(zeta, 0.7), omega));

/* Claude: a star mostly at rest. Now and then one small thing: a slow part turn that settles, a breath, a ray's
   shimmer or a soft ripple round the rays; never a turn that goes on. No life loop: between gestures it is still. */
const claudeRig = (R: Rand): Rig => {
  const n = CLAUDE_RAY_ANGLES.length;
  const calm = CLAUDE_CALM;
  const parts: Rig['parts'] = { body: { sel: '[data-p="body"]' } };
  CLAUDE_RAY_ANGLES.forEach((a, i) => (parts[`r${i}`] = { sel: `[data-p="r${i}"]`, a }));
  const between = (lo: number, hi: number) => lo + (hi - lo) * R();
  const ripple = (I: Gestures, k: number) => {
    const from = Math.floor(R() * n);
    const w = R() < 0.5 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const at = ((((w * (i - from)) % n) + n) % n) * 46;
      I.x(`r${i}`, once(1100, (t) => ({ sx: 1 + k * bell(t - at, 480) })));
    }
  };
  // Mostly one way, now and then back: it reads as a slow, wandering clock.
  let way = R() < 0.5 ? 1 : -1;
  const turn = (I: Gestures) => {
    if (R() < 0.3) way = -way;
    I.rotate(way * between(...calm.turn), between(...calm.turnMs));
  };
  const [wTurn, wBreath, wShimmer, wRipple] = calm.weights;
  const acts: Rig['acts'] = [
    [wTurn, turn],
    [
      wBreath,
      (I) => {
        const D = 1700;
        const k = calm.breath;
        I.x('body', once(D, (t) => ({ sx: 1 + k * bell(t, D), sy: 1 + k * bell(t, D) })));
        for (let i = 0; i < n; i++) I.x(`r${i}`, once(D, (t) => ({ sx: 1 + k * 1.4 * bell(t - 60, D - 60) })));
      },
    ],
    [
      wShimmer,
      (I) => {
        const i = Math.floor(R() * n);
        I.x(`r${i}`, once(900, (t) => ({ sx: 1 + calm.shimmer * bell(t, 900) })));
        I.x(`r${(i + 1) % n}`, once(900, (t) => ({ sx: 1 + calm.shimmer * 0.4 * bell(t - 120, 700) })));
      },
    ],
    [wRipple, (I) => ripple(I, calm.shimmer * 0.7)],
  ];
  return {
    parts,
    life: () => undefined,
    lean: 0,
    gap: (first) => (first ? between(400, calm.gap[1] * 0.7) : between(...calm.gap)),
    acts,
  };
};

/* Codex: the cloud bobs crisply, never stretching; the prompt is its face (> an eye, _ the cursor), and it looks about. */
const codexRig = (R: Rand): Rig => {
  const u = px(128);
  const Db = 3300 + 1500 * R();
  const Df = 6100 + 2900 * R();
  const Dc = 1040 + 280 * R();
  const p1 = R();
  const p2 = R();
  const side = () => (R() < 0.5 ? -1 : 1);
  const blink = (I: Gestures, twice = false) => I.x('chev', once(twice ? 360 : 140, (t) => ({ sy: 1 - 0.9 * (bell(t, 140) + (twice ? bell(t - 220, 140) : 0)) })));
  return {
    parts: { body: { sel: '[data-p="body"]' }, face: { sel: '[data-p="face"]' }, chev: { sel: '[data-p="chev"]' }, und: { sel: '[data-p="und"]' } },
    life: (p) =>
      p === 'body'
        ? loop(Db, (t) => ({ y: -0.65 * u * (1 + sq(t / Db + p1, 1.6)) }), 50)
        : p === 'face'
          ? loop(Df, (t) => ({ x: u * (0.85 * S(t / Df + p2) + 0.3 * S((3 * t) / Df + p1)) }), 70)
          : p === 'und'
            ? loop(Dc, (t) => ({ o: t / Dc < 0.56 ? 1 : 0.2 }))
            : undefined,
    eyes: 'face',
    lean: 1,
    acts: [
      [3, (I) => blink(I)],
      [1.5, (I) => blink(I, true)],
      [
        2.5,
        (I) => {
          const s = side();
          I.x('face', once(1100, (t) => ({ x: 1.9 * u * s * visit(t, 700, 0.8, 26) })));
        },
      ],
      [2, (I) => I.x('body', once(600, (t) => hop(t, 600, 2.3 * u, 0.06, 0.85)))],
      [1, (I) => I.x('face', once(460, (t) => ({ y: 1.4 * u * bell(t, 460) })))],
      [1.2, (I) => I.x('face', once(1300, (t) => ({ y: -1.3 * u * visit(t, 850, 0.8, 22) })))],
      [
        1.5,
        (I) => {
          I.x('chev', once(700, (t) => ({ x: t < 690 ? 1.2 * u * bell(t % 230, 230) : 0 })));
          I.x('und', once(700, (t) => ({ sx: t < 690 ? 1 + 0.25 * bell(t % 230, 230) : 1 })));
        },
      ],
    ],
  };
};

/* Pi: three blocks, each standing on its own base. They ride a slow wave, shuffle and hop. */
const piRig = (R: Rand): Rig => {
  const u = px(540);
  const B = ['blue', 'coral', 'yellow'];
  const idx = (p: string) => B.indexOf(p);
  const Dw = 3000 + 1400 * R();
  const Ds = 7000 + 3000 * R();
  const p1 = R();
  const side = () => (R() < 0.5 ? -1 : 1);
  return {
    parts: { body: { sel: '[data-p="body"]' }, blue: { sel: '[data-p="blue"]' }, coral: { sel: '[data-p="coral"]' }, yellow: { sel: '[data-p="yellow"]' } },
    life: (p) => (p === 'body' ? loop(Ds, (t) => ({ r: 3 * S(t / Ds + p1) }), 80) : loop(Dw, (t) => ({ y: -0.75 * u * (1 + S(t / Dw + idx(p) / 3 + p1)) }), 50)),
    eyes: 'coral',
    lean: 1,
    acts: [
      [
        3,
        (I) => {
          const b = B[Math.floor(R() * 3)]!;
          const H = (2.8 + 1.4 * R()) * u;
          I.x(b, once(1000, (t) => hop(t, 1000, H, 0.18, 0.6)));
          const land = 1000 * 0.6 * 0.65;
          for (const o of B) {
            if (o === b) continue;
            I.x(
              o,
              once(1000, (t) => {
                const r = t > land ? ring(t - land, 0.45, 30) * smooth((t - land) / 30) : 0;
                return { sy: 1 - 0.06 * r, sx: 1 + 0.03 * r };
              }),
            );
          }
        },
      ],
      // one after another, a little hop each
      [
        2,
        (I) => {
          const w = side();
          for (const b of B) {
            const at = (w > 0 ? idx(b) : 2 - idx(b)) * 190;
            I.x(b, once(1000, (t) => (t < at || t > at + 620 ? {} : hop(t - at, 620, 1.9 * u, 0.14, 0.9))));
          }
        },
      ],
      // a shuffle: the two standing blocks shift from side to side while the top one lifts
      [
        2,
        (I) => {
          const s = side();
          const sway = (t: number) => Math.sin((TAU * t) / 560) * Math.sin((Math.PI * t) / 1120);
          I.x('blue', once(1120, (t) => ({ x: 1.4 * u * s * sway(t) })));
          I.x('yellow', once(1120, (t) => ({ x: 1.4 * u * s * sway(Math.max(0, t - 70)) })));
          I.x('coral', once(1120, (t) => ({ y: -1 * u * bell(t, 1000) })));
        },
      ],
      [1.6, (I) => I.x('body', once(1150, (t) => ({ r: 6 * Math.sin((TAU * t) / 460) * Math.sin((Math.PI * t) / 1150) })))],
      [
        1.6,
        (I) => {
          const s = side();
          I.x('coral', once(1500, (t) => ({ y: -1.9 * u * visit(t, 1000, 0.7, 20), r: 9 * s * visit(t, 1000, 0.7, 20) })));
        },
      ],
    ],
  };
};

/* OpenCode: the frame sways and leans; the square inside is its eye: it drifts, peeks, glances and blinks. */
const opencodeRig = (R: Rand): Rig => {
  const u = px(32);
  const Db = 5200 + 2400 * R();
  const Di = 3800 + 1500 * R();
  const p1 = R();
  const p2 = R();
  const side = () => (R() < 0.5 ? -1 : 1);
  return {
    parts: { body: { sel: '[data-p="body"]' }, inner: { sel: '[data-p="inner"]' } },
    life: (p) =>
      p === 'body'
        ? loop(Db, (t) => ({ k: 3.4 * S(t / Db + p1) + 1.2 * S((2 * t) / Db + p2) }), 70)
        : loop(Di, (t) => ({ y: -0.85 * u * S(t / Di + p2), x: 0.5 * u * S((2 * t) / Di + p1) }), 60),
    eyes: 'inner',
    lean: 1,
    acts: [
      [
        2.5,
        (I) => {
          const s = side();
          I.x('body', once(1300, (t) => ({ k: 11 * s * pull(t, 180, 0.5, 13) })));
          I.x('inner', once(1300, (t) => ({ x: -1.6 * u * s * pull(t - 90, 180, 0.5, 13) })));
        },
      ],
      [2.5, (I) => I.x('inner', once(1350, (t) => ({ y: -2.6 * u * visit(t, 850, 0.6, 18) })))],
      [
        2,
        (I) => {
          const s = side();
          I.x('inner', once(1150, (t) => ({ x: 1.8 * u * s * visit(t, 720, 0.75, 24) })));
        },
      ],
      [1.5, (I) => I.x('body', once(720, (t) => hop(t, 720, 2.1 * u, 0.1, 0.85)))],
      [
        1.8,
        (I) => {
          const twice = R() < 0.4;
          I.x('inner', once(twice ? 400 : 170, (t) => ({ sy: 1 - 0.85 * (bell(t, 170) + (twice ? bell(t - 230, 170) : 0)) })));
        },
      ],
    ],
  };
};

/**
 * A face that keeps its shape: a squash becomes the same small dip on both axes, so a tile (the Glass faces' rounded
 * square) is only ever turned, moved and scaled as a whole, never stretched into a shape it is not.
 */
const keepShape = (p: PoseIn): PoseIn => {
  if (p.sx === undefined && p.sy === undefined) return p;
  const s = Math.sqrt((p.sx ?? 1) * (p.sy ?? 1));
  return { ...p, sx: s, sy: s };
};
const whole = (clip: Clip): Clip => ({ ...clip, f: (t) => keepShape(clip.f(t)) });

/* Our faces (the favicon art) and a host with no rig: the whole mark sways, tilts, bounces and nods, in a 64-unit grid. */
const faceRig = (R: Rand): Rig => {
  const u = px(64);
  const D = 5200 + 2600 * R();
  const p1 = R();
  const p2 = R();
  const side = () => (R() < 0.5 ? -1 : 1);
  return {
    parts: { body: { sel: '[data-p="body"]', vb: 64 } },
    life: () => loop(D, (t) => ({ r: 3 * S(t / D + p1) + 1.1 * S((3 * t) / D + p2), y: -0.5 * u * (1 + S((2 * t) / D + p2)) }), 60),
    lean: 1,
    acts: [
      [
        2.5,
        (I) => {
          const s = side();
          I.x('body', once(1600, (t) => ({ r: 9 * s * visit(t, 900, 0.55, 13) })));
        },
      ],
      [2, (I) => I.x('body', whole(once(900, (t) => hop(t, 900, 2.4 * u, 0.12, 0.85))))],
      [1.5, (I) => I.x('body', whole(once(420, (t) => ({ sy: 1 - 0.08 * bell(t, 420), sx: 1 + 0.04 * bell(t, 420) }))))],
      [1.5, (I) => I.x('body', once(1050, (t) => ({ x: 1.3 * u * Math.sin((TAU * t) / 420) * Math.sin((Math.PI * t) / 1050) })))],
      [1.2, (I) => I.x('body', once(1300, (t) => ({ y: -1.7 * u * visit(t, 800, 0.7, 18) })))],
    ],
  };
};

/** A part turn: eases in, eases out and settles with the faintest overshoot (about 3 % of the turn). */
const TURN_EASE = 'cubic-bezier(0.45, 0, 0.22, 1.035)';

const RIGS: Record<AgentRigKind | 'face', (R: Rand) => Rig> = { claude: claudeRig, codex: codexRig, pi: piRig, opencode: opencodeRig, face: faceRig };

/** One gesture at a time across the page: when the last one started. */
let lastGesture = -1e9;

/* ---------- an instance: one rig mounted in one face element, living its own life ---------- */
interface Instance {
  /** Start its life (or, under reduced motion, hold its rest pose). */
  start: () => void;
  /** Back on screen: gestures are scheduled again. */
  resume: () => void;
  stop: () => void;
  /** The layers that look toward the pointer, and how much the body leans. */
  eyes: HTMLElement[];
  lean: number;
}

function instance(icon: Icon, kind: AgentRigKind | 'face', root: HTMLElement, R: Rand): Instance {
  const rig = RIGS[kind](R);
  const T: Record<string, Track> = {};
  const X: Record<string, Track> = {};
  const glyph = root.querySelector<HTMLElement>('.am-rig');
  const vb = Number(glyph?.dataset.vb) || icon.size;
  for (const [name, def] of Object.entries(rig.parts)) {
    const node = root.querySelector<HTMLElement>(def.sel);
    if (!node) continue;
    // An HTML part moves in px; the rig speaks in its svg's units.
    const k = def.vb ? icon.size / def.vb : icon.size / vb;
    T[name] = new Track(icon, [node], def.a ?? 0, k);
    X[name] = new Track(icon, [node.firstElementChild as HTMLElement].filter(Boolean), def.a ?? 0, k);
  }
  // The eyes: one more layer inside the part's gesture layer, moved only by the pointer (made once, kept).
  const eyes: HTMLElement[] = [];
  const inside = rig.eyes ? root.querySelector<HTMLElement>(rig.parts[rig.eyes]!.sel)?.firstElementChild : null;
  if (inside) {
    let eye = inside.firstElementChild as HTMLElement | null;
    if (!eye?.classList.contains('am-e')) {
      eye = document.createElement('span');
      eye.className = 'am-e';
      eye.append(...inside.childNodes);
      inside.append(eye);
    }
    eyes.push(eye);
  }
  // One gesture's clips are padded to one length, so they all end on the same frame (one style pass, not ten).
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
      for (const [n, c] of b) go1(n, c.D === D ? c : once(D, (t) => (t < c.D ? c.f(t) : {})));
    }
  };
  let alive = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const phase = R();
  // Its temperament: how long it waits between gestures.
  const tempo = 0.85 + 0.45 * R();
  let last = -1;
  // Claude's part turns: one at a time on its own layer, each from where the last one left the star; the angle it
  // rests at is kept as a plain style (nothing left running between gestures). Cancelled on stop.
  const spinEl = root.querySelector<HTMLElement>('.am-spin');
  let angle = 0;
  let turning: Animation | null = null;
  const I: Gestures = {
    x: (name, clip) => (batch ? batch.push([name, clip]) : go1(name, clip)),
    rotate: (deg, ms) => {
      if (!spinEl) return;
      // A turn still on its way (rare: gestures come seconds apart): start from where it is now, never jump.
      let from = angle;
      if (turning) {
        const m = /matrix\(([-\d.e]+),\s*([-\d.e]+)/.exec(getComputedStyle(spinEl).transform);
        if (m) from = (Math.atan2(Number(m[2]), Number(m[1])) * 180) / Math.PI;
        turning.cancel();
      }
      const to = from + deg;
      angle = ((to % 360) + 360) % 360;
      const an = animate(icon, spinEl, [{ transform: `rotate(${f3(from)}deg)` }, { transform: `rotate(${f3(to)}deg)` }], { duration: ms, easing: TURN_EASE, fill: 'forwards' });
      turning = an;
      an.finished?.then(
        () => {
          if (turning !== an) return;
          spinEl.style.transform = `rotate(${f3(angle)}deg)`;
          an.cancel();
          turning = null;
        },
        () => {},
      );
    },
  };
  const total = rig.acts.reduce((sum, [w]) => sum + w, 0);
  /** A gesture by its weight, never the one before. */
  const choose = (): number => {
    for (let tries = 0; tries < 6; tries++) {
      let at = R() * total;
      const i = rig.acts.findIndex(([w]) => (at -= w) < 0);
      if (i >= 0 && i !== last) return i;
    }
    return (last + 1) % rig.acts.length;
  };
  /** The wait before the next gesture: mostly a few seconds, now and then a quick second thing or a longer rest. */
  const gap = (first = false): number => {
    if (rig.gap) return rig.gap(first);
    if (first) return 400 + 3600 * R();
    const r = R();
    if (r < 0.18) return 900 + 600 * R();
    const base = 2200 + 5200 * R() * R();
    return (r > 0.84 ? base + 2500 + 3500 * R() : base) * tempo;
  };
  function schedule(first = false) {
    clearTimeout(timer);
    timer = undefined;
    if (agentMotionStill() || !alive || icon.off) return;
    timer = setTimeout(
      () => {
        const live = !icon.off && !(typeof document !== 'undefined' && document.hidden);
        if (live && agentMotionOptions.fidgets && alive) {
          const now = performance.now();
          if (now - lastGesture < 380 / agentMotionOptions.clock) {
            timer = setTimeout(schedule, (300 + R() * 900) / agentMotionOptions.clock);
            return;
          }
          lastGesture = now;
          last = choose();
          const act = rig.acts[last]![1];
          run(() => act(I));
        }
        schedule();
      },
      gap(first) / agentMotionOptions.clock,
    );
  }
  return {
    eyes,
    lean: rig.lean,
    start() {
      const first = !alive;
      alive = true;
      clearTimeout(timer);
      for (const t of Object.values(X)) t.stop();
      if (agentMotionStill()) {
        turning?.cancel();
        turning = null;
        for (const tr of Object.values(T)) tr.hold({});
        return;
      }
      for (const [name, tr] of Object.entries(T)) {
        const c = rig.life(name, kind === 'claude' && name[0] === 'r' ? Number(name.slice(1)) : 0);
        if (c) tr.play(c, { phase: phase * c.D });
        else tr.stop();
      }
      schedule(first);
    },
    resume: () => schedule(),
    stop() {
      alive = false;
      clearTimeout(timer);
      timer = undefined;
      turning?.cancel();
      turning = null;
      angle = 0;
      if (spinEl) spinEl.style.transform = '';
      for (const t of Object.values(T)) t.stop();
      for (const t of Object.values(X)) t.stop();
      for (const eye of eyes) eye.style.transform = '';
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
    else an.play();
  }
  if (!off) for (const inst of icon.inst.values()) inst.resume();
  wake();
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

// Reduced motion turned on or off while icons show: each takes its new kind of pose, and lets go of the pointer.
reduceQuery?.addEventListener?.('change', () => {
  for (const icon of icons.values()) {
    // An uploaded picture that moves by itself: its still under reduced motion, itself again without.
    for (const [face, f] of icon.faces) if (face.startsWith('own:')) f.querySelector<HTMLImageElement>('img[data-own]')?.setAttribute('src', ownIconSrc(face, reduceQuery.matches));
    icon.inst.get(icon.face)?.start();
  }
  watchPointer();
  wake();
});

/* ---------- attention: every icon leans a little toward the pointer ---------- */
type Box = { left: number; top: number; right: number; bottom: number };
const pointer = { x: 0, y: 0, at: -1e9, here: false };
let watching = false;
let due: number | ReturnType<typeof setTimeout> = 0;
let lastTick = 0;
let stale = true;
/** Some icon is looking at the pointer, or on its way back. */
let attending = false;
let stillTimer: ReturnType<typeof setTimeout> | undefined;
let sizeWatch: ResizeObserver | null = null;
const hasFrames = typeof requestAnimationFrame === 'function';

function wake(): void {
  if (due || !icons.size) return;
  due = hasFrames ? requestAnimationFrame(tick) : setTimeout(() => tick(performance.now()), 16);
}
function sleep(): void {
  if (due) {
    if (hasFrames) cancelAnimationFrame(due as number);
    else clearTimeout(due as ReturnType<typeof setTimeout>);
  }
  due = 0;
  lastTick = 0;
}
function onPointerMove(event: PointerEvent): void {
  if (event.pointerType === 'touch') return;
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  pointer.at = performance.now();
  pointer.here = true;
  // Still for long enough: one more frame then, which lets go.
  clearTimeout(stillTimer);
  stillTimer = setTimeout(wake, AGENT_LOOK.stillMs / agentMotionOptions.clock + 30);
  wake();
}
function onPointerGone(): void {
  if (!pointer.here) return;
  pointer.here = false;
  wake();
}
/** The page moved under the icons (a resize, a scroll, a change of the list): measure again before the next look. */
function onMoved(): void {
  stale = true;
  // Only an icon that is looking has to know now; the rest learn at the pointer's next move.
  if (attending) wake();
}
/** Listen while any icon shows and may move; stop when none does. */
function watchPointer(): void {
  const want = icons.size > 0 && !agentMotionStill() && typeof document !== 'undefined';
  if (want === watching) return;
  watching = want;
  if (want) {
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onPointerGone, { passive: true });
    document.addEventListener('scroll', onMoved, { passive: true, capture: true });
    window.addEventListener('resize', onMoved, { passive: true });
    if (typeof ResizeObserver === 'function') sizeWatch = new ResizeObserver(onMoved);
    stale = true;
  } else {
    document.removeEventListener('pointermove', onPointerMove);
    document.documentElement.removeEventListener('pointerleave', onPointerGone);
    document.removeEventListener('scroll', onMoved, { capture: true });
    window.removeEventListener('resize', onMoved);
    sizeWatch?.disconnect();
    sizeWatch = null;
    clearTimeout(stillTimer);
    pointer.here = false;
    attending = false;
    if (!icons.size) sleep();
  }
}

/** Where each icon is, and the part of the page it attends to: its sidebar, or around its own section. One pass of layout reads. */
function measure(): void {
  stale = false;
  const zones = new Map<Element, Box>();
  for (const icon of icons.values()) {
    const look = icon.look;
    const box = icon.el.getBoundingClientRect();
    look.cx = box.left + box.width / 2;
    look.cy = box.top + box.height / 2;
    look.zone = null;
    // A closed section's one row left on show minds its own business.
    if (icon.el.closest('[data-agents-section]')?.hasAttribute('data-closed')) continue;
    const side = icon.el.closest('.ib-side');
    const home = side ?? icon.el.closest('[data-agents-surface]') ?? icon.el.parentElement;
    if (!home) continue;
    let zone = zones.get(home);
    if (!zone) {
      const r = home.getBoundingClientRect();
      const near = side ? 0 : 64;
      zone = { left: r.left - near, top: r.top - near, right: r.right + near, bottom: r.bottom + near };
      zones.set(home, zone);
      sizeWatch?.observe(home);
    }
    look.zone = zone;
  }
}

const lookTransform = (x: number, y: number, turn: number) => `translate(${f3(x)}px,${f3(y)}px) rotate(${f3(turn)}deg)`;

/** One frame of attention: every icon's spring a step toward where it should look. No layout is read (but after `stale`). */
function tick(now: number): void {
  due = 0;
  const still = agentMotionStill();
  if (stale && !still && pointer.here) measure();
  const h = ((lastTick ? Math.min(now - lastTick, 34) : 16) / 1000) * agentMotionOptions.clock;
  lastTick = now;
  const live = !still && pointer.here && (now - pointer.at) * agentMotionOptions.clock < AGENT_LOOK.stillMs;
  let moving = false;
  attending = false;
  for (const icon of icons.values()) {
    const look = icon.look;
    let tx = 0;
    let ty = 0;
    const zone = look.zone;
    if (live && !icon.off && zone && pointer.x >= zone.left && pointer.x <= zone.right && pointer.y >= zone.top && pointer.y <= zone.bottom) {
      const dx = pointer.x - look.cx;
      const dy = pointer.y - look.cy;
      const d = Math.hypot(dx, dy);
      if (d > 0.5) {
        // Full from `reach` px away; right over the icon it looks straight at you.
        const g = smooth(d / AGENT_LOOK.reach) / d;
        tx = dx * g;
        ty = dy * g;
      }
    }
    if (still || icon.off) {
      look.x = look.y = look.vx = look.vy = 0;
    } else {
      // A critically damped spring, stepped exactly: it never overshoots and never rings.
      const decay = Math.exp(-look.omega * h);
      const ex = look.x - tx;
      const nx = look.vx + look.omega * ex;
      look.x = tx + (ex + nx * h) * decay;
      look.vx = (look.vx - look.omega * nx * h) * decay;
      const ey = look.y - ty;
      const ny = look.vy + look.omega * ey;
      look.y = ty + (ey + ny * h) * decay;
      look.vy = (look.vy - look.omega * ny * h) * decay;
      if (Math.abs(look.x - tx) + Math.abs(look.y - ty) < 0.004 && Math.abs(look.vx) + Math.abs(look.vy) < 0.02) {
        look.x = tx;
        look.y = ty;
        look.vx = look.vy = 0;
      } else moving = true;
    }
    const x = clamp(look.x, -1, 1);
    const y = clamp(look.y, -1, 1);
    const inst = icon.inst.get(icon.face);
    const rest = x === 0 && y === 0;
    if (tx !== 0 || ty !== 0) attending = true;
    if (rest && !look.shown) continue;
    look.shown = !rest;
    if (!rest) attending = true;
    look.layer.style.transform = rest ? '' : lookTransform(x * AGENT_LOOK.shift, y * AGENT_LOOK.shift, x * AGENT_LOOK.turn * (inst?.lean ?? 1));
    for (const eye of inst?.eyes ?? []) eye.style.transform = rest ? '' : `translate(${f3(x * AGENT_LOOK.eyes)}px,${f3(y * AGENT_LOOK.eyes)}px)`;
  }
  if (moving) wake();
  else lastTick = 0;
}

/** Our faces' art (faceArt.ts), set once it is loaded. Until then a swap waits for it. */
let faceArt: Readonly<Record<OurFace, string>> | null = null;
export function setAgentFaceArt(art: Readonly<Record<OurFace, string>>): void {
  faceArt = art;
}
export function agentFaceArtReady(): boolean {
  return faceArt !== null;
}

/**
 * An uploaded picture ("Your own…"), moved as a whole like our faces: built with the DOM, never as markup, and only ever
 * an `<img>` of its address on this Inbox (an SVG in an image runs no script and loads nothing). It plays its own
 * animation here, in the sidebar; under reduced motion it shows its still, which the Inbox makes (an animation inside
 * an image does not hear the setting). A picture that does not load shows the agent's own mark.
 */
function ownFaceEl(icon: Icon, f: HTMLElement, face: AgentFace): void {
  const body = document.createElement('span');
  body.className = 'am-p am-fb';
  body.dataset.p = 'body';
  const x = document.createElement('span');
  x.className = 'am-x am-fb am-ownart';
  const img = document.createElement('img');
  img.className = 'am-art';
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  img.dataset.own = face;
  img.src = ownIconSrc(face, reduceQuery?.matches ?? false);
  img.addEventListener('error', () => {
    if (icons.get(icon.el) !== icon) return;
    if (icon.face === face) showFace(icon, 'agent', false);
    // Built again (and asked again) the next time this face shows.
    if (icon.face !== face && icon.faces.get(face) === f) {
      f.remove();
      icon.faces.delete(face);
    }
  });
  x.append(img);
  body.append(x);
  f.append(body);
}

function faceEl(icon: Icon, face: AgentFace): HTMLElement {
  const known = icon.faces.get(face);
  if (known) return known;
  const f = document.createElement('span');
  f.className = face.startsWith('own:') ? 'am-face am-f-own' : `am-face am-f-${face}`;
  if (face.startsWith('own:')) ownFaceEl(icon, f, face);
  // Our art is a picture moved as a whole; `faceArt` holds markup from our own assets only.
  else if (face !== 'agent') f.innerHTML = `<span class="am-p am-fb" data-p="body"><span class="am-x am-fb">${faceArt?.[face as OurFace] ?? ''}</span></span>`;
  f.hidden = true;
  icon.card.append(f);
  icon.faces.set(face, f);
  return f;
}

function startFace(icon: Icon, face: AgentFace): void {
  if (icon.inst.has(face)) return;
  const kind = face === 'agent' ? (icon.rig ?? 'face') : 'face';
  // Each face of each icon has its own run of chances.
  const inst = instance(icon, kind, faceEl(icon, face), seeded(icon.seed ^ seedOf(face)));
  icon.inst.set(face, inst);
  inst.start();
}

function stopFace(icon: Icon, face: AgentFace): void {
  icon.inst.get(face)?.stop();
  icon.inst.delete(face);
}

/** Where the caller draws a plain mark: only a host with no rig has one. */
const plainOf = (icon: Icon): HTMLElement | null => (icon.rig ? null : icon.faces.get('agent')!.querySelector<HTMLElement>('.am-plain'));

/**
 * Draws a mark in `el` (an empty `.am` box React owns no children of): the agent's rig when its host has one, then
 * `face` when it is one of ours. `seed` (the agent's id) gives the icon its own life. Returns null for a rig; for a
 * host with none, the element the caller draws its plain mark in (a portal), which moves as a whole.
 */
export function mountAgentMark(el: HTMLElement, options: { rig: AgentRigKind | null; face: AgentFace; size: number; seed: string }): HTMLElement | null {
  const known = icons.get(el);
  if (known) return plainOf(known);
  const tile = options.rig ? AGENT_RIGS[options.rig] : '<span class="am-p am-fb" data-p="body"><span class="am-x am-fb am-plain"></span></span>';
  el.innerHTML = `<span class="am-look"><span class="am-card"><span class="am-face am-f-agent"><span class="am-tile">${tile}</span></span></span></span>`;
  const layer = el.firstElementChild as HTMLElement;
  const card = layer.firstElementChild as HTMLElement;
  const seed = (seedOf(options.seed) ^ LOAD_SALT) >>> 0;
  const R = seeded(seed ^ 0x9e3779b9);
  const icon: Icon = {
    el,
    rig: options.rig,
    size: options.size,
    seed,
    face: 'agent',
    off: false,
    card,
    faces: new Map([['agent', card.firstElementChild as HTMLElement]]),
    inst: new Map(),
    swap: [],
    anims: new Set(),
    // Each follows at its own pace (about 0.5 to 1 s to arrive), so a list never turns as one.
    look: { layer, x: 0, y: 0, vx: 0, vy: 0, omega: 5 + 5 * R(), cx: 0, cy: 0, zone: null, shown: false },
  };
  icons.set(el, icon);
  el.dataset.face = 'agent';
  startFace(icon, 'agent');
  screenWatch()?.observe(el);
  watchPointer();
  onMoved();
  if (options.face !== 'agent' && (faceArt || options.face.startsWith('own:'))) showFace(icon, options.face, false);
  return plainOf(icon);
}

/** Show a face (the click cycle, or the face kept for this agent). `animate`: the swap's little show. */
export function showAgentFace(el: HTMLElement, face: AgentFace, withMotion = true): void {
  const icon = icons.get(el);
  if (!icon || icon.face === face) return;
  if (face !== 'agent' && !face.startsWith('own:') && !faceArt) return;
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

/** Call before the icon leaves the page: every animation and timer it runs stops, and the last one stops the listening. */
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
  watchPointer();
  onMoved();
}

/** What an icon runs now (tests, the perf guards): live animations, and how many of them play. */
export function agentMarkActivity(el: HTMLElement): { animations: number; playing: number; off: boolean } | null {
  const icon = icons.get(el);
  if (!icon) return null;
  const all = [...icon.anims];
  return { animations: all.length, playing: all.filter((an) => an.playState === 'running').length, off: icon.off };
}

/** Whether the page listens for the pointer, and whether a frame is due (tests: nothing is left behind). */
export function agentPointerActivity(): { listening: boolean; frame: boolean } {
  return { listening: watching, frame: !!due };
}
