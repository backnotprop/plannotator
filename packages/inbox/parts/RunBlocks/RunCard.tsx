/**
 * A `:::run` block's card: the command in mono with Copy, where it runs, and one Run. Pressed, it runs on the
 * computer that owns the thread (the same card from a phone or a linked machine); its output shows as it comes,
 * with Stop, then how it ended. Open in terminal is always there: the person's own terminal, in that folder, the
 * command copied. A command with a hidden character cannot be run or copied, and the card says why.
 */
import { useState } from 'react';
import { inboxRunShowHidden, type ParsedInboxRun } from '@plannotator/core/inbox-run-blocks';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { runApi, type RunStateWire, type RunView } from '../../data/runApi';
import { refreshRunState } from '../../data/runStore';
import { Icon } from '../../icons';
import { RunOutput } from './RunOutput';
import { SecretField } from './SecretField';

const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);

/** How a run stands, in words, and its tone. */
export function runStatus(run: RunView): { text: string; tone: 'live' | 'ok' | 'bad' | 'mut' } {
  if (run.state === 'starting') return { text: 'Starting…', tone: 'live' };
  if (run.state === 'running') return { text: `Running · ${Math.floor(run.duration_ms / 1000)} s`, tone: 'live' };
  if (run.state === 'stopped') return { text: `Stopped after ${secs(run.duration_ms)}`, tone: 'mut' };
  if (run.exit_code === null && run.error) return { text: "Couldn't start", tone: 'bad' };
  const how = run.exit_code !== null ? `exit code ${run.exit_code}` : `ended by ${run.signal ?? 'a signal'}`;
  return { text: `${run.state === 'done' ? 'Done' : 'Failed'} · ${how} · ${secs(run.duration_ms)}`, tone: run.state === 'done' ? 'ok' : 'bad' };
}

export function RunCard({ messageId, block, state, agent }: { messageId: string; block: ParsedInboxRun; state: RunStateWire | null; agent: string }) {
  const view = state?.blocks[block.key] ?? null;
  const run = state?.runs[block.key] ?? null;
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const [pressing, setPressing] = useState(false);
  const live = run?.state === 'starting' || run?.state === 'running';
  const hidden = view?.hidden ?? null;
  const computer = state?.computer ?? 'your computer';

  const act = async (work: () => Promise<unknown>, after?: string) => {
    setPressing(true);
    setNote(null);
    try {
      await work();
      if (after) setNote(after);
    } catch (failure) {
      setNote(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPressing(false);
      await refreshRunState(messageId);
    }
  };
  const copy = async () => setCopied((await copyTextToClipboard(block.command)) ? 'ok' : 'failed');
  const terminal = () =>
    act(async () => {
      const copiedNow = await copyTextToClipboard(block.command);
      const opened = await runApi.terminal(messageId, block.key, block.command);
      setNote(`Opened ${opened.terminal} on ${computer} in ${view?.folder ?? 'the project folder'}.${copiedNow ? ' The command is copied: paste it there.' : ''}`);
    });

  return (
    <section className="ib-rb" data-run-card={block.key} data-run-state={hidden ? 'refused' : (run?.state ?? 'idle')} aria-label={block.title}>
      <div className="ib-rb-head">
        <Icon name="terminal" />
        <span className="ib-rb-title">
          <InlineMarkdown text={block.title} />
        </span>
        {run && !hidden && <RunStatusLine run={run} />}
      </div>
      {block.why && (
        <p className="ib-rb-why">
          <InlineMarkdown text={block.why} />
        </p>
      )}
      {hidden ? (
        <div className="ib-rb-refused" data-run-refused="">
          <p className="ib-rb-warn" role="note">
            <Icon name="warn" />
            <span>{`${hidden.words} Ask ${agent} to send it again without it.`}</span>
          </p>
          <pre className="ib-rb-cmd">{inboxRunShowHidden(block.command)}</pre>
        </div>
      ) : (
        <>
          <div className="ib-rb-cmdrow">
            <pre className="ib-rb-cmd" data-run-command="">{block.command}</pre>
            <button type="button" className="ib-btn ib-ghost ib-sm ib-rb-copy" onClick={() => void copy()} data-run-copy="">
              <Icon name={copied === 'ok' ? 'check' : 'copy'} />
              {copied === 'ok' ? 'Copied' : copied === 'failed' ? "Couldn't copy" : 'Copy'}
            </button>
          </div>
          <p className="ib-rb-where" data-run-where="">
            {view?.folder_missing ? `That folder isn't on ${computer}: ${view.folder ?? 'the project has no folder'}` : `On ${computer} · in ${view?.folder ?? '…'}`}
          </p>
          {view?.needs.map((name) => (
            <div key={name} className="ib-rb-need" data-run-needs={name}>
              <p className="ib-rb-needs-l">
                <Icon name="lock" />
                {`Needs ${name}`}
              </p>
              <SecretField messageId={messageId} name={name} />
            </div>
          ))}
          {run && !(run.error && run.total_lines === 0) && <RunOutput run={run} />}
          {run?.error && (
            <p className="ib-rb-warn" data-run-error="">
              <Icon name="warn" />
              <span>{run.error}</span>
            </p>
          )}
          {run?.waiting_for_input && (
            <p className="ib-rb-warn" data-run-waiting="">
              <Icon name="keyboard" />
              <span>It looks like it's waiting for you to type something. You can't type into it here: stop it and run it in your terminal.</span>
            </p>
          )}
          {run?.needs_terminal && (
            <p className="ib-rb-warn" data-run-needs-terminal="">
              <Icon name="keyboard" />
              <span>It needs a terminal to finish (it asked for a password or a sign-in). Run it in your terminal instead.</span>
            </p>
          )}
          {run && !live && <p className="ib-rb-hint">{`${agent} got the exit code and the last lines of output.`}</p>}
          <div className="ib-rb-acts">
            {live ? (
              <button type="button" className={`ib-btn ${run?.waiting_for_input ? '' : 'ib-pri'}`} disabled={pressing} onClick={() => void act(() => runApi.stop(messageId, block.key))} data-run-stop="">
                <Icon name="stop" />
                Stop
              </button>
            ) : (
              <button
                type="button"
                className={`ib-btn ${run?.needs_terminal || (view?.needs.length ?? 0) > 0 ? '' : 'ib-pri'}`}
                disabled={pressing || !view || view.folder_missing}
                onClick={() => void act(() => runApi.start(messageId, block.key, block.command))}
                data-run-start=""
              >
                <Icon name={run ? 'replay' : 'play'} />
                {run ? 'Run again' : 'Run'}
              </button>
            )}
            <button
              type="button"
              className={`ib-btn ${run?.needs_terminal || run?.waiting_for_input ? 'ib-pri' : 'ib-ghost'}`}
              disabled={pressing || !view || view.folder_missing}
              onClick={() => void terminal()}
              data-run-terminal=""
            >
              <Icon name="terminal" />
              Open in terminal
            </button>
          </div>
        </>
      )}
      <p className="ib-rb-note" role="status" data-run-note="">
        {note ?? ''}
      </p>
    </section>
  );
}

function RunStatusLine({ run }: { run: RunView }) {
  const status = runStatus(run);
  return (
    <span className={`ib-rb-status ib-${status.tone}`} data-run-status="">
      {status.tone === 'live' && <span className="ib-rb-dot" aria-hidden="true" />}
      {status.text}
    </span>
  );
}
