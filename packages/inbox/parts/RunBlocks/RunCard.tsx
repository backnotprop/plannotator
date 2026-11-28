/**
 * A `:::run` block's card: the command in mono with Copy, where it runs, and one Run. Pressed, it runs on the
 * computer that owns the thread (the same card from a phone or a linked machine); its output shows as it comes,
 * with Stop, then how it ended. Open in terminal is always there: the person's own terminal, in that folder, the
 * command on that computer's clipboard. A command (or folder) with a hidden character cannot be run or copied, and
 * the card says why: it knows that from the block itself, before and without the computer's answer.
 */
import { useCallback, useRef, useState } from 'react';
import { inboxRunBlockHidden, inboxRunShowHidden, inboxRunUnusableWords, type ParsedInboxRun } from '@plannotator/core/inbox-run-blocks';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { runApi, type RunStateWire, type RunView } from '../../data/runApi';
import { refreshRunState } from '../../data/runStore';
import { Icon } from '../../icons';
import { RunOutput } from './RunOutput';
import { goToField, runHint, runStatus, useFieldPlaces, useMoreBelow } from './runCardWords';
import { secretKeptWords } from './SecretCard';
import { SecretField } from './SecretField';

export function RunCard({ messageId, block, state, agent, cardRef }: { messageId: string; block: ParsedInboxRun; state: RunStateWire | null; agent: string; cardRef?: (element: Element | null) => (() => void) | undefined }) {
  const view = state?.blocks[block.key] ?? null;
  const run = state?.runs[block.key] ?? null;
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const [pressing, setPressing] = useState(false);
  // A second press while one is on its way is swallowed (a double click), before React draws anything.
  const pressingRef = useRef(false);
  // One button that is Run, then Stop, then Run again: focus stays on it through each change.
  const mainRef = useRef<HTMLButtonElement>(null);
  const live = run?.state === 'starting' || run?.state === 'running';
  const leftRunning = run?.interrupted === 'lost' && run.left_running === true;
  // Read from the block here, so Copy is never offered for a hidden character while the computer's answer is on its way.
  const hidden = inboxRunBlockHidden(block);
  const computer = state?.computer ?? 'your computer';
  const needs = view?.needs ?? [];
  const fromShell = view?.from_shell ?? [];
  const using = view?.uses.filter((name) => !needs.includes(name) && !fromShell.includes(name)) ?? [];
  const [card, setCard] = useState<HTMLElement | null>(null);
  const [commandRef, commandMore] = useMoreBelow<HTMLPreElement>(block.command);
  const places = useFieldPlaces(card, needs.filter((name) => !(view?.fields.includes(name) ?? false)), view?.field_at);
  // Stable, so the store sees each card come on and off screen once, not on every redraw.
  const sectionRef = useCallback(
    (element: HTMLElement | null) => {
      setCard(element);
      const done = cardRef?.(element);
      return () => {
        setCard(null);
        done?.();
      };
    },
    [cardRef],
  );
  const unusable = inboxRunUnusableWords(block.uses_unusable);

  const act = async (work: () => Promise<unknown>) => {
    if (pressingRef.current) return;
    pressingRef.current = true;
    setPressing(true);
    setNote(null);
    try {
      await work();
    } catch (failure) {
      setNote(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pressingRef.current = false;
      setPressing(false);
      await refreshRunState(messageId);
    }
  };
  const start = () => act(() => runApi.start(messageId, block.key, block.command));
  const stop = () => act(() => runApi.stop(messageId, block.key));
  const copy = async () => setCopied((await copyTextToClipboard(block.command)) ? 'ok' : 'failed');
  const terminal = () =>
    act(async () => {
      const opened = await runApi.terminal(messageId, block.key, block.command);
      const where = `Opened ${opened.terminal} on ${computer} in ${view?.folder ?? 'the project folder'}.`;
      const paste = opened.copied ? 'The command is on its clipboard: paste it there.' : 'Copy the command from this card and paste it there.';
      // Names the person's own shell sets are set in that terminal too: only the saved ones are not.
      const names = (view?.uses ?? []).filter((name) => !(view?.from_shell ?? []).includes(name));
      const unset = names.length > 0 ? ` ${names.join(' and ')} ${names.length === 1 ? "isn't" : "aren't"} set in that terminal.` : '';
      setNote(`${where} ${paste}${unset}`);
    });

  const stopping = live || leftRunning;
  const waiting = needs.length > 0 && !stopping;
  const unavailable = pressing || waiting;
  const main = {
    label: stopping ? 'Stop' : run ? 'Run again' : 'Run',
    icon: stopping ? 'stop' : run ? 'replay' : 'play',
    primary: stopping ? !run?.waiting_for_input : !(run?.needs_terminal || waiting),
  } as const;

  return (
    <section
      ref={sectionRef}
      className="ib-rb"
      data-run-card={block.key} data-run-state={hidden ? 'refused' : (run?.state ?? 'idle')} aria-label={block.title.replace(/[*_`~]/g, '')}>
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
          <pre className="ib-rb-cmd">{hidden.where === 'folder' ? `Folder: ${inboxRunShowHidden(block.folder ?? '')}` : inboxRunShowHidden(block.command)}</pre>
        </div>
      ) : (
        <>
          <div className="ib-rb-cmdrow">
            <pre className="ib-rb-cmd" ref={commandRef} data-run-command="" data-more={commandMore ? '' : undefined} tabIndex={0} aria-label="Command">
              {block.command}
            </pre>
            <button type="button" className="ib-btn ib-ghost ib-sm ib-rb-copy" onClick={() => void copy()} data-run-copy="">
              <Icon name={copied === 'ok' ? 'check' : 'copy'} />
              {copied === 'ok' ? 'Copied' : copied === 'failed' ? "Couldn't copy" : 'Copy'}
            </button>
          </div>
          <p className="ib-rb-where" data-run-where="">
            {view?.folder_missing ? `That folder isn't on ${computer}: ${view.folder ?? 'the project has no folder'}` : `On ${computer} · in ${view?.folder ?? '…'}`}
          </p>
          {using.length > 0 && (
            <p className="ib-rb-uses" data-run-uses="">
              <Icon name="lock" />
              {`Uses ${using.join(', ')}`}
            </p>
          )}
          {fromShell.length > 0 && (
            <p className="ib-rb-uses" data-run-from-shell="">
              <Icon name="lock" />
              {`Uses ${fromShell.join(', ')} from your shell`}
            </p>
          )}
          {unusable && (
            <p className="ib-rb-warn" data-run-unusable="">
              <Icon name="warn" />
              <span>{unusable}</span>
            </p>
          )}
          {view?.lookalike && (
            <p className="ib-rb-warn" data-run-lookalike="">
              <Icon name="warn" />
              <span>{view.lookalike}</span>
            </p>
          )}
          {view?.shell_note && (
            <p className="ib-rb-warn" data-run-shell-note="">
              <Icon name="warn" />
              <span>{view.shell_note}</span>
            </p>
          )}
          {needs.map((name) => {
            const here = view?.fields.includes(name) ?? false;
            return (
              <div key={name} className="ib-rb-need" data-run-needs={name}>
                <p className="ib-rb-needs-l">
                  <Icon name="lock" />
                  {`Needs ${name}`}
                  {!here && (
                    <button type="button" className="ib-btn ib-ghost ib-sm" onClick={() => void goToField(name, view?.field_at?.[name])} data-run-needs-go="">
                      {places[name] ? `Save it ${places[name]}` : 'Save it in its card'}
                    </button>
                  )}
                </p>
                {here && (
                  <>
                  <SecretField
                    messageId={messageId}
                    name={name}
                    // The last secret it waits for: one press saves it and runs.
                    {...(needs.length === 1 && !live
                      ? {
                          saveLabel: 'Save and run',
                          onDone: () => {
                            mainRef.current?.focus();
                            void start();
                          },
                        }
                      : {})}
                  />
                  <p className="ib-rb-hint" data-secret-kept="">
                    {secretKeptWords(state, agent)}
                  </p>
                  </>
                )}
              </div>
            );
          })}
          {run && !((run.error || run.interrupted === 'lost') && run.total_lines === 0) && <RunOutput run={run} />}
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
          {run && !live && (
            <p className="ib-rb-hint" data-run-hint="">
              {runHint(run, agent, computer)}
            </p>
          )}
          <div className="ib-rb-acts">
            <button
              ref={mainRef}
              type="button"
              className={`ib-btn ${main.primary ? 'ib-pri' : ''}`}
              disabled={!view || (!stopping && view.folder_missing)}
              aria-disabled={unavailable || undefined}
              title={waiting ? `Needs ${needs.join(' and ')}` : undefined}
              onClick={() => {
                if (unavailable) return;
                void (stopping ? stop() : start());
              }}
              {...(stopping ? { 'data-run-card-stop': '' } : { 'data-run-start': '' })}
            >
              <Icon name={main.icon} />
              {main.label}
            </button>
            <button
              type="button"
              className={`ib-btn ${run?.needs_terminal || run?.waiting_for_input ? 'ib-pri' : 'ib-ghost'}`}
              disabled={!view || view.folder_missing}
              aria-disabled={pressing || undefined}
              onClick={() => {
                if (!pressing) void terminal();
              }}
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
  // Screen readers hear the state as it changes, not each second's count.
  const heard = run.state === 'running' ? 'Running' : status.text;
  return (
    <span className={`ib-rb-status ib-${status.tone}`} data-run-status="">
      {status.tone === 'live' && <span className="ib-rb-dot" aria-hidden="true" />}
      <span aria-hidden="true">{status.text}</span>
      <span className="ib-sr" aria-live="polite">
        {heard}
      </span>
    </span>
  );
}
