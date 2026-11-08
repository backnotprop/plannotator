/**
 * The picture on top of Shape's offer (approval "shape-turn-on-dialog", 2026-11-08; the owner on the mock's picture:
 * "Don't we have a more technical style diagram?"). A small fixed board in Shape's technical style, drawn by the real
 * Shape renderer (`ShapeDiagram`, packages/ui), so it always looks like the product: hairline strokes, small corners,
 * a sans for names and a monospace for labels, quiet zone fills (the technical look's own mixes, scene/look.ts
 * `LOOK_CSS`), one accent, the dot grid. Every colour is the board frame's, from the theme's tokens, so light and dark
 * both hold. The dialog shows a close-up crop of it (ShapeOffer.tsx). A fixture, not a stored board: nothing is read
 * from the Inbox for it.
 */
import type { ShapeDrawnView } from '@plannotator/core/shape';

/** The technical look's quiet fills and the dot grid (scene/look.ts `LOOK_CSS`, for a still board). */
const CSS = `
.board {
  --blue-soft: color-mix(in oklab, #2f6fb0 6%, var(--paper));
  --amber-soft: color-mix(in oklab, #d9971f 8%, var(--paper));
  --green-soft: color-mix(in oklab, #2b8a57 6%, var(--paper));
  --blue: color-mix(in oklab, #2f6fb0 62%, var(--ink));
  --amber: color-mix(in oklab, #b87a12 70%, var(--ink));
  --green: color-mix(in oklab, #2b8a57 62%, var(--ink));
  --mark-soft: color-mix(in oklab, var(--primary) 9%, transparent);
}
.board > svg {
  background-image: radial-gradient(circle, color-mix(in oklab, var(--ink) 9%, transparent) .6px, transparent .9px);
  background-size: 16px 16px;
}
svg text { font-variant-numeric: tabular-nums; }
svg .nm { font-size: 14px; font-weight: 600; }
svg .lb { font-size: 11.5px; }
svg .sm { font-size: 10.5px; }
svg .box { fill: var(--paper); stroke: var(--rule); }
svg .num circle { fill: var(--paper); stroke: var(--ink2); }
svg .num text { font-size: 10.5px; fill: var(--ink2); }
`;

/** A numbered mark: a thin ring with its number in the monospace. */
const num = (x: number, y: number, n: number) =>
  `<g class="num"><circle cx="${x}" cy="${y}" r="9" stroke-width="1"/><text x="${x}" y="${y + 3.6}" text-anchor="middle" class="t-mono">${n}</text></g>`;

/** A connector that draws on, with its arrowhead. */
const arrow = (d: string, head: string, cls = 'line') =>
  `<path d="${d}" class="${cls} draw" pathLength="1" fill="none" stroke-width="1.25" stroke-linejoin="round"/><path d="${head}" class="${cls}" fill="none" stroke-width="1.25" stroke-linejoin="round"/>`;

