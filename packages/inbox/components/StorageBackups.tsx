import { useEffect, useState } from 'react';
import { inboxApi, type InboxStorageModel } from '../api';
import { formatBytes } from '../format';

/** Settings → Storage's Backup group: the dated copy a move into SQLite left. Remove asks twice, as Delete does: a removed backup does not come back. */
type Backup = NonNullable<InboxStorageModel['backups']>[number];

function backupLabel(backup: Backup): string {
  const day = new Date(`${backup.date}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return backup.kind === 'jsonl' ? `Inbox files from before the upgrade, ${day}` : `Inbox database, ${day}`;
}

function RemoveLink({ what, onRemove }: { what: string; onRemove: () => Promise<void> }) {
  const [state, setState] = useState<'idle' | 'confirm' | 'busy'>('idle');
  useEffect(() => {
    if (state !== 'confirm') return;
    const timer = setTimeout(() => setState('idle'), 4000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className={`ib-del-l${state === 'confirm' ? ' ib-confirm' : ''}`}
      disabled={state === 'busy'}
      aria-label={state === 'confirm' ? `Remove: ${what} (click again to remove)` : `Remove: ${what}`}
      onClick={() => {
        if (state === 'idle') return setState('confirm');
        if (state !== 'confirm') return;
        setState('busy');
        onRemove().finally(() => setState('idle'));
      }}
    >
      {state === 'confirm' ? 'Remove? Click again' : 'Remove'}
    </button>
  );
}

export function StorageBackups({ store, onChanged }: { store: InboxStorageModel; onChanged?: () => void }) {
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState(false);
  const backups = (store.backups ?? []).filter((backup) => !removed.has(backup.name));
  if (backups.length === 0) return null;
  const remove = async (name: string) => {
    setError(false);
    try {
      await inboxApi.removeBackup(name);
      setRemoved((current) => new Set(current).add(name));
      onChanged?.();
    } catch {
      setError(true);
    }
  };
  return (
    <section className="ib-sgroup" aria-labelledby="ib-g-backup" data-store-backups="">
      <h2 id="ib-g-backup">Backup</h2>
      <p>Your Inbox as it was before the upgrade, kept in case. Nothing reads it now.</p>
      <div className="ib-card">
        <table className="ib-stbl">
          <tbody>
            {backups.map((backup) => (
              <tr key={backup.name} data-store-backup={backup.name}>
                <td>{backupLabel(backup)}</td>
                <td className="ib-n">{formatBytes(backup.bytes)}</td>
                <td className="ib-a">
                  <RemoveLink what={backupLabel(backup)} onRemove={() => remove(backup.name)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && (
        <p role="alert" data-store-backup-error="">
          The backup was not removed. Try again.
        </p>
      )}
    </section>
  );
}
