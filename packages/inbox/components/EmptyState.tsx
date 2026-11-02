import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { InboxAgentId, InboxAgentsModel } from '@plannotator/core/inbox-types';
import { inboxApi, type ComposeSessionsModel } from '../api';
import { OTHER_HARNESSES, harnessPanel, hostMcpSnippet, type ConnectContext } from '../harnesses';
import { HostMark, Icon } from '../icons';
import {
  CLAUDE_PLUGIN_INSTALL,
  OPENCODE_CONFIG_PATH,
  OPENCODE_PLUGIN_LINES,
  PI_EXTENSION_INSTALL,
  PLUGIN_HOSTS,
  mcpWakeLine,
  mcpWakingHostsHere,
  TRY_PROMPT,
  wakeLine,
  blockedText,
  connectPlan,
  doneNote,
  harnessOf,
  isPluginHost,
  laterNote,
  mcpFoldHint,
  stepEyebrow,
  stepText,
  stepTitle,
  tryWho,
  type ConnectRow,
  type PluginHost,
} from '../connectSteps';
import { CodeBox, ConnectPicker, CopyButton } from './ConnectPicker';
import { SidebarTrigger } from '../shell/sidebar';

/** A live session of one of Plannotator's hosts, for "Message <host>". */
interface LiveHost {
  session: string;
  project: string;
}

/** The first live session each host has (GET /api/inbox/sessions). */
function liveByHost(sessions: ComposeSessionsModel | null): Map<string, LiveHost> {
  const live = new Map<string, LiveHost>();
  for (const group of sessions?.projects ?? []) {
    for (const session of group.sessions) {
      if (!live.has(session.host)) live.set(session.host, { session: session.session, project: group.project.name });
    }
  }
  return live;
}

function Fold({ label, sub, children, id }: { label: string; sub?: string; children: ReactNode; id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ib-cn-foldw">
      {/* The examples sit beside the button, not in it: its name stays the label. */}
      <div className="ib-cn-foldh">
        <button type="button" className="ib-byhand ib-cn-fold" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
          <Icon name="chevR" />
          {label}
        </button>{' '}
        {sub && <span className="ib-mut">{sub}</span>}
      </div>
      {open && (
        <div id={id} className="ib-cn-foldb">
          {children}
        </div>
      )}
    </div>
  );
}

/** A small segmented choice (radio buttons that look like the mock's switch). */
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { id: T; label: string }[]; onChange: (next: T) => void }) {
  const name = useId();
  return (
    <span className="ib-cn-seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option.id} className="ib-cn-sego" data-on={value === option.id ? '' : undefined}>
          <input type="radio" name={name} value={option.id} checked={value === option.id} onChange={() => onChange(option.id)} />
          {option.label}
        </label>
      ))}
    </span>
  );
}

/** The command that installs Plannotator's own connection on a host, with what to do after. */
function InstallBlock({ host, generation }: { host: PluginHost; generation?: '1' | '2' }) {
  // The OpenCode on PATH decides which plugin line shows first: OpenCode 1 does not read `plugins`.
  const [version, setVersion] = useState<'2' | '1'>(generation ?? '2');
  // The agents are read again every few seconds: follow what they say about the OpenCode on this computer.
  useEffect(() => {
    if (generation) setVersion(generation);
  }, [generation]);
  if (host === 'claude-code') {
    return (
      <div className="ib-cn-blk" data-install="claude-code">
        <CodeBox text={CLAUDE_PLUGIN_INSTALL} />
        <p className="ib-cn-hint">Run it in a terminal, then restart Claude Code. Needs Claude Code 2.1.287 or newer, on macOS or Linux.</p>
      </div>
    );
  }
  if (host === 'pi') {
    return (
      <div className="ib-cn-blk" data-install="pi">
        <CodeBox text={PI_EXTENSION_INSTALL} />
        <p className="ib-cn-hint">Then come back here to turn on its Inbox tool.</p>
      </div>
    );
  }
  return (
    <div className="ib-cn-blk" data-install="opencode">
      <div>
        <Choice
          label="OpenCode version"
          value={version}
          options={[
            { id: '2', label: 'OpenCode 2' },
            { id: '1', label: 'OpenCode 1' },
          ]}
          onChange={setVersion}
        />
      </div>
      <CodeBox text={OPENCODE_PLUGIN_LINES[version]} label={OPENCODE_CONFIG_PATH} />
      <p className="ib-cn-hint">Add it to the file, restart OpenCode, then come back here to turn on its Inbox tool.</p>
    </div>
  );
}

