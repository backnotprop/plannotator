/**
 * Hover cards for issue, pull request and merge request links.
 *
 * Two parts, each usable alone:
 *
 * - `RefCardView`: the card's contents for one answer (loading, the item, or
 *   a quiet failure that still offers "Open on GitHub / GitLab").
 *   Presentational: no fetch, no state but an inline link confirm.
 * - `useRefHoverCards(rootRef)`: one controller per region of rendered text.
 *   It listens on the region (event delegation), so links drawn anywhere
 *   inside (a `#123` that InlineMarkdown linked, a pasted PR or MR URL) get a
 *   card with no change to the renderer. It does nothing unless the host
 *   installed a transport (`utils/refCard`), and asks for data only once a
 *   hover or keyboard focus has rested on a link for `REF_CARD_DELAY_MS`.
 *
 * Behaviour: open on hover after the delay, or on keyboard focus (Enter on
 * the link still follows it). Tab from the focused link moves into the card;
 * Shift+Tab from its first control goes back. A press inside the card pins it
 * (it then stays when the pointer leaves, and scrolls); Escape, Close or a
 * press outside close it, focus back on the link when it was in the card.
 * One card at a time. On a touch screen a tap on the link shows the card as a
 * sheet from the bottom edge instead of following it; the sheet's "Open on
 * GitHub" follows it. A host may add its own link beside "Open on GitHub"
 * (`utils/refCardAction`). No keyboard shortcut of its own.
 *
 * Click to pin (`configurePlannotatorUI({ refCardClick })`, `utils/refCardClick`;
 * off by default): on a ref written in prose (the renderer marks it) whose URL
 * is the page itself, a plain click, tap, Enter or Space opens its card pinned
 * instead of following the link, the focus in the card when by the keyboard;
 * a modified or middle click follows it, and so does a click on a ref known to
 * have no card. While a card is pinned, a hover or focus on another ref opens
 * nothing; a click there moves the pin; a second click on the link closes it
 * (a double-click leaves it open). A ref in the card's description opens its
 * card in its place. Every other link (an "Open on GitHub" button, a
 * permalink to a comment) behaves as above.
 *
 * Untrusted text: the body and the comment come from anyone who can write on
 * the repo. They render through `RenderedMarkdown` (DOMPurify on HTML
 * blocks), images are never loaded (drawn as their alt text), and a link
 * inside them does nothing until the person confirms it in the card.
 */

import React, { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  forgeRefLabel,
  type ForgeRef,
  type ForgeRefCardData,
  type ForgeRefCardError,
  type ForgeRefCardResult,
  type ForgeRefChecks,
  type ForgeRefPerson,
} from '@plannotator/core/forge-ref-card';
import { FORGE_SPECS } from '@plannotator/core/forge-refs';
import { cardProblem, refUnsupportedLine } from '@plannotator/core/problem-words';
import { loadRefCard, peekRefCard, refCardKnownMissing, refCardTarget } from '../utils/refCard';
import { refCardActionFor, useRefCardActionVersion, type RefCardActionLink } from '../utils/refCardAction';
import { REF_CARD_PROSE_ATTR, refCardClickOn, refCardClickPins, refUrlIsWhole } from '../utils/refCardClick';
import { ProblemNotice } from './ProblemNotice';
import { providedRefCardLabel, providedRefCardView } from '../utils/refCardProviders';
import { RenderedMarkdown } from './RenderedMarkdown';
import { tooltipContainerOf } from './HostTitle';

/** How long a hover or focus rests on a link before the card opens and its data is asked for. */
export const REF_CARD_DELAY_MS = 400;
/** How long the pointer may be away (link to card, card to link) before an unpinned card closes. */
export const REF_CARD_CLOSE_MS = 250;

const CARD_WIDTH = 400;
const EDGE = 12;
const GAP = 6;
/** The description box's tallest (border box), before it scrolls: about eight lines of a description. */
const BODY_MAX = 216;
/** The same once pinned: the person asked for it, so more of the description shows. */
const BODY_MAX_PINNED = 340;
/** Inside a card the controller drew: a ref link in its description opens that ref's card in its place. */
const OpenRefContext = createContext<((href: string, target: ForgeRef) => void) | null>(null);

const modified = (e: MouseEvent | KeyboardEvent) => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;

// --- words ---

function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const fmt = (n: number) => n.toLocaleString();
const forgeName = (p: ForgeRef['platform']) => FORGE_SPECS[p].name;

/** "Issue", "Pull request", "Merge request". */
export function refKindName(ref: Pick<ForgeRef, 'platform' | 'kind'>): string {
  return ref.kind === 'issue' ? 'Issue' : FORGE_SPECS[ref.platform].pullName;
}

/** Bitbucket has no CLI: Plannotator reads it with an API token, so its failures keep their own lines (`unavailable` also: no answer at all). */
const BITBUCKET_FAILURE_TEXT: Record<ForgeRefCardError, string> = {
  unsupported: 'Details show for Bitbucket Cloud pull requests in the Inbox.',
  cli_missing: "Details couldn't load right now.",
  signed_out: "Plannotator couldn't sign in to Bitbucket. Check its API token setup to see details here.",
  not_found: "Your Bitbucket API token can't see this one, or it doesn't exist.",
  rate_limited: 'Bitbucket asked for a short break. Details come back in a minute.',
  unavailable: "Details couldn't load right now.",
};

type Tone = 'open' | 'merged' | 'closed' | 'neutral';

function stateOf(data: ForgeRefCardData): { label: string; tone: Tone } {
  switch (data.state) {
    case 'open':
      return { label: 'Open', tone: 'open' };
    case 'draft':
      return { label: 'Draft', tone: 'neutral' };
    case 'merged':
      return { label: 'Merged', tone: 'merged' };
    case 'completed':
      return { label: 'Closed', tone: 'merged' };
    case 'not_planned':
      return { label: 'Not planned', tone: 'neutral' };
    default:
      return { label: 'Closed', tone: data.kind === 'pull' ? 'closed' : 'neutral' };
  }
}

// Merged and done read in the palette's primary (violet in Plannotator's own), like the forges' purple.
const TONE_TEXT: Record<Tone, string> = {
  open: 'text-success',
  merged: 'text-primary',
  closed: 'text-destructive',
  neutral: 'text-muted-foreground',
};
const TONE_PILL: Record<Tone, string> = {
  open: 'bg-success/15 text-success',
  merged: 'bg-primary/15 text-primary',
  closed: 'bg-destructive/15 text-destructive',
  neutral: 'bg-muted text-muted-foreground',
};

