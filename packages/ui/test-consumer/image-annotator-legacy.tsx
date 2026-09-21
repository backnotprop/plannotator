import { Toolbar } from '../components/ImageAnnotator/Toolbar';
import type { AnnotatorState } from '../components/ImageAnnotator/types';

/** Legacy state literal retained as a compile-time published-contract check. */
export const legacyAnnotatorState: AnnotatorState = {
  tool: 'pen',
  color: '#ffffff',
  strokeSize: 6,
  strokes: [],
  currentStroke: null,
};

/** Legacy direct Toolbar usage retained without the additive redo props. */
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
