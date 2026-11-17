import {
  Children,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
  type ReactNode,
  type Ref,
} from "react";

import { cn } from "../lib/utils";
import { CARD_MOTIONS, cardDurationMs } from "./motions";

export type CardKind = "document" | "page" | "image" | "data";
export type CardSize = "large" | "regular";

/** A picture face: drawn as a lazy `<img>`. The face is hidden from assistive tech, so it takes no alt. */
export interface CardImageFace {
  readonly src: string;
  readonly alt?: never;
}

export interface CardLinkProps {
  readonly href: string;
  readonly className?: string;
  readonly "aria-label"?: string;
  readonly children?: ReactNode;
}

/** What a card and a row share: the link, the grey line, unread, pinned and the host's action. */
interface CardCommonProps {
  readonly kind: CardKind;
  /** What the preview shows; leave it out (or null) for the designed empty face. */
  readonly face?: ReactNode | CardImageFace;
  readonly title: string;
  readonly href: string;
  /** The host's router link; it receives `href`, `className`, `aria-label` and `children`. Default `<a>`. */
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
  readonly time?: Date | string;
  /**
   * The host's own control (for example a pin button), beside the link and never inside it: top right of the
   * card's preview, the right end of a row. Shown on hover and focus, always on touch and while `pinned`.
   */
  readonly action?: ReactNode;
  /** Visual state only: keeps `action` shown and adds "pinned" to the spoken name. The host owns the click. */
  readonly pinned?: boolean;
}

export interface CardProps extends CardCommonProps {
  readonly size: CardSize;
  /** Plays `settle` once: the card comes to rest and its unread dot appears. */
  readonly settle?: boolean;
  /** `view-transition-name` for the preview, so it can grow into the page it opens (`open`). */
  readonly transitionName?: string;
}

export interface CardRowProps extends CardCommonProps {
  /** A second, quieter text after the title, for example the project; hidden on a phone. */
  readonly secondary?: string;
  /** The 36×27 thumbnail; without it the face is drawn small. */
  readonly thumb?: ReactNode | CardImageFace;
}

/** The width each kind's face is laid out at (the page is 4:3), before it is scaled to the card. */
export const CARD_FACE_WIDTH: Record<CardKind, number> = { document: 420, page: 400, image: 320, data: 400 };

/** The card's width per size, in CSS pixels; on a phone a card fills its column. */
export const CARD_WIDTH: Record<CardSize, number> = { large: 352, regular: 256 };

const ROW_THUMB_WIDTH = 36;

const NEAR_SCREEN_MARGIN = "240px";

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

/** The spoken name of a card or row: the title, the grey line, then "new" when unread and "pinned" when pinned. */
export function cardName(title: string, line: string | null, unread: boolean, pinned = false): string {
  return [title, line, unread ? "new" : null, pinned ? "pinned" : null]
    .filter((part): part is string => part !== null && part !== "")
    .join(", ");
}

function useNearScreen<T extends Element>(ref: { readonly current: T | null }): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near) return;
    const element = ref.current;
    if (element === null) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: NEAR_SCREEN_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, ref]);
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
  const faceWidth = CARD_FACE_WIDTH[kind];
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

function LazyImage({ src, onReady }: { readonly src: string; readonly onReady: () => void }) {
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={onReady}
      onError={onReady}
      className="block size-full object-cover object-top"
    />
  );
}

