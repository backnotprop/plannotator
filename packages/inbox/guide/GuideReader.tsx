/**
 * The guide viewer inside the Inbox: Plannotator's guide chain
 * (`@plannotator/guide-viewer`'s GuideView) with the Inbox as its GuideHost,
 * over Plannotator's own `AllFilesCodeView` in `readOnly` mode, the renderer
 * guides.show uses (apps/guides-show/viewer/ReadOnlyDiffRenderer.tsx), so the
 * diff panes are the ones Plannotator draws. Read-only: annotations on guides
 * are not in this step.
 *
 * Mounted only through GuidePane's dynamic import (`#guide-reader`,
 * tests/entry-assets.test.ts). The single-file build inlines it: its bytes
 * ship in inbox.html and its modules (the guide chain, the diff renderer) run
 * at page load; what waits for Open is the mount, the diff render and the
 * highlighter, as with every lazy runtime in Plannotator's single-file apps.
 * No new Tailwind classes here or in the chain: the guides.show viewer CSS,
 * and with it its pinned manifest, stay as they are.
 */

import { useCallback, useMemo, useState, type FC } from 'react';
import type { CodeGuideData } from '@plannotator/core/guide';
import type { GuideSnapshot } from '@plannotator/core/guide-format';
import type { GuideReaderProps } from './types';
import type ReaderShape from './reader-module';
import { GuideHostProvider, GuideView, type GuideDiffRendererProps } from '@plannotator/guide-viewer';
import { parseDiffToFiles } from '@plannotator/guide-viewer/diffParser';
import { engineLabel } from '@plannotator/guide-viewer/GuideViewer';
import { AllFilesCodeView } from '@plannotator/review-editor/components/AllFilesCodeView';
import { useConfigValue } from '@plannotator/ui/config';

const NO_ANNOTATIONS: never[] = [];
const noop = () => {};

/**
 * The read-only diff renderer, configured from Plannotator's diff settings like guides.show's (the surface's reader draws with it too).
 * `compactTouchLayout` is the review app's own phone header (the surface passes it): the full path, its ellipsis at the leading edge
 * only when it does not fit, and 44 pt targets.
 */
export const ReadOnlyDiff: FC<GuideDiffRendererProps & { compactTouchLayout?: boolean }> = (props) => {
  const diffStyle = useConfigValue('diffStyle');
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
      contextExpansionAvailable={false}
      diffStyle={diffStyle}
      diffOverflow={diffOverflow}
      diffIndicators={diffIndicators}
      lineDiffType={lineDiffType}
      disableLineNumbers={!showLineNumbers}
      disableBackground={!showBackground}
      expandUnchanged={expandUnchanged}
      fontFamily={fontFamily || undefined}
      fontSize={fontSize || undefined}
      annotations={NO_ANNOTATIONS}
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

const noRendererProps = (): Record<string, never> => ({});

/** The provenance line guides.show draws under the counts: repository, branch, the reviewed range. */
function sourceLine(snapshot: GuideSnapshot): string {
  return [snapshot.source.repo, snapshot.source.branch, snapshot.review.gitRef].filter(Boolean).join(' · ');
}

export default function GuideReader({ snapshot, reviewed, onReviewedChange }: GuideReaderProps) {
  const files = useMemo(() => parseDiffToFiles(snapshot.review.rawPatch), [snapshot.review.rawPatch]);
  const guide = useMemo<CodeGuideData>(
    () => ({
      title: snapshot.guide.title,
      intent: snapshot.guide.intent,
      sections: snapshot.guide.sections,
      unplacedFiles: snapshot.guide.unplacedFiles,
      reviewed: [...snapshot.guide.reviewed],
    }),
    [snapshot.guide],
  );
  const ticks = useMemo(() => guide.sections.map((_, i) => reviewed[i] ?? snapshot.guide.reviewed[i] ?? false), [guide.sections, reviewed, snapshot.guide.reviewed]);
  const [focusedFile, setFocusedFile] = useState<string | null>(null);
  const toggle = useCallback((index: number) => onReviewedChange(ticks.map((value, i) => (i === index ? !value : value))), [ticks, onReviewedChange]);
  const host = useMemo(() => ({ files, DiffRenderer: ReadOnlyDiff, getDiffRendererProps: noRendererProps }), [files]);

  return (
    <GuideHostProvider value={host}>
      <GuideView
        guide={guide}
        reviewed={ticks}
        onToggleReviewed={toggle}
        engineLabel={engineLabel(snapshot.generator?.engine, snapshot.generator?.model)}
        focusedFile={focusedFile}
        onFocusFile={setFocusedFile}
        sourceLine={sourceLine(snapshot)}
      />
    </GuideHostProvider>
  );
}

// Held to the shape the window's strict typecheck reads (reader-module.d.ts).
GuideReader satisfies typeof ReaderShape;
