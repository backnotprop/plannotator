/** A text file's annotation toolstrip, floating at the pane's top left (AttachmentPane.tsx). */
import { AnnotationToolstrip } from '@plannotator/ui/components/AnnotationToolstrip';
import type { EditorMode, InputMethod } from '@plannotator/ui/types';
import { useNarrowPhone } from '../phone';

export function PaneToolstrip({
  inputMethod,
  onInputMethodChange,
  mode,
  onModeChange,
  phone,
  contents,
}: {
  inputMethod: InputMethod;
  onInputMethodChange: (method: InputMethod) => void;
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  phone: boolean;
  /** The file shows a Contents button at the top right. */
  contents: boolean;
}) {
  const narrow = useNarrowPhone();
  return (
    <div className="ib-toolstrip">
      <AnnotationToolstrip
        inputMethod={inputMethod}
        onInputMethodChange={onInputMethodChange}
        mode={mode}
        onModeChange={onModeChange}
        showHelpLink={false}
        hideQuickLabel
        compact
        // Under 360 px the labelled strip ran under the Contents button (the 2026-11-19 phone audit): icons there.
        iconOnly={phone && narrow && contents}
      />
    </div>
  );
}
