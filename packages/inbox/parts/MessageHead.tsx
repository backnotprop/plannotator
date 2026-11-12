import { isInboxNote, type InboxMessageWire } from '@plannotator/core/inbox-types';
import { AttachmentsCount } from '../components/AttachmentTiles';
import { MessageMenu, type CopyMenuHost } from '../components/CopyMenus';
import { SessionEndedMark } from '../components/ReplyRoute';
import { Tip } from '../components/Tip';
import { AuthorMark, Icon } from '../icons';
import { labelledAuthorName } from './AuthorName';
import type { MessageActsRef } from './messageActs';

export type MessageHeadData = {
  message: InboxMessageWire;
  phone: boolean;
  one: boolean;
  isNew: boolean;
  revealed: boolean;
  time: string;
  fullWhen: string;
  name: string;
  nameSaid: string;
  nameTip: string;
  named: string | null;
  kind: string | null;
  authorLabel: string | null;
  folder: string;
  toLabel: string;
  ended: boolean;
  tagNames: string | null;
  fileCount: number;
  filesOpen: boolean;
  changed: number;
  live: boolean;
  acts: MessageActsRef;
  copy: { readonly current: CopyMenuHost };
};

export function drawMessageHead(d: MessageHeadData) {
  const { message, one, isNew, revealed, time, name, named, kind, authorLabel, acts } = d;
  const isAgent = message.author.kind === 'agent';
  const hide = one ? undefined : true;
  const toggle = () => acts.current.toggleMessage(message.id);
  const count =
    d.fileCount > 0 ? (
      <AttachmentsCount
        messageId={message.id}
        count={d.fileCount}
        changed={d.changed}
        open={d.filesOpen}
        controls={`ib-hatts-${message.id}`}
        onToggle={() => acts.current.setHeaderOpen(message.id, !d.filesOpen)}
        onKeyDown={(event) => acts.current.closeHeaderOnEscape(message.id)(event)}
      />
    ) : null;
  return (
    <MessageMenu
      phone={d.phone}
      newest={d.copy}
      message={message}
      head={(more) => (
        <div className="ib-fline ib-is-open" data-open-head="" data-revealed={revealed ? '' : undefined}>
          {!one && (
            <button type="button" className="ib-fl-hit" data-fold-head="" aria-expanded={true} aria-label={`${d.nameSaid}, ${time}${isNew ? ', new' : ''}. Fold this message`} onClick={toggle} />
          )}
          <span className="ib-a11y-skip" aria-hidden={hide}>
            {isAgent ? (
              <AuthorMark author={message.author} big />
            ) : (
              <span className="ib-mk ib-big">
                <Icon name="reply" />
              </span>
            )}
          </span>
          <Tip content={authorLabel || named ? d.nameTip : one ? name : null} cut={!authorLabel && !named}>
            {authorLabel ? (
              labelledAuthorName({ agent: name, label: authorLabel, open: true, hidden: hide, onFold: one ? undefined : toggle })
            ) : (
              <span className="ib-fl-nm ib-who" aria-hidden={hide} data-session-name={named ? '' : undefined} onClick={named && !one ? toggle : undefined}>
                <bdi>{name}</bdi>
                {named && !hide && <span className="ib-sr">, {kind}</span>}
              </span>
            )}
          </Tip>
          <span className="ib-fl-meta">
            <span className="ib-fl-in" aria-hidden={hide}>
              in <bdi>{d.folder}</bdi>{' '}
            </span>
            <span className="ib-fl-to" aria-hidden={hide}>
              <span className="ib-to-sep">·</span>{' '}
              <span className="ib-to">
                to {d.toLabel}
                {d.ended && <SessionEndedMark />}
                {d.tagNames !== null && (
                  <span data-tagged-names="">
                    {' · tagged '}
                    {d.tagNames}
                  </span>
                )}
                {!isAgent && message.board_request === true && (
                  <span className="ib-m-board" data-board-request="">
                    <span className="ib-to-sep">·</span>
                    <Icon name="board" />
                    <span aria-hidden="true">Board</span>
                    <span className="ib-sr">Board tracking asked</span>
                  </span>
                )}
              </span>
            </span>
            {count && <span className="ib-fl-files">{count}</span>}
          </span>
          <span className="ib-fl-chips" />
          <span className="ib-fl-tm">
            {isNew && <span className="ib-newtag">New</span>}
            <Tip content={d.fullWhen}>
              <span data-full-when="">{time}</span>
            </Tip>
            {d.live && (isAgent || (!isInboxNote(message) && !message.ack_of)) && (
              <Tip content="Reply">
                <button
                  type="button"
                  className="ib-mut"
                  onPointerDown={() => acts.current.quoteAtPress(message.id)}
                  onClick={() => acts.current.replyToMessage(message)}
                  aria-label="Reply"
                  data-message-reply={message.id}
                >
                  <Icon name="reply" size={15} />
                </button>
              </Tip>
            )}
            {more}
          </span>
        </div>
      )}
    />
  );
}
