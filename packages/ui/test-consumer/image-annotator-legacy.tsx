import { Toolbar } from '../components/ImageAnnotator/Toolbar';
import type { AnnotatorState } from '../components/ImageAnnotator/types';

export const legacyAnnotatorState: AnnotatorState = {
  tool: 'pen',
  color: '#ffffff',
  strokeSize: 6,
  strokes: [],
  currentStroke: null,
};

export function LegacyImageAnnotatorToolbar() {
  return (
    <Toolbar
      tool="pen"
      color="#ffffff"
      strokeSize={6}
      canUndo={false}
      onToolChange={() => {}}
      onColorChange={() => {}}
      onStrokeSizeChange={() => {}}
      onUndo={() => {}}
      onClear={() => {}}
      onSave={() => {}}
    />
  );
}