function StateIcon({ kind, tone, className = '' }: { kind: 'issue' | 'pull'; tone: Tone; className?: string }) {
  const cls = `h-4 w-4 flex-none ${TONE_TEXT[tone]} ${className}`;
  if (kind === 'issue') {
    return (
      <svg viewBox="0 0 16 16" className={cls} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="8" cy="8" r="6.25" />
        {tone === 'merged' ? (
          <path d="M5.5 8.2l1.7 1.7 3.4-3.6" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
        )}
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" className={cls} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="12.5" r="1.6" />
      <path d="M4.5 5.1v5.8" />
      {tone === 'merged' ? <path d="M4.5 5.1c0 3.4 7 2.4 7 5.8" /> : <path d="M11.5 10.9V6.5a2 2 0 00-2-2H7.5m1.4-1.4L7.5 4.5l1.4 1.4" />}
    </svg>
  );
}

function Avatar({ person, size = 18 }: { person: ForgeRefPerson; size?: number }) {
  return person.avatarUrl ? (
    <img src={person.avatarUrl} alt="" width={size} height={size} className="flex-none rounded-full" />
  ) : (
    <span
      aria-hidden="true"
      className="inline-flex flex-none items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground"
      style={{ width: size, height: size }}
    >
      {person.login.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** "All 32 checks passed" / "Pipeline failed · 2 of 12 jobs". */
export function checksText(checks: ForgeRefChecks, platform: ForgeRef['platform']): string {
  if (platform === 'gitlab') {
    const jobs = (n: number) => `${n} job${n === 1 ? '' : 's'}`;
    if (checks.state === 'failure') return `Pipeline failed${checks.total ? ` · ${checks.failed} of ${jobs(checks.total)}` : ''}`;
    if (checks.state === 'pending') return `Pipeline running${checks.total ? ` · ${checks.pending} of ${jobs(checks.total)} left` : ''}`;
    return `Pipeline passed${checks.total ? ` · ${jobs(checks.total)}` : ''}`;
  }
  if (checks.failed > 0) return `${checks.failed} failing${checks.pending ? `, ${checks.pending} running` : ''} · ${checks.passed} passed`;
  if (checks.pending > 0 || checks.state === 'pending') return `${checks.pending} running · ${checks.passed} passed`;
  return `All ${checks.total} check${checks.total === 1 ? '' : 's'} passed`;
}

function ChecksLine({ checks, platform }: { checks: ForgeRefChecks; platform: ForgeRef['platform'] }) {
  const failing = checks.state === 'failure' || checks.failed > 0;
  const pending = !failing && (checks.state === 'pending' || checks.pending > 0);
  const tone = failing ? 'text-destructive' : pending ? 'text-warning' : 'text-success';
  return (
    <span className={`inline-flex items-center gap-1 ${tone}`} data-ref-card-checks={failing ? 'failure' : pending ? 'pending' : 'success'}>
      <span aria-hidden="true">{failing ? '✕' : pending ? '●' : '✓'}</span>
      {checksText(checks, platform)}
    </span>
  );
}

const REVIEW_TEXT = {
  approved: { text: 'Approved', cls: 'text-success' },
  changes_requested: { text: 'Changes requested', cls: 'text-destructive' },
  review_required: { text: 'Review required', cls: 'text-warning' },
} as const;

/** Body markdown with images and links made harmless (the renderer still sanitizes HTML). An empty title: the alt text says it, and no native tooltip shows. */
const NO_IMAGES = () => ({ kind: 'unavailable' as const, title: '' });

/** A local path in an untrusted body never opens anything of the host's (a thread's file, a document). */
const NO_LOCAL_LINKS = () => ({ kind: 'unavailable' as const, title: '' });

const XLINK = 'http://www.w3.org/1999/xlink';
/** Everything in a body that could navigate: HTML and SVG anchors, image-map areas. */
const LINKISH = 'a, area';

function linkHref(el: Element): string | null {
  return el.getAttribute('href') ?? el.getAttributeNS(XLINK, 'href');
}

/** The link an event landed on, `href` still on it or already moved. */
function linkAt(root: Element | null, target: EventTarget | null): Element | null {
  const el = target instanceof Element ? target.closest(LINKISH) : null;
  if (!el || !root?.contains(el)) return null;
  return el.hasAttribute('data-ref-card-href') || linkHref(el) !== null ? el : null;
}

/**
 * Moves every link's `href` to `data-ref-card-href`, so nothing in the body can navigate: not a
 * click, a middle-click, a modified click or the context menu's "Open link". Run after every change
 * to the body's DOM, whoever made it: React, or `HtmlBlock`, which writes raw HTML in a passive
 * effect after this component's layout effects ran.
 */
function neutralizeLinks(root: Element): void {
  for (const a of root.querySelectorAll(LINKISH)) {
    const href = linkHref(a);
    if (href === null) continue;
    a.setAttribute('data-ref-card-href', href);
    a.removeAttribute('href');
    a.removeAttributeNS(XLINK, 'href');
    a.removeAttribute('target');
    a.setAttribute('role', 'link');
    if (a instanceof HTMLElement || a instanceof SVGElement) {
      a.tabIndex = 0;
      a.style.cursor = 'pointer';
    }
  }
}

/** The longest path the confirm shows whole; a longer one keeps its start and end. */
const CONFIRM_PATH_MAX = 48;

/**
 * A link's parts for the confirm row: the host whole (it says where the link really goes, so it is
 * never shortened, however long a lookalike makes it), then the path, cut in the middle when long.
 */
export function confirmUrlParts(url: string): { scheme: string; host: string; path: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { scheme: '', host: url, path: '' };
  }
  const rest = `${u.pathname === '/' && !u.search && !u.hash ? '' : u.pathname}${u.search}${u.hash}`;
  const half = Math.floor((CONFIRM_PATH_MAX - 1) / 2);
  const path = rest.length > CONFIRM_PATH_MAX ? `${rest.slice(0, half)}…${rest.slice(-half)}` : rest;
  return { scheme: `${u.protocol}//`, host: u.host, path };
}

/** The confirm's URL: a screen reader gets it whole; the eye gets the host whole, in the text colour. */
function ConfirmUrl({ url }: { url: string }) {
  const { scheme, host, path } = confirmUrlParts(url);
  return (
    <span className="min-w-0 flex-1 font-mono" data-ref-card-confirm-url="">
      <span className="sr-only">{url}</span>
      <span aria-hidden="true" className="[overflow-wrap:anywhere]">
        <span className="text-muted-foreground">{scheme}</span>
        <span className="font-semibold text-foreground" data-ref-card-confirm-host="">
          {host}
        </span>
        <span className="text-muted-foreground" data-ref-card-confirm-path="">
          {path}
        </span>
      </span>
    </span>
  );
}

/**
 * Links in the body carry no `href` once drawn. A click with any button or modifier, or Enter, on
 * one only offers "Open · Cancel" with its full URL; the Open there is the one real link. The
 * listeners are native and in the capture phase on the body, so they run before any listener the
 * renderer put on a link, and they catch a link whose `href` is still on it.
 */
function SafeMarkdown({ markdown }: { markdown: string }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const openRefHere = useContext(OpenRefContext);
  const openRef = useRef(openRefHere);
  openRef.current = openRefHere;
  // Every render (React's own links), and on every later DOM change (raw HTML lands after this).
  useLayoutEffect(() => {
    if (bodyRef.current) neutralizeLinks(bodyRef.current);
  });
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const ask = (e: Event) => {
      const a = linkAt(body, e.target);
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'mousedown') return;
      const href = a.getAttribute('data-ref-card-href') ?? linkHref(a) ?? '';
      const https = /^https?:\/\//i.test(href);
      // A plain click or Enter on a ref written in the description (utils/refCardClick) opens its card here; anything
      // else, or any other link, asks first.
      const plain = (e.type === 'click' && (e as MouseEvent).button === 0) || e.type === 'keydown';
      const prose = refCardClickOn() && a.hasAttribute(REF_CARD_PROSE_ATTR) && refUrlIsWhole(href);
      const ref = plain && https && prose && openRef.current && !modified(e as MouseEvent | KeyboardEvent) ? refCardTarget(href) : null;
      if (ref) {
        setConfirm(null);
        openRef.current?.(href, ref);
        return;
      }
      setConfirm(https ? href : null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') ask(e);
    };
    const onMouseDown = (e: MouseEvent) => {
      // The middle button's autoscroll and open-in-tab start on the press.
      if (e.button === 1) ask(e);
    };
    body.addEventListener('click', ask, true);
    body.addEventListener('auxclick', ask, true);
    body.addEventListener('mousedown', onMouseDown, true);
    body.addEventListener('keydown', onKey, true);
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => neutralizeLinks(body));
    observer?.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    return () => {
      body.removeEventListener('click', ask, true);
      body.removeEventListener('auxclick', ask, true);
      body.removeEventListener('mousedown', onMouseDown, true);
      body.removeEventListener('keydown', onKey, true);
      observer?.disconnect();
    };
  }, []);
  return (
    <div
      // `!`: a host may rescale the renderer's fixed sizes in a later cascade layer (the Inbox's text size does).
      className="text-[12.5px] leading-[1.55] text-foreground [overflow-wrap:anywhere] [&_h1]:my-1.5! [&_h1]:text-[13px]! [&_h1]:font-semibold [&_h2]:my-1.5! [&_h2]:text-[13px]! [&_h2]:font-semibold [&_h3]:my-1! [&_h3]:text-[12.5px]! [&_h3]:font-semibold [&_p]:my-1! [&_p]:text-[12.5px]! [&_p]:leading-[1.55]! [&_.text-sm]:text-[12.5px]! [&_pre]:text-[11.5px]! [&_.my-5]:my-2! [&_ul]:my-1! [&_li]:my-0! [&>:first-child]:mt-0!"
    >
      <div
        ref={bodyRef}
      >
        <RenderedMarkdown markdown={markdown} softLineBreaks resolveImage={NO_IMAGES} resolveLocalLink={NO_LOCAL_LINKS} />
      </div>
      {confirm ? (
        <div className="mt-1.5 flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2 py-1.5 text-[11.5px]" role="group" aria-label="Open this link?" data-ref-card-confirm="">
          <ConfirmUrl url={confirm} />
          <a href={confirm} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-primary hover:underline" onClick={() => setConfirm(null)}>
            Open
          </a>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setConfirm(null)}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

// --- the card ---

export interface RefCardViewProps {
  target: ForgeRef;
  href: string;
  /** undefined: still loading. null: no answer. */
  result: ForgeRefCardResult | null | undefined;
  pinned?: boolean;
  onClose?: () => void;
  /** The sheet on a touch screen (the body takes the height, larger targets). */
  sheet?: boolean;
  /**
   * Too little room for the whole card (a short window): the header and the description scroll
   * together, so the description never shrinks to a line, and the footer (Open on GitHub) stays.
   */
  tight?: boolean;
  /** The host's own link, left of "Open on GitHub" (`utils/refCardAction`). */
  action?: RefCardActionLink | null;
}

/** The comment count, longest first: with "· pinned", without it, then the icon and the number (the words said, unseen). */
function commentForms(comments: number, pinned: boolean): { key: string; node: React.ReactNode }[] {
  const words = `${comments} comment${comments === 1 ? '' : 's'}`;
  const full = (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden="true">💬</span> {words}
    </span>
  );
  return [
    ...(pinned
      ? [
          {
            key: 'pinned',
            node: (
              <span className="inline-flex items-center gap-1">
                <span aria-hidden="true">💬</span> {words}
                <span className="ml-1.5 text-muted-foreground/80">· pinned</span>
              </span>
            ),
          },
        ]
      : []),
    { key: 'full', node: full },
    {
      key: 'short',
      node: (
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true">💬 {comments}</span>
          <span className="sr-only">{words}</span>
        </span>
      ),
    },
  ];
}

/**
 * The footer's words, whole: the first of `forms` (longest first) that fits the room the buttons leave, else the
 * last. Never cut. Each form is measured in a clipped zero-size box, so the measuring adds no room to the footer.
 */
function FootWords({ forms, line }: { forms: { key: string; node: React.ReactNode }[]; line?: boolean }) {
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [pick, setPick] = useState(0);
  const keys = forms.map((f) => f.key).join('|');
  useLayoutEffect(() => {
    const box = boxRef.current;
    const measure = measureRef.current;
    if (!box || !measure) return;
    const fit = () => {
      const room = box.clientWidth;
      const widths = Array.from(measure.children, (c) => (c as HTMLElement).offsetWidth);
      const first = widths.findIndex((w) => w <= room);
      setPick(first === -1 ? widths.length - 1 : first);
    };
    fit();
    // The words' widths change once the page's fonts load (the box's own size may not).
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) fit();
    });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(box);
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [keys]);
  const shown = forms[Math.min(pick, forms.length - 1)];
  return (
    <span
      ref={boxRef}
      // `line`: a line of its own (the sheet), as wide as the footer; else the room beside the buttons.
      className={`relative overflow-hidden whitespace-nowrap ${line ? 'block w-full' : 'min-w-0 flex-1'}`}
      data-ref-card-count="" data-ref-card-count-form={shown?.key}>
      {shown?.node}
      <span aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 h-0 w-0 overflow-hidden">
        <span ref={measureRef} className="flex w-max flex-col">
          {forms.map((f) => (
            <span key={f.key} className="block w-max whitespace-nowrap">
              {f.node}
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}

/**
 * The sheet's button row, right-aligned. Short of room (a narrow phone with a long forge name), Close shows as its
 * icon (×), named "Close" for a screen reader, until the row has room for the word again.
 */
function SheetRow({ children }: { children: (closeIcon: boolean) => React.ReactNode }) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [closeIcon, setCloseIcon] = useState(false);
  /** The row's width with the word: the room it needs before the word comes back. */
  const needed = useRef(0);
  const icon = useRef(false);
  icon.current = closeIcon;
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    // The buttons' widths and gaps: right-aligned, a row too wide spills to the left, which scrollWidth never counts.
    const width = () => {
      const kids = Array.from(row.children) as HTMLElement[];
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      return kids.reduce((sum, k) => sum + k.getBoundingClientRect().width, 0) + gap * Math.max(0, kids.length - 1);
    };
    const fit = () => {
      if (!icon.current) {
        const need = width();
        if (need > row.clientWidth + 0.5) {
          needed.current = need;
          setCloseIcon(true);
        }
      } else if (row.clientWidth + 0.5 >= needed.current) setCloseIcon(false);
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(row);
    for (const child of Array.from(row.children)) observer.observe(child);
    return () => observer.disconnect();
  });
  return (
    <div ref={rowRef} className="flex items-center justify-end gap-2 max-[379px]:gap-1" data-ref-card-row="">
      {children(closeIcon)}
    </div>
  );
}

export function RefCardView({ target, href, result, pinned, onClose, sheet, tight, action }: RefCardViewProps) {
  // A provider's own card (utils/refCardProviders.ts).
  const Provided = providedRefCardView(target);
  if (Provided) return <Provided target={target} href={href} result={result} pinned={pinned} onClose={onClose} sheet={sheet} tight={tight} />;
  const repoName = `${target.owner}/${target.repo}`;
  const forge = forgeName(target.platform);
  // A narrow phone: less padding, never a shorter word.
  const btn = sheet ? 'min-h-11 px-3 max-[379px]:px-2' : 'h-7 px-2.5';
  const buttons = (closeIcon: boolean) => (
    <>
      {onClose && (pinned || sheet) ? (
        <button
          type="button"
          onClick={onClose}
          className={`${btn} relative inline-flex flex-none items-center justify-center whitespace-nowrap rounded-md hover:bg-muted hover:text-foreground`}
          data-ref-card-close=""
          data-ref-card-close-icon={closeIcon ? '' : undefined}
        >
          {closeIcon ? (
            <>
              <span aria-hidden="true" className="text-[15px] leading-none">×</span>
              <span className="sr-only">Close</span>
            </>
          ) : (
            'Close'
          )}
        </button>
      ) : null}
      {action ? (
        <button
          type="button"
          onClick={action.open}
          // Never shorter than its words: short of room the comment count gives way (FootWords).
          className={`${btn} inline-flex flex-none items-center whitespace-nowrap rounded-md bg-muted/60 font-medium text-foreground hover:bg-muted`}
          data-ref-card-action=""
        >
          {action.label}
        </button>
      ) : null}
      <a
        href={result?.ok ? result.data.url : href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${btn} inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-md bg-primary/10 font-medium text-primary hover:bg-primary/15`}
        data-ref-card-open=""
      >
        Open on {forge} <span aria-hidden="true">↗</span>
      </a>
    </>
  );
  // The sheet: the comment count on its own line, the buttons in one row under it. Elsewhere: one row.
  const footer = (words?: { key: string; node: React.ReactNode }[]) =>
    sheet ? (
      <div className="flex flex-none flex-col gap-1.5 border-t border-border px-3.5 py-2 text-[11.5px] text-muted-foreground max-[379px]:px-3" data-ref-card-foot="">
        {words ? <FootWords forms={words} line /> : null}
        <SheetRow>{buttons}</SheetRow>
      </div>
    ) : (
      <div className="flex flex-none items-center gap-2 border-t border-border px-3.5 py-2 text-[11.5px] text-muted-foreground" data-ref-card-foot="">
        {words ? <FootWords forms={words} /> : <span className="min-w-0 flex-1" />}
        {buttons(false)}
      </div>
    );

  if (result === undefined) {
    return (
      <div aria-busy="true" data-ref-card-loading="">
        <div className="px-3.5 pb-3 pt-3">
          <div className="text-[11.5px] text-muted-foreground">
            {repoName} · {forgeRefLabel(target)}
          </div>
          <div className="mt-2 h-4 w-4/5 animate-pulse rounded bg-muted" />
          <div className="mt-2 h-3 w-2/5 animate-pulse rounded bg-muted" />
          <div className="mt-3 h-3 w-full animate-pulse rounded bg-muted/70" />
          <div className="mt-1.5 h-3 w-11/12 animate-pulse rounded bg-muted/70" />
        </div>
        {footer()}
      </div>
    );
  }

  if (!result || !result.ok) {
    const error = result && 'error' in result ? result.error : 'unavailable';
    // The tool's state in the one table's words (problem-words.ts): the same lines the Inbox's PR card and Pull
    // requests page say. No answer at all (the route failed) claims nothing about the tool: a neutral line.
    const problem = result ? cardProblem(result, target) : null;
    return (
      <div>
        <div className="px-3.5 pt-3">
          <div className="text-[11.5px] text-muted-foreground">{repoName}</div>
          <div className="mt-1 text-[13.5px] font-semibold text-foreground">
            {refKindName(target)} {forgeRefLabel(target)}
          </div>
        </div>
        {problem ? (
          <div className="-mt-1" data-ref-card-error={error}>
            <ProblemNotice problem={problem} touch={sheet} linked={href} />
          </div>
        ) : (
          <p className="px-3.5 pb-3 pt-1.5 text-[12px] leading-relaxed text-muted-foreground" data-ref-card-error={error}>
            {!result || target.platform === 'bitbucket' ? BITBUCKET_FAILURE_TEXT[error] : refUnsupportedLine(target.platform === 'gitlab' ? 'glab' : 'gh')}
          </p>
        )}
        {footer()}
      </div>
    );
  }

  const d = result.data;
  const state = stateOf(d);
  const ref = { platform: d.platform, kind: d.kind, number: d.number };
  const p = d.pull;
  // One element scrolls: the description (its own height capped), or, when tight, the header and the description together.
  const together = !!tight && !sheet;
  const scroller = { 'data-ref-card-scroll': '', tabIndex: 0 };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={together ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain' : 'flex min-h-0 flex-1 flex-col'}
        {...(together ? { ...scroller, 'aria-label': `${refKindName(ref)} details` } : {})}
      >
        <div className="flex-none px-3.5 pt-3" data-ref-card-head="">
          <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <span className="truncate">{d.repo || repoName}</span>
            <span aria-hidden="true">·</span>
            <span className="flex-none">opened {timeAgo(d.createdAt)}</span>
          </div>
          <div className="mt-1.5 flex items-start gap-2">
            <StateIcon kind={d.kind} tone={state.tone} className="mt-[3px]" />
            <div className="min-w-0 flex-1 text-[14px] font-semibold leading-snug text-foreground [overflow-wrap:anywhere]" data-ref-card-title="">
              {d.title} <span className="font-normal text-muted-foreground">{forgeRefLabel(ref)}</span>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
            <span className={`rounded-full px-2 py-[1px] text-[11px] font-semibold ${TONE_PILL[state.tone]}`} data-ref-card-state={d.state}>
              {state.label}
            </span>
            {d.author ? (
              <span className="inline-flex items-center gap-1">
                <Avatar person={d.author} size={16} />
                {d.author.login}
              </span>
            ) : null}
            {d.closedAt && d.state !== 'open' && d.state !== 'draft' ? (
              <span>
                {d.state === 'merged' ? 'merged' : 'closed'} {timeAgo(d.closedAt)}
              </span>
            ) : (
              <span>updated {timeAgo(d.updatedAt)}</span>
            )}
          </div>
          {p ? (
            <div className="mt-2 space-y-1 text-[11.5px]">
              {p.base || p.head ? (
                <div className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" data-ref-card-branch="">
                  {p.base} ← {p.head}
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>
                  <span className="text-success">+{fmt(p.additions)}</span> <span className="text-destructive">−{fmt(p.deletions)}</span>
                  <span className="text-muted-foreground">
                    {' '}
                    · {fmt(p.files)} file{p.files === 1 ? '' : 's'}
                  </span>
                </span>
                {p.checks ? <ChecksLine checks={p.checks} platform={d.platform} /> : null}
                {p.review ? (
                  <span className={REVIEW_TEXT[p.review].cls} data-ref-card-review={p.review}>
                    {REVIEW_TEXT[p.review].text}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
          {d.labels.length > 0 || d.assignees.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {d.labels.map((l) => (
                <span key={l.name} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border px-1.5 py-[1px] text-[10.5px] text-foreground">
                  <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full" style={{ background: `#${l.color}` }} />
                  <span className="truncate">{l.name}</span>
                </span>
              ))}
              {d.assignees.length > 0 ? (
                <span className="ml-auto inline-flex items-center gap-1" role="img" aria-label={`Assigned to ${d.assignees.map((a) => a.login).join(', ')}`}>
                  {d.assignees.map((a) => (
                    <Avatar key={a.login} person={a} size={16} />
                  ))}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div
          className={`mt-2.5 border-t border-border px-3.5 py-2.5 ${together ? '' : 'min-h-0 flex-1 overflow-y-auto overscroll-contain'}`}
          style={sheet || together ? undefined : { maxHeight: pinned ? BODY_MAX_PINNED : BODY_MAX }}
          data-ref-card-body=""
          {...(together ? {} : { ...scroller, 'aria-label': `${refKindName(ref)} description` })}
        >
          {d.body.trim() ? <SafeMarkdown markdown={d.body} /> : <p className="text-[12px] italic text-muted-foreground">No description.</p>}
          {d.bodyCut ? <p className="mt-1 text-[11px] text-muted-foreground">The rest is on {forge}.</p> : null}
          {d.linked.length > 0 ? (
            <div className="mt-2.5 space-y-1">
              <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">{d.kind === 'pull' ? 'Closes' : 'Closed by'}</div>
              {d.linked.map((l) => (
                <div key={l.number} className="flex items-center gap-1.5 text-[12px]">
                  <StateIcon kind={d.kind === 'pull' ? 'issue' : 'pull'} tone={l.state === 'open' ? 'open' : l.state === 'merged' || d.kind === 'pull' ? 'merged' : 'closed'} />
                  <span className="min-w-0 truncate">{l.title}</span>
                  <span className="flex-none text-muted-foreground">#{l.number}</span>
                </div>
              ))}
            </div>
          ) : null}
          {d.lastComment ? (
            <div className="mt-2.5 rounded-md border border-border bg-muted/30 px-2.5 py-2" data-ref-card-comment="">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {d.lastComment.author ? <Avatar person={d.lastComment.author} size={14} /> : null}
                <span className="font-medium text-foreground">{d.lastComment.author?.login ?? 'someone'}</span>
                <span>commented {timeAgo(d.lastComment.at)}</span>
                <span className="ml-auto">latest</span>
              </div>
              <SafeMarkdown markdown={d.lastComment.body} />
            </div>
          ) : null}
        </div>
      </div>
      {footer(commentForms(d.comments, !!pinned && !sheet))}
    </div>
  );
}

// --- the controller ---

interface OpenCard {
  anchor: HTMLAnchorElement;
  href: string;
  target: ForgeRef;
  /** `click`: a click, Enter or Space on the link (or a ref link in a card's description); `tap`: the sheet. */
  via: 'hover' | 'focus' | 'tap' | 'click';
  pinned: boolean;
  result: ForgeRefCardResult | null | undefined;
}

/**
 * The card open anywhere on the page: it closes when another opens. With click to pin on (`utils/refCardClick`),
 * while it is pinned a hover or a focus elsewhere opens nothing; a click on another ref moves it there.
 */
let shownCard: { close: () => void; pinned: () => boolean } | null = null;
const pinnedShown = () => refCardClickOn() && !!shownCard?.pinned();

function touchOnly(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(hover: none)').matches;
}

function firstControl(card: HTMLElement | null): HTMLElement | null {
  return card?.querySelector<HTMLElement>('a[href], button, [tabindex="0"]') ?? null;
}

/**
 * The card's height with nothing squeezed (the header, the description up to its cap, the footer)
 * and the description's part of it. Measured from the parts, so it reads the same whether the card
 * is tight or not (a tight card's description is uncapped, and its scroller clips the rest).
 */
function naturalHeight(card: HTMLElement, pinned: boolean): { natural: number; body: number } {
  const head = card.querySelector<HTMLElement>('[data-ref-card-head]');
  const body = card.querySelector<HTMLElement>('[data-ref-card-body]');
  const foot = card.querySelector<HTMLElement>('[data-ref-card-foot]');
  if (!head || !body || !foot) return { natural: card.scrollHeight, body: 0 };
  const cs = getComputedStyle(body);
  const bodyHeight = Math.min(body.scrollHeight + (parseFloat(cs.borderTopWidth) || 0), pinned ? BODY_MAX_PINNED : BODY_MAX);
  return {
    natural: head.offsetHeight + (parseFloat(cs.marginTop) || 0) + bodyHeight + foot.offsetHeight + (card.offsetHeight - card.clientHeight),
    body: bodyHeight,
  };
}

function place(anchor: Element, card: HTMLElement, pinned: boolean): Pos {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(CARD_WIDTH, vw - EDGE * 2);
  const left = Math.min(Math.max(EDGE, r.left), vw - width - EDGE);
  const below = vh - r.bottom - GAP - EDGE;
  const above = r.top - GAP - EDGE;
  const { natural, body } = naturalHeight(card, pinned);
  const downward = below >= Math.min(natural, 320) || below >= above;
  const maxHeight = Math.max(160, Math.min(520, downward ? below : above));
  const height = Math.min(natural, maxHeight);
  // Tight: the room left for the description is less than it shows unpinned (a pinned card that only
  // lost some of its extra room keeps its header still, and its description scrolls as before).
  const roomForBody = maxHeight - (natural - body);
  const tight = natural > maxHeight + 1 && roomForBody < Math.min(body, BODY_MAX) - 1;
  return { left, top: downward ? r.bottom + GAP : r.top - GAP - height, maxHeight, tight };
}

interface Pos {
  left: number;
  top: number;
  maxHeight: number;
  /** Too little room for the card's description: see `RefCardViewProps.tight`. */
  tight: boolean;
}

/**
 * Hover cards for the issue / PR / MR links inside `rootRef`. Render what it
 * returns anywhere in the tree (it portals). Nothing happens without a transport.
 *
 * `onlyWithData` (default false): a hover opens the card only once its data
 * arrived and only when the forge answered (`ok`), with no loading state and
 * no failure card; a hover that leaves first shows nothing, and a tap on a
 * link a click does not pin follows it (no sheet). For hosts where a person
 * without gh / glab must see links work as before (plan review, annotate and
 * code review). With click to pin on, a click on a ref known to have no card
 * follows the link at once; one whose answer has not come yet shows the
 * loading card, whose Open on GitHub is the link, then the answer.
 */
export function useRefHoverCards(
  rootRef: React.RefObject<HTMLElement | null>,
  { delayMs = REF_CARD_DELAY_MS, onlyWithData = false }: { delayMs?: number; onlyWithData?: boolean } = {},
): React.ReactNode {
  const [card, setCard] = useState<OpenCard | null>(null);
  /** onlyWithData: the link a card is being fetched for (cleared when the hover or focus leaves it). */
  const wanted = useRef<HTMLAnchorElement | null>(null);
  const dataOnly = useRef(onlyWithData);
  dataOnly.current = onlyWithData;
  const [pos, setPos] = useState<Pos | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const current = useRef<OpenCard | null>(null);
  current.current = card;
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const lastPointer = useRef('mouse');
  /** Each open, pin and close: an answer for an older one is dropped. */
  const seq = useRef(0);
  /** The focus goes into the card once it draws (a pin by the keyboard, or a ref in the description replaced it while the focus was in it). */
  const refocus = useRef(false);
  const cardId = useId();
  // The host's link ("Open in Reviews") is asked again when the host says its answer changed.
  useRefCardActionVersion();

  const clearTimers = () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  };

  const close = useCallback((restoreFocus = false) => {
    clearTimers();
    seq.current++;
    const was = current.current;
    if (!was) return;
    const focusWasInside = !!cardRef.current?.contains(document.activeElement);
    setCard(null);
    if (restoreFocus && (focusWasInside || was.via === 'tap' || was.via === 'click')) was.anchor.focus({ preventScroll: true });
  }, []);
  // One object for the hook's life (`close` never changes), so `shownCard` can tell this card from another's.
  const self = useRef({ close: () => close(), pinned: () => !!current.current?.pinned });
  const claim = () => {
    if (shownCard && shownCard !== self.current) shownCard.close();
    shownCard = self.current;
  };

  const open = useCallback((anchor: HTMLAnchorElement, target: ForgeRef, via: OpenCard['via']) => {
    // A hover or a focus never replaces a pinned card (a tap does: the person asked for this one).
    const passing = via === 'hover' || via === 'focus';
    if (passing && pinnedShown()) return;
    clearTimers();
    seq.current++;
    if (dataOnly.current) {
      // Nothing on screen until the forge answered; then only if the hover or focus is still on the link.
      wanted.current = anchor;
      const href = anchor.href;
      void loadRefCard(href, target).then((result) => {
        if (wanted.current !== anchor) return;
        wanted.current = null;
        if (!result?.ok || !anchor.isConnected || pinnedShown()) return;
        claim();
        setCard({ anchor, href, target, via, pinned: false, result });
      });
      return;
    }
    claim();
    const href = anchor.href;
    setCard({ anchor, href, target, via, pinned: via === 'tap', result: undefined });
    void loadRefCard(href, target).then((result) => {
      setCard((c) => (c && c.anchor === anchor && c.href === href ? { ...c, result } : c));
    });
  }, []);

  /**
   * A click's card: pinned at once, anchored to `anchor`, for `href` (the link's own, or a ref in the card's
   * description, which replaces the card). With no answer yet it draws loading, its Open on GitHub the link itself,
   * so the click is never a dead one; then the answer, or the quiet failure with the same link.
   */
  const pin = useCallback((anchor: HTMLAnchorElement, href: string, target: ForgeRef, via: OpenCard['via'], keyboard: boolean) => {
    clearTimers();
    wanted.current = null;
    const mine = ++seq.current;
    if (keyboard) refocus.current = true;
    claim();
    const known = peekRefCard(target);
    setCard({ anchor, href, target, via, pinned: true, result: known });
    if (known !== undefined) return;
    void loadRefCard(href, target).then((result) => {
      if (seq.current !== mine) return;
      setCard((c) => (c && c.anchor === anchor && c.href === href ? { ...c, result } : c));
    });
  }, []);

  /**
   * A plain click, Enter or Space on a ref a click opens (`refCardClickPins`). True: it is the card's (the caller
   * stops the link); false: the link does what it always did.
   */
  const activate = useCallback(
    (anchor: HTMLAnchorElement, target: ForgeRef, tap: boolean, keyboard: boolean, clicks: number): boolean => {
      const c = current.current;
      const mine = !!c && c.anchor === anchor && c.href === anchor.href;
      // A double-click's second click leaves the card it opened.
      if (mine && c!.pinned && clicks >= 2) return true;
      // Known to have no card (no gh / glab, signed out, offline, a forge this computer does not read, a ref the forge
      // does not know): the link opens at once, as it always did.
      if (refCardKnownMissing(target)) {
        if (mine) close();
        return false;
      }
      if (mine) {
        // Its card is open: a hover's or focus's is pinned; a pinned one closes.
        if (c!.pinned) close(true);
        else {
          clearTimers();
          if (keyboard) refocus.current = true;
          setCard({ ...c!, pinned: true, via: c!.via === 'hover' ? 'click' : c!.via });
        }
        return true;
      }
      pin(anchor, anchor.href, target, tap ? 'tap' : 'click', keyboard);
      return true;
    },
    [close, pin],
  );

  const openInCard = useCallback(
    (href: string, target: ForgeRef) => {
      const c = current.current;
      if (!c) return;
      const focusInside = !!cardRef.current?.contains(document.activeElement);
      pin(c.anchor, href, target, c.via === 'hover' ? 'click' : c.via, focusInside);
    },
    [pin],
  );

  const scheduleClose = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      if (!current.current?.pinned) close();
    }, REF_CARD_CLOSE_MS);
  }, [close]);

  // Delegated listeners on the region.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const linkOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLAnchorElement>('a[href]') : null);
    const targetOf = (a: HTMLAnchorElement | null) => (a && root.contains(a) ? refCardTarget(a.href) : null);
    const later = (fn: () => void) => {
      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
      openTimer.current = window.setTimeout(fn, delayMs);
    };
    const onPointerDown = (e: PointerEvent) => {
      lastPointer.current = e.pointerType;
      // A press on a ref a click opens: its answer is asked now, so the click it ends in more often knows it (a ref
      // with no card then follows its link at once).
      const a = linkOf(e.target);
      const target = a && e.button === 0 && refCardClickPins(a) ? targetOf(a) : null;
      if (a && target) void loadRefCard(a.href, target);
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || touchOnly()) return;
      const a = linkOf(e.target);
      const target = targetOf(a);
      if (!a || !target) return;
      if (current.current?.anchor === a) {
        if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
        return;
      }
      if (pinnedShown()) return;
      later(() => open(a, target, 'hover'));
    };
    const onOut = (e: PointerEvent) => {
      const a = linkOf(e.target);
      if (!a || (e.relatedTarget instanceof Node && a.contains(e.relatedTarget))) return;
      if (wanted.current === a) wanted.current = null;
      if (openTimer.current !== null && current.current?.anchor !== a) {
        window.clearTimeout(openTimer.current);
        openTimer.current = null;
      }
      if (current.current?.anchor === a && !(e.relatedTarget instanceof Node && cardRef.current?.contains(e.relatedTarget))) scheduleClose();
    };
    const onFocusIn = (e: FocusEvent) => {
      const a = linkOf(e.target);
      const target = targetOf(a);
      if (!a || !target || !a.matches(':focus-visible') || current.current?.anchor === a || pinnedShown()) return;
      later(() => open(a, target, 'focus'));
    };
    const onFocusOut = (e: FocusEvent) => {
      const a = linkOf(e.target);
      if (!a) return;
      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
      if (wanted.current === a) wanted.current = null;
      const c = current.current;
      const next = e.relatedTarget;
      if (c?.anchor === a && c.via === 'focus' && !c.pinned && !(next instanceof Node && cardRef.current?.contains(next))) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ' && !modified(e) && !e.defaultPrevented) {
        // Space on a ref a click opens opens its card as a click does (Enter clicks the link itself).
        const a = linkOf(e.target);
        const target = a && a === e.target && refCardClickPins(a) ? targetOf(a) : null;
        if (!a || !target) return;
        // A held Space repeats: the first press opened the card, the rest neither close it nor scroll.
        if (e.repeat) {
          if (current.current?.anchor === a) e.preventDefault();
          return;
        }
        if (activate(a, target, false, true, 1)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      const c = current.current;
      if (!c || e.target !== c.anchor || e.key !== 'Tab' || e.shiftKey) return;
      const first = firstControl(cardRef.current);
      if (!first) return;
      e.preventDefault();
      setCard((x) => (x ? { ...x, pinned: true } : x));
      first.focus();
    };
    const onClick = (e: MouseEvent) => {
      const a = linkOf(e.target);
      // A modified or middle click opens the link as a link (a new tab, a window).
      if (!a || e.defaultPrevented || e.button !== 0 || modified(e)) return;
      const target = targetOf(a);
      if (!target) return;
      const touch = lastPointer.current === 'touch' || touchOnly();
      if (!refCardClickPins(a)) {
        // Any other link (an "Open on GitHub" button, a comment's permalink, a host with click to pin off): as it
        // always was. A tap on a touch screen shows the sheet, except where cards show only with data.
        if (dataOnly.current || !touch) return;
        e.preventDefault();
        e.stopPropagation();
        open(a, target, 'tap');
        return;
      }
      // `detail` 0: Enter on the link (the keyboard), never the sheet.
      const keyboard = e.detail === 0;
      if (!activate(a, target, !keyboard && touch, keyboard, e.detail)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    root.addEventListener('pointerdown', onPointerDown, true);
    root.addEventListener('pointerover', onOver);
    root.addEventListener('pointerout', onOut);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('keydown', onKey);
    root.addEventListener('click', onClick, true);
    return () => {
      root.removeEventListener('pointerdown', onPointerDown, true);
      root.removeEventListener('pointerover', onOver);
      root.removeEventListener('pointerout', onOut);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      root.removeEventListener('keydown', onKey);
      root.removeEventListener('click', onClick, true);
      clearTimers();
    };
  }, [rootRef, delayMs, open, close, scheduleClose, activate]);

  // A ref a click opens says it has a card, open or not, and which (the renderer sets `aria-haspopup` and
  // `aria-expanded` false where it knew; a transport installed later is caught up here).
  useEffect(() => {
    const a = card?.anchor;
    if (!a || !refCardClickPins(a)) return;
    a.setAttribute('aria-haspopup', 'dialog');
    a.setAttribute('aria-expanded', 'true');
    a.setAttribute('aria-controls', cardId);
    return () => {
      a.setAttribute('aria-expanded', 'false');
      a.removeAttribute('aria-controls');
    };
  }, [card?.anchor, cardId]);

  const reposition = useCallback(() => {
    const c = current.current;
    if (!c || !cardRef.current || c.via === 'tap') return;
    setPos(place(c.anchor, cardRef.current, c.pinned));
  }, []);

  // While open: Escape, a press outside, scrolling and resizing.
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Used: the window's own Escape (closing a thread) skips it.
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (cardRef.current?.contains(t) || card.anchor.contains(t)) return;
      // The sheet's scrim closes on its click: closing on pointer-down would let the tap land on what is under it.
      if (t instanceof Element && t.closest('[data-ref-card-scrim]')) return;
      close();
    };
    const onScroll = (e: Event) => {
      if (card.via === 'tap' || cardRef.current?.contains(e.target as Node)) return;
      if (!current.current?.pinned) close();
      else reposition();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', reposition);
    };
  }, [card, close, reposition]);

  useEffect(
    () => () => {
      if (shownCard === self.current) shownCard = null;
    },
    [],
  );

  useLayoutEffect(() => {
    if (!card) setPos(null);
    else reposition();
  }, [card?.anchor, card?.href, card?.result, card?.pinned, reposition]);

  // A pin by the keyboard, or a ref in the description replaced the card with the focus in it: the focus goes into
  // the card (and stays there until its answer drew).
  useLayoutEffect(() => {
    if (!refocus.current) return;
    if (!card) {
      refocus.current = false;
      return;
    }
    if (!cardRef.current?.contains(document.activeElement)) firstControl(cardRef.current)?.focus({ preventScroll: true });
    if (card.result !== undefined) refocus.current = false;
  }, [card]);

  if (!card || typeof document === 'undefined') return null;
  const container = tooltipContainerOf(card.anchor) ?? document.body;
  const sheet = card.via === 'tap';
  const action = refCardActionFor(card.target, card.result);
  const provided = providedRefCardLabel(card.target);
  const label = card.result?.ok
    ? `${provided ?? `${refKindName(card.result.data)} ${forgeRefLabel(card.result.data)}`}: ${card.result.data.title}`
    : (provided ?? `${refKindName(card.target)} ${forgeRefLabel(card.target)}`);
  const surface = 'border border-border bg-popover text-popover-foreground shadow-2xl';
  const body = (
    <div
      ref={cardRef}
      id={cardId}
      role="dialog"
      aria-label={label}
      aria-modal={sheet ? true : undefined}
      data-ref-card=""
      data-ref-card-pinned={card.pinned ? '' : undefined}
      data-ref-card-sheet={sheet ? '' : undefined}
      data-ref-card-tight={!sheet && pos?.tight ? '' : undefined}
      onPointerEnter={() => {
        if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'touch' && !card.pinned) scheduleClose();
      }}
      onPointerDown={() => {
        if (!card.pinned) setCard((c) => (c ? { ...c, pinned: true } : c));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Tab' && e.shiftKey && document.activeElement === firstControl(cardRef.current)) {
          e.preventDefault();
          card.anchor.focus();
        }
      }}
      className={
        sheet
          ? `fixed inset-x-0 bottom-0 z-[120] flex max-h-[78vh] flex-col overflow-hidden rounded-t-[12px] pb-[env(safe-area-inset-bottom)] ${surface}`
          : `fixed z-[120] flex flex-col overflow-hidden rounded-xl ${surface} ${card.pinned ? 'ring-1 ring-primary/30' : ''}`
      }
      style={
        sheet
          ? undefined
          : { width: Math.min(CARD_WIDTH, window.innerWidth - EDGE * 2), left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxHeight: pos?.maxHeight ?? 520 }
      }
    >
      {sheet ? <div aria-hidden="true" className="mx-auto mt-2 h-1 w-9 flex-none rounded-full bg-muted-foreground/30" /> : null}
      <OpenRefContext.Provider value={openInCard}>
        <RefCardView
          target={card.target}
          href={card.href}
          result={card.result}
          pinned={card.pinned}
          sheet={sheet}
          tight={!sheet && !!pos?.tight}
          onClose={() => close(true)}
          action={
            action && {
              label: action.label,
              open: () => {
                // Asked again now: the list may have changed since the card drew. Gone from it, the forge's page opens.
                const now = refCardActionFor(card.target, card.result);
                close();
                if (now) now.open();
                else window.open(card.result?.ok ? card.result.data.url : card.href, '_blank', 'noopener,noreferrer');
              },
            }
          }
        />
      </OpenRefContext.Provider>
    </div>
  );
  return createPortal(
    sheet ? (
      <>
        <div className="fixed inset-0 z-[119] bg-black/30" data-ref-card-scrim="" onClick={() => close(true)} />
        {body}
      </>
    ) : (
      body
    ),
    container,
  );
}

/**
 * `useRefHoverCards` as a component: render it inside the region `rootRef`
 * points at, so its listeners attach once that element exists (a host whose
 * root is not on screen at its first render, behind a loading state).
 */
export function RefHoverCards({
  rootRef,
  delayMs,
  onlyWithData,
}: {
  rootRef: React.RefObject<HTMLElement | null>;
  delayMs?: number;
  onlyWithData?: boolean;
}): React.ReactElement {
  return <>{useRefHoverCards(rootRef, { delayMs, onlyWithData })}</>;
}

// The card's parts, for a provider's own card (utils/refCardProviders.ts).
export { Avatar as RefCardAvatar, SafeMarkdown as RefCardMarkdown, StateIcon as RefCardStateIcon, timeAgo as refCardTimeAgo };
