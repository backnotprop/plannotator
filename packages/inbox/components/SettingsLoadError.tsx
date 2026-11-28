import { Icon } from '../icons';

/** Settings' callout when their read failed (Settings.tsx), with Try again. */
export function LoadError({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  return (
    <div className="ib-callout ib-err" role="alert" data-settings-load-error="">
      <Icon name="xCircle" />
      <span>
        <b>Settings did not load.</b> {error} It may have stopped: run <code>plannotator inbox</code>, then{' '}
        <button type="button" className="ib-lnk" onClick={onRetry}>
          Try again
        </button>
        .
      </span>
    </div>
  );
}
