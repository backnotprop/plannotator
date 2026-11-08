/**
 * The board, as the Inbox opens it (lazy: `#shape-board`). ShapeSurface
 * without its Code view (approval "shape-whats-changed": the guided review is
 * another part of the review, so the board does not embed it). With a review,
 * a place in code on the board (a drawn part's `data-code`) opens the review's
 * own guided review (`review`); without one, the file viewer.
 * The shared Code view (`ShapeCode`, `@plannotator/guide-viewer/ShapeCodeGuide`)
 * stays in its packages for other hosts. Checked under tsconfig.guide.json;
 * the window sees its shape in board-module.d.ts.
 */
import { useMemo } from 'react';
import { ShapeSurface, type ShapeBoxOptions } from '@plannotator/ui/components/shape';
import { OpenInCodeSpans } from '../components/OpenIn';
import type { ShapeBoardProps } from './types';
import type BoardShape from './board-module';

/** A same-site image or font for a box's picture: the board itself makes no request. */
async function readAsset(url: string): Promise<string | null> {
  const answer = await fetch(url);
  if (!answer.ok) return null;
  const blob = await answer.blob();
  return new Promise((done) => {
    const reader = new FileReader();
    reader.onload = () => done(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => done(null);
    reader.readAsDataURL(blob);
  });
}

const BOX_SELECT: ShapeBoxOptions = {
  readAsset,
  // STUB (proto/shape-box-comment): the word is drawn; Show me on boards is another branch's (#2669). It logs what it would receive.
  onShowMe: (selection, text) => {
    void selection.picture.then((picture) => console.info('[shape-box] Show me stub', JSON.stringify({ ...selection, picture: picture ? `${picture.slice(0, 40)}… (${picture.length} chars)` : null, text })));
  },
};

export default function ShapeBoard({ host, id, onClose, onCode, renderThread, initialView, initialPanel, onNavigate, headStart, review, crosshair = false, onAddToReply }: ShapeBoardProps) {
  // The crosshair is the Inbox's (its ShapeLayer asks for it): the standalone page keeps Annotate.
  const boxSelect = useMemo<ShapeBoxOptions | undefined>(() => (!crosshair ? undefined : onAddToReply ? { ...BOX_SELECT, onAddToReply } : BOX_SELECT), [crosshair, onAddToReply]);
  return (
    <OpenInCodeSpans scope={{ shape: id }} on={!!host.fileAction}>
    <ShapeSurface
      key={id}
      host={host}
      id={id}
      onClose={onClose}
      onCode={onCode}
      codeView={false}
      review={review}
      renderThread={renderThread}
      readFirst
      darkContrast
      stackBadges
      boxSelect={boxSelect}
      initialView={initialView}
      initialPanel={initialPanel}
      onNavigate={onNavigate}
      headStart={headStart}
    />
    </OpenInCodeSpans>
  );
}

// Held to the shape the window's typecheck reads.
ShapeBoard satisfies typeof BoardShape;
