import type { EarlierReply } from '../earlierComments';

/**
 * The earlier comments themselves, by the reply that carried them. Read only, and it knows nothing of what holds it:
 * the host brings its own title, close and scrolling.
 */
export function EarlierCommentsList({ replies }: { replies: readonly EarlierReply[] }) {
  return (
    <div className="ib-earlier-comments">
      {replies.map((reply) => (
        <section key={reply.replyId} className="ib-earlier-reply">
          <div className="ib-earlier-sub">{reply.label}</div>
          {reply.comments.map((comment) => (
            <div key={comment.id} className="ib-earlier-item" data-earlier-comment={comment.id}>
              <p className="ib-earlier-t">{comment.words}</p>
              {comment.spot && <span className="ib-earlier-m">{comment.spot}</span>}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
