/**
 * The pane beside the thread on its Artifacts tab (approval
 * "inbox-files-tabs"): the tab row, the thread's artifacts grid
 * (ArtifactsView, as the Artifacts view drew it in place of the messages),
 * and the files panel when it is open. A file shown beside the thread is
 * AttachmentPane, with the same tab row (its `tabs` prop).
 */
import type { ReactNode, Ref } from 'react';

export function FilesPane({ id, tabRow, grid, aside, paneRef }: { id?: string; tabRow: ReactNode; grid: ReactNode; aside?: ReactNode; paneRef?: Ref<HTMLElement> }) {
  return (
    <section
      ref={paneRef}
      id={id}
      tabIndex={-1}
      className={`ib-view ib-nopanel ib-tabbed ib-filesart${aside != null ? ' ib-withtree' : ''}`}
      aria-label="Artifacts"
      data-files-pane="artifacts"
    >
      <div className="ib-ftop" data-files-header="">
        {tabRow}
      </div>
      <div />
      <div className="ib-vbody">
        <div className="ib-docarea ib-artarea">{grid}</div>
        {aside}
      </div>
    </section>
  );
}
