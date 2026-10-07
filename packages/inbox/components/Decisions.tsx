import { useEffect, useId, useState } from 'react';
import type { InboxDecision } from '@plannotator/core/inbox-types';
import { InboxApiError, type DecisionsModel, type ProjectFolder, type WaitingDecision } from '../api';
import { agentName, dateTime, dayWords, shortTime } from '../format';
import { DecisionDiamond, Icon } from '../icons';

/**
 * The project's decisions (the window record's 3.2): a project switch, then
 * Waiting (questions that record a decision once answered and sent),
 * Settled (what holds), and "Replaced or retired" folded with its history.
 * A row opens beside the list, the list narrowing as it does for a thread,
 * with the decision's words, why, where it came from and when, and Retire
 * and Replace for one that holds. No star, no other actions.
 */

export interface DecisionsPageProps {
  projects: readonly ProjectFolder[];
  project: ProjectFolder;
  model: DecisionsModel | null;
  error: string | null;
  openId: string | null;
  onProject: (projectId: string) => void;
  onOpen: (decisionId: string | null) => void;
  onOpenThread: (threadId: string) => void;
  onRetire: (decision: InboxDecision) => Promise<void>;
  onReplace: (decision: InboxDecision, text: string, reason: string) => Promise<void>;
}

/** Who and how, in the row's two muted columns. */
function sourceWords(decision: InboxDecision): { who: string; how: string } {
  const agent = agentName(decision.source.agent ? { kind: 'agent', ...decision.source.agent } : null);
  switch (decision.source.kind) {
    case 'answer':
      return { who: `From your answer to ${agent}`, how: 'Recorded at Send' };
    case 'agent':
      return { who: `Recorded by ${agent}`, how: 'record_decision' };
    case 'person':
      return { who: 'Written by you', how: decision.replaces_id ? 'Replace' : 'Written' };
  }
}

const STATE_WORDS: Record<InboxDecision['state'], string> = { current: 'Settled', replaced: 'Replaced', retired: 'Retired' };

function WaitingRow({ item, narrow, onOpenThread }: { item: WaitingDecision; narrow: boolean; onOpenThread: () => void }) {
  const asked = `Asked by ${agentName(item.agent ? { kind: 'agent', ...item.agent } : null)}, ${dayWords(item.asked_at)}`;
  if (narrow) {
    return (
      <div className="ib-drow ib-w ib-dnarrow" data-waiting-question={item.question_id}>
        <DecisionDiamond />
        <span className="ib-dtxt">
          <span className="ib-st">{item.prompt}</span>
          <span className="ib-src">{asked}</span>
        </span>
        <button type="button" className="ib-btn ib-sm" onClick={onOpenThread}>
          Open
        </button>
      </div>
    );
  }
  return (
    <div className="ib-drow ib-w" data-waiting-question={item.question_id}>
      <DecisionDiamond />
      <span className="ib-st">{item.prompt}</span>
      <span className="ib-src">{asked}</span>
      <span />
      <span className="ib-act">
        <button type="button" className="ib-btn ib-sm" onClick={onOpenThread}>
          Open
        </button>
      </span>
    </div>
  );
}

function DecisionRow({ decision, narrow, selected, onOpen }: { decision: InboxDecision; narrow: boolean; selected: boolean; onOpen: () => void }) {
  const { who, how } = sourceWords(decision);
  const when = shortTime(decision.changed_at ?? decision.created_at);
  const ended = decision.state === 'current' ? null : STATE_WORDS[decision.state];
  return (
    <button
      type="button"
      className={`ib-drow${narrow ? ' ib-dnarrow' : ''}${selected ? ' ib-sel' : ''}${ended ? ' ib-ended' : ''}`}
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      data-decision-id={decision.id}
      data-decision-state={decision.state}
    >
      <DecisionDiamond />
      {narrow ? (
        <span className="ib-dtxt">
          <span className="ib-st">{decision.text}</span>
          <span className="ib-src">
            {ended ? `${ended} · ` : ''}
            {who} · {when}
          </span>
        </span>
      ) : (
        <>
          <span className="ib-st">{decision.text}</span>
          <span className="ib-src">{ended ? `${ended} · ${who}` : who}</span>
          <span className="ib-src">{how}</span>
          <span className="ib-when">{when}</span>
        </>
      )}
    </button>
  );
}

