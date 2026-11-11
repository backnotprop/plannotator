/**
 * A Send on its way, drawn as the person's own reply is (data/actions/sendDraw.ts): their words, and "Sending…" in
 * place of the delivery line, as a reply held for another machine (HeldWrites.tsx). It goes once the reply lands
 * (the thread draws it) or the Send stops (the words are still in the box, which says why).
 */
import type { SendDrawn } from '../data/actions/sendDraw';
import { Icon } from '../icons';

export function SendingReply({ sends }: { sends: readonly SendDrawn[] }) {
  return (
    <>
      {sends.map((send) => (
        <article key={send.key} className="ib-message" data-author="person" data-message-article={send.key} data-sending="">
          <div className="ib-fline ib-is-open">
            <span className="ib-mk ib-big" aria-hidden="true">
              <Icon name="reply" />
            </span>
            <span className="ib-fl-nm ib-who">You</span>
          </div>
          <div className="ib-msg">
            <p className="ib-held-words" dir="auto">
              {send.words}
            </p>
            <div className="ib-delivered" data-delivery="queued">
              <span className="ib-dl-main">
                <Icon name="send" size={14} />
                <span className="ib-dl-text">Sending…</span>
              </span>
            </div>
          </div>
        </article>
      ))}
    </>
  );
}
