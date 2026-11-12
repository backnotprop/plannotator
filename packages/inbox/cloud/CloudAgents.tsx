import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  inboxCloudHostOf,
  INBOX_CLOUD_PRESET_LABELS,
  INBOX_CLOUD_PRESET_NAMES,
  INBOX_CLOUD_PRESETS,
  type InboxCloudAgentView,
  type InboxCloudPreset,
  type InboxCloudSetup,
} from '@plannotator/core/inbox-cloud';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { inboxApi, InboxApiError, type CloudAgentTest, type CloudAgentsModel } from '../api';
import { HostMark, Icon } from '../icons';
import { relativeWords, useRelativeClock } from '../relativeTime';

const WAKE_HINTS: Record<Exclude<InboxCloudPreset, 'muse'>, { url: string; key: string; where: string }> = {
  'claude-routine': {
    url: 'https://api.anthropic.com/v1/claude_code/routines/trig_…/fire',
    key: 'sk-ant-oat01-…',
    where: 'In the routine on claude.ai/code: Edit → add an API trigger → Generate token. Copy the Fire URL and the token.',
  },
  'grok-bot': {
    url: 'The routine’s “POST to” address',
    key: 'The routine’s key',
    where: 'On the desktop app, open the routine’s Webhook section: copy “POST to” and the key.',
  },
  other: {
    url: 'https://…',
    key: 'Sent as Authorization: Bearer',
    where: 'Any address that takes a POST with a Bearer key and a JSON body.',
  },
};

const LIVE_POLL_MS = 3_000;
const IDLE_POLL_MS = 30_000;

type Fresh = { setup: InboxCloudSetup | null };

const errorText = (cause: unknown) => (cause instanceof InboxApiError ? cause.message : 'The Inbox did not answer. Try again.');
const noEnter = (event: KeyboardEvent) => {
  if (event.key === 'Enter') event.preventDefault();
};

export function CloudAgentsSection() {
  const [model, setModel] = useState<CloudAgentsModel | null>(null);
  const [hidden, setHidden] = useState(false);
  const [adding, setAdding] = useState(false);
  const [fresh, setFresh] = useState<Record<string, Fresh>>({});
  const addButton = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      setModel(await inboxApi.cloudAgents());
    } catch {
      setHidden(true);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const live = !!model && (Object.keys(fresh).length > 0 || model.agents.some((agent) => agent.link.state !== 'connected'));
  useEffect(() => {
    if (!model || model.agents.length === 0) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void inboxApi.cloudAgents().then(setModel, () => {});
    }, live ? LIVE_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [model?.agents.length, live]);

  if (hidden || !model || (model.available === false && model.agents.length === 0)) return null;

  const opened = (session: string, setup: InboxCloudSetup | null) => setFresh((all) => ({ ...all, [session]: { setup } }));
  const closed = (session: string) =>
    setFresh((all) => {
      const { [session]: _gone, ...rest } = all;
      return rest;
    });

  return (
    <section className="ib-sgroup" data-settings-cloud="" aria-labelledby="ib-g-cloud">
      <h2 id="ib-g-cloud">Cloud agents</h2>
      <p>A Claude Code routine, Grok Bot, Muse or another agent in the cloud that reads and answers its threads here.</p>
      <div className="ib-card" aria-label="Cloud agents">
        {model.agents.map((agent) => (
          <AgentCard
            key={agent.session}
            agent={agent}
            fresh={fresh[agent.session] ?? null}
            onModel={setModel}
            onSetup={(setup) => opened(agent.session, setup)}
            onDone={() => closed(agent.session)}
          />
        ))}
        {adding ? (
          <PairForm
            projects={model.projects}
            onCancel={() => {
              setAdding(false);
              requestAnimationFrame(() => addButton.current?.focus());
            }}
            onPaired={(next, session, setup) => {
              setModel(next);
              setAdding(false);
              opened(session, setup);
            }}
          />
        ) : (
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
        )}
      </div>
    </section>
  );
}

