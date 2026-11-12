import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { InboxCloudAgentView } from '@plannotator/core/inbox-cloud';
import { inboxApi, type CloudAgentTest, type CloudAgentsModel } from '../api';
import { Icon } from '../icons';
import { errorText, noEnter, wakeHintOf } from './cloudShared';

type OnModel = (model: CloudAgentsModel) => void;

export function CloudLine({ k, v, children, data }: { k: string; v: ReactNode; children?: ReactNode; data?: Record<string, string> }) {
  return (
    <div className="ib-cl-line" {...data}>
      <span className="ib-cl-line-t">
        <span className="ib-cl-k">{k}</span>
        <span className="ib-cl-v">{v}</span>
      </span>
      {children && <span className="ib-cl-line-a">{children}</span>}
    </div>
  );
}

export function CloudWakeRow({ agent, onModel }: { agent: InboxCloudAgentView; onModel: OnModel }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  if (agent.preset === 'muse') {
    return <CloudLine k="Wake address" v="Not needed: it checks for your messages itself." data={{ 'data-cloud-checks-itself': '' }} />;
  }
  if (agent.wake) return <TestLine agent={agent} onModel={onModel} />;
  if (open) {
    return (
      <WakeForm
        agent={agent}
        onModel={onModel}
        onCancel={() => {
          setOpen(false);
          requestAnimationFrame(() => opener.current?.focus());
        }}
      />
    );
  }
  return (
    <CloudLine k="Wake address" v="Not set. Add it so it starts when you write to it." data={{ 'data-cloud-wake-offer': '' }}>
      <button ref={opener} type="button" className="ib-btn" onClick={() => setOpen(true)} data-cloud-wake-open="">
        Add wake address
      </button>
    </CloudLine>
  );
}

function WakeForm({ agent, onModel, onCancel }: { agent: InboxCloudAgentView; onModel: OnModel; onCancel: () => void }) {
  const hint = wakeHintOf(agent.preset);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const ready = !busy && url.trim() !== '' && key.trim() !== '';
  const save = () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    inboxApi
      .setCloudWake(agent.session, url.trim(), key)
      .then(onModel)
      .catch((cause) => {
        setError(errorText(cause));
        setBusy(false);
      });
  };
  return (
    <div className="ib-cl-wake" data-cloud-wake-form="">
      <span className="ib-cl-k">Wake address</span>
      <p className="ib-cl-p">{hint.where}</p>
      <label className="ib-mfield">
        <span className="ib-l">Webhook address</span>
        <input ref={first} type="url" className="ib-fbk-contact ib-mono" placeholder={hint.url} spellCheck={false} autoComplete="off" value={url} readOnly={busy} onChange={(event) => setUrl(event.target.value)} onKeyDown={noEnter} data-cloud-url="" />
      </label>
      <label className="ib-mfield">
        <span className="ib-l">Key</span>
        <input type="password" className="ib-fbk-contact ib-mono" placeholder={hint.key} spellCheck={false} autoComplete="off" value={key} readOnly={busy} onChange={(event) => setKey(event.target.value)} onKeyDown={noEnter} data-cloud-key="" />
      </label>
      {error && (
        <div className="ib-callout ib-err" role="alert">
          <Icon name="xCircle" />
          <span>{error}</span>
        </div>
      )}
      <div className="ib-mform-f">
        <button type="button" className="ib-btn ib-ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={`ib-btn ib-pri${ready ? '' : ' ib-dim'}`} aria-disabled={!ready} onClick={save} data-cloud-wake-save="">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function TestLine({ agent, onModel }: { agent: InboxCloudAgentView; onModel: OnModel }) {
  const [state, setState] = useState<{ busy: boolean; test: CloudAgentTest | null; error: string | null }>({ busy: false, test: null, error: null });
  const run = () => {
    setState({ busy: true, test: null, error: null });
    inboxApi
      .testCloudAgent(agent.session)
      .then((answer) => {
        setState({ busy: false, test: answer.test, error: null });
        onModel(answer);
      })
      .catch((cause) => setState({ busy: false, test: null, error: errorText(cause) }));
  };
  const said = state.test?.words ?? state.error;
  const result = (
    <span className={`ib-cl-said${state.test?.started ? ' ib-cl-ok' : said ? ' ib-cl-bad' : ''}`} role="status" data-cloud-test-result={state.test ? (state.test.started ? 'started' : 'not-started') : undefined}>
      {said && <Icon name={state.test?.started ? 'check' : 'xCircle'} size={14} />}
      {said ?? 'Set. It starts when you write to it.'}
      {state.test?.run_url && (
        <>
          {' '}
          <a href={state.test.run_url} target="_blank" rel="noreferrer noopener">
            Open the run
          </a>
        </>
      )}
    </span>
  );
  return (
    <CloudLine k="Wake address" v={result}>
      <button type="button" className="ib-btn" disabled={state.busy} onClick={run} data-cloud-test="">
        {state.busy ? 'Sending…' : 'Send a test'}
      </button>
    </CloudLine>
  );
}

export function CloudNewKey({ agent, onModel }: { agent: InboxCloudAgentView; onModel: OnModel }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !busy && key.trim() !== '';
  return (
    <div className="ib-cl-wake" data-cloud-new-key="">
      <span className="ib-cl-warn">
        <Icon name="warn" size={14} /> The routine refused this key. Paste the new key.
      </span>
      <div className="ib-cl-inline">
        <input
          type="password"
          className="ib-fbk-contact ib-mono"
          aria-label={`New key for ${agent.name}`}
          placeholder={wakeHintOf(agent.preset).key}
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={noEnter}
        />
        <button
          type="button"
          className={`ib-btn ib-pri${ready ? '' : ' ib-dim'}`}
          aria-disabled={!ready}
          onClick={() => {
            if (!ready) return;
            setBusy(true);
            setError(null);
            inboxApi
              .rekeyCloudAgent(agent.session, key)
              .then(onModel)
              .catch((cause) => {
                setError(errorText(cause));
                setBusy(false);
              });
          }}
        >
          Save key
        </button>
      </div>
      {error && <span className="ib-cl-said ib-cl-bad">{error}</span>}
    </div>
  );
}
