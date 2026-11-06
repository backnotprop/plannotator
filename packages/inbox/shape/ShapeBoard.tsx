/**
 * The board, as the Inbox opens it (lazy: `#shape-board`, like the guide
 * reader). ShapeSurface with the Code view's Guided Review and code review's
 * hover card. Checked under tsconfig.guide.json (it imports review-editor);
 * the window sees its shape in board-module.d.ts.
 */
import { useContext, useMemo } from 'react';
import { ShapeSurface, type ShapeBoxOptions, type ShapeCodeGuideProps, type ShapeCodeHoverCardProps } from '@plannotator/ui/components/shape';
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

export default function ShapeBoard({ host, id, onClose, renderThread, initialView, initialPanel, onNavigate, headStart, crosshair = false, onAddToReply }: ShapeBoardProps) {
  // The crosshair is the Inbox's (its ShapeLayer asks for it): the standalone page keeps Annotate.
  const boxSelect = useMemo<ShapeBoxOptions | undefined>(() => (!crosshair ? undefined : onAddToReply ? { ...BOX_SELECT, onAddToReply } : BOX_SELECT), [crosshair, onAddToReply]);
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
      pictureTiles
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
