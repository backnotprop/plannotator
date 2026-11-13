import { useEffect, useRef, useState } from 'react';
import type { InboxCloudAgentView, InboxCloudSetup } from '@plannotator/core/inbox-cloud';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { Icon } from '../icons';
import { CloudStatus } from './CloudStatus';

function CopyBox({ text, data, label, primary }: { text: string; data: string; label: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ib-cl-box" data-cloud-copy-block={data}>
      <div className="ib-cl-box-bar">
        <span className="ib-cl-note">{label}</span>
        <button type="button" className={`ib-btn ib-cl-copy-b${primary ? ' ib-pri' : ''}`} onClick={() => void copyTextToClipboard(text).then((ok) => setCopied(ok))} data-cloud-copy={data}>
          <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="ib-cl-block">{text}</pre>
    </div>
  );
}

export function CloudSetup({ agent, setup, busy, onRetry, onDone }: { agent: InboxCloudAgentView; setup: InboxCloudSetup | null; busy: boolean; onRetry: () => void; onDone: () => void }) {
  const head = useRef<HTMLDivElement>(null);
  useEffect(() => head.current?.focus(), [setup]);
  const connected = agent.link.state === 'connected';
  return (
    <div className="ib-cl-step" data-cloud-setup={setup ? setup.kind : 'no-relay'} tabIndex={-1} ref={head}>
      {!setup ? (
        <>
          <p className="ib-cl-step-t">Nothing to send {agent.name} yet</p>
          <p className="ib-cl-p" role="alert" data-cloud-no-relay="">
            This computer could not reach the relay. Check that this computer is online, then try again.
          </p>
        </>
      ) : setup.kind === 'message' ? (
        <>
          <p className="ib-cl-step-t">Send this to {agent.name}. It sets itself up.</p>
          <CopyBox text={setup.message} data="message" label="Shown only now." primary={!connected} />
        </>
      ) : (
        <>
          <p className="ib-cl-step-t">Add these to {agent.name}’s routine</p>
          <p className="ib-cl-p">In the routine: Edit → Advanced settings → Cloud environment → its settings icon. Then Save changes.</p>
          <CopyBox text={setup.variable} data="variable" label="Environment variables · shown only now" />
          <CopyBox text={setup.domains} data="domains" label="Network access: Limited. Allowed domains" />
          <CopyBox text={setup.instructions} data="instructions" label="Add to the routine’s instructions" />
        </>
      )}
      <div className="ib-cl-step-f">
        {setup && <CloudStatus agent={agent} />}
        <span className="ib-cl-step-acts">
          <button type="button" className={`ib-btn${connected ? ' ib-pri' : ' ib-ghost'}`} onClick={onDone} data-cloud-done="">
            Done
          </button>
          {!setup && (
            <button type="button" className="ib-btn ib-pri" disabled={busy} onClick={onRetry} data-cloud-retry="">
              {busy ? 'Trying…' : 'Try again'}
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
