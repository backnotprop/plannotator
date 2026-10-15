import type { DraftView } from '../api';
import { shortTime, whenTime } from '../format';
import { HostMark, Icon } from '../icons';
import { SidebarTrigger } from '../shell/sidebar';
import { draftChip, draftSnippet, hostLabel, subjectPreview } from './model';

/**
 * Drafts (compose): messages the person started and did not send, newest
 * saved first, each with a worded chip (its session is live, has ended, or
 * none was chosen) and a delete with Undo (the window's one toast). A row
 * reopens its draft in compose. A draft never sends itself.
 */
export function DraftsPage({
  drafts,
  error,
  phone,
  onOpen,
  onDelete,
  onCompose,
}: {
  drafts: readonly DraftView[] | null;
  error: string | null;
  phone: boolean;
  onOpen: (draft: DraftView, opener: HTMLElement) => void;
  onDelete: (draft: DraftView) => void;
  onCompose: (opener: HTMLElement) => void;
}) {
  const list = drafts ?? [];
  return (
    <section className="ib-dpage ib-drafts" aria-label="Drafts" data-drafts-page="">
      <div className="ib-dh">
        <SidebarTrigger />
        <h1 tabIndex={-1}>Drafts</h1>
        {list.length > 0 && <span className="ib-drafts-n">{list.length} not sent</span>}
        {phone && (
          <button type="button" className="ib-lhead-compose" aria-label="New message" aria-haspopup="dialog" onClick={(event) => onCompose(event.currentTarget)}>
            <Icon name="compose" size={20} />
          </button>
        )}
      </div>
      <p className="ib-dsub">Messages you started but did not send. A draft never sends itself: open one, pick a live agent, and send it.</p>
      {error && <div className="ib-error">{error}</div>}
      {drafts && list.length === 0 && <p className="ib-drafts-empty">No drafts. Closing a message you did not send asks whether to keep it here.</p>}
      <div className="ib-drafts-list" role="list">
        {list.map((draft) => {
          const subject = subjectPreview(draft.body) ?? '(no words yet)';
          const snippet = draftSnippet(draft.body);
          const files = draft.files.length;
          return (
            <div className="ib-draft" role="listitem" key={draft.id} data-draft-id={draft.id} data-draft-status={draft.status}>
              <button type="button" className="ib-draft-open" onClick={(event) => onOpen(draft, event.currentTarget)} aria-label={`Open draft: ${subject}. ${draftChip(draft)}. Saved ${whenTime(draft.updated_at)}`}>
                <span className="ib-draft-mk">{draft.to ? <HostMark host={draft.to.host} big /> : <Icon name="doc" size={17} />}</span>
                <span className="ib-draft-t">
                  <span className="ib-draft-to" dir="auto">
                    {draft.to ? (
                      <>
                        To <b>{hostLabel(draft.to.host)}</b>
                        {draft.to.project_name ? (
                          <>
                            {' '}
                            in <bdi>{draft.to.project_name}</bdi>
                          </>
                        ) : null}
                        {draft.to.started_at ? ` · started ${whenTime(draft.to.started_at)}` : ''}
                      </>
                    ) : (
                      <>
                        No agent{draft.project ? (
                          <>
                            {' · '}
                            <bdi>{draft.project.name}</bdi>
                          </>
                        ) : null}
                      </>
                    )}
                  </span>
                  <span className="ib-draft-s" dir="auto">
                    {subject}
                  </span>
                  {snippet && (
                    <span className="ib-draft-sn" dir="auto">
                      {snippet}
                    </span>
                  )}
                </span>
                <span className="ib-draft-meta">
                  <span className="ib-draft-when">
                    Saved {shortTime(draft.updated_at)}
                    {files > 0 && (
                      <>
                        {' · '}
                        <Icon name="clip" size={12} /> {files}
                      </>
                    )}
                  </span>
                  <span className={`ib-chip${draft.status === 'live' ? ' ib-chip-on' : draft.status === 'ended' ? ' ib-chip-warn' : ''}`} data-draft-chip={draft.status}>
                    {draftChip(draft)}
                  </span>
                </span>
              </button>
              <button type="button" className="ib-draft-del" aria-label={`Delete draft: ${subject}`} title="Delete draft" onClick={() => onDelete(draft)} data-draft-delete="">
                <Icon name="trash" size={17} />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
