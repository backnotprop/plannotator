/**
 * The emoji reaction on the person's own message (approval
 * "inbox-emoji-reactions", item 1; design record `placement/`, variant D):
 * a 22 px tapback ON the words, at the top-right corner of the text block,
 * overlapping its top edge the way a tapback overlaps a bubble's corner.
 * Never by the head row or the time; the same on a desktop and a phone.
 *
 * Where (mock-d.html `placeD`): from the words' own line boxes. One line, it
 * rides the end of the words (its left edge 4 px before the last letter
 * ends); several lines, the top-right of the words' box, never past the end
 * of the first line. Its bottom edge reaches 0.2 em under the cap line, into
 * the cap/ascender band only. It never overhangs the message by more than the
 * gutter (14 px, 7 on a phone); pulled in over letters, it lifts by half the
 * pull-in. The words get 8 px more air above them while it is there, so it
 * never reaches the head row.
 *
 * When: the server stored the reaction with the delivery (`reaction.at`, 0.8
 * to 2.5 s after it). A page showing the thread then draws it arriving: a
 * waiting shell with three breathing dots for a beat, then the emoji lands
 * with a small tilt that settles, and the reaction sound plays as it lands
 * (`onLanded`). Reduced motion: a 150 ms fade, no beat, no transform. A page
 * that opens the thread later, or that is not in view, shows it still and
 * silent.
 */

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { InboxReaction } from '@plannotator/core/inbox-types';
import { INBOX_REACTION_FALLBACK } from '@plannotator/core/inbox-reactions';
import { whenTime } from '../format';
import { prefersReducedMotion } from '../settle';
import { Tip } from './Tip';

/** What the thread does as a reaction lands on screen: the sound, when its switch is on. Null: silent. */
export const ReactionLandedContext = createContext<(() => void) | null>(null);

/** The waiting shell's beat before the emoji lands (the mock's "typing beat"). */
export const REACTION_BEAT_MS = 560;
/** A reaction first seen this long after it landed is drawn still: the page was not there when it came. */
export const REACTION_LATE_MS = 4000;

const SIZE = 22;
/** Its left edge starts this far before the end of the words. */
const IN = 4;

/** Reactions this page has drawn already (by message): a later render or a reopened thread never replays one. */
const drawn = new Set<string>();

/** Springs as CSS linear() easings: a damped oscillator sampled into points (mock-d.html). */
function spring(zeta: number, omega: number): { easing: string; duration: number } {
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const T = Math.log(400) / (zeta * omega);
  const pts: number[] = [];
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * T;
    const x = 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
    pts.push(+x.toFixed(4));
  }
  pts[N] = 1;
  return { easing: `linear(${pts.join(', ')})`, duration: Math.round(T * 1000) };
}
const SPR = {
  pop: spring(0.55, 19),
  tilt: spring(0.32, 21),
  emoji: spring(0.45, 24),
  shell: spring(0.7, 22),
};

/** The text nodes of the person's words: the first text block of the body (a paragraph), else the whole body. */
function wordRects(body: Element): DOMRect[] {
  const block = body.querySelector('p, li, h1, h2, h3, h4, h5, h6, blockquote') ?? body;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const rects: DOMRect[] = [];
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) if (r.width > 0.5) rects.push(r);
  }
  return rects;
}

/** Place the badge on the words (mock-d.html `placeD`). False: no words to sit on. */
function place(badge: HTMLElement, phone: boolean): boolean {
  const article = badge.closest('.ib-message');
  const msgEl = article?.querySelector(':scope > .ib-msg');
  const body = msgEl?.querySelector('.ib-body');
  if (!article || !msgEl || !body) return false;
  const rects = wordRects(body);
  if (rects.length === 0) return false;
  const a = article.getBoundingClientRect();
  const msg = msgEl.getBoundingClientRect();
  const first = rects[0]!;
  const fs = parseFloat(getComputedStyle(body).fontSize) || 14;
  const lines = new Set(rects.map((r) => Math.round(r.top))).size;
  const lineEnd = Math.max(...rects.filter((r) => Math.abs(r.top - first.top) < 2).map((r) => r.right));
  const boxRight = Math.max(...rects.map((r) => r.right));
  const right = lines > 1 ? Math.min(boxRight, lineEnd) : lineEnd;
  const over = Math.round(fs * 0.2);
  const gutter = phone ? 7 : 14;
  // The cap line: Inter's ascent less its cap height, from the top of the first line's text box.
  const capTop = first.top + (0.96875 - 0.727) * fs;
  const want = right - IN;
  const left = Math.min(want, msg.right + gutter - SIZE);
  const lift = Math.min(over + 2, Math.max(0, want - left) * 0.5);
  badge.style.left = `${left - a.left - article.clientLeft}px`;
  badge.style.top = `${capTop + over - lift - SIZE - a.top - article.clientTop}px`;
  return true;
}

