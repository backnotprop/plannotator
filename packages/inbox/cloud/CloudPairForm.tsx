import { useEffect, useRef, useState } from 'react';
import { inboxCloudHostOf, INBOX_CLOUD_PRESET_LABELS, INBOX_CLOUD_PRESETS, type InboxCloudPreset, type InboxCloudSetup } from '@plannotator/core/inbox-cloud';
import { inboxApi, type CloudAgentsModel } from '../api';
import { HostMark, Icon } from '../icons';
import { errorText, noEnter } from './cloudShared';

function KindPicker({ value, disabled, onChange }: { value: InboxCloudPreset; disabled: boolean; onChange: (preset: InboxCloudPreset) => void }) {
  return (
    <fieldset className="ib-cl-kinds-f" disabled={disabled}>
      <legend className="ib-l">Kind</legend>
      <div className="ib-cl-kinds">
        {INBOX_CLOUD_PRESETS.map((id) => (
          <label key={id} className="ib-cl-kind" data-on={value === id ? '' : undefined} data-cloud-kind={id}>
            <input type="radio" name="ib-cloud-preset" value={id} checked={value === id} onChange={() => onChange(id)} />
            <HostMark host={inboxCloudHostOf(id)} />
            <span className="ib-cl-kind-n">{INBOX_CLOUD_PRESET_LABELS[id]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function CloudPairForm({
  projects,
  onCancel,
  onPaired,
}: {
  projects: CloudAgentsModel['projects'];
  onCancel: () => void;
  onPaired: (model: CloudAgentsModel, session: string, setup: InboxCloudSetup | null) => void;
}) {
  const [preset, setPreset] = useState<InboxCloudPreset>('claude-routine');
  const [name, setName] = useState('');
  const [project, setProject] = useState<string | null>(projects[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const ready = !busy && name.trim() !== '';

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await inboxApi.pairCloudAgent({ name: name.trim(), preset, project_id: project });
      onPaired(answer, answer.agent.session, answer.setup);
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };

  return (
    <div className="ib-mform ib-cl-pair" data-cloud-pair-form="">
      <span className="ib-cl-step-t">Pair a cloud agent</span>
      <KindPicker value={preset} disabled={busy} onChange={setPreset} />
      <label className="ib-mfield">
        <span className="ib-l">Name</span>
        <input ref={first} type="text" className="ib-fbk-contact" placeholder="Nightly fixer" maxLength={60} autoComplete="off" value={name} readOnly={busy} onChange={(event) => setName(event.target.value)} onKeyDown={noEnter} data-cloud-name="" />
      </label>
      {projects.length > 1 && (
        <label className="ib-mfield">
          <span className="ib-l">Its threads go in</span>
          <select className="ib-fbk-contact" value={project ?? ''} disabled={busy} onChange={(event) => setProject(event.target.value || null)} data-cloud-project="">
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <div className="ib-callout ib-err" role="alert" data-cloud-pair-error="">
          <Icon name="xCircle" />
          <span>{error}</span>
        </div>
      )}
      <div className="ib-mform-f">
        <button type="button" className="ib-btn ib-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={`ib-btn ib-pri${ready ? '' : ' ib-dim'}`} aria-disabled={!ready} onClick={() => void submit()} data-cloud-pair-submit="">
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </div>
    </div>
  );
}