function AgentCard({
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
  return (
    <div className="ib-cl-agent" data-cloud-agent={agent.session} data-cloud-link={agent.link.state}>
      <div className="ib-prow">
        <span className="ib-tile">
          <HostMark host={inboxCloudHostOf(agent.preset)} agent={agent.session} />
        </span>
        <span className="ib-txt">
          <span className="ib-l">{agent.name}</span>
          <span className="ib-desc">
            {INBOX_CLOUD_PRESET_NAMES[agent.preset]}
            {agent.project ? <> · in {agent.project.name}</> : null}
          </span>
          <LinkLine agent={agent} />
        </span>
        <span className="ib-ctl">
          <button
            type="button"
            className="ib-del-l"
            disabled={busy !== null}
            aria-label={`Remove ${agent.name}`}
            data-cloud-remove=""
            onClick={() => {
              setBusy('remove');
              inboxApi
                .removeCloudAgent(agent.session)
                .then(onModel)
                .catch((cause) => {
                  setError(errorText(cause));
                  setBusy(null);
                });
            }}
          >
            Remove
          </button>
        </span>
      </div>
      {fresh && <SetupPanel agent={agent} setup={fresh.setup} busy={busy === 'pairing'} onRetry={newPairing} onDone={onDone} />}
      {agent.key_rejected_at && agent.preset !== 'muse' && <NewKey agent={agent} placeholder={WAKE_HINTS[agent.preset].key} onModel={onModel} />}
      {agent.preset === 'muse' ? (
        <div className="ib-cl-sub ib-cl-quiet" data-cloud-checks-itself="">
          <span className="ib-cl-said">It checks for your messages itself: no wake address needed.</span>
        </div>
      ) : agent.wake ? (
        <TestLine agent={agent} onModel={onModel} />
      ) : (
        <WakeForm agent={agent} hint={WAKE_HINTS[agent.preset]} onModel={onModel} />
      )}
      {!fresh && (
        <div className="ib-cl-sub ib-cl-quiet" data-cloud-pairing-row="">
          <button type="button" className="ib-cl-link" disabled={busy !== null} onClick={newPairing} data-cloud-new-pairing="">
            {busy === 'pairing' ? 'Making a new pairing…' : 'New pairing (the old one stops working)'}
          </button>
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

function LinkLine({ agent }: { agent: InboxCloudAgentView }) {
  const now = useRelativeClock(agent.link.state === 'connected');
  const { state, last_seen_at } = agent.link;
  const text =
    state === 'connected'
      ? `Connected · last seen ${last_seen_at ? relativeWords(last_seen_at, now) : 'just now'}`
      : state === 'waiting'
        ? `Waiting for ${agent.name} to connect…`
        : state === 'relay_down'
          ? `This computer cannot reach the relay, so ${agent.name} cannot reach it. Check that this computer is online.`
          : 'Not connected: this computer could not reach the relay. Once it is online, make a new pairing.';
  return (
    <span className={`ib-cl-link-line ib-cl-${state}`} role="status" data-cloud-status={state}>
      <span className="ib-cl-dot" aria-hidden="true" />
      {text}
    </span>
  );
}

function CopyBlock({ label, text, data, primary }: { label?: ReactNode; text: string; data: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ib-cl-copy" data-cloud-copy-block={data}>
      {label && <span className="ib-cl-copy-l">{label}</span>}
      <pre className="ib-cl-block">{text}</pre>
      <button type="button" className={`ib-btn ib-cl-copy-b${primary ? ' ib-pri' : ''}`} onClick={() => void copyTextToClipboard(text).then((ok) => setCopied(ok))} data-cloud-copy={data}>
        <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function SetupPanel({ agent, setup, busy, onRetry, onDone }: { agent: InboxCloudAgentView; setup: InboxCloudSetup | null; busy: boolean; onRetry: () => void; onDone: () => void }) {
  const head = useRef<HTMLDivElement>(null);
  useEffect(() => head.current?.focus(), [setup]);
  return (
    <div className="ib-mform ib-cl-setup" data-cloud-setup={setup ? setup.kind : 'no-relay'} tabIndex={-1} ref={head}>
      {!setup ? (
        <>
          <div className="ib-callout ib-err" role="alert" data-cloud-no-relay="">
            <Icon name="xCircle" />
            <span>This computer could not reach the relay, so there is nothing to give {agent.name} yet. Check that this computer is online, then try again.</span>
          </div>
          <div className="ib-cl-row">
            <button type="button" className="ib-btn ib-pri" disabled={busy} onClick={onRetry} data-cloud-retry="">
              {busy ? 'Trying…' : 'Try again'}
            </button>
          </div>
        </>
      ) : setup.kind === 'message' ? (
        <CopyBlock label={<>Send this to {agent.name}. It sets itself up.</>} text={setup.message} data="message" primary />
      ) : (
        <>
          <p className="ib-cl-p">In the routine: Edit → Advanced settings → Cloud environment → its settings icon. Then Save changes.</p>
          <CopyBlock label="Environment variables" text={setup.variable} data="variable" />
          <CopyBlock label="Network access: Limited. Allowed domains" text={setup.domains} data="domains" />
          <CopyBlock label="Add to the routine’s instructions" text={setup.instructions} data="instructions" />
        </>
      )}
      <div className="ib-mform-f ib-cl-foot">
        {setup && <span className="ib-cl-said">Shown only now.</span>}
        <button type="button" className="ib-btn ib-ghost" onClick={onDone} data-cloud-done="">
          Done
        </button>
      </div>
    </div>
  );
}

function WakeForm({ agent, hint, onModel }: { agent: InboxCloudAgentView; hint: (typeof WAKE_HINTS)['other']; onModel: (model: CloudAgentsModel) => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) first.current?.focus();
  }, [open]);
  const ready = !busy && url.trim() !== '' && key.trim() !== '';
  if (!open) {
    return (
      <div className="ib-cl-sub ib-cl-quiet" data-cloud-wake-offer="">
        <button type="button" className="ib-cl-link" onClick={() => setOpen(true)} data-cloud-wake-open="">
          Add its wake address so it starts when you write to it
        </button>
      </div>
    );
  }
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
    <div className="ib-mform ib-cl-wake" data-cloud-wake-form="">
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
        <button type="button" className="ib-btn ib-ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="button" className={`ib-btn ib-pri${ready ? '' : ' ib-dim'}`} aria-disabled={!ready} onClick={save} data-cloud-wake-save="">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function NewKey({ agent, placeholder, onModel }: { agent: InboxCloudAgentView; placeholder: string; onModel: (model: CloudAgentsModel) => void }) {
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
          placeholder={placeholder}
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

function TestLine({ agent, onModel }: { agent: InboxCloudAgentView; onModel: (model: CloudAgentsModel) => void }) {
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
      <button type="button" className="ib-btn" disabled={state.busy} onClick={run} data-cloud-test="">
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

function PairForm({
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
    <div className="ib-mform" data-cloud-pair-form="">
      <div className="ib-seg ib-cl-seg" role="radiogroup" aria-label="Kind of agent">
        {INBOX_CLOUD_PRESETS.map((id) => (
          <label key={id} className="ib-seg-o" data-on={preset === id ? '' : undefined}>
            <input type="radio" name="ib-cloud-preset" value={id} checked={preset === id} onChange={() => setPreset(id)} />
            {INBOX_CLOUD_PRESET_LABELS[id]}
          </label>
        ))}
      </div>
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
