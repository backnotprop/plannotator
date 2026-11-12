import { memo } from 'react';
import type { EarlierReply } from '../earlierComments';

export const EarlierCommentsList = memo(function EarlierCommentsList({ replies }: { replies: readonly EarlierReply[] }) {
  return (
    <div>
      {replies.map((reply) => (
        <section key={reply.replyId} className="ib-earlier-reply">
          <div className="ib-earlier-sub">{reply.label}</div>
          {reply.comments.map((comment) => (
            <div key={comment.id} className="ib-earlier-item" data-earlier-comment={comment.id}>
              {comment.spot && <p className="ib-earlier-q">{comment.spot}</p>}
              <p className="ib-earlier-t">{comment.words}</p>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
});