/** "Use MCP instead", folded: the host's own MCP line, with what it lacks. */
function McpFold({ host, context }: { host: PluginHost; context: ConnectContext }) {
  const id = useId();
  const snippet = hostMcpSnippet(host, context);
  const text = host === 'opencode' ? snippet.replace(/^opencode\.json: /, '') : snippet;
  return (
    <Fold label="Use MCP instead" id={id}>
      <CodeBox text={text} label={host === 'opencode' ? 'opencode.json' : undefined} />
      <p className="ib-cn-hint">{mcpFoldHint(host === 'claude-code' ? 'Claude Code' : host === 'pi' ? 'Pi' : 'OpenCode')}</p>
    </Fold>
  );
}

/** An agent connected by hand: the picker's own command for it. */
function ManualBlock({ id, context }: { id: InboxAgentId; context: ConnectContext }) {
  const panel = harnessPanel(harnessOf(id), context);
  return (
    <div className="ib-cn-blk">
      {panel.artefacts.map((artefact, i) =>
        artefact.kind === 'code' ? (
          <CodeBox key={i} text={artefact.text} label={artefact.label} />
        ) : (
          <div key={i}>
            <a className="ib-btn ib-pri" href={artefact.href} style={{ textDecoration: 'none' }}>
              <Icon name="external" size={15} />
              {artefact.label}
            </a>
          </div>
        ),
      )}
      {panel.note && <p className="ib-cn-hint">{panel.note}</p>}
    </div>
  );
}

function Mark({ id, size }: { id: string; size: 'hero' | 'sm' }) {
  return (
    <span className={size === 'hero' ? 'ib-cn-mark' : 'ib-cn-smark'}>
      <HostMark host={id} big />
    </span>
  );
}

const APPLIES: Record<PluginHost, string> = {
  'claude-code': 'Restart Claude Code to pick it up.',
  pi: 'Start a new Pi session, or run /reload in one that is running.',
  opencode: 'Restart OpenCode to pick it up.',
};

export interface EmptyStateProps {
  /** The CLI's command and address, for the MCP lines and the picker. */
  context: ConnectContext | null;
  /** GET /api/inbox/agents; null while it loads or where it is refused (a tailnet guest's page). */
  agents: InboxAgentsModel | null;
  /**
   * The agents could not be read: `tailnet`, a tailnet guest's page
   * (the agents route refuses it); `failed`, a read on this computer that
   * did not answer. The screen then offers the commands without this
   * computer's state.
   */
  agentsUnavailable: 'tailnet' | 'failed' | null;
  /** Read the agents again (after `failed`). */
  onRetry?: () => void;
  /** The live sessions (GET /api/inbox/sessions), for "running now" and "Message <host>". */
  sessions: ComposeSessionsModel | null;
  onAgents: (next: InboxAgentsModel) => void;
  /** Open compose addressed to a live session. */
  onMessage: (session: string, opener: HTMLElement | null) => void;
  /**
   * The notifications ask (NotificationAsk with `firstRun`), drawn under
   * "Try it": the moment before the first question arrives. App decides
   * when (never while a one-time dialog is open).
   */
  ask?: ReactNode;
  /** The screen's heading in place of "No agent has written yet" (the tour's step 6: "Now, let's connect your agents"). */
  heading?: string;
  /** A line above everything (the tour's step 6: back in the person's own Inbox). */
  lead?: string;
  /**
   * "Want to see it work first? Take the 2-minute tour" at the screen's foot
   * (approval "inbox-onboarding-tour"): once the tour was finished or left,
   * the entry screen no longer opens and this quiet link stays. Absent: none.
   */
  onTakeTour?: () => void;
  /** Try it's prompt to copy in place of the test message (the tour's step 6: one real question, with pictures). */
  tryPrompt?: string;
}

