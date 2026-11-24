import { DeferredMarkdownContentsRail } from '@plannotator/ui/components/DeferredMarkdownContentsRail';
import type { MarkdownContentsRailProps } from '@plannotator/ui/components/MarkdownContentsRail';
import { ContentsHide } from '../components/ContentsPanel';
import { INBOX_CONTENTS_MIN_HEADINGS } from '../contents';
import { useContentsDotsShown } from '../data/contentsDots';

type Props = Omit<MarkdownContentsRailProps, 'minHeadings' | 'contentSelector' | 'panelAction'> & {
  /** The open panel's Hide: the rail goes, a Contents button over the file brings it back. */
  onHide: () => void;
};

/**
 * An open file's contents rail: ui's contents rail (Workspaces' rail, approved 2026-10-03), ticks in the page's right
 * gutter, the panel opening left over the page. Loaded once the page is interactive; it measures itself and yields
 * where the gutter is short, then says so and the Contents button takes over. Hidden by choice, it still measures.
 * Given `annotations` and `onSelectAnnotation`, the file's comments show as dots beside the ticks; a dot selects its
 * comment as the comments panel does. Settings' "Annotation minimap" off (data/contentsDots.ts), the rail gets neither and
 * draws no dots; its ticks and panel stay. A Markdown plan on the Plans page (plans/PlanAnnotate.tsx, through AttachmentPane) and a plan's other pages (plans/PlanDocument.tsx) mount it too.
 */
export function FileContentsRail({ onHide, annotations, onSelectAnnotation, ...rail }: Props) {
  const dots = useContentsDotsShown();
  return (
    <DeferredMarkdownContentsRail
      {...rail}
      annotations={dots ? annotations : undefined}
      onSelectAnnotation={dots ? onSelectAnnotation : undefined}
      minHeadings={INBOX_CONTENTS_MIN_HEADINGS}
      contentSelector="[data-doc-text-root]"
      panelAction={<ContentsHide onHide={onHide} />}
    />
  );
}