function DecisionPane({
  decision,
  all,
  onClose,
  onOpen,
  onOpenThread,
  onRetire,
  onReplace,
}: {
  decision: InboxDecision;
  all: readonly InboxDecision[];
  onClose: () => void;
  onOpen: (id: string) => void;
  onOpenThread: (threadId: string) => void;
  onRetire: (decision: InboxDecision) => Promise<void>;
  onReplace: (decision: InboxDecision, text: string, reason: string) => Promise<void>;
}) {
  const id = useId();
  const [replacing, setReplacing] = useState(false);
  const [text, setText] = useState(decision.text);
  const [reason, setReason] = useState(decision.reason ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setReplacing(false);
    setText(decision.text);
    setReason(decision.reason ?? '');
    setError(null);
  }, [decision.id, decision.text, decision.reason]);

  const { who } = sourceWords(decision);
  const replaces = decision.replaces_id ? all.find((d) => d.id === decision.replaces_id) : undefined;
  const replacement = decision.replacement_id ? all.find((d) => d.id === decision.replacement_id) : undefined;
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof InboxApiError || cause instanceof Error ? cause.message : 'Nothing changed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ib-pane ib-dpane" aria-label={decision.text} data-decision-pane={decision.id}>
      <div className="ib-phead">
        <span className="ib-dstate">
          <DecisionDiamond />
          {STATE_WORDS[decision.state]}
        </span>
        <span className="ib-sp" />
        <button type="button" className="ib-iconbtn" onClick={onClose} title="Close" aria-label="Close the decision">
          <Icon name="x" />
        </button>
      </div>
      <div className="ib-pbody">
        <h2 className="ib-subject">{decision.text}</h2>
        <dl className="ib-dfacts">
          <dt>Why</dt>
          <dd>{decision.reason ?? <span className="ib-mut">No reason given.</span>}</dd>
          <dt>Source</dt>
          <dd>
            <span>{who}</span>
            {decision.source.thread_id && (
              <button type="button" className="ib-link" onClick={() => onOpenThread(decision.source.thread_id!)}>
                Open the thread
              </button>
            )}
          </dd>
          <dt>Recorded</dt>
          <dd>{dateTime(decision.created_at)}</dd>
          {replaces && (
            <>
              <dt>Replaces</dt>
              <dd>
                <button type="button" className="ib-link" onClick={() => onOpen(replaces.id)}>
                  {replaces.text}
                </button>
              </dd>
            </>
          )}
          {decision.state === 'replaced' && (
            <>
              <dt>Replaced</dt>
              <dd>
                {dateTime(decision.changed_at ?? decision.created_at)}
                {replacement && (
                  <>
                    {' by '}
                    <button type="button" className="ib-link" onClick={() => onOpen(replacement.id)}>
                      {replacement.text}
                    </button>
                  </>
                )}
              </dd>
            </>
          )}
          {decision.state === 'retired' && (
            <>
              <dt>Retired</dt>
              <dd>{dateTime(decision.changed_at ?? decision.created_at)}</dd>
            </>
          )}
        </dl>
      </div>
      {decision.state === 'current' && (
        <div className="ib-pfoot">
          {replacing ? (
            <form
              className="ib-dform"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() => onReplace(decision, text, reason));
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setReplacing(false);
                }
              }}
            >
              <label htmlFor={`${id}-text`}>Decision</label>
              <textarea id={`${id}-text`} className="ib-ta" rows={2} value={text} autoFocus onChange={(event) => setText(event.target.value)} />
              <label htmlFor={`${id}-reason`}>
                Why <span>(optional)</span>
              </label>
              <textarea id={`${id}-reason`} className="ib-ta" rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
              <div className="ib-acts">
                <button type="submit" className="ib-btn ib-pri" disabled={busy}>
                  Replace
                </button>
                <button type="button" className="ib-btn ib-ghost" onClick={() => setReplacing(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="ib-acts">
              <button type="button" className="ib-btn" onClick={() => setReplacing(true)}>
                Replace
              </button>
              <button type="button" className="ib-btn" disabled={busy} onClick={() => void run(() => onRetire(decision))}>
                Retire
              </button>
            </div>
          )}
          {error && (
            <div className="ib-error" role="alert">
              {error}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function DecisionsPage(props: DecisionsPageProps) {
  const { model, project } = props;
  const decisions = model?.decisions ?? [];
  const settled = decisions.filter((d) => d.state === 'current').reverse();
  const ended = decisions.filter((d) => d.state !== 'current').reverse();
  const open = props.openId ? decisions.find((d) => d.id === props.openId) ?? null : null;
  const [foldOpen, setFoldOpen] = useState(false);
  // A decision opened from history unfolds it, so its row shows where it went.
  const showEnded = foldOpen || (open !== null && open.state !== 'current');
  const narrow = open !== null;

  return (
    <>
      <section className={`ib-dpage${narrow ? ' ib-narrow' : ''}`} aria-label="Decisions">
        <div className="ib-dh">
          <h1>Decisions</h1>
          <select className="ib-select" aria-label="Project" value={project.id} onChange={(event) => props.onProject(event.target.value)}>
            {props.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <p className="ib-dsub">What holds true in {project.name}, and what waits on a call.</p>
        {props.error && <div className="ib-error">{props.error}</div>}
        {model && (
          <>
            {model.waiting.length > 0 && (
              <div className="ib-group" role="group" aria-label="Waiting" data-decision-group="waiting">
                <div className="ib-band">
                  Waiting <span className="ib-n">{model.waiting.length}</span>
                </div>
                {model.waiting.map((item) => (
                  <WaitingRow key={item.question_id} item={item} narrow={narrow} onOpenThread={() => props.onOpenThread(item.thread_id)} />
                ))}
              </div>
            )}
            <div className="ib-group" role="group" aria-label="Settled" data-decision-group="settled">
              <div className="ib-band">
                Settled <span className="ib-n">{settled.length}</span>
              </div>
              {settled.length === 0 && <p className="ib-dnone">Nothing recorded in {project.name} yet.</p>}
              {settled.map((decision) => (
                <DecisionRow
                  key={decision.id}
                  decision={decision}
                  narrow={narrow}
                  selected={decision.id === props.openId}
                  onOpen={() => props.onOpen(decision.id)}
                />
              ))}
            </div>
            {ended.length > 0 && (
              <div className="ib-group" role="group" aria-label="Replaced or retired" data-decision-group="ended">
                <button type="button" className="ib-band" onClick={() => setFoldOpen(!showEnded)} aria-expanded={showEnded}>
                  Replaced or retired <span className="ib-n">{ended.length}</span>
                  <Icon name={showEnded ? 'chevD' : 'chevR'} size={14} />
                </button>
                {showEnded &&
                  ended.map((decision) => (
                    <DecisionRow
                      key={decision.id}
                      decision={decision}
                      narrow={narrow}
                      selected={decision.id === props.openId}
                      onOpen={() => props.onOpen(decision.id)}
                    />
                  ))}
              </div>
            )}
          </>
        )}
      </section>
      {open && (
        <DecisionPane
          decision={open}
          all={decisions}
          onClose={() => props.onOpen(null)}
          onOpen={(id) => props.onOpen(id)}
          onOpenThread={props.onOpenThread}
          onRetire={props.onRetire}
          onReplace={props.onReplace}
        />
      )}
    </>
  );
}