/**
 * First run, "No agent has written yet" (the approved design
 * "inbox-connect-next-step", variant C "One next step"): one large card
 * naming the single most useful thing to do next, Plannotator's own
 * connections first (Claude Code, Pi, OpenCode, whose replies come back into
 * the session by themselves), then a short list of what is done and what is
 * left, "Try it", and every other agent or editor folded at the end. The
 * window turns a tool on or connects an MCP agent in one click; installing a
 * plugin is a command to copy, and the screen moves on by itself once the
 * agents are read again (App re-reads them while this screen shows).
 */
export function EmptyState({ context, agents, agentsUnavailable, onRetry, sessions, onAgents, onMessage, ask, heading, lead, onTakeTour, tryPrompt }: EmptyStateProps) {
  const [skipped, setSkipped] = useState<string[]>([]);
  const [busy, setBusy] = useState<InboxAgentId | null>(null);
  const [error, setError] = useState<{ id: InboxAgentId; text: string } | null>(null);
  const [turnedOn, setTurnedOn] = useState<Set<string>>(new Set());
  const [said, setSaid] = useState('');
  const [firstPick, setFirstPick] = useState<PluginHost>('claude-code');
  const pickerId = useId();
  const stepHeading = useRef<HTMLHeadingElement | null>(null);
  const tryHeading = useRef<HTMLHeadingElement | null>(null);
  // After Turn on, Connect or Not now the card is rebuilt for the next step: focus goes to its heading
  // (or to Try it once nothing is left), never to the page.
  const [focusTick, setFocusTick] = useState(0);

  const live = liveByHost(sessions);
  // A host with a session polling the Inbox now is connected, whatever the files the Inbox can read say.
  const plan = agents ? connectPlan(agents, skipped, new Set(live.keys())) : null;
  // The agents are read once more before anything shows, so the screen never opens on a guess.
  const loading = !agents && !agentsUnavailable;
  const allSet = !!plan && plan.found.length > 0 && !plan.next && !plan.blocked;

  useLayoutEffect(() => {
    if (focusTick === 0) return;
    (allSet ? tryHeading.current : stepHeading.current)?.focus();
  }, [focusTick, allSet]);

  const act = async (row: ConnectRow) => {
    if (busy) return;
    setBusy(row.id);
    setError(null);
    try {
      const next = await inboxApi.saveAgent(row.id, { reach: true });
      onAgents(next);
      if (next.error) {
        setError({ id: row.id, text: next.error });
        return;
      }
      setFocusTick((tick) => tick + 1);
      if (isPluginHost(row.id)) {
        setTurnedOn((current) => new Set([...current, row.id]));
        setSaid(`${row.label}'s Inbox tool is on. ${APPLIES[row.id]}`);
      } else {
        setSaid(`${row.label} is connected. Its next session reaches the Inbox.`);
      }
    } catch (cause) {
      setError({ id: row.id, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(null);
    }
  };

  let hero: ReactNode = null;
  if ((plan && plan.found.length === 0) || (!plan && agentsUnavailable)) {
    hero = (
      <div className="ib-cn" data-connect-step="first">
        <Mark id={firstPick} size="hero" />
        <div className="ib-cn-eb">
          <span className="ib-cn-ebl">First step</span>
        </div>
        <h3 ref={stepHeading} tabIndex={-1}>
          Connect your first agent
        </h3>
        <p>Which agent do you use?</p>
        <div className="ib-cn-acts">
          <Choice
            label="Your agent"
            value={firstPick}
            options={PLUGIN_HOSTS.map((id) => ({ id, label: id === 'claude-code' ? 'Claude Code' : id === 'pi' ? 'Pi' : 'OpenCode' }))}
            onChange={setFirstPick}
          />
        </div>
        <div className="ib-cn-blk ib-cn-body">
          <InstallBlock key={firstPick} host={firstPick} />
          {context && <McpFold key={`mcp-${firstPick}`} host={firstPick} context={context} />}
          {agentsUnavailable === 'tailnet' && <p className="ib-cn-hint">Open the Inbox on the computer to connect agents with one click.</p>}
          {agentsUnavailable === 'failed' && (
            <p className="ib-cn-hint" data-agents-failed="">
              The Inbox could not read the agents on this computer.{' '}
              {onRetry && (
                <button type="button" className="ib-lnk ib-cn-retry" onClick={onRetry}>
                  Try again
                </button>
              )}
            </p>
          )}
        </div>
      </div>
    );
  } else if (plan?.next) {
    const next = plan.next;
    const text = stepText(next);
    const eyebrow = stepEyebrow(plan);
    const failed = error?.id === next.id ? error.text : null;
    const oneClick = next.state === 'tool-off' || next.state === 'connect';
    const skip = (
      <button
        type="button"
        className="ib-btn ib-ghost"
        onClick={() => {
          setSkipped((current) => [...current, next.id]);
          setFocusTick((tick) => tick + 1);
        }}
      >
        Not now
      </button>
    );
    hero = (
      <div className="ib-cn" data-connect-step={next.id} data-connect-state={next.state}>
        <Mark id={next.id} size="hero" />
        <div className="ib-cn-eb">
          <span className="ib-cn-ebl">{eyebrow.label}</span> · {eyebrow.count}
        </div>
        <h3 ref={stepHeading} tabIndex={-1}>
          {stepTitle(next)}
        </h3>
        <p>
          {text.text}
          {text.cost && (
            <>
              <b>{text.cost}</b>.
            </>
          )}
        </p>
        {failed && (
          <p className="ib-cn-err" role="alert">
            {failed}
          </p>
        )}
        {oneClick ? (
          <div className="ib-cn-acts">
            {/* aria-disabled, not disabled, while it saves: a disabled button drops keyboard focus to the page. */}
            <button
              type="button"
              className="ib-btn ib-pri"
              aria-busy={busy === next.id || undefined}
              aria-disabled={busy !== null || undefined}
              onClick={() => void act(next)}
            >
              {busy === next.id ? (next.state === 'connect' ? 'Connecting…' : 'Turning on…') : failed ? 'Try again' : next.state === 'connect' ? 'Connect' : 'Turn on'}
            </button>
            {skip}
          </div>
        ) : (
          <>
            <div className="ib-cn-blk ib-cn-body">
              {isPluginHost(next.id) ? (
                <>
                  <InstallBlock host={next.id} generation={next.generation} />
                  {next.state === 'missing' && context && <McpFold host={next.id} context={context} />}
                </>
              ) : (
                context && <ManualBlock id={next.id} context={context} />
              )}
            </div>
            <div className="ib-cn-acts">{skip}</div>
          </>
        )}
      </div>
    );
  } else if (plan?.blocked) {
    const why = blockedText(plan, { skipped, toolEnv: agents?.tool_env ?? null });
    hero = (
      <div className="ib-cn" data-connect-step="blocked">
        <Mark id={plan.found[0]!.id} size="hero" />
        <div className="ib-cn-eb">
          <span className="ib-cn-ebl">Nothing connected</span>
        </div>
        <h3 ref={stepHeading} tabIndex={-1}>
          No agent reaches the Inbox yet
        </h3>
        <p>
          {why.text}
          {why.settings && (
            <>
              {' '}
              Turn it back on in <a href="#settings/agents">Settings → Agents</a>.
            </>
          )}
        </p>
      </div>
    );
  } else if (plan) {
    hero = (
      <div className="ib-cn" data-connect-step="done">
        <Mark id={plan.done[0]?.id ?? 'claude-code'} size="hero" />
        <div className="ib-cn-eb">
          <span className="ib-cn-ebl">All set</span>
        </div>
        <h3 ref={stepHeading} tabIndex={-1}>
          Your agents reach the Inbox
        </h3>
        <p>Ask one of them for a test message below.</p>
      </div>
    );
  }

  const lists = plan && plan.found.length > 0 && (
    <div className="ib-cl" data-connect-lists="">
      <div>
        <h4>Already connected</h4>
        <ul>
          {plan.done.length === 0 && <li className="ib-mut">None yet</li>}
          {plan.done.map((row) => (
            <li key={row.id} data-done={row.id}>
              <Icon name="check" className="ib-cl-tick" />
              <Mark id={row.id} size="sm" />
              {row.label}{' '}
              <span className="ib-mut">{doneNote(row, { live: live.has(row.id), turnedOn: turnedOn.has(row.id) })}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h4>Left to do</h4>
        <ul>
          {plan.next && (
            <li className="ib-cl-now" data-left={plan.next.id}>
              <span className="ib-cl-ring" aria-hidden="true" />
              <Mark id={plan.next.id} size="sm" />
              {plan.next.label}{' '}
              <span className="ib-mut">now</span>
            </li>
          )}
          {plan.later.map((row) => (
            <li key={row.id} data-left={row.id}>
              <span className="ib-cl-ring" aria-hidden="true" />
              <Mark id={row.id} size="sm" />
              {row.label}{' '}
              <span className="ib-mut">{laterNote(row, { skipped: skipped.includes(row.id), toolEnv: agents?.tool_env ?? null })}</span>
            </li>
          ))}
          {plan.absent.map((row) => (
            <li key={row.id} data-absent={row.id}>
              <span className="ib-cl-ring ib-cl-dash" aria-hidden="true" />
              <Mark id={row.id} size="sm" />
              <span className="ib-mut">{row.label}: not on this computer</span>
            </li>
          ))}
          {!plan.next && plan.later.length === 0 && plan.absent.length === 0 && <li className="ib-mut">Nothing</li>}
        </ul>
      </div>
    </div>
  );

  // Try it: "Message <host>" when one of Plannotator's hosts has a session running now.
  const found = plan?.found ?? [];
  const reaching = found.filter((row) => row.state === 'ready' || row.state === 'mcp' || row.state === 'mcp-only');
  const left = found.some((row) => row.state === 'tool-off' || row.state === 'missing' || row.state === 'mcp-only');
  const running = found.find((row) => row.state === 'ready' && live.has(row.id)) ?? null;
  const runningIn = running ? live.get(running.id)! : null;
  const who = tryWho(reaching.map((row) => row.label));

  return (
    <section className="ib-listcol" aria-label="Inbox">
      <div className="ib-lhead">
        <SidebarTrigger />
        <h1>Inbox</h1>
      </div>
      <div className="ib-lbody">
        <div className="ib-empty" data-inbox-empty="" aria-busy={loading || undefined}>
          {lead && (
            <p className="ib-tour-lead" role="status">
              <Icon name="check" size={14} />
              {lead}
            </p>
          )}
          <h2 tabIndex={-1}>{heading ?? 'No agent has written yet'}</h2>
          {hero}
          {lists}
          {!loading && (
            <p className="ib-note ib-cn-wake" data-wake-note="">
              <Icon name="info" />
              <span>{wakeLine(mcpWakingHostsHere(agents))}</span>
            </p>
          )}
          {!loading && (
          <div className="ib-try">
            <h3 ref={tryHeading} tabIndex={-1}>
              Try it
            </h3>
            {running && runningIn ? (
              <>
                <div className="ib-try-row">
                  <button
                    type="button"
                    className={`ib-btn${left ? '' : ' ib-pri'}`}
                    data-message-host={running.id}
                    onClick={(event) => onMessage(runningIn.session, event.currentTarget)}
                  >
                    <Icon name="comment" size={15} />
                    Message {running.label}
                  </button>
                  <span className="ib-try-where">
                    {running.label} is running in <b>{runningIn.project}</b>. It answers here.
                  </span>
                </div>
                <p>Or {who.charAt(0).toLowerCase() + who.slice(1)}</p>
              </>
            ) : (
              <p>{who}</p>
            )}
            <div className="ib-try-quote">
              <span>{tryPrompt ?? TRY_PROMPT}</span>
              <CopyButton text={tryPrompt ?? TRY_PROMPT} />
            </div>
            {ask && <div data-first-run-ask="">{ask}</div>}
          </div>
          )}
          {context && !loading && (
            <Fold label="Another agent or editor" sub="VS Code, Zed, JetBrains, Goose, any MCP client" id={pickerId}>
              <p className="ib-note ib-cn-wake" data-wake-note="mcp">
                <Icon name="info" />
                <span>{mcpWakeLine(mcpWakingHostsHere(agents))}</span>
              </p>
              <ConnectPicker harnesses={OTHER_HARNESSES} initial="vscode" context={context} icons />
            </Fold>
          )}
          {onTakeTour && (
            <p className="ib-tour-again" data-tour-again="">
              Want to see it work first?{' '}
              <button type="button" className="ib-lnk" onClick={onTakeTour}>
                Take the 2-minute tour
              </button>
              : how we built the Inbox with the Inbox.
            </p>
          )}
          <div className="ib-sr" aria-live="polite">
            {said}
          </div>
        </div>
      </div>
    </section>
  );
}
