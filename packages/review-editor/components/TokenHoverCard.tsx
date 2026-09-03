import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { modKey } from '@plannotator/ui/utils/platform';
import type { TokenHoverState } from '../hooks/useTokenHover';

/** Fixed width, so the horizontal clamp can be computed before measuring. */
const CARD_WIDTH = 400;
const EDGE_MARGIN = 12;
const RIGHT_MARGIN = 30;
const ANCHOR_GAP = 8;

/**
 * The card's own box. Shared by the live card and by the static one the
 * announcement dialog renders, so the two cannot drift apart: only the
 * positioning classes differ.
 */
const CARD_SURFACE_CLASS =
  'w-[400px] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl';

export type TokenHoverLocation = {
  filePath: string;
  line: number;
  column: number;
};

export interface TokenHoverCardProps {
  hover: TokenHoverState;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  /** Opens the References panel for the hovered symbol, anchored at a location. */
  onSelectLocation: (location: TokenHoverLocation) => void;
  /**
   * Positioning layer. Defaults to the app's own `fixed z-[60]`.
   *
   * The announcement dialog's try-it needs the card ABOVE the modal it is
   * demonstrated inside, and the card portals to <body> like every other
   * instance, so the stacking context is the one thing its host has to be able
   * to say.
   */
  layerClassName?: string;
  /**
   * Drop the location buttons out of the tab order. For hosts where they lead
   * nowhere (the try-it has no References panel behind it), so Tab does not
   * walk three dead controls.
   */
  inert?: boolean;
}

function locationLabel(filePath: string, line: number): string {
  return `${filePath}:${line}`;
}

/**
 * The card's contents, with no opinion about where the card sits.
 *
 * Split out so the one-time announcement dialog can render a REAL card from a
 * fixture instead of redrawing one: a forked copy of this markup would drift
 * from the shipped card the first time either changed. `interactive: false` is
 * the only difference the static host needs — it drops the location buttons
 * out of the tab order, because they live inside an aria-hidden decorative
 * block where a focusable element would be an accessibility defect. Every
 * class, every section, and their order are shared verbatim.
 */
function TokenHoverCardContent({
  data,
  onSelectLocation,
  interactive = true,
}: {
  data: TokenHoverState['data'];
  onSelectLocation: (location: TokenHoverLocation) => void;
  interactive?: boolean;
}) {
  const { definition, alternateDefinition, references, referenceCount, capped } = data;
  const shownCount = capped ? `${referenceCount}+` : `${referenceCount}`;
  const remaining = referenceCount - references.length;
  const inertProps = interactive ? {} : { tabIndex: -1 };

  return (
    <>
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <span className="font-mono text-sm font-bold text-primary">{data.symbol}</span>
        {definition?.symbolKind && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
            {definition.symbolKind}
          </span>
        )}
      </div>

      {definition?.signature && (
        <div className="mx-3.5 mt-2 overflow-x-auto whitespace-pre rounded-md border border-border bg-muted/40 px-2.5 py-2 font-mono text-[11.5px] text-foreground">
          {definition.signature}
          {definition.signatureApproximate && (
            <span className="text-muted-foreground"> {'// matched line'}</span>
          )}
        </div>
      )}

      {definition?.doc && (
        <p className="mx-3.5 mt-2 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
          {definition.doc}
        </p>
      )}

      {definition && (
        <div className="mt-2.5 px-3.5 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-1.5">
            <span aria-hidden="true">{'→'}</span>
            <span>Defined at</span>
            <button
              type="button"
              {...inertProps}
              className="font-mono text-[11.5px] text-success hover:underline"
              onClick={() => onSelectLocation(definition)}
            >
              {locationLabel(definition.filePath, definition.line)}
            </button>
          </div>
          {alternateDefinition && (
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <span className="invisible" aria-hidden="true">{'→'}</span>
              <span>or possibly</span>
              <button
                type="button"
                {...inertProps}
                className="font-mono text-[11.5px] text-success hover:underline"
                onClick={() => onSelectLocation(alternateDefinition)}
              >
                {locationLabel(alternateDefinition.filePath, alternateDefinition.line)}
              </button>
            </div>
          )}
        </div>
      )}

      {referenceCount > 0 && (
        <div className="mt-2.5 border-t border-border px-3.5 py-2.5">
          <div className="mb-1.5 text-xs text-muted-foreground">
            {shownCount} {referenceCount === 1 ? 'reference' : 'references'}
          </div>
          {references.map((reference) => (
            <div
              key={`${reference.filePath}:${reference.line}:${reference.column}`}
              className="flex gap-1.5 py-0.5 font-mono text-[11px]"
            >
              <span className="text-muted-foreground/60" aria-hidden="true">{'❯'}</span>
              <button
                type="button"
                {...inertProps}
                className="truncate text-left text-primary hover:underline"
                onClick={() => onSelectLocation(reference)}
              >
                {locationLabel(reference.filePath, reference.line)}
              </button>
            </div>
          ))}
          {remaining > 0 && (
            <div className="py-0.5 text-[11px] text-muted-foreground">
              {`… ${remaining} more in the References panel`}
            </div>
          )}
        </div>
      )}

      {/* Frozen copy: the card teaches exactly one thing, and the Alt-click
          alias is deliberately not advertised here. */}
      <div className="border-t border-border px-3.5 py-1.5 text-[10.5px] text-muted-foreground">
        Click a location to jump.{' '}
        <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">
          {modKey}
        </kbd>
        {modKey === '⌘' ? '' : '+'}click a token for the full References panel.
      </div>
    </>
  );
}

