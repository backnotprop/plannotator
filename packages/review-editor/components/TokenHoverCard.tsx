import type React from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { modKey } from '@plannotator/ui/utils/platform';
import type { TokenHoverState } from '../hooks/useTokenHover';

const CARD_WIDTH = 400;
const EDGE_MARGIN = 12;
const RIGHT_MARGIN = 30;
const ANCHOR_GAP = 8;

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
  onSelectLocation: (location: TokenHoverLocation) => void;
  layerClassName?: string;
  inert?: boolean;
  content?: React.ReactNode;
}

function locationLabel(filePath: string, line: number): string {
  return `${filePath}:${line}`;
}

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
  const inertProps = interactive ? {} : { tabIndex: -1, 'aria-disabled': true as const };
  const locationClass = interactive ? '' : ' cursor-default hover:no-underline opacity-80';

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
              className={`font-mono text-[11.5px] text-success hover:underline${locationClass}`}
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
                className={`font-mono text-[11.5px] text-success hover:underline${locationClass}`}
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
                className={`truncate text-left text-primary hover:underline${locationClass}`}
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

      {}
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

export function TokenHoverCard({
  hover,
  onPointerEnter,
  onPointerLeave,
  onSelectLocation,
  layerClassName = 'fixed z-[60]',
  inert = false,
  content,
}: TokenHoverCardProps) {
  const { data, rect } = hover;
  const cardRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<
    { for: TokenHoverState; left: number; top: number } | null
  >(null);

  useLayoutEffect(() => {
    const height = cardRef.current?.offsetHeight ?? 0;
    const left = Math.max(
      EDGE_MARGIN,
      Math.min(rect.left, window.innerWidth - CARD_WIDTH - RIGHT_MARGIN),
    );
    let top = rect.bottom + ANCHOR_GAP;
    if (top + height > window.innerHeight - EDGE_MARGIN) {
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
      // Safe to hide because `inert` has already taken every control out of the tab order.
      aria-hidden={inert || undefined}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={`${layerClassName} ${CARD_SURFACE_CLASS}`}
      style={{
        left: placed?.left ?? rect.left,
        top: placed?.top ?? rect.bottom + ANCHOR_GAP,
        visibility: placed ? 'visible' : 'hidden',
      }}
    >
      {content ?? (
        <TokenHoverCardContent
          data={data}
          onSelectLocation={onSelectLocation}
          interactive={!inert}
        />
      )}
    </div>,
    document.body,
  );
}