type Phase = 'hidden' | 'shell' | 'landed';

/**
 * The badge. `agent`: who received the reply ("Claude Code"), for its name
 * and tooltip. `phone`: the narrower gutter.
 */
export function ReactionBadge({ messageId, reaction, agent, phone }: { messageId: string; reaction: InboxReaction; agent: string; phone: boolean }) {
  const key = `${messageId}:${reaction.at}`;
  const landsAt = Date.parse(reaction.at);
  const onLanded = useContext(ReactionLandedContext);
  const onLandedRef = useRef(onLanded);
  onLandedRef.current = onLanded;
  // Arrives on screen only when this page sees it come: not drawn before, in view, and not long landed.
  const [arrive] = useState(
    () => !drawn.has(key) && typeof document !== 'undefined' && document.visibilityState === 'visible' && Date.now() < landsAt + REACTION_LATE_MS,
  );
  // Reduced motion: no waiting shell, the badge fades in as it lands.
  const [beat] = useState(() => (prefersReducedMotion() ? 0 : REACTION_BEAT_MS));
  const [phase, setPhase] = useState<Phase>(() => {
    if (!arrive) return 'landed';
    const now = Date.now();
    return now < landsAt - beat ? 'hidden' : now < landsAt && beat > 0 ? 'shell' : now < landsAt ? 'hidden' : 'landed';
  });
  const ref = useRef<HTMLSpanElement>(null);
  const emoji = useDrawableEmoji(reaction.emoji);

  // The timeline: the shell a beat before it lands, then the landing.
  useEffect(() => {
    drawn.add(key);
    if (!arrive) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const now = Date.now();
    if (beat > 0 && now < landsAt - beat) timers.push(setTimeout(() => setPhase('shell'), landsAt - beat - now));
    timers.push(setTimeout(() => setPhase('landed'), Math.max(0, landsAt - now)));
    return () => timers.forEach(clearTimeout);
  }, [key, arrive, landsAt, beat]);

  // Where: on the words, again whenever the message changes size or the fonts arrive.
  useLayoutEffect(() => {
    const badge = ref.current;
    if (!badge || phase === 'hidden') return;
    const article = badge.closest<HTMLElement>('.ib-message');
    const msg = article?.querySelector<HTMLElement>(':scope > .ib-msg') ?? null;
    const y0 = msg?.getBoundingClientRect().top ?? 0;
    article?.setAttribute('data-reaction', '');
    const placed = place(badge, phone);
    badge.hidden = !placed;
    // The words open 8 px of air above them as it arrives; the badge rides along (the shell's spring).
    if (arrive && phase === 'shell' && msg && !prefersReducedMotion()) {
      const dy = y0 - msg.getBoundingClientRect().top;
      if (dy) for (const el of [msg, badge]) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], SPR.shell);
    }
    const again = () => {
      if (ref.current) ref.current.hidden = !place(ref.current, phone);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(again);
    if (article) observer?.observe(article);
    void document.fonts?.ready.then(again);
    return () => observer?.disconnect();
  }, [phase, phone, arrive]);

  useEffect(
    () => () => {
      // The badge went (another thread, a re-render without it): the words close the air again.
      ref.current?.closest('.ib-message')?.removeAttribute('data-reaction');
    },
    [],
  );

  // The motion.
  useEffect(() => {
    const badge = ref.current;
    if (!badge || !arrive) return;
    const body = badge.querySelector<HTMLElement>('.ib-rx-body');
    const e = badge.querySelector<HTMLElement>('.ib-rx-e');
    const dots = badge.querySelector<HTMLElement>('.ib-rx-dots');
    if (!body || !e || !dots || typeof body.animate !== 'function') {
      if (phase === 'landed') onLandedRef.current?.();
      return;
    }
    const reduce = prefersReducedMotion();
    if (phase === 'shell' && !reduce) {
      body.animate([{ transform: 'scale(0.2)', opacity: 0 }, { transform: 'scale(0.82)', opacity: 1 }], { ...SPR.shell, fill: 'both' });
      const breathing = [...dots.children].map((d, i) =>
        (d as HTMLElement).animate(
          [
            { opacity: 0.35, transform: 'translateY(0)' },
            { opacity: 0.85, transform: 'translateY(-1.5px)' },
            { opacity: 0.35, transform: 'translateY(0)' },
          ],
          { duration: 620, delay: i * 140, iterations: Infinity, easing: 'ease-in-out' },
        ),
      );
      return () => breathing.forEach((a) => a.cancel());
    }
    if (phase === 'landed') {
      if (reduce) badge.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
      else {
        const waited = body.getAnimations().length > 0;
        body.getAnimations().forEach((a) => a.cancel());
        if (waited) body.animate([{ transform: 'scale(0.82)' }, { transform: 'scale(1)' }], SPR.pop);
        else body.animate([{ transform: 'scale(0.25)', opacity: 0, offset: 0 }, { opacity: 1, offset: 0.12 }, { transform: 'scale(1)', opacity: 1 }], { ...SPR.pop, fill: 'backwards' });
        e.animate([{ transform: 'scale(0.3)' }, { transform: 'scale(1)' }], { ...SPR.emoji, delay: waited ? 0 : 50, fill: 'backwards' });
        e.animate([{ rotate: '-18deg' }, { rotate: '0deg' }], { ...SPR.tilt, delay: waited ? 0 : 50, fill: 'backwards', composite: 'add' });
      }
      // The sound, as the emoji lands, only on a page that shows the thread now.
      if (document.visibilityState === 'visible') onLandedRef.current?.();
    }
  }, [phase, arrive]);

  if (phase === 'hidden') return null;
  const label = `${agent} reacted with ${emoji}`;
  return (
    <Tip content={`${agent} reacted ${emoji} when it got your reply, ${whenTime(reaction.at)}`}>
      <span ref={ref} className="ib-rx" role="img" aria-label={label} data-reaction={reaction.emoji} data-phase={phase}>
        <span className="ib-rx-body">
          <span className="ib-rx-dots" aria-hidden="true" data-on={phase === 'shell' ? '' : undefined}>
            <i />
            <i />
            <i />
          </span>
          <span className="ib-rx-e" aria-hidden="true" data-on={phase === 'landed' ? '' : undefined}>
            {emoji}
          </span>
        </span>
      </span>
    </Tip>
  );
}

