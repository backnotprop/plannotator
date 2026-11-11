import { useMemo } from 'react';
import { ShapeSurface, type ShapeBoxOptions } from '@plannotator/ui/components/shape';
import { OpenInCodeSpans } from '../components/OpenIn';
import { markShapeDock, markShapePill } from '../pageMarks';
import type { ShapeBoardProps } from './types';
import type BoardShape from './board-module';

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

const BOX_SELECT: ShapeBoxOptions = { readAsset };

export default function ShapeBoard({ host, id, onClose, onCode, renderThread, initialView, initialPanel, onNavigate, headStart, headSide, review, crosshair = false, onAddToReply }: ShapeBoardProps) {
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
      headSide={headSide}
      dockRef={markShapeDock}
      pillRef={markShapePill}
    />
    </OpenInCodeSpans>
  );
}

ShapeBoard satisfies typeof BoardShape;
