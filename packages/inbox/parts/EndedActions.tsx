import { Icon } from '../icons';

export function EndedActions({ sendElsewhere, onArchive }: { sendElsewhere: (() => void) | null; onArchive: () => void }) {
  return (
    <div className="ib-footended" data-foot-ended="">
      {sendElsewhere && (
        <button type="button" className="ib-btn" data-ended-send="" onClick={sendElsewhere}>
          <Icon name="forward" size={15} />
          Send to another session
        </button>
      )}
      <button type="button" className="ib-btn" data-ended-archive="" onClick={onArchive}>
        Archive
      </button>
    </div>
  );
}

export function DeliveredLine({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <div className="ib-delivered" data-delivery="delivered">
      <span className="ib-dl-main">
        <Icon name="check" size={14} />
        <span className="ib-dl-text">{text}</span>
      </span>
    </div>
  );
}
