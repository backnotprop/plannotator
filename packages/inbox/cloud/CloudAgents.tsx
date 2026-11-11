import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { INBOX_CLOUD_PRESET_NAMES, INBOX_CLOUD_PRESETS, INBOX_CLOUD_ROUTINE_BLOCK, type InboxCloudAgentView, type InboxCloudPreset } from '@plannotator/core/inbox-cloud';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { inboxApi, InboxApiError, type CloudAgentTest, type CloudAgentsModel } from '../api';
import { HostMark, Icon } from '../icons';

/** What each preset's fields ask for, and where the person finds them. */
const HINTS: Record<InboxCloudPreset, { url: string; key: string; where: string }> = {
  'claude-routine': {
    url: 'https://api.anthropic.com/v1/claude_code/routines/trig_…/fire',
    key: 'sk-ant-oat01-…',
    where: 'In the routine on claude.ai/code: Add another trigger → API → Generate token. Copy the address and the token.',
  },
  'grok-bot': {
    url: 'The routine’s “POST to” address',
    key: 'The routine’s key',
    where: 'Ask Grok Bot to add a webhook trigger to the routine. Its Webhook section shows the address and the key.',
  },
  other: {
    url: 'https://…',
    key: 'Sent as Authorization: Bearer',
    where: 'Any address that takes a POST with a Bearer key and a JSON body.',
  },
};

const errorText = (cause: unknown) => (cause instanceof InboxApiError ? cause.message : 'The Inbox did not answer. Try again.');
/** Enter never submits here (the Inbox adds no keys): only the buttons do. */
const noEnter = (event: KeyboardEvent) => {
  if (event.key === 'Enter') event.preventDefault();
};

/**
 * Settings → Devices → Cloud agents (packages/server/inbox-cloud-agents.ts): pair a Claude Code or Grok Bot routine
 * by its webhook, and the Inbox wakes it when the person writes to it. The window never learns the address or the
 * key back, only that one is set. Hidden where the route refuses (a tailnet guest).
 */
export function CloudAgentsSection() {
  const [model, setModel] = useState<CloudAgentsModel | null>(null);
  const [hidden, setHidden] = useState(false);
  const [adding, setAdding] = useState(false);
  /** The agent just paired: its block to paste and its test. */
  const [fresh, setFresh] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      setModel(await inboxApi.cloudAgents());
    } catch {
      setHidden(true);
    }
  }, []);
  useEffect(() => void load(), [load]);
  if (hidden || !model) return null;

  const freshAgent = model.agents.find((agent) => agent.session === fresh) ?? null;
  return (
    <section className="ib-sgroup" data-settings-cloud="" aria-labelledby="ib-g-cloud">
      <h2 id="ib-g-cloud">Cloud agents</h2>
      <p>Wake a Claude Code or Grok Bot routine when you write to it. It answers where it works, such as a pull request.</p>
      <div className="ib-card" aria-label="Cloud agents">
        {model.agents.map((agent) =>
          agent.session === fresh ? (
            <PairedPanel key={agent.session} agent={agent} onModel={setModel} onDone={() => setFresh(null)} />
          ) : (
            <AgentRow key={agent.session} agent={agent} onModel={setModel} />
          ),
        )}
        {adding ? (
          <PairForm
            projects={model.projects}
            onCancel={() => {
              setAdding(false);
              requestAnimationFrame(() => addButton.current?.focus());
            }}
            onPaired={(next, session) => {
              setModel(next);
              setAdding(false);
              setFresh(session);
            }}
          />
        ) : (
          !freshAgent && (
            <div className="ib-prow">
              <span className="ib-txt">
                <span className="ib-l">{model.agents.length > 0 ? 'Pair another cloud agent' : 'No cloud agent paired yet'}</span>
              </span>
              <span className="ib-ctl">
                <button ref={addButton} type="button" className={`ib-btn${model.agents.length === 0 ? ' ib-pri' : ''}`} onClick={() => setAdding(true)} data-cloud-pair-start="">
                  Pair a cloud agent
                </button>
              </span>
            </div>
          )
        )}
      </div>
    </section>
  );
}

