import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ElementType,
  type ReactNode,
  type Ref,
} from "react";

import { cn } from "../lib/utils";
import { CARD_MOTIONS, cardDurationMs } from "./motions";

export type CardKind = "document" | "page" | "image" | "data";
export type CardSize = "large" | "regular";

/**
 * A picture face: drawn as a lazy `<img>`, fitted inside its panel (`contain`, the default) or filling it
 * (`cover`). The face is hidden from assistive tech, so it takes no alt.
 */
export interface CardImageFace {
  readonly src: string;
  readonly fit?: "contain" | "cover";
  readonly alt?: never;
}

export interface CardLinkProps {
  readonly href: string;
  readonly className?: string;
  readonly title?: string;
  readonly "aria-label"?: string;
  readonly children?: ReactNode;
}

/** What a card and a row share: the link, the grey line, unread, pinned and the host's action. */
interface CardCommonProps {
  readonly kind: CardKind;
  readonly title: string;
  readonly href: string;
  /** The host's router link; it receives `href`, `className`, `title`, `aria-label` and `children`. Default `<a>`. */
  readonly linkComponent?: ElementType<CardLinkProps>;
  /** The grey line, for example "Your move"; without it the line is the date from `time`. */
  readonly fact?: string;
  /** A 14 px mark before `fact`, for example the agent's icon. */
  readonly factMark?: ReactNode;
  /** `action` draws `fact` in the accent colour, for a fact that asks the viewer to act ("Your move"). Default grey. */
  readonly factTone?: "default" | "action";
  /** The mark breathes while the agent works. */
  readonly working?: boolean;
  readonly unread?: boolean;
  /** When it last changed: a `Date` or an ISO string. The card formats it, and puts the full date and time in a tooltip. */
  readonly time?: Date | string;
  /**
   * The host's own control (for example a pin button), beside the link and never inside it: top right of the
   * card's preview, the right end of a row. Shown on hover and keyboard focus; on a card also while `pinned` and
   * always on touch; on a row on touch as its `CardRows`' `actionAtRest` says.
   */
  readonly action?: ReactNode;
  /** Visual state only: keeps `action` shown and adds "pinned" to the spoken name. The host owns the click. */
  readonly pinned?: boolean;
}

export interface CardProps extends CardCommonProps {
  /** What the preview shows; leave it out (or null) for the designed empty face, a dashed sheet. */
  readonly face?: ReactNode | CardImageFace;
  readonly size: CardSize;
  /** Plays `settle` once: the card comes to rest and its unread dot appears. */
  readonly settle?: boolean;
  /** `view-transition-name` for the preview, so it can grow into the page it opens (`open`). */
  readonly transitionName?: string;
}

export interface CardRowProps extends CardCommonProps {
  /** A second, quieter text after the title, for example the project; spoken after the title, hidden on a phone. */
  readonly secondary?: string;
  /** A small picture for the 36×27 thumbnail, drawn inside the kind's sheet, window or panel; without it, the kind's glyph. */
  readonly thumb?: ReactNode | CardImageFace;
  /** Nothing to show yet, for example a plan with no version: the thumbnail is the empty face in small, on the neutral ground, as on a card with no face. */
  readonly empty?: boolean;
}

/**
 * The width every face is laid out at, in CSS pixels, before it is scaled to fit its sheet, window or panel.
 * A caller sizes its face for this width.
 */
export const CARD_FACE_WIDTH = 420;

/** A first guess at a card's width, used only until the card has been measured. */
const CARD_WIDTH_GUESS: Record<CardSize, number> = { large: 350, regular: 256 };

/** How far ahead of the screen a face mounts, and how far past it a face is let go again. */
const NEAR_SCREEN_MARGIN = "240px";
const FAR_FROM_SCREEN_MARGIN = "1200px";

function isImageFace(face: unknown): face is CardImageFace {
  return (
    typeof face === "object" &&
    face !== null &&
    !Array.isArray(face) &&
    !isValidElement(face) &&
    typeof (face as { src?: unknown }).src === "string"
  );
}

function present(node: unknown): boolean {
  return node !== null && node !== undefined && node !== false;
}

