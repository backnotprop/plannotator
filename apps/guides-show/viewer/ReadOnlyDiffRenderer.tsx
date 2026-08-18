import React from 'react';
import { AllFilesCodeView } from '@plannotator/review-editor/components/AllFilesCodeView';
import { useConfigValue } from '@plannotator/ui/config';
import type { GuideDiffRendererProps } from '@plannotator/guide-viewer/host';

const EMPTY_ANNOTATIONS: never[] = [];
const noop = () => {};

/**
 * The portable viewer's diff renderer: Plannotator's own `AllFilesCodeView`
 * in `readOnly` mode. Same component the in-app guide uses, so the diff panes
 * are byte-identical; the read-only switch only removes surfaces that need the
 * review server or mutate review state (decision record D2, D4).
 *
 * Display settings come from configStore defaults (or whatever the host
 * seeded) — never cookies, since the viewer installs an in-memory backend.
 */
/**
 * Below Tailwind's `lg` (1024px) the diff pane is at most ~430px wide (a phone
 * has ~350px, a portrait tablet shares the row with the chapter column), so a
 * two-column diff gets under 220px per side and is unreadable; force unified
 * there. The setting itself is untouched: widen the window past 1024px and the
 * configured style applies again. Desktop layouts are unaffected.
 */
const NARROW_VIEWPORT = '(max-width: 1023px)';

function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = React.useState<boolean>(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW_VIEWPORT).matches,
  );
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(NARROW_VIEWPORT);
    const onChange = () => setNarrow(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

export const ReadOnlyDiffRenderer: React.FC<GuideDiffRendererProps> = (props) => {
  const configuredDiffStyle = useConfigValue('diffStyle');
  const diffStyle = useNarrowViewport() ? 'unified' : configuredDiffStyle;
  const diffOverflow = useConfigValue('diffOverflow');
  const diffIndicators = useConfigValue('diffIndicators');
  const lineDiffType = useConfigValue('diffLineDiffType');
  const showLineNumbers = useConfigValue('diffShowLineNumbers');
  const showBackground = useConfigValue('diffShowBackground');
  const expandUnchanged = useConfigValue('diffExpandUnchanged');
  const fontFamily = useConfigValue('diffFontFamily');
  const fontSize = useConfigValue('diffFontSize');

  return (
    <AllFilesCodeView
      {...props}
      readOnly
      diffStyle={diffStyle}
      diffOverflow={diffOverflow}
      diffIndicators={diffIndicators}
      lineDiffType={lineDiffType}
      disableLineNumbers={!showLineNumbers}
      disableBackground={!showBackground}
      expandUnchanged={expandUnchanged}
      fontFamily={fontFamily || undefined}
      fontSize={fontSize || undefined}
      annotations={EMPTY_ANNOTATIONS}
      selectedAnnotationId={null}
      scrollTargetAnnotation={null}
      pendingSelection={null}
      onLineSelection={noop}
      onAddAnnotationForFile={noop}
      onEditAnnotation={noop}
      onSelectAnnotation={noop}
      onDeleteAnnotation={noop}
    />
  );
};

/** The guide chain forwards no extra props to a read-only renderer. */
export const getReadOnlyDiffRendererProps = (): Record<string, never> => ({});