const HTML = `<svg viewBox="0 0 1000 340" width="100%" aria-label="Stripe webhooks: the API adds each event to a queue, a worker runs it and retries with backoff">
<g data-step="1">
  <rect x="20" y="20" width="220" height="300" rx="3" style="fill:var(--blue-soft)"/>
  <text x="38" y="48" class="nm">Webhook API</text>
  <text x="38" y="66" class="sm t-mono t-grey">POST /webhooks/stripe</text>
  <rect x="38" y="96" width="184" height="64" rx="3" class="box" stroke-width="1.25"/>
  <text x="52" y="122" class="nm" style="font-size:13px">verify signature</text>
  <text x="52" y="142" class="lb t-mono">constructEvent()</text>
  <rect x="38" y="186" width="184" height="64" rx="3" class="box" stroke-width="1.25"/>
  <text x="52" y="212" class="nm" style="font-size:13px">ack 200</text>
  <text x="52" y="232" class="lb t-mono t-grey">under 300 ms</text>
  ${num(222, 96, 1)}
</g>
<g data-step="2">
  <rect x="270" y="20" width="470" height="300" rx="3" style="fill:var(--amber-soft)"/>
  <text x="288" y="48" class="nm">Redis · BullMQ</text>
  <text x="288" y="66" class="sm t-mono t-grey">queue: stripe-events</text>
  <rect x="300" y="104" width="172" height="50" rx="3" class="ink" stroke-width="1.25"/>
  <rect x="308" y="112" width="34" height="34" rx="2" style="fill:color-mix(in oklab, var(--ink) 16%, var(--paper))" stroke="var(--ink2)" stroke-width="1"/>
  <rect x="348" y="112" width="34" height="34" rx="2" style="fill:color-mix(in oklab, var(--ink) 16%, var(--paper))" stroke="var(--ink2)" stroke-width="1"/>
  <rect x="388" y="112" width="34" height="34" rx="2" class="box" stroke-width="1"/>
  <rect x="428" y="112" width="34" height="34" rx="2" class="box" stroke-width="1"/>
  <text x="386" y="180" text-anchor="middle" class="nm" style="font-size:13px">stripe-events</text>
  <text x="386" y="198" text-anchor="middle" class="lb t-mono t-grey">jobId = event.id</text>
</g>
<g data-step="3">
  ${arrow('M222 128H297', 'M291 124L297 128L291 132')}
  <text x="259" y="120" text-anchor="middle" class="sm t-mono t-grey">add</text>
</g>
<g data-step="4">
  ${arrow('M472 129H527', 'M521 125L527 129L521 133')}
  <text x="499" y="121" text-anchor="middle" class="sm t-mono t-grey">job</text>
  <rect x="530" y="96" width="186" height="92" rx="3" class="box" style="stroke:var(--mark)" stroke-width="1.25"/>
  <text x="546" y="122" class="nm" style="font-size:13px">stripe worker</text>
  <text x="546" y="144" class="lb t-mono">runs handleEvent</text>
  <text x="546" y="164" class="lb t-mono">throws → retry</text>
  ${num(716, 96, 2)}
  <rect x="672" y="196" width="40" height="18" rx="3" class="acc-fill" stroke-width="1"/>
  <text x="692" y="209" text-anchor="middle" class="sm t-mono t-acc">new</text>
</g>
<g data-step="5">
  ${arrow('M612 188V238H496V150H476', 'M482 146L476 150L482 154', 'acc')}
  <text x="554" y="256" text-anchor="middle" class="lb t-mono t-acc">backoff ×8</text>
  ${num(612, 238, 3)}
</g>
<g data-step="6">
  <rect x="770" y="20" width="210" height="300" rx="3" style="fill:var(--green-soft)"/>
  <text x="788" y="48" class="nm">Postgres</text>
  <text x="788" y="66" class="sm t-mono t-grey">table: stripe_events</text>
  <rect x="788" y="96" width="174" height="92" rx="3" class="box" stroke-width="1.25"/>
  <text x="800" y="116" class="sm t-mono t-grey">event_id</text><text x="886" y="116" class="sm t-mono t-grey">status</text>
  <path d="M788 124H962" class="grey" stroke-width="1"/>
  <text x="800" y="144" class="lb t-mono">evt_1Q8…</text><text x="886" y="144" class="lb t-mono">done</text>
  <text x="800" y="164" class="lb t-mono">evt_1Q9…</text><text x="886" y="164" class="lb t-mono t-acc">retry</text>
  <text x="800" y="182" class="lb t-mono t-grey">evt_1QA…</text><text x="886" y="182" class="lb t-mono t-grey">done</text>
  <rect x="788" y="212" width="174" height="52" rx="3" class="dash" style="fill:var(--paper)" stroke-width="1"/>
  <text x="800" y="234" class="nm" style="font-size:13px">dead-letter</text>
  <text x="800" y="252" class="lb t-mono t-grey">after 8 tries</text>
</g>
<g data-step="7">
  ${arrow('M716 128H785', 'M779 124L785 128L779 132')}
  <text x="750" y="120" text-anchor="middle" class="sm t-mono t-grey">upsert</text>
  ${arrow('M692 214V238H785', 'M779 234L785 238L779 242', 'grey')}
</g>
</svg>`;

export const SHAPE_OFFER_BOARD: ShapeDrawnView = { html: HTML, css: CSS, width: 1000, height: 340 };
