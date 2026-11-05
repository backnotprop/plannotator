/**
 * What the question circle beside Trust and start opens (approval "inbox-launch-trust-compose"): the folder the trust
 * lands on and short fact lines, with no button: the press on Trust and start is the consent. The Inbox's popover at
 * the button, its bottom sheet on a phone; nothing under it moves. Both sit over compose's error line, so while they
 * are open that line is said here (`said`: a folder that changed since the press, or a trust that failed).
 */
export function TrustDetails({ folder, facts, said }: { folder: string; facts: readonly string[]; said: string | null }) {
  return (
    <div className="ib-state ib-nmpop ib-cp-trustask" id="ib-cp-trust-pop" role="dialog" aria-labelledby="ib-cp-trust-q" data-compose-trust-ask="">
      <h5 id="ib-cp-trust-q">
        Trust <bdi>{folder}</bdi>?
      </h5>
      <p>
        {facts.map((fact) => (
          <span key={fact}>{fact}</span>
        ))}
      </p>
      {said && (
        <p className="ib-cp-trustsaid" role="alert" data-compose-error="">
          {said}
        </p>
      )}
    </div>
  );
}
