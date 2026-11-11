import { useId, useRef, useState, type ReactNode } from 'react';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import type { RestartNote } from '../deliveryLine';
import { Icon } from '../icons';

export const RESTART_COPIED_MS = 2000;
export const RESTART_COPIED_ANNOUNCEMENT = 'Restart command copied.';
export const UPDATE_COPIED_ANNOUNCEMENT = 'Update command copied.';
export const RELOAD_COMMAND = '/reload-plugins';
export const RELOAD_COPIED_ANNOUNCEMENT = '/reload-plugins copied.';

export function CopyCommand({ text, label, short = 'Copy', announcement = RESTART_COPIED_ANNOUNCEMENT }: { text: string; label: string; short?: string; announcement?: string }) {
  const [copied, setCopied] = useState(false);
  const [said, setSaid] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <>
      <button
        type="button"
        className="ib-rw-copy"
        data-copied={copied ? '' : undefined}
        aria-label={label}
        data-restart-copy=""
        onClick={async () => {
          const ok = await copyTextToClipboard(text);
          setSaid('');
          // A fresh string each time, so a second copy is said again.
          setTimeout(() => setSaid(ok ? announcement : "Couldn't copy the command."), 30);
          if (!ok) return;
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), RESTART_COPIED_MS);
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} />
        <span>{copied ? 'Copied' : short}</span>
      </button>
      <span className="ib-sr" role="status" aria-live="polite" data-restart-live="">
        {said}
      </span>
    </>
  );
}

export function CommandLine({ text, label, announcement }: { text: string; label: string; announcement?: string }) {
  return (
    <div className="ib-rw-cmd">
      <code>{text}</code>
      <CopyCommand text={text} label={label} {...(announcement ? { announcement } : {})} />
    </div>
  );
}

export interface ReloadSpec {
  command: string;
  where: 'session' | 'shell';
}

export const CLAUDE_RELOAD: ReloadSpec = { command: RELOAD_COMMAND, where: 'session' };

export function ReloadCopy({ command = RELOAD_COMMAND }: { command?: string } = {}) {
  return <CopyCommand text={command} label={`Copy ${command}`} announcement={`${command} copied.`} />;
}

