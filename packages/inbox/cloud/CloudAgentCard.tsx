import { useState } from 'react';
import { inboxCloudHostOf, INBOX_CLOUD_PRESET_NAMES, type InboxCloudAgentView, type InboxCloudSetup } from '@plannotator/core/inbox-cloud';
import { inboxApi, type CloudAgentsModel } from '../api';
import { HostMark, Icon } from '../icons';
import { errorText, type Fresh } from './cloudShared';
import { CloudSetup } from './CloudSetup';
import { CloudStatus } from './CloudStatus';
import { CloudLine, CloudNewKey, CloudWakeRow } from './CloudWake';

export function CloudAgentCard({
  agent,
  fresh,
  onModel,
  onSetup,
  onDone,
}: {
  agent: InboxCloudAgentView;
  fresh: Fresh | null;
  onModel: (model: CloudAgentsModel) => void;
  onSetup: (setup: InboxCloudSetup | null) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<'remove' | 'pairing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const newPairing = () => {
    setBusy('pairing');
    setError(null);
    inboxApi
      .newCloudPairing(agent.session)
      .then((answer) => {
        onModel(answer);
        onSetup(answer.setup);
      })
      .catch((cause) => setError(errorText(cause)))
      .finally(() => setBusy(null));
  };
  const remove = () => {
    setBusy('remove');
    inboxApi
      .removeCloudAgent(agent.session)
      .then(onModel)
      .catch((cause) => {
        setError(errorText(cause));
        setBusy(null);
      });
  };
  return (
    <div className="ib-cl-agent" data-cloud-agent={agent.session} data-cloud-link={agent.link.state}>
      <div className="ib-prow">
        <HostMark host={inboxCloudHostOf(agent.preset)} agent={agent.session} big />
        <span className="ib-txt">
          <span className="ib-l">{agent.name}</span>
          <span className="ib-desc">
            {INBOX_CLOUD_PRESET_NAMES[agent.preset]}
            {agent.project ? <> · in {agent.project.name}</> : null}
          </span>
          {!fresh && <CloudStatus agent={agent} />}
        </span>
        <span className="ib-ctl">
          <button type="button" className="ib-del-l" disabled={busy !== null} aria-label={`Remove ${agent.name}`} data-cloud-remove="" onClick={remove}>
            Remove
          </button>
        </span>
      </div>
      {fresh ? (
        <CloudSetup agent={agent} setup={fresh.setup} busy={busy === 'pairing'} onRetry={newPairing} onDone={onDone} />
      ) : (
        <div className="ib-cl-more">
          {agent.key_rejected_at && agent.preset !== 'muse' && <CloudNewKey agent={agent} onModel={onModel} />}
          <CloudWakeRow agent={agent} onModel={onModel} />
          <CloudLine k="Pairing" v="A new one stops the old one working." data={{ 'data-cloud-pairing-row': '' }}>
            <button type="button" className="ib-btn" disabled={busy !== null} onClick={newPairing} data-cloud-new-pairing="">
              {busy === 'pairing' ? 'Making…' : 'New pairing'}
            </button>
          </CloudLine>
        </div>
      )}
      {error && (
        <div className="ib-callout ib-err ib-in-card" role="alert">
          <Icon name="xCircle" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
