import { useState } from 'react';
import { createPortal } from 'react-dom';
import { CommentPopover } from '@plannotator/ui/components/CommentPopover';
import { AnnotationType } from '@plannotator/ui/types';
import { getIdentity } from '@plannotator/ui/utils/identity';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import { InboxApiError, inboxApi } from '../api';
import { LIVE_FRAME_SANDBOX } from '../prototypes';

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function WebPage(props: {
  threadId: string;
  siteId: string;
  url: string;
  framed: boolean;
  title: string;
  commentAnchor: HTMLElement | null;
  onCommentDone: () => void;
  onSaved: (record: InboxAnnotationRecord) => void;
}) {
  const { threadId, siteId } = props;
  const [error, setError] = useState<string | null>(null);

  const save = async (text: string) => {
    props.onCommentDone();
    try {
      const answer = await inboxApi.saveLiveAnnotation(threadId, siteId, {
        id: `global-${Date.now()}`,
        blockId: '',
        startOffset: 0,
        endOffset: 0,
        type: AnnotationType.GLOBAL_COMMENT,
        text: text.trim(),
        originalText: '',
        author: getIdentity(),
        createdA: Date.now(),
      });
      props.onSaved(answer.annotation);
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The comment was not saved.');
    }
  };

  return (
    <>
      {error ? (
        <p className="ib-pw-line" role="alert">
          {error}
        </p>
      ) : props.framed ? (
        <iframe
          className="ib-pw-web"
          src={inboxApi.liveFrameUrl(threadId, siteId)}
          sandbox={LIVE_FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          title={props.title}
          data-prototype-web=""
        />
      ) : (
        <p className="ib-pw-line" data-prototype-not-framed="">
          {hostOf(props.url)} does not let other pages show it.{' '}
          <a className="ib-pw-again" href={props.url} target="_blank" rel="noopener noreferrer">
            Open it in a new tab
          </a>
          , then come back to pick.
        </p>
      )}
      {props.commentAnchor &&
        createPortal(
          <CommentPopover
            anchorEl={props.commentAnchor}
            contextText=""
            isGlobal
            draftKey={`html:global:src:${props.url}`}
            onSubmit={(text) => void save(text)}
            allowImages={false}
            onClose={props.onCommentDone}
          />,
          document.body,
        )}
    </>
  );
}
