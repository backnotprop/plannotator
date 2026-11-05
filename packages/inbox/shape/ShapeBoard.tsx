/**
 * The board, as the Inbox opens it (lazy: `#shape-board`, like the guide
 * reader). ShapeSurface with the Code view's Guided Review and code review's
 * hover card. Checked under tsconfig.guide.json (it imports review-editor);
 * the window sees its shape in board-module.d.ts.
 */
import { useContext } from 'react';
import { ShapeSurface, type ShapeCodeGuideProps, type ShapeCodeHoverCardProps } from '@plannotator/ui/components/shape';
import { CodeSpanContext } from '@plannotator/ui/components/LocalLinkContext';
import { GuideCodeSpanContext } from '@plannotator/guide-viewer/renderInlineMarkdown';
import { ShapeCodeGuide } from '@plannotator/guide-viewer/ShapeCodeGuide';
import { OpenInCodeSpans } from '../components/OpenIn';
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

/** The Code view's source line: inside the surface, so its spans follow the board's (only words while annotating). */
function CodeGuide(props: ShapeCodeGuideProps) {
  return (
    <GuideCodeSpanContext.Provider value={useContext(CodeSpanContext)}>
      <ShapeCodeGuide {...props} />
    </GuideCodeSpanContext.Provider>
  );
}

export default function ShapeBoard({ host, id, onClose, renderThread, initialView, initialPanel, onNavigate }: ShapeBoardProps) {
  return (
    <OpenInCodeSpans scope={{ shape: id }} on={!!host.fileAction}>
    <ShapeSurface
      key={id}
      host={host}
      id={id}
      onClose={onClose}
      CodeGuide={CodeGuide}
      CodeHoverCard={HoverCard}
      renderThread={renderThread}
      readFirst
      initialView={initialView}
      initialPanel={initialPanel}
      onNavigate={onNavigate}
    />
    </OpenInCodeSpans>
  );
}

// Held to the shape the window's typecheck reads.
ShapeBoard satisfies typeof BoardShape;