function asDate(time: Date | string | undefined): Date | null {
  if (time === undefined) return null;
  const date = time instanceof Date ? time : new Date(time);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Nov 15", with the year when it is not this year. */
export function cardDateWords(date: Date, now: Date = new Date()): string {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

function cardDateTitle(date: Date): string {
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * The spoken name of a card or row: the title, a row's `secondary`, the grey line, then "new" when unread and
 * "pinned" when pinned.
 */
export function cardName(
  title: string,
  line: string | null,
  unread: boolean,
  pinned = false,
  secondary: string | null = null,
): string {
  return [title, secondary, line, unread ? "new" : null, pinned ? "pinned" : null]
    .filter((part): part is string => part !== null && part !== "")
    .join(", ");
}

function scrollingAncestor(element: Element): Element | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const { overflowY, overflowX } = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(`${overflowY} ${overflowX}`)) return node;
  }
  return null;
}

/**
 * True while the element is near the screen: it turns true 240 px before the element scrolls into view and
 * false again once it is far past, measured in the nearest scrolling ancestor (else the viewport).
 */
function useNearScreen<T extends Element>(ref: { readonly current: T | null }, enabled = true): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (!enabled || element === null || typeof IntersectionObserver === "undefined") return;
    const root = scrollingAncestor(element);
    const enter = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { root, rootMargin: NEAR_SCREEN_MARGIN },
    );
    const leave = new IntersectionObserver(
      (entries) => {
        if (entries.every((entry) => !entry.isIntersecting)) setNear(false);
      },
      { root, rootMargin: FAR_FROM_SCREEN_MARGIN },
    );
    enter.observe(element);
    leave.observe(element);
    return () => {
      enter.disconnect();
      leave.disconnect();
    };
  }, [ref, enabled]);
  return near;
}

/** The share of the well's width that each kind's content box takes (the sheet, the window, the panel). */
const CARD_BOX_SHARE: Record<CardKind, number> = { document: 0.8, page: 0.84, image: 0.84, data: 0.84 };

