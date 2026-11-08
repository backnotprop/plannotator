/**
 * The picture of Shape's offer (ShapeOffer.tsx): the fixed technical board (`SHAPE_OFFER_BOARD`) drawn by the real
 * Shape renderer, cropped close. A small chunk of its own (this wrapper and the board fixture; the renderer is already
 * in the window's entry script), fetched once the line arms the offer on a load (shapeOffer.ts `preload`). Its lines draw on once; under reduced motion it is still.
 * Decoration only: the dialog hides it from assistive tech and makes it inert.
 */
import { ShapeDiagram } from '@plannotator/ui/components/shape/ShapeDrawn';
import { useReducedMotion } from '../tour/Tour';
import { SHAPE_OFFER_BOARD } from '../shapeOfferBoard';

export default function ShapeOfferArt() {
  const still = useReducedMotion();
  return (
    <div className="ib-sho-board" data-shape-offer-board="">
      <ShapeDiagram drawn={SHAPE_OFFER_BOARD} animate={!still} />
    </div>
  );
}
