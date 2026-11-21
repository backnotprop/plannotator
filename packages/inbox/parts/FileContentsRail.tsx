import { DeferredMarkdownContentsRail } from '@plannotator/ui/components/DeferredMarkdownContentsRail';
import type { MarkdownContentsRailProps } from '@plannotator/ui/components/MarkdownContentsRail';
import { ContentsHide } from '../components/ContentsPanel';
import { INBOX_CONTENTS_MIN_HEADINGS } from '../contents';

type Props = Omit<MarkdownContentsRailProps, 'minHeadings' | 'contentSelector' | 'panelAction'> & {
  /** The open panel's Hide: the rail goes, a Contents button over the file brings it back. */
  onHide: () => void;
};

/**
 * An open file's contents rail: ui's contents rail (Workspaces' rail, approved 2026-10-03), ticks in the page's right
 * gutter, the panel opening left over the page. Loaded once the page is interactive; it measures itself and yields
 * where the gutter is short, then says so and the Contents button takes over. Hidden by choice, it still measures.
 * Given `annotations` and `onSelectAnnotation`, the file's comments show as dots beside the ticks; a dot selects its
 * comment as the comments panel does.
 */
export function FileContentsRail({ onHide, ...rail }: Props) {
  return (
    <DeferredMarkdownContentsRail
      {...rail}
      minHeadings={INBOX_CONTENTS_MIN_HEADINGS}
      contentSelector="[data-doc-text-root]"
      panelAction={<ContentsHide onHide={onHide} />}
    />
  );
}
