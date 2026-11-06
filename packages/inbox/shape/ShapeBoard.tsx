/**
 * The board, as the Inbox opens it (lazy: `#shape-board`). ShapeSurface
 * without its Code view (approval "shape-whats-changed": the guided review is
 * another part of the review, so the board does not embed it). With a review,
 * What's changed and the board's `file:line` links open the review's own
 * guided review (`review`); without one, a `file:line` opens the file viewer.
 * The shared Code view (`ShapeCode`, `@plannotator/guide-viewer/ShapeCodeGuide`)
 * stays in its packages for other hosts. Checked under tsconfig.guide.json;
 * the window sees its shape in board-module.d.ts.
 */
import { ShapeSurface } from '@plannotator/ui/components/shape';
import { OpenInCodeSpans } from '../components/OpenIn';
import type { ShapeBoardProps } from './types';
import type BoardShape from './board-module';

export default function ShapeBoard({ host, id, onClose, renderThread, initialView, initialPanel, onNavigate, headStart, review }: ShapeBoardProps) {
  return (
    <OpenInCodeSpans scope={{ shape: id }} on={!!host.fileAction}>
    <ShapeSurface
      key={id}
      host={host}
      id={id}
      onClose={onClose}
      codeView={false}
      review={review}
      renderThread={renderThread}
      readFirst
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
