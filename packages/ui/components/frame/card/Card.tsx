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

export interface CardProps {
  readonly kind: CardKind;
  /** What the preview shows; leave it out (or null) for the designed empty face. */
  readonly face?: ReactNode | CardImageFace;
  readonly title: string;
  readonly href: string;
  /** The host's router link; it receives `href`, `className`, `aria-label` and `children`. Default `<a>`. */
  readonly linkComponent?: ElementType<CardLinkProps>;
  /** The grey line under the title, for example "Your move"; without it the line is the date from `time`. */
  readonly fact?: string;
  /** A 14 px mark before `fact`, for example the agent's icon. */
  readonly factMark?: ReactNode;
  /** The mark breathes while the agent works. */
  readonly working?: boolean;
  readonly unread?: boolean;
  readonly size: CardSize;
  readonly time?: Date | string;
  /** Plays `settle` once: the card comes to rest and its unread dot appears. */
  readonly settle?: boolean;
  /** `view-transition-name` for the preview, so it can grow into the page it opens (`open`). */
  readonly transitionName?: string;
}

/** The width each kind's face is laid out at (the page is 4:3), before it is scaled to the card. */
export const CARD_FACE_WIDTH: Record<CardKind, number> = { document: 420, page: 400, image: 320, data: 400 };

/** The card's width per size, in CSS pixels; on a phone a card fills its column. */
export const CARD_WIDTH: Record<CardSize, number> = { large: 352, regular: 256 };

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

