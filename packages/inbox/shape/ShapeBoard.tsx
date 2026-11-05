/**
 * The board, as the Inbox opens it (lazy: `#shape-board`, like the guide
 * reader). ShapeSurface with the Code view's Guided Review and code review's
 * hover card. Checked under tsconfig.guide.json (it imports review-editor);
 * the window sees its shape in board-module.d.ts.
 */
import { ShapeSurface, type ShapeCodeHoverCardProps } from '@plannotator/ui/components/shape';
import { ShapeCodeGuide } from '@plannotator/guide-viewer/ShapeCodeGuide';
import { TokenHoverCard } from '@plannotator/review-editor/components/TokenHoverCard';
import type { ShapeBoardProps } from './types';
import type BoardShape from './board-module';

function HoverCard(props: ShapeCodeHoverCardProps) {
  return (
    <TokenHoverCard
      hover={props.hover as never}
      onPointerEnter={props.onPointerEnter ?? (() => {})}
      onPointerLeave={props.onPointerLeave ?? (() => {})}
      onSelectLocation={(loc) => props.onSelectLocation?.({ filePath: loc.filePath, line: loc.line })}
    />
  );
}

export default function ShapeBoard({ host, id, onClose, onCode, renderThread, initialView, initialPanel, onNavigate }: ShapeBoardProps) {
  return (
    <ShapeSurface
      key={id}
      host={host}
      id={id}
      onClose={onClose}
      onCode={onCode}
      CodeGuide={ShapeCodeGuide}
      CodeHoverCard={HoverCard}
      renderThread={renderThread}
      initialView={initialView}
      initialPanel={initialPanel}
      onNavigate={onNavigate}
    />
  );
}

// Held to the shape the window's typecheck reads.
ShapeBoard satisfies typeof BoardShape;
