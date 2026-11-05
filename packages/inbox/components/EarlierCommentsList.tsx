import type { EarlierReply } from '../earlierComments';

/**
 * The earlier comments themselves, by the reply that carried them. Read only, dimmed like a resolved comment, and it
 * knows nothing of what holds it (EarlierSection.tsx, in the comments column).
 */
export function EarlierCommentsList({ replies }: { replies: readonly EarlierReply[] }) {
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
}