export function ReloadLead({
  where,
  updateCommand,
  reload = CLAUDE_RELOAD,
  what = "Plannotator's Claude Code plugin",
}: {
  where: string;
  updateCommand?: string | null;
  reload?: ReloadSpec;
  what?: string;
}) {
  const verb = reload.where === 'shell' ? 'run' : 'type';
  const capital = verb === 'run' ? 'Run' : 'Type';
  if (updateCommand) {
    return (
      <ol className="ib-rl-lead ib-rl-two" data-reload-lead="update_plugin">
        <li>
          <span>Update the {reload === CLAUDE_RELOAD ? 'plugin' : what.replace(/^Plannotator's /, '')}:</span>
          <CommandLine text={updateCommand} label={`Copy the command that updates ${what}`} announcement={UPDATE_COPIED_ANNOUNCEMENT} />
        </li>
        <li>
          <div className="ib-rl-line">
            <span>
              Then {verb} <code>{reload.command}</code> {where}.
            </span>
            <ReloadCopy command={reload.command} />
          </div>
        </li>
      </ol>
    );
  }
  return (
    <p className="ib-rl-lead ib-rl-line" data-reload-lead="restart" data-reload-command={reload.command}>
      <span>
        {capital} <code>{reload.command}</code> {where}.
      </span>
      <ReloadCopy command={reload.command} />
    </p>
  );
}

export function reloadOf(note: RestartNote): ReloadSpec {
  return { command: note.reloadCommand, where: note.reloadWhere };
}

export function updatedThing(runtime: RestartNote['runtime']): string {
  if (runtime === 'opencode') return "Plannotator's OpenCode plugin";
  if (runtime === 'pi' || runtime === 'oh-my-pi') return "Plannotator's extension";
  return "Plannotator's Claude Code plugin";
}

function wherePhrase(note: RestartNote, name: string, purpose: string): string {
  return note.reloadWhere === 'shell' ? purpose : `in that ${name} ${purpose}`;
}

function ManualPath({ note, name }: { note: RestartNote; name: string }) {
  if (note.runtime === 'oh-my-pi') return null;
  if (note.runtime === 'opencode') {
    if (!note.fallbackCommand || openCodeCommand(note) !== 'opencode2 reload') return null;
    return (
      <Fold question="Still no Send now after reloading?">
        <div data-restart-fallback="">
          Restart OpenCode's background server:
          <CommandLine text={note.fallbackCommand} label="Copy the command that restarts OpenCode's background server" />
          <p className="ib-rw-warn">It stops any turn an OpenCode session is working on.</p>
        </div>
        <p className="ib-rw-after">Your reply waits here.</p>
      </Fold>
    );
  }
  if (note.runtime === 'pi') {
    return (
      <Fold question="Still no Send now after reloading?">
        <div data-restart-fallback="">
          Quit that Pi (<code>/quit</code>), then start it again in its folder with <code>pi --continue</code>.
          <p className="ib-rw-warn">Quitting stops the turn it is working on.</p>
        </div>
        <p className="ib-rw-after">Your reply waits here.</p>
      </Fold>
    );
  }
  return (
    <Fold question="Still no Send now after reloading?">
      <div data-restart-fallback="">
        {note.command ? (
          <>
            Type <code>/exit</code> in that {name}, then run:
            <CommandLine text={note.command} label={`Copy the command that restarts this ${name} session`} />
          </>
        ) : (
          <>
            Type <code>/exit</code> in that {name}, then run <code>claude --resume</code> in its folder and pick the session.
          </>
        )}
        <p className="ib-rw-warn">/exit stops the turn it is working on.</p>
      </div>
      <p className="ib-rw-after">Your reply waits here.</p>
    </Fold>
  );
}

export function openCodeCommand(note: Pick<RestartNote, 'fix' | 'updateCommand' | 'reloadCommand' | 'pinnedSpec'>): string {
  return note.fix === 'update_extension' && note.updateCommand && !note.pinnedSpec ? note.updateCommand : note.reloadCommand;
}

export const OPENCODE_RELOAD_WARNING = 'Cancels any permission prompt OpenCode is showing.';
export const OPENCODE_UPDATES_ALL = 'It updates every OpenCode plugin that has a newer version.';

export function OpenCodeQuiet({ command, updatesAll, className = 'ib-rw-after ib-rl-quiet' }: { command: string; updatesAll: boolean; className?: string }) {
  const reload = command === 'opencode2 reload';
  const all = updatesAll && !reload;
  if (!reload && !all) return null;
  return (
    <p className={className} data-opencode-quiet="">
      {reload ? OPENCODE_RELOAD_WARNING : OPENCODE_UPDATES_ALL}
    </p>
  );
}

export function OpenCodeWords({ command, pinnedSpec, pinTo, tail = '' }: { command: string; pinnedSpec: string | null; pinTo: string | null; tail?: string }) {
  if (pinnedSpec) {
    const to = pinTo ?? '@plannotator/opencode@latest';
    return (
      <>
        OpenCode's config pins <code className="ib-rl-wrap">{pinnedSpec}</code>: change it to <code className="ib-rl-wrap">{to}</code>{' '}
        <span className="ib-rl-inline-copy">
          <ReloadCopy command={to} />
        </span>{' '}
        then run <code className="ib-rl-wrap">{command}</code>
        {tail}.
      </>
    );
  }
  return (
    <>
      Run <code className="ib-rl-wrap">{command}</code>
      {tail}.
    </>
  );
}

export function Fold({ question, children }: { question: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="ib-rl-fold">
      <button type="button" className="ib-rw-lnk" aria-expanded={open} aria-controls={id} data-restart-toggle="" onClick={() => setOpen((was) => !was)}>
        <span>{question}</span>
        <Icon name="chevD" className="ib-rw-chev" />
      </button>
      <div className="ib-rw-steps" id={id} hidden={!open} data-restart-steps="">
        {children}
      </div>
    </div>
  );
}

export function RestartLine({ note, name }: { note: RestartNote; name: string }) {
  const updating = note.fix === 'update_plugin' || note.fix === 'update_extension';
  if (note.runtime === 'opencode') {
    const command = openCodeCommand(note);
    return (
      <div className="ib-rw-note" data-restart-note={note.fix} data-restart-runtime={note.runtime}>
        <p className="ib-rl-lead ib-rl-line" data-reload-lead={note.pinnedSpec ? 'pin' : 'restart'} data-reload-command={command}>
          <span>
            <OpenCodeWords command={command} pinnedSpec={note.pinnedSpec} pinTo={note.pinTo} tail=" to get Send now" />
          </span>
          {!note.pinnedSpec && <ReloadCopy command={command} />}
        </p>
        <OpenCodeQuiet command={command} updatesAll={note.updatesAll} />
        <ManualPath note={note} name={name} />
      </div>
    );
  }
  return (
    <div className="ib-rw-note" data-restart-note={note.fix} data-restart-runtime={note.runtime}>
      <ReloadLead
        where={wherePhrase(note, name, 'to get Send now')}
        updateCommand={updating ? note.updateCommand : null}
        reload={reloadOf(note)}
        what={updatedThing(note.runtime)}
      />
      <ManualPath note={note} name={name} />
    </div>
  );
}

export function StuckReason({ note, name }: { note: RestartNote | null; name: string }) {
  if (!note) {
    return (
      <p className="ib-m-why" data-stuck-why="">
        It can't go in sooner.
      </p>
    );
  }
  const updating = note.fix === 'update_plugin' || note.fix === 'update_extension';
  const what = note.runtime === 'pi' || note.runtime === 'oh-my-pi' ? 'extension' : 'plugin';
  const verb = note.reloadWhere === 'shell' ? 'Run' : 'Type';
  if (note.runtime === 'opencode') {
    const command = openCodeCommand(note);
    return (
      <div className="ib-rw-note ib-m-whybox" data-restart-note={note.fix} data-restart-runtime={note.runtime}>
        <p className="ib-m-why" data-stuck-why="" data-reload-lead={note.pinnedSpec ? 'pin' : 'restart'} data-reload-command={command}>
          <span>
            It can't go in sooner: this session runs an older Plannotator plugin.{' '}
            <OpenCodeWords command={command} pinnedSpec={note.pinnedSpec} pinTo={note.pinTo} tail={note.pinnedSpec ? '' : ' to fix it'} />
          </span>
          {!note.pinnedSpec && <ReloadCopy command={command} />}
        </p>
        <OpenCodeQuiet command={command} updatesAll={note.updatesAll} />
        <ManualPath note={note} name={name} />
      </div>
    );
  }
  return (
    <div className="ib-rw-note ib-m-whybox" data-restart-note={note.fix} data-restart-runtime={note.runtime}>
      {updating ? (
        <>
          <p className="ib-m-why" data-stuck-why="">
            It can't go in sooner: this session runs an older Plannotator {what}.
          </p>
          <ReloadLead where={wherePhrase(note, name, 'to fix it')} updateCommand={note.updateCommand} reload={reloadOf(note)} what={updatedThing(note.runtime)} />
        </>
      ) : (
        <p className="ib-m-why" data-stuck-why="" data-reload-lead="restart" data-reload-command={note.reloadCommand}>
          <span>
            It can't go in sooner: this session runs an older Plannotator {what}. {verb} <code>{note.reloadCommand}</code> {wherePhrase(note, name, 'to fix it')}.
          </span>
          <ReloadCopy command={note.reloadCommand} />
        </p>
      )}
      <ManualPath note={note} name={name} />
    </div>
  );
}
