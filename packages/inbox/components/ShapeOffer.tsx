import { Suspense } from 'react';
import { LazyBlockBoundary } from '@plannotator/ui/components/LazyBlockBoundary';
import { PEBBLE_REST } from '@plannotator/ui/components/shape/Pebble';
import { lazyPart } from '../lazyParts';
import { pageHeading, useFirstFocusOnDialog } from './CodeReviewOffer';
import { Modal } from './Updates';

/**
 * The picture: a small chunk of its own (the board fixture and its wrapper; the Shape renderer itself is already in the
 * window's entry script), fetched once the line arms the offer (`preloadShapeOfferArt`). `shapeOfferArtChunk.load` is
 * the fetch, so a test can make it fail as a dropped link or a replaced build does.
 */
export const shapeOfferArtChunk = { load: () => import('./ShapeOfferArt') };
const ShapeOfferArtPart = lazyPart(() => shapeOfferArtChunk.load());
export const preloadShapeOfferArt = (): void => void ShapeOfferArtPart.preload().catch(() => {});

/**
 * Shape's one-time offer (approval "shape-turn-on-dialog", 2026-11-08; the owner chose "C · The list"): Code review's
 * offer shell (`.ib-cro`, CodeReviewOffer.tsx) with a close-up of a board in Shape's technical style on top (the
 * owner's one change: "Don't we have a more technical style diagram?"; `SHAPE_OFFER_BOARD`, drawn by the real Shape
 * renderer), the title, three lines, and two buttons. "Turn on Shape" turns Shape on, as Settings → Capabilities
 * does; "Not now", Escape and a click outside leave it off. Every way out is final (the claim already spent it);
 * Settings is the way on later. No keyboard shortcut. Its slot in the line: `SHAPE_OFFER`
 * (packages/shared/inbox/reveals.ts); its moment: shapeOffer.ts.
 */
export function ShapeOffer({ phone, onClose, onTurnOn }: { phone: boolean; onClose: () => void; onTurnOn: () => void }) {
  useFirstFocusOnDialog('shape-offer');
  return (
    <Modal labelledBy="ib-sho-title" describedBy="ib-sho-feats" testId="shape-offer" onClose={onClose} ownKeys fallbackFocus={pageHeading} className={`ib-cro ib-sho${phone ? ' ib-cro-phone' : ''}`}>
      <div className="ib-cro-art ib-sho-art" aria-hidden="true" inert>
        {/* A chunk that cannot arrive (a dropped link, an Inbox restarted onto a new release) leaves the band empty:
            the dialog keeps its words and buttons, and the window stays mounted with whatever the person typed. */}
        <LazyBlockBoundary fallback={() => null}>
          <Suspense fallback={null}>
            <ShapeOfferArtPart.Part />
          </Suspense>
        </LazyBlockBoundary>
      </div>
      <div className="ib-cro-body">
        <h2 id="ib-sho-title">Draw the work with Shape</h2>
        <ul className="ib-cro-feats" id="ib-sho-feats">
          <li>
            <SlashIcon />
            <span>
              Type <code className="ib-sho-cmd">/shape</code> in a reply, and the agent draws the work as a board
            </span>
          </li>
          <li>
            <svg viewBox="0 0 24 24" aria-hidden="true" className="ib-sho-pebble">
              <path d={PEBBLE_REST} />
            </svg>
            <span>It opens from the Shape button at the top of the thread</span>
          </li>
          <li>
            <PointerIcon />
            <span>Point at any part to ask about it or change it</span>
          </li>
        </ul>
        <div className="ib-cro-acts">
          <button type="button" className="ib-btn ib-ghost" onClick={onClose} data-shape-offer-close="">
            Not now
          </button>
          <span className="ib-bsp" />
          <button type="button" className="ib-btn ib-pri" onClick={onTurnOn} data-shape-offer-on="">
            Turn on Shape
          </button>
        </div>
        <p className="ib-cro-note">It stays off unless you turn it on. You can change this in Settings.</p>
      </div>
    </Modal>
  );
}

/** A key with a slash: the "/" command in a reply. */
function SlashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M13.5 8.5l-3 7" />
    </svg>
  );
}

/** A pointer: point at a part. */
function PointerIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 3.5l12 7.2-5.3 1.4 3.2 5.6-2.3 1.3-3.2-5.6L6.6 17.2z" />
    </svg>
  );
}