/** The card's accessible name: the title, then the grey line, then "new" when unread. */
export function cardName(title: string, line: string | null, unread: boolean): string {
  return [title, line, unread ? "new" : null].filter((part): part is string => part !== null && part !== "").join(", ");
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

function useFaceScale(ref: { readonly current: HTMLElement | null }, faceWidth: number) {
  useLayoutEffect(() => {
    const well = ref.current;
    if (well === null || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      const width = well.getBoundingClientRect().width;
      if (width > 0) well.style.setProperty("--frame-card-scale", String(width / faceWidth));
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(well);
    return () => observer.disconnect();
  }, [ref, faceWidth]);
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

function FaceFrame({
  kind,
  state,
  face,
  onImageReady,
}: {
  readonly kind: CardKind;
  readonly state: "loading" | "empty" | "ready";
  readonly face: ReactNode | CardImageFace;
  readonly onImageReady: () => void;
}) {
  const content =
    state !== "ready" ? (
      state === "empty" ? <Blank /> : null
    ) : isImageFace(face) ? (
      <img
        src={face.src}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={onImageReady}
        onError={onImageReady}
        className="block size-full object-cover object-top"
      />
    ) : (
      face
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
 * One plan, document or page as a card: a preview well and, under it, the
 * title and one grey line. The whole card is one link.
 */
export function Card({
  kind,
  face = null,
  title,
  href,
  linkComponent,
  fact,
  factMark,
  working = false,
  unread = false,
  size,
  time,
  settle = false,
  transitionName,
}: CardProps) {
  const Link: ElementType<CardLinkProps> = linkComponent ?? "a";
  const wellRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLSpanElement>(null);
  const near = useNearScreen(wellRef);
  const faceWidth = CARD_FACE_WIDTH[kind];
  useFaceScale(wellRef, faceWidth);
  useBreatheInPhase(markRef, working && factMark !== undefined && factMark !== null);
  const image = isImageFace(face);
  const [imageReady, setImageReady] = useState(false);
  const hasFace = face !== null && face !== undefined && face !== false;
  const state: "loading" | "empty" | "ready" = !hasFace ? "empty" : near ? "ready" : "loading";
  const shown = state === "ready" && image && !imageReady ? "loading" : state;
  const date = asDate(time);
  const dateWords = date === null ? null : cardDateWords(date);
  const line = fact ?? dateWords;
  const wellStyle = {
    "--frame-card-scale": String(CARD_WIDTH[size] / faceWidth),
    ...(transitionName === undefined ? {} : { viewTransitionName: transitionName }),
  } as CSSProperties;
  return (
    <div
      data-frame-card=""
      data-frame-card-kind={kind}
      data-frame-card-size={size}
      data-frame-card-unread={unread ? "" : undefined}
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden rounded-[12px] bg-card max-sm:w-full",
        size === "large" ? "w-88" : "w-64",
        settle && CARD_MOTIONS.settle,
      )}
    >
      <div
        ref={wellRef}
        data-frame-card-well=""
        data-frame-card-kind={kind}
        data-frame-card-face={shown}
        inert
        aria-hidden="true"
        style={wellStyle}
        className={cn("relative aspect-[4/3] overflow-hidden", transitionName !== undefined && CARD_MOTIONS.open)}
      >
        <div
          data-frame-card-stage=""
          className="absolute left-0 top-0 origin-top-left [transform:scale(var(--frame-card-scale))]"
          style={{ width: faceWidth, height: (faceWidth * 3) / 4 }}
        >
          {kind === "document" && <div data-frame-card-back="" className={cn("frame-card-sheet", CARD_MOTIONS.fan)} />}
          {(state !== "loading" || kind === "document") && (
            <div className={cn("contents", state === "ready" && image && !imageReady && "[&_[data-frame-card-hero]>*]:invisible")}>
              <FaceFrame kind={kind} state={state} face={face} onImageReady={() => setImageReady(true)} />
            </div>
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 px-3.5 pb-[13px] pt-[11px]">
        <Link
          href={href}
          aria-label={cardName(title, line, unread)}
          className="outline-none before:absolute before:inset-0 before:z-10 before:rounded-[12px] before:content-['']"
        >
          <span
            data-frame-card-title=""
            className={cn(
              "line-clamp-2 break-words font-medium text-foreground",
              size === "large" ? "text-[15px] leading-[22px]" : "text-[14px] leading-5",
            )}
          >
            {unread && (
              <span
                data-frame-card-dot=""
                aria-hidden="true"
                className="mr-[7px] inline-block size-[7px] rounded-full bg-primary align-[1px]"
              />
            )}
            {title}
          </span>
        </Link>
        {line !== null && (
          <span
            data-frame-card-line=""
            aria-hidden="true"
            title={date === null ? undefined : cardDateTitle(date)}
            className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[13px] leading-[18px] text-frame-muted-fg"
          >
            {factMark !== undefined && factMark !== null && fact !== undefined && (
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
                {dateWords}
              </time>
            ) : (
              <span className="truncate">{line}</span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * A document face: rendered Markdown at the sheet's type scale. The first
 * heading is hidden when it repeats `title`, which the card already shows.
 */
export function CardFaceDocument({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (root === null) return;
    const wanted = title.replace(/\s+/g, " ").trim();
    const apply = () => {
      const first = root.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6");
      for (const element of root.querySelectorAll<HTMLElement>("[data-frame-card-title-repeat]")) {
        if (element === first) continue;
        element.removeAttribute("data-frame-card-title-repeat");
        element.hidden = false;
      }
      if (first === null) return;
      const repeats = (first.textContent ?? "").replace(/\s+/g, " ").trim() === wanted;
      if (repeats === first.hasAttribute("data-frame-card-title-repeat")) return;
      if (repeats) first.setAttribute("data-frame-card-title-repeat", "");
      else first.removeAttribute("data-frame-card-title-repeat");
      first.hidden = repeats;
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
    <ul ref={ref} aria-label={label} className="flex flex-wrap items-start gap-x-6 gap-y-7 max-sm:flex-col max-sm:items-stretch">
      {Children.map(children, (child) =>
        child === null || child === undefined || child === false ? null : <li className="flex min-w-0">{child}</li>,
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
  return <div className="flex flex-wrap items-start gap-x-6 gap-y-11 max-sm:flex-col max-sm:items-stretch">{children}</div>;
}