/** A paired agent: its name, kind and project; Send a test and Remove; a refused key asks for the new one. */
function AgentRow({ agent, onModel }: { agent: InboxCloudAgentView; onModel: (model: CloudAgentsModel) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="ib-cl-agent" data-cloud-agent={agent.session}>
      <div className="ib-prow">
        <span className="ib-tile">
          <HostMark host="cloud" />
        </span>
        <span className="ib-txt">
          <span className="ib-l">{agent.name}</span>
          <span className="ib-desc">
            {INBOX_CLOUD_PRESET_NAMES[agent.preset]}
            {agent.project ? <> · in {agent.project.name}</> : null}
          </span>
        </span>
        <span className="ib-ctl">
          <button
            type="button"
            className="ib-del-l"
            disabled={busy}
            aria-label={`Remove ${agent.name}`}
            data-cloud-remove=""
            onClick={() => {
              setBusy(true);
              inboxApi
                .removeCloudAgent(agent.session)
                .then(onModel)
                .catch((cause) => {
                  setError(errorText(cause));
                  setBusy(false);
                });
            }}
          >
            Remove
          </button>
        </span>
      </div>
      {agent.key_rejected_at && <NewKey agent={agent} onModel={onModel} />}
      <TestLine agent={agent} onModel={onModel} />
      {error && (
        <div className="ib-callout ib-err ib-in-card" role="alert">
          <Icon name="xCircle" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

/** "The routine refused this key": one field for the new one. Held wakes go once it is saved. */
function NewKey({ agent, onModel }: { agent: InboxCloudAgentView; onModel: (model: CloudAgentsModel) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !busy && key.trim() !== '';
  return (
    <div className="ib-cl-sub" data-cloud-new-key="">
      <span className="ib-cl-warn">
        <Icon name="warn" size={14} /> The routine refused this key. Paste the new key.
      </span>
      <div className="ib-cl-inline">
        <input
          type="password"
          className="ib-fbk-contact ib-mono"
          aria-label={`New key for ${agent.name}`}
          placeholder={HINTS[agent.preset].key}
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

/** Send a test: fires the webhook once and says plainly whether a run started (with its link when there is one). */
function TestLine({ agent, onModel, primary }: { agent: InboxCloudAgentView; onModel: (model: CloudAgentsModel) => void; primary?: boolean }) {
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
  return (
    <div className="ib-cl-sub ib-cl-test">
      <button type="button" className={`ib-btn${primary ? ' ib-pri' : ''}`} disabled={state.busy} onClick={run} data-cloud-test="">
        {state.busy ? 'Sending…' : 'Send a test'}
      </button>
      <span className={`ib-cl-said${state.test?.started ? ' ib-cl-ok' : said ? ' ib-cl-bad' : ''}`} role="status" data-cloud-test-result={state.test ? (state.test.started ? 'started' : 'not-started') : undefined}>
        {said && <Icon name={state.test?.started ? 'check' : 'xCircle'} size={14} />}
        {said}
        {state.test?.run_url && (
          <>
            {' '}
            <a href={state.test.run_url} target="_blank" rel="noreferrer noopener">
              Open the run
            </a>
          </>
        )}
      </span>
    </div>
  );
}

/** Right after Pair: the block to paste into the routine, Copy, and Send a test. */
function PairedPanel({ agent, onModel, onDone }: { agent: InboxCloudAgentView; onModel: (model: CloudAgentsModel) => void; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const head = useRef<HTMLDivElement>(null);
  useEffect(() => head.current?.focus(), []);
  return (
    <div className="ib-mform ib-cl-paired" data-cloud-paired={agent.session}>
      <div className="ib-cl-head" tabIndex={-1} ref={head}>
        <HostMark host="cloud" />
        <span className="ib-l">Paired {agent.name}</span>
      </div>
      <p className="ib-cl-p">Paste this into the routine’s instructions, so it knows what a wake is:</p>
      <pre className="ib-cl-block" data-cloud-block="">
        {INBOX_CLOUD_ROUTINE_BLOCK}
      </pre>
      <div className="ib-cl-row">
        <button
          type="button"
          className="ib-btn"
          onClick={() => void copyTextToClipboard(INBOX_CLOUD_ROUTINE_BLOCK).then((ok) => setCopied(ok))}
          data-cloud-copy=""
        >
          <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="ib-cl-p">Then write to {agent.name} from New message. Each message you send it starts a run.</p>
      <TestLine agent={agent} onModel={onModel} primary />
      <div className="ib-mform-f">
        <button type="button" className="ib-btn ib-ghost" onClick={onDone} data-cloud-done="">
          Done
        </button>
      </div>
    </div>
  );
}

/** Pair: the kind, a name, the webhook's address and key, and (with more than one) the project it works in. */
function PairForm({ projects, onCancel, onPaired }: { projects: CloudAgentsModel['projects']; onCancel: () => void; onPaired: (model: CloudAgentsModel, session: string) => void }) {
  const [preset, setPreset] = useState<InboxCloudPreset>('claude-routine');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [project, setProject] = useState<string | null>(projects[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const ready = !busy && name.trim() !== '' && url.trim() !== '' && key.trim() !== '';
  const hint = HINTS[preset];

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await inboxApi.pairCloudAgent({ name: name.trim(), preset, url: url.trim(), key, project_id: project });
      onPaired(answer, answer.agent.session);
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };

  return (
    <div className="ib-mform" data-cloud-pair-form="">
      <div className="ib-seg ib-cl-seg" role="radiogroup" aria-label="Kind of agent">
        {INBOX_CLOUD_PRESETS.map((id) => (
          <label key={id} className="ib-seg-o" data-on={preset === id ? '' : undefined}>
            <input type="radio" name="ib-cloud-preset" value={id} checked={preset === id} onChange={() => setPreset(id)} />
            {INBOX_CLOUD_PRESET_NAMES[id].replace(' routine', '')}
          </label>
        ))}
      </div>
      <p className="ib-cl-p ib-cl-where">{hint.where}</p>
      <label className="ib-mfield">
        <span className="ib-l">Name</span>
        <input ref={first} type="text" className="ib-fbk-contact" placeholder="Nightly fixer" maxLength={60} autoComplete="off" value={name} readOnly={busy} onChange={(event) => setName(event.target.value)} onKeyDown={noEnter} data-cloud-name="" />
      </label>
      <label className="ib-mfield">
        <span className="ib-l">Webhook address</span>
        <input type="url" className="ib-fbk-contact ib-mono" placeholder={hint.url} spellCheck={false} autoComplete="off" value={url} readOnly={busy} onChange={(event) => setUrl(event.target.value)} onKeyDown={noEnter} data-cloud-url="" />
      </label>
      <label className="ib-mfield">
        <span className="ib-l">Key</span>
        <input type="password" className="ib-fbk-contact ib-mono" placeholder={hint.key} spellCheck={false} autoComplete="off" value={key} readOnly={busy} onChange={(event) => setKey(event.target.value)} onKeyDown={noEnter} data-cloud-key="" />
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