function FaceFrame({
  kind,
  state,
  face,
  wellWidth,
  onImageReady,
}: {
  readonly kind: CardKind;
  readonly state: "loading" | "empty" | "ready";
  readonly face: ReactNode | CardImageFace;
  readonly wellWidth: number;
  readonly onImageReady: () => void;
}) {
  const content =
    state !== "ready" ? (
      state === "empty" ? <Blank /> : null
    ) : isImageFace(face) ? (
      <LazyImage src={face.src} onReady={onImageReady} />
    ) : (
      <Stage kind={kind} wellWidth={wellWidth}>
        {face}
      </Stage>
    );
  const blank = state === "empty";
  if (kind === "page") {
    return (
      <div data-frame-card-hero="" data-frame-card-window="" data-frame-card-blank={blank ? "" : undefined} className="frame-card-window">
        <div data-frame-card-window-bar="" className="frame-card-window-bar">
          <i />
          <i />
          <i />
        </div>
        <div className="frame-card-window-body">{content}</div>
      </div>
    );
  }
  if (kind === "document") {
    return (
      <div data-frame-card-hero="" data-frame-card-sheet="" data-frame-card-blank={blank ? "" : undefined} className="frame-card-sheet">
        {content}
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
      {content}
    </div>
  );
}

/**
 * The preview well. A card's well is 4:3 with one sheet behind a document; a
 * row's thumbnail is 36×27 and draws `thumb` as given, else the face, small.
 */
function Well({
  kind,
  face,
  thumb,
  width,
  compact = false,
  transitionName,
}: {
  readonly kind: CardKind;
  readonly face: ReactNode | CardImageFace;
  readonly thumb?: ReactNode | CardImageFace;
  readonly width: number;
  readonly compact?: boolean;
  readonly transitionName?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearScreen(ref);
  const [imageReady, setImageReady] = useState(false);
  const row = compact;
  const ownThumb = row && present(thumb);
  const shown = ownThumb ? thumb : face;
  const image = isImageFace(shown);
  const state: "loading" | "empty" | "ready" = !present(shown) ? "empty" : near ? "ready" : "loading";
  const faceState = state === "ready" && image && !imageReady ? "loading" : state;
  const style = transitionName === undefined ? undefined : ({ viewTransitionName: transitionName } as CSSProperties);
  return (
    <div
      ref={ref}
      data-frame-card-well=""
      data-frame-card-thumb={row ? "" : undefined}
      data-frame-card-kind={kind}
      data-frame-card-face={faceState}
      inert
      aria-hidden="true"
      style={style}
      className={cn(
        "relative shrink-0 overflow-hidden",
        row ? "h-[27px] w-9 rounded-[5px]" : "aspect-[4/3]",
        transitionName !== undefined && CARD_MOTIONS.open,
      )}
    >
      {ownThumb ? (
        state === "ready" &&
        (isImageFace(thumb) ? (
          <span className={cn("block size-full", !imageReady && "invisible")}>
            <LazyImage src={thumb.src} onReady={() => setImageReady(true)} />
          </span>
        ) : (
          thumb
        ))
      ) : (
        <>
          {kind === "document" && !row && <div data-frame-card-back="" className={cn("frame-card-sheet", CARD_MOTIONS.fan)} />}
          {(state !== "loading" || (kind === "document" && !row)) && (
            <div className={cn("contents", state === "ready" && image && !imageReady && "[&_[data-frame-card-hero]>*]:invisible")}>
              <FaceFrame kind={kind} state={state} face={face} wellWidth={width} onImageReady={() => setImageReady(true)} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GreyLine({
  fact,
  factMark,
  factTone = "default",
  working,
  date,
  className,
}: {
  readonly fact?: string;
  readonly factMark?: ReactNode;
  readonly factTone?: "default" | "action";
  readonly working: boolean;
  readonly date: Date | null;
  readonly className?: string;
}) {
  const markRef = useRef<HTMLSpanElement>(null);
  const marked = present(factMark) && fact !== undefined;
  useBreatheInPhase(markRef, working && marked);
  if (fact === undefined && date === null) return null;
  return (
    <span
      data-frame-card-line=""
      data-frame-card-fact-tone={fact !== undefined && factTone === "action" ? "action" : undefined}
      aria-hidden="true"
      title={date === null ? undefined : cardDateTitle(date)}
      className={cn(
        "flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[13px] leading-[18px]",
        fact !== undefined && factTone === "action" ? "text-primary" : "text-muted-foreground",
        className,
      )}
    >
      {marked && (
        <span
          ref={markRef}
          data-frame-card-mark=""
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

function Dot() {
  return (
    <span
      data-frame-card-dot=""
      aria-hidden="true"
      className="mr-[7px] inline-block size-[7px] shrink-0 rounded-full bg-primary align-[1px]"
    />
  );
}

/**
 * One plan, document or page as a card: a preview well and, under it, the
 * title (up to two lines) and one grey line. The whole card is one link; the
 * host's `action` sits beside it, never inside.
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
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden rounded-[12px] bg-card max-sm:w-full",
        size === "large" ? "w-88" : "w-64",
        settle && CARD_MOTIONS.settle,
      )}
    >
      <Well kind={kind} face={face} width={CARD_WIDTH[size]} transitionName={transitionName} />
      <div className="flex min-w-0 flex-col gap-0.5 px-3.5 pb-[13px] pt-[11px]">
        <Link
          href={href}
          aria-label={cardName(title, line, unread, pinned)}
          className="outline-none before:absolute before:inset-0 before:z-10 before:rounded-[12px] before:content-['']"
        >
          <span
            data-frame-card-title=""
            className={cn(
              "line-clamp-2 break-words font-medium text-foreground",
              size === "large" ? "text-[15px] leading-[22px]" : "text-[14px] leading-5",
            )}
          >
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
  face = null,
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
}: CardRowProps) {
  const hasAction = present(action);
  const Link: ElementType<CardLinkProps> = linkComponent ?? "a";
  const date = asDate(time);
  const line = fact ?? (date === null ? null : cardDateWords(date));
  return (
    <div
      data-frame-card-row=""
      data-frame-card-kind={kind}
      data-frame-card-unread={unread ? "" : undefined}
      data-frame-card-pinned={pinned ? "" : undefined}
      className={cn(
        "relative grid h-11 min-w-0 items-center gap-x-3.5 rounded-[8px] pl-1.5 pr-2.5 max-sm:h-13",
        hasAction
          ? secondary === undefined
            ? "grid-cols-[36px_minmax(0,1fr)_180px_28px]"
            : "grid-cols-[36px_minmax(0,1fr)_160px_180px_28px]"
          : secondary === undefined
            ? "grid-cols-[36px_minmax(0,1fr)_180px]"
            : "grid-cols-[36px_minmax(0,1fr)_160px_180px]",
        hasAction ? "max-sm:grid-cols-[36px_minmax(0,1fr)_auto_28px]" : "max-sm:grid-cols-[36px_minmax(0,1fr)_auto]",
      )}
    >
      <Well kind={kind} face={face} thumb={thumb} width={ROW_THUMB_WIDTH} compact />
      <Link
        href={href}
        aria-label={cardName(title, line, unread, pinned)}
        className="flex min-w-0 items-center outline-none before:absolute before:inset-0 before:z-10 before:rounded-[8px] before:content-['']"
      >
        {unread && <Dot />}
        <span data-frame-card-title="" className="truncate text-[14px] leading-5 text-foreground">
          {title}
        </span>
      </Link>
      {secondary !== undefined && (
        <span data-frame-card-secondary="" aria-hidden="true" className="truncate text-[13px] text-frame-muted-fg max-sm:hidden">
          {secondary}
        </span>
      )}
      <span className="flex min-w-0 justify-end">
        <GreyLine fact={fact} factMark={factMark} factTone={factTone} working={working} date={date} className="justify-end" />
      </span>
      {hasAction && (
        <span data-frame-card-action="" className="relative z-20 flex items-center justify-end">
          {action}
        </span>
      )}
    </div>
  );
}

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word !== "");
}

/** True when a heading says the same as the card's title: equal, one the start of the other, or nearly all its words. */
export function cardHeadingRestatesTitle(heading: string, title: string): boolean {
  const said = wordsOf(heading);
  const wanted = wordsOf(title);
  if (said.length === 0 || wanted.length === 0) return false;
  const a = said.join(" ");
  const b = wanted.join(" ");
  if (a === b || b.startsWith(`${a} `) || a.startsWith(`${b} `)) return true;
  if (said.length < 2) return false;
  const inTitle = new Set(wanted);
  return said.filter((word) => inTitle.has(word)).length / said.length >= 0.8;
}

const SKIPPED = "data-frame-card-title-repeat";

/**
 * A document face: rendered Markdown at the sheet's type. When the first
 * heading restates `title`, which the card already shows, the face starts at
 * the first paragraph instead; it never opens on a bare list, so a heading
 * that a list follows directly stays.
 */
export function CardFaceDocument({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (root === null) return;
    const apply = () => {
      const skip = new Set<HTMLElement>();
      const first = root.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6");
      if (first !== null && cardHeadingRestatesTitle(first.textContent ?? "", title)) {
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

/** Cards of one size class in rows that wrap; on a phone, one column. */
export function CardGrid({
  children,
  label,
  ref,
}: {
  readonly children: ReactNode;
  readonly label?: string;
  readonly ref?: Ref<HTMLUListElement>;
}) {
  return (
    <ul ref={ref} aria-label={label} className="flex flex-wrap items-stretch gap-x-6 gap-y-7 max-sm:flex-col max-sm:flex-nowrap">
      {Children.map(children, (child) =>
        child === null || child === undefined || child === false ? null : <li className="flex min-w-0 max-sm:block">{child}</li>,
      )}
    </ul>
  );
}

/** A named group of cards, its name over a hairline; groups placed in `CardGroups` wrap side by side. */
export function CardGroup({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <section data-frame-card-group="" aria-label={label} className="flex min-w-0 max-w-full flex-col gap-6 max-sm:w-full">
      <h3 className="flex h-[30px] items-center pb-2 text-[13px] font-medium leading-5 text-frame-muted-fg shadow-[inset_0_-1px_0_var(--frame-divider)]">
        {label}
      </h3>
      <CardGrid>{children}</CardGrid>
    </section>
  );
}

export function CardGroups({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-wrap items-start gap-x-6 gap-y-11 max-sm:flex-col max-sm:flex-nowrap max-sm:items-stretch">{children}</div>;
}