// ──────────────────────── the fallback for old systems ────────────────────────

const drawable = new Map<string, boolean>();

/**
 * Whether this device draws `emoji` as one colour picture. On a canvas, an
 * emoji the system does not know draws as a box (no colour), as nothing, or,
 * for a ZWJ sequence, as its pieces side by side (wider than one emoji).
 * Unknown (no canvas): yes.
 */
export function emojiDrawable(emoji: string): boolean {
  const known = drawable.get(emoji);
  if (known !== undefined) return known;
  let ok = true;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 40;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      ctx.font = '32px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
      ctx.textBaseline = 'top';
      const one = ctx.measureText('😀').width;
      const it = ctx.measureText(emoji).width;
      ctx.fillStyle = '#000';
      ctx.fillText(emoji, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let colour = false;
      for (let i = 0; i < pixels.length && !colour; i += 4) {
        const [r, g, b, alpha] = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!];
        if (alpha > 0 && Math.max(r, g, b) - Math.min(r, g, b) > 24) colour = true;
      }
      ok = one > 0 && it > 0 && it < one * 1.4 && colour;
    }
  } catch {
    ok = true;
  }
  drawable.set(emoji, ok);
  return ok;
}

/** The emoji as this device can draw it: a modern one the system lacks becomes its older stand-in. */
function useDrawableEmoji(emoji: string): string {
  const fallback = INBOX_REACTION_FALLBACK[emoji];
  const [shown] = useState(() => (fallback && typeof document !== 'undefined' && !emojiDrawable(emoji) ? fallback : emoji));
  return shown;
}
