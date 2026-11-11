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
