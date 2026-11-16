import type { TakeBackState } from '../takeBack';

export function TakeBackLine({ state, id }: { state: TakeBackState | null; id: string }) {
  if (state?.id !== id || !state.line) return null;
  return (
    <p className="ib-error" role="status" data-take-back-line="">
      {state.line}
    </p>
  );
}

export function TakeBackNote({ state }: { state: TakeBackState | null }) {
  if (!state?.note) return null;
  return (
    <p className="ib-takeback-note" role="status" data-take-back-note="">
      {state.note}
    </p>
  );
}