function useFaceScale(ref: { readonly current: HTMLElement | null }, faceWidth: number) {
  useLayoutEffect(() => {
    const stage = ref.current;
    const box = stage?.parentElement ?? null;
    if (stage === null || box === null || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      const width = box.clientWidth;
      if (width > 0) stage.style.setProperty("--frame-card-scale", String(width / faceWidth));
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(box);
    return () => observer.disconnect();
  }, [ref, faceWidth]);
}

/** The face, laid out at its kind's page width and scaled to fit the content box it sits in. */
function Stage({ kind, wellWidth, children }: { readonly kind: CardKind; readonly wellWidth: number; readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const faceWidth = CARD_FACE_WIDTH;
  useFaceScale(ref, faceWidth);
  return (
    <div
      ref={ref}
      data-frame-card-stage=""
      className="absolute left-0 top-0 h-[calc(100%/var(--frame-card-scale))] origin-top-left [transform:scale(var(--frame-card-scale))]"
      style={{ width: faceWidth, "--frame-card-scale": String((wellWidth * CARD_BOX_SHARE[kind]) / faceWidth) } as CSSProperties}
    >
      {children}
    </div>
  );
}

function useBreatheInPhase(ref: { readonly current: HTMLElement | null }, working: boolean) {
  useLayoutEffect(() => {
    const mark = ref.current;
    if (!working || mark === null) return;
    const duration = cardDurationMs(getComputedStyle(mark).animationDuration, 4800);
    const now = typeof document.timeline?.currentTime === "number" ? document.timeline.currentTime : performance.now();
    if (duration > 0) mark.style.animationDelay = `-${Math.round(now % duration)}ms`;
    return () => {
      mark.style.animationDelay = "";
    };
  }, [ref, working]);
}

function Blank() {
  return (
    <>
      <i className="absolute left-[12%] right-[30%] top-[24%] h-0.5 bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)]" />
      <i className="absolute left-[12%] right-[12%] top-[40%] h-px bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)]" />
      <i className="absolute left-[12%] right-[24%] top-[52%] h-px bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)]" />
    </>
  );
}

function LazyImage({ src, fit = "contain", onReady }: { readonly src: string; readonly fit?: "contain" | "cover"; readonly onReady: () => void }) {
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      data-frame-card-fit={fit}
      onLoad={onReady}
      onError={onReady}
      className={cn("block size-full", fit === "cover" ? "object-cover object-top" : "object-contain")}
    />
  );
}

/** The kind's chrome: a sheet for a document, a window with three dots for a page, a panel for an image or data. */
function Chrome({ kind, blank = false, children }: { readonly kind: CardKind; readonly blank?: boolean; readonly children?: ReactNode }) {
  if (kind === "page") {
    return (
      <div data-frame-card-hero="" data-frame-card-window="" data-frame-card-blank={blank ? "" : undefined} className="frame-card-window">
        <div data-frame-card-window-bar="" className="frame-card-window-bar">
          <i />
          <i />
          <i />
        </div>
        <div className="frame-card-window-body">{children}</div>
      </div>
    );
  }
  if (kind === "document") {
    return (
      <div data-frame-card-hero="" data-frame-card-sheet="" data-frame-card-blank={blank ? "" : undefined} className="frame-card-sheet">
        {children}
      </div>
    );
  }
  return (
    <div
      data-frame-card-hero=""
      data-frame-card-panel={kind}
      data-frame-card-blank={blank ? "" : undefined}
      className={cn("frame-card-panel", kind === "data" && "frame-card-panel-rows")}
    >
      {children}
    </div>
  );
}

/**
 * The preview well: 4:3 on the kind's ground, one sheet behind a document,
 * and the face inside the kind's chrome. The face mounts near the screen and
 * is let go far from it; the well keeps its size either way.
 */
function Well({
  kind,
  face,
  size,
  transitionName,
}: {
  readonly kind: CardKind;
  readonly face: ReactNode | CardImageFace;
  readonly size: CardSize;
  readonly transitionName?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearScreen(ref);
  const [imageReady, setImageReady] = useState(false);
  const image = isImageFace(face);
  const state: "loading" | "empty" | "ready" = !present(face) ? "empty" : near ? "ready" : "loading";
  const faceState = state === "ready" && image && !imageReady ? "loading" : state;
  const style = transitionName === undefined ? undefined : ({ viewTransitionName: transitionName } as CSSProperties);
  const content =
    state === "empty" ? (
      <Blank />
    ) : state === "loading" ? null : isImageFace(face) ? (
      <LazyImage src={face.src} fit={face.fit} onReady={() => setImageReady(true)} />
    ) : (
      <Stage kind={kind} wellWidth={CARD_WIDTH_GUESS[size]}>
        {face}
      </Stage>
    );
  return (
    <div
      ref={ref}
      data-frame-card-well=""
      data-frame-card-kind={kind}
      data-frame-card-face={faceState}
      data-frame-card-transition={transitionName === undefined ? undefined : ""}
      inert
      aria-hidden="true"
      style={style}
      className={cn("relative aspect-[4/3] shrink-0 overflow-hidden", transitionName !== undefined && CARD_MOTIONS.open)}
    >
      {kind === "document" && <div data-frame-card-back="" className={cn("frame-card-sheet", CARD_MOTIONS.fan)} />}
      {(state !== "loading" || kind === "document") && (
        <div className={cn("contents", faceState === "loading" && state === "ready" && "[&_[data-frame-card-hero]>*]:invisible")}>
          <Chrome kind={kind} blank={state === "empty"}>
            {content}
          </Chrome>
        </div>
      )}
    </div>
  );
}

/** The kind's small glyph, drawn with a few lines; never a face scaled down. */
function Glyph({ kind }: { readonly kind: CardKind }) {
  const line = "absolute left-[18%] h-px bg-[var(--frame-ink-3)]";
  if (kind === "document") {
    return (
      <>
        <i className={cn(line, "right-[34%] top-[26%]")} />
        <i className={cn(line, "right-[18%] top-[48%]")} />
        <i className={cn(line, "right-[28%] top-[70%]")} />
      </>
    );
  }
  if (kind === "page") {
    return (
      <>
        <i className="absolute left-[14%] top-[22%] h-[30%] w-[38%] rounded-[1px] bg-[var(--frame-ink-3)]" />
        <i className={cn(line, "left-[60%] right-[14%] top-[30%]")} />
        <i className={cn(line, "left-[60%] right-[22%] top-[50%]")} />
      </>
    );
  }
  if (kind === "image") {
    return <i className="absolute inset-x-[22%] bottom-[22%] top-[30%] rounded-[1px] bg-[var(--frame-ink-3)] [clip-path:polygon(0_100%,38%_30%,62%_70%,78%_45%,100%_100%)]" />;
  }
  return (
    <>
      <i className="absolute inset-x-0 top-[34%] h-px bg-[var(--frame-ink-3)]" />
      <i className="absolute inset-x-0 top-[62%] h-px bg-[var(--frame-ink-3)]" />
      <i className="absolute inset-y-0 left-[40%] w-px bg-[var(--frame-ink-3)]" />
    </>
  );
}

/** A row's 36×27 thumbnail: the kind's chrome on its ground, holding the host's `thumb` or else the kind's glyph. */
function Thumb({ kind, thumb, empty = false }: { readonly kind: CardKind; readonly thumb?: ReactNode | CardImageFace; readonly empty?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const own = !empty && present(thumb);
  const near = useNearScreen(ref, own);
  const [imageReady, setImageReady] = useState(false);
  const content = empty ? (
    <Blank />
  ) : !own ? (
    <Glyph kind={kind} />
  ) : !near ? null : isImageFace(thumb) ? (
    <span className={cn("block size-full", !imageReady && "invisible")}>
      <LazyImage src={thumb.src} fit={thumb.fit} onReady={() => setImageReady(true)} />
    </span>
  ) : (
    thumb
  );
  return (
    <div
      ref={ref}
      data-frame-card-well=""
      data-frame-card-thumb={empty ? "empty" : own ? "picture" : "glyph"}
      data-frame-card-kind={kind}
      data-frame-card-face={empty ? "empty" : own ? (near ? "ready" : "loading") : "ready"}
      inert
      aria-hidden="true"
      className="relative h-[27px] w-9 shrink-0 overflow-hidden rounded-[5px]"
    >
      <Chrome kind={kind} blank={empty}>
        {content}
      </Chrome>
    </div>
  );
}

function GreyLine({
  fact,
  factMark,
  factTone = "default",
  working,
  date,
}: {
  readonly fact?: string;
  readonly factMark?: ReactNode;
  readonly factTone?: "default" | "action";
  readonly working: boolean;
  readonly date: Date | null;
}) {
  const markRef = useRef<HTMLSpanElement>(null);
  const marked = present(factMark) && fact !== undefined;
  useBreatheInPhase(markRef, working && marked);
  if (fact === undefined && date === null) return null;
  const action = fact !== undefined && factTone === "action";
  return (
    <span
      data-frame-card-line=""
      data-frame-card-fact-tone={action ? "action" : undefined}
      aria-hidden="true"
      className={cn(
        "flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[13px] leading-[18px]",
        action ? "text-primary" : "text-muted-foreground",
      )}
    >
      {marked && (
        <span
          ref={markRef}
          data-frame-card-mark=""
          data-frame-card-working={working ? "" : undefined}
          className={cn(
            "grid size-3.5 shrink-0 place-items-center [&_img]:size-[13px] [&_svg]:size-[13px]",
            working && CARD_MOTIONS.breathe,
          )}
        >
          {factMark}
        </span>
      )}
      {fact === undefined && date !== null ? (
        <time dateTime={date.toISOString()} className="truncate">
          {cardDateWords(date)}
        </time>
      ) : (
        <span className="truncate">{fact}</span>
      )}
    </span>
  );
}

/** A pinned row's resting mark, after its title: a plain pin. */
function PinnedMark() {
  return (
    <svg data-frame-card-pinned-mark="" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className="ml-1.5 shrink-0 text-muted-foreground">
      <path d="M6 2h4l-.5 4 2.5 2.5V10H4V8.5L6.5 6 6 2Zm2 8v4" fill="currentColor" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function Dot() {
  return <span data-frame-card-dot="" aria-hidden="true" className="mr-[7px] inline-block size-[7px] shrink-0 rounded-full bg-primary align-[1px]" />;
}

/**
 * One plan, document or page as a card: a preview well and, under it, the
 * title (up to two lines) and one grey line. The card fills its column; the
 * whole card is one link, and the host's `action` sits beside it, never inside.
 */
export function Card({
  kind,
  face = null,
  title,
  href,
  linkComponent,
  fact,
  factMark,
  factTone,
  working = false,
  unread = false,
  size,
  time,
  settle = false,
  transitionName,
  action,
  pinned = false,
}: CardProps) {
  const Link: ElementType<CardLinkProps> = linkComponent ?? "a";
  const date = asDate(time);
  const line = fact ?? (date === null ? null : cardDateWords(date));
  return (
    <div
      data-frame-card=""
      data-frame-card-kind={kind}
      data-frame-card-size={size}
      data-frame-card-unread={unread ? "" : undefined}
      data-frame-card-pinned={pinned ? "" : undefined}
      data-frame-card-settle={settle ? "" : undefined}
      className={cn("relative flex h-full w-full min-w-0 flex-col overflow-hidden rounded-[12px] bg-card", settle && CARD_MOTIONS.settle)}
    >
      <Well kind={kind} face={face} size={size} transitionName={transitionName} />
      <div className="flex min-w-0 flex-col gap-0.5 px-3.5 pb-[13px] pt-[11px]">
        <Link
          href={href}
          title={date === null ? undefined : cardDateTitle(date)}
          aria-label={cardName(title, line, unread, pinned)}
          className="outline-none before:absolute before:inset-0 before:z-10 before:rounded-[12px] before:content-['']"
        >
          <span data-frame-card-title="" dir="auto">
            {unread && <Dot />}
            {title}
          </span>
        </Link>
        <GreyLine fact={fact} factMark={factMark} factTone={factTone} working={working} date={date} />
      </div>
      {present(action) && (
        <div data-frame-card-action="" className="absolute right-2 top-2 z-20 flex items-center gap-1">
          {action}
        </div>
      )}
    </div>
  );
}

/**
 * The same plan as one list row: a 36×27 thumbnail, the title on one line, an
 * optional quieter `secondary`, and the grey line at the right. 44 px tall
 * (52 on a phone), filled on hover and focus only. One link, named like the card.
 */
export function CardRow({
  kind,
  thumb,
  title,
  href,
  linkComponent,
  fact,
  factMark,
  factTone,
  working = false,
  unread = false,
  time,
  secondary,
  action,
  pinned = false,
  empty = false,
}: CardRowProps) {
  const Link: ElementType<CardLinkProps> = linkComponent ?? "a";
  const date = asDate(time);
  const line = fact ?? (date === null ? null : cardDateWords(date));
  return (
    <div
      data-frame-card-row=""
      data-frame-card-kind={kind}
      data-frame-card-unread={unread ? "" : undefined}
      data-frame-card-pinned={pinned ? "" : undefined}
      data-frame-card-columns={`${secondary === undefined ? "" : "secondary "}${present(action) ? "action" : ""}`.trim() || undefined}
      className="relative grid min-w-0 items-center gap-x-3.5 rounded-[8px] pl-1.5 pr-2.5"
    >
      <Thumb kind={kind} thumb={thumb} empty={empty} />
      <Link
        href={href}
        title={date === null ? undefined : cardDateTitle(date)}
        aria-label={cardName(title, line, unread, pinned, secondary ?? null)}
        className="flex min-w-0 items-center outline-none before:absolute before:inset-0 before:z-10 before:rounded-[8px] before:content-['']"
      >
        {unread && <Dot />}
        <span data-frame-card-title="" dir="auto">
          {title}
        </span>
        {pinned && <PinnedMark />}
      </Link>
      {secondary !== undefined && (
        <span data-frame-card-secondary="" aria-hidden="true" className="truncate text-[13px] text-muted-foreground">
          {secondary}
        </span>
      )}
      <span data-frame-card-end="" className="flex min-w-0 items-center justify-end">
        <span data-frame-card-trail="" className="relative flex min-w-0 items-center">
          <GreyLine fact={fact} factMark={factMark} factTone={factTone} working={working} date={date} />
          {present(action) && (
            <span data-frame-card-action="" className="z-20 flex items-center justify-end">
              {action}
            </span>
          )}
        </span>
      </span>
    </div>
  );
}

/** True when a heading is the card's title: the same text, ignoring case and spacing. */
export function cardHeadingIsTitle(heading: string, title: string): boolean {
  const plain = (text: string) => text.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const said = plain(heading);
  return said !== "" && said === plain(title);
}

const SKIPPED = "data-frame-card-title-repeat";

/**
 * A document face: rendered Markdown at the sheet's type. When the first
 * heading is the card's title (the same text, ignoring case and spacing),
 * which the card already shows, the face starts at the first paragraph
 * instead; it never opens on a bare list, so a heading that a list follows
 * directly stays.
 */
export function CardFaceDocument({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (root === null) return;
    const apply = () => {
      const skip = new Set<HTMLElement>();
      const first = root.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6");
      if (first !== null && cardHeadingIsTitle(first.textContent ?? "", title)) {
        const before: HTMLElement[] = [first];
        let next = first.nextElementSibling as HTMLElement | null;
        while (next !== null && next.matches("h1, h2, h3, h4, h5, h6, hr")) {
          before.push(next);
          next = next.nextElementSibling as HTMLElement | null;
        }
        if (next === null || !next.matches("ul, ol")) for (const element of before) skip.add(element);
      }
      for (const element of root.querySelectorAll<HTMLElement>(`[${SKIPPED}]`)) {
        if (skip.has(element)) continue;
        element.removeAttribute(SKIPPED);
        element.hidden = false;
      }
      for (const element of skip) {
        if (element.hasAttribute(SKIPPED)) continue;
        element.setAttribute(SKIPPED, "");
        element.hidden = true;
      }
    };
    apply();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(apply);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [title]);
  return (
    <div ref={ref} data-frame-card-document="" className="frame-card-document">
      {children}
    </div>
  );
}


const GridColumns = createContext<number | null>(null);

const CARD_GRID_ROW_GAP: Record<CardSize, number> = { large: 28, regular: 44 };

/**
 * A list of `CardRow`s. No row keeps room for its action: every fact or date
 * ends at the row's edge, and a row's action shows just before it on hover or
 * keyboard focus, where the text before it always keeps 20 px clear. `actionAtRest` says what a screen without hover shows at
 * rest: `"touch"` (the default) shows each row's action, so touch can reach
 * it; `"never"` shows none, for a host that gives touch another way in, such
 * as a long-press menu, and pinned rows then keep the card's pin.
 */
export function CardRows({
  children,
  label,
  actionAtRest = "touch",
  ref,
  ...rest
}: Omit<ComponentPropsWithoutRef<"ul">, "children" | "aria-label" | "dangerouslySetInnerHTML"> & {
  readonly children: ReactNode;
  readonly label?: string;
  readonly actionAtRest?: "touch" | "never";
  readonly ref?: Ref<HTMLUListElement>;
}) {
  return (
    <ul {...rest} ref={ref} aria-label={label} data-frame-card-rows="" data-frame-card-action-rest={actionAtRest}>
      {Children.map(children, (child) => (present(child) ? <li className="min-w-0">{child}</li> : null))}
    </ul>
  );
}

/**
 * Cards of one size in fluid columns: each card fills its column. `large`
 * gives three across a 1440 px layout's content column, `regular` four;
 * columns have a minimum width, so they wrap, and a phone shows one.
 */
export function CardGrid({
  children,
  size,
  gap = CARD_GRID_ROW_GAP[size],
  label,
  ref,
}: {
  readonly children: ReactNode;
  readonly size: CardSize;
  /** The space between rows of cards, in CSS pixels. Default 28 for large cards and 44 for regular ones; a group on its own passes 24. */
  readonly gap?: number;
  readonly label?: string;
  readonly ref?: Ref<HTMLUListElement>;
}) {
  return (
    <ul ref={ref} aria-label={label} data-frame-card-grid={size} style={{ rowGap: gap }}>
      {Children.map(children, (child) => (present(child) ? <li className="flex min-w-0">{child}</li> : null))}
    </ul>
  );
}

/**
 * A named group of regular cards, its name over a hairline. Inside
 * `CardGroups` it takes as many of the shared columns as it has cards (up
 * to a full row), so every card lines up whatever its group.
 */
export function CardGroup({
  label,
  children,
  gap = 24,
}: {
  readonly label: string;
  readonly children: ReactNode;
  /** The space between its rows of cards, in CSS pixels. Default 24. */
  readonly gap?: number;
}) {
  const columns = useContext(GridColumns);
  const count = Children.toArray(children).filter(present).length;
  const shared = columns !== null;
  return (
    <section
      data-frame-card-group={shared ? "shared" : "alone"}
      aria-label={label}
      style={shared ? { gridColumn: `span ${Math.max(1, Math.min(count, columns))}` } : undefined}
    >
      <h3 className="flex h-[30px] items-center pb-2 text-[13px] font-medium leading-5 text-muted-foreground shadow-[inset_0_-1px_0_var(--frame-divider)]">
        {label}
      </h3>
      {shared ? (
        <ul data-frame-card-grid="group" style={{ rowGap: gap }}>
          {Children.map(children, (child) => (present(child) ? <li className="flex min-w-0">{child}</li> : null))}
        </ul>
      ) : (
        <CardGrid size="regular" gap={gap}>
          {children}
        </CardGrid>
      )}
    </section>
  );
}

/** Groups of regular cards on one shared grid of columns, 44 px between rows. */
export function CardGroups({ children }: { readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(4);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const style = getComputedStyle(element);
      const narrow = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches;
      const least = Number.parseFloat(style.getPropertyValue("--frame-card-column-min")) || 230;
      const gap = Number.parseFloat(style.columnGap) || 0;
      const width = element.clientWidth;
      if (width > 0) setColumns(narrow ? 1 : Math.max(1, Math.floor((width + gap) / (least + gap))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} data-frame-card-groups="">
      <GridColumns.Provider value={columns}>{children}</GridColumns.Provider>
    </div>
  );
}