/**
 * The Tier 0 hover card: what the search actually found, and nothing it did
 * not. It never renders rank vocabulary, a backend name or a latency readout —
 * uncertainty is expressed by SHOWING the alternative location, not by
 * describing the algorithm.
 */
export function TokenHoverCard({
  hover,
  onPointerEnter,
  onPointerLeave,
  onSelectLocation,
  layerClassName = 'fixed z-[60]',
  inert = false,
}: TokenHoverCardProps) {
  const { data, rect } = hover;
  const cardRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<
    { for: TokenHoverState; left: number; top: number } | null
  >(null);

  // Below the token, flipped above when the viewport bottom would clip it,
  // clamped horizontally. Measured in a layout effect so the flip decision uses
  // the real height and nothing is painted at the pre-measurement position.
  useLayoutEffect(() => {
    const height = cardRef.current?.offsetHeight ?? 0;
    const left = Math.max(
      EDGE_MARGIN,
      Math.min(rect.left, window.innerWidth - CARD_WIDTH - RIGHT_MARGIN),
    );
    let top = rect.bottom + ANCHOR_GAP;
    if (top + height > window.innerHeight - EDGE_MARGIN) {
      // Flipping a card taller than the space above the token would put its
      // head off the top of the viewport, where the name and signature are
      // unreachable. Clamp instead: the foot may overlap the token.
      top = Math.max(EDGE_MARGIN, rect.top - height - ANCHOR_GAP);
    }
    setPlacement({ for: hover, left, top });
  }, [hover, rect]);

  const placed = placement?.for === hover ? placement : null;

  return createPortal(
    <div
      ref={cardRef}
      // Read by the hook's scroll cancel: a scroll inside the card is not a
      // pane scroll and must not close it.
      data-token-hover-card
      // Not a dialog: nothing here takes focus, traps it, or must be
      // dismissed. It is supplementary information about the hovered token.
      role="tooltip"
      aria-label={`${data.symbol} details`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={`${layerClassName} ${CARD_SURFACE_CLASS}`}
      style={{
        left: placed?.left ?? rect.left,
        top: placed?.top ?? rect.bottom + ANCHOR_GAP,
        visibility: placed ? 'visible' : 'hidden',
      }}
    >
      <TokenHoverCardContent
        data={data}
        onSelectLocation={onSelectLocation}
        interactive={!inert}
      />
    </div>,
    document.body,
  );
}
