import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { INBOX_CARD_NOTES_MAX, INBOX_CARD_TITLE_MAX, type InboxInitiative } from '@plannotator/core/inbox-types';
import type { ComposeSessionsModel, ProjectFolder } from '../api';
import { tildePath } from '../format';
import { HostMark, Icon } from '../icons';
import { Modal } from '../components/Updates';
import { HashtagFieldMenu } from '../components/HashtagFieldMenu';
import { useHashtagPicker, useInitiativeTags } from '../hashtags';
import { SessionDetail, ToPicker } from '../compose/ToPicker';
import { composeGroups, findTarget, hostLabel, type ComposeTarget } from '../compose/model';

/** Where a New card goes: Backlog by default, or straight to an agent (Todo). The Icebox folded into Backlog (Board columns v2). */
export type NewCardMode = 'backlog' | 'send';

export interface NewCardInput {
  title: string;
  notes: string | null;
  /** Links, as typed (each `owner/repo#123` or a URL). */
  refs: string[];
  mode: NewCardMode;
  project: string | null;
  to: ComposeTarget | null;
  /** The initiative the card starts in (the Board's filter, approval "board-initiatives"), or null. */
  initiative: string | null;
}

/**
 * The links in a links field, split on spaces and commas. A URL keeps the
 * commas inside it (a map's `@37.7,-122.4`, a filter's `a,b`); only a comma
 * that ends it, or one right before another `http(s)://` (`url1,url2` from a
 * spreadsheet cell), is a separator.
 */
export function splitRefs(text: string): string[] {
  return text
    .split(/\s+|,(?=https?:\/\/)/i)
    .flatMap((word) => (/^https?:\/\//i.test(word) ? [word.replace(/,+$/, '')] : word.split(',')))
    .map((word) => word.trim())
    .filter(Boolean);
}

/**
 * New card, as mocked (approval "inbox-board", step 2): a title, notes, the
 * project (or the agent, when sent), links (issues, PRs, any web page), and two plain
 * buttons for where it goes: Backlog (the default, sent to no agent) or Send
 * to an agent (compose's live-session picker; the notes are the message; the
 * card lands in Todo). The main button names the action: "Add to Backlog",
 * "Send to Claude Code". On a phone the dialog is a full screen with
 * Cancel and the action at the top.
 */
export function NewCardDialog({
  projects,
  defaultProject,
  sessions,
  home,
  phone,
  initialMode = 'backlog',
  fixed = null,
  initiatives = [],
  defaultInitiative = null,
  onClose,
  onCreate,
}: {
  /** The live initiatives: the one the card starts in is named by its id. */
  initiatives?: readonly InboxInitiative[];
  /** The initiative the Board is filtered to: the card starts in it (the × takes it out). */
  defaultInitiative?: string | null;
  /** Sending a card that exists (the opened card's Send to an agent): its title and notes, shown and not edited; only the agent is picked. */
  fixed?: { title: string; notes: string | null } | null;
  projects: readonly ProjectFolder[];
  defaultProject: string | null;
  sessions: ComposeSessionsModel | null;
  home: string | null;
  phone: boolean;
  initialMode?: NewCardMode;
  onClose: () => void;
  /** Resolves to an error to show, or null when the card was made. */
  onCreate: (input: NewCardInput) => Promise<string | null>;
}) {
  const [title, setTitle] = useState(fixed?.title ?? '');
  const [notes, setNotes] = useState(fixed?.notes ?? '');
  const [links, setLinks] = useState('');
  const [mode, setMode] = useState<NewCardMode>(initialMode);
  const [project, setProject] = useState<string | null>(defaultProject ?? projects[0]?.id ?? null);
  const [initiative, setInitiative] = useState<string | null>(defaultInitiative && initiatives.some((i) => i.id === defaultInitiative) ? defaultInitiative : null);
  const initiativeName = initiative ? (initiatives.find((i) => i.id === initiative)?.name ?? null) : null;
  const [chosen, setChosen] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const toRef = useRef<HTMLButtonElement>(null);
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  // `#` in the title or notes picks the card's initiative (approval "board-hashtags"): the token below says it, and
  // the tag leaves the text (cards show no mark, so a title carries none). A card sent as it is (`fixed`) has none.
  const known = useInitiativeTags();
  const tags = useMemo(() => ({ ...known, initiatives: fixed ? [] : initiatives }), [fixed, initiatives, known]);
  const pickInitiative = (picked: InboxInitiative) => setInitiative(picked.id);
  const titleHash = useHashtagPicker({ text: title, setText: setTitle, fieldRef: titleRef, tags, onPick: pickInitiative, bareEscapeDismisses: true });
  const notesHash = useHashtagPicker({ text: notes, setText: setNotes, fieldRef: notesRef, tags, onPick: pickInitiative, bareEscapeDismisses: true });
  useEffect(() => titleRef.current?.focus(), []);
  const projectRow = projects.find((p) => p.id === project) ?? null;
  const groups = useMemo(() => composeGroups(sessions?.projects ?? [], projectRow ? { id: projectRow.id, root: projectRow.root } : null), [sessions, projectRow]);
  const target = sessions ? findTarget(sessions.projects, chosen) : null;
  const anyLive = (sessions?.projects ?? []).some((g) => g.sessions.length > 0);

  const action = mode === 'send' ? (target ? `Send to ${hostLabel(target.host)}` : 'Send to an agent') : 'Add to Backlog';
  const submit = async () => {
    const text = title.replace(/\s+/g, ' ').trim();
    if (!text) {
      setError('Give the card a title.');
      titleRef.current?.focus();
      return;
    }
    if (mode === 'send' && !target) {
      setError(anyLive ? 'Choose an agent to send it to.' : 'No agent is running. Add it to Backlog, and send it from the card when one is.');
      (toRef.current ?? titleRef.current)?.focus();
      return;
    }
    if (mode !== 'send' && !project) {
      setError('A card needs a project: an agent’s first message makes one.');
      return;
    }
    setBusy(true);
    setError(null);
    const failed = await onCreate({ title: text, notes: notes.trim() || null, refs: splitRefs(links), mode, project, to: mode === 'send' ? target : null, initiative: fixed ? null : initiative });
    setBusy(false);
    if (failed) setError(failed);
  };

  // One choice of two: native radios in one group (arrows move it), drawn as plain buttons.
  const modeButton = (value: NewCardMode, icon: 'board' | 'send', label: string, short: string) => (
    <label className="ib-ncd-mode" data-new-card-mode={value} data-on={mode === value ? '' : undefined}>
      <input
        type="radio"
        name={`ib-ncd-mode-${uid}`}
        value={value}
        checked={mode === value}
        aria-label={label}
        onChange={() => {
          setMode(value);
          setError(null);
          if (value === 'send' && !chosen && anyLive) setPicker(true);
        }}
      />
      {value === 'backlog' ? <span className="ib-lane-dot" data-col="backlog" aria-hidden="true" /> : <Icon name={icon} size={15} />}
      <span aria-hidden="true">{phone ? short : label}</span>
    </label>
  );

  return (
    <Modal labelledBy={`ib-ncd-t-${uid}`} testId="new-card" onClose={onClose} ownKeys className={`ib-ncd${phone ? ' ib-ncd-phone' : ''}`}>
      <form
        className="ib-ncd-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="ib-ncd-head">
          {phone && (
            <button type="button" className="ib-ncd-bar" onClick={onClose}>
              Cancel
            </button>
          )}
          <h2 id={`ib-ncd-t-${uid}`}>{fixed ? 'Send to an agent' : 'New card'}</h2>
          {phone ? (
            <button type="submit" className="ib-ncd-bar ib-strong" disabled={busy} data-new-card-add="">
              {mode === 'send' ? 'Send' : 'Add'}
            </button>
          ) : (
            <button type="button" className="ib-ncd-x" aria-label="Close" onClick={onClose}>
              <Icon name="x" size={16} />
            </button>
          )}
        </div>
        <div className="ib-ncd-body">
          <label className="ib-sr" htmlFor={`ib-ncd-title-${uid}`}>
            Title
          </label>
          <div className="ib-hashwrap">
            {titleHash.menu && <HashtagFieldMenu id={`ib-ncd-hash-t-${uid}`} field={titleRef.current} menu={titleHash.menu} onSelect={titleHash.select} />}
            <input
              id={`ib-ncd-title-${uid}`}
              ref={titleRef}
              className="ib-ncd-title"
              type="text"
              placeholder="Title"
              value={title}
              maxLength={INBOX_CARD_TITLE_MAX}
              onChange={(event) => {
                setTitle(event.target.value);
                titleHash.onSelect();
              }}
              onSelect={titleHash.onSelect}
              onKeyDown={(event) => {
                if (titleHash.onKeyDown(event)) event.stopPropagation();
              }}
              readOnly={fixed !== null}
              role={titleHash.menu ? 'combobox' : undefined}
              aria-expanded={titleHash.menu ? true : undefined}
              aria-controls={titleHash.menu ? `ib-ncd-hash-t-${uid}` : undefined}
              aria-activedescendant={titleHash.menu?.activeIndex != null ? `ib-ncd-hash-t-${uid}-option-${titleHash.menu.activeIndex}` : undefined}
              data-new-card-title=""
            />
          </div>
          <label className="ib-sr" htmlFor={`ib-ncd-notes-${uid}`}>
            Notes
          </label>
          <div className="ib-hashwrap ib-hashwrap-notes">
            {notesHash.menu && <HashtagFieldMenu id={`ib-ncd-hash-n-${uid}`} field={notesRef.current} menu={notesHash.menu} onSelect={notesHash.select} />}
            <textarea
              id={`ib-ncd-notes-${uid}`}
              ref={notesRef}
              className="ib-ncd-notes"
              placeholder={mode === 'send' ? 'Notes: what the agent should do. They are the message it gets.' : 'Notes (optional)'}
              value={notes}
              maxLength={INBOX_CARD_NOTES_MAX}
              onChange={(event) => {
                setNotes(event.target.value);
                notesHash.onSelect();
              }}
              onSelect={notesHash.onSelect}
              onKeyDown={(event) => {
                if (notesHash.onKeyDown(event)) event.stopPropagation();
              }}
              readOnly={fixed !== null}
              role={notesHash.menu ? 'combobox' : undefined}
              aria-expanded={notesHash.menu ? true : undefined}
              aria-controls={notesHash.menu ? `ib-ncd-hash-n-${uid}` : undefined}
              aria-activedescendant={notesHash.menu?.activeIndex != null ? `ib-ncd-hash-n-${uid}-option-${notesHash.menu.activeIndex}` : undefined}
              data-new-card-notes=""
            />
          </div>
          {fixed === null && (
          <label className="ib-ncd-links">
            <Icon name="link" size={15} />
            <span className="ib-sr">Links</span>
            <input
              type="text"
              // Any web link, or GitHub's owner/repo#123; a phone's narrow field keeps the short form whole.
              placeholder={phone ? 'Paste links' : 'Paste links, or owner/repo#123'}
              value={links}
              onChange={(event) => setLinks(event.target.value)}
              data-new-card-links=""
            />
          </label>
          )}
        </div>
        <div className="ib-ncd-row">
          {mode === 'send' ? (
            <>
              <span className="ib-ncd-l">To</span>
              {sessions && !anyLive ? (
                <span className="ib-ncd-none" data-new-card-to="none">
                  <Icon name="info" size={15} />
                  No agent is running
                </span>
              ) : (
                <button
                  ref={toRef}
                  type="button"
                  className="ib-cp-tobtn"
                  data-compose-to={target ? target.session : 'choose'}
                  aria-haspopup="listbox"
                  aria-expanded={picker}
                  aria-label={target ? `To: ${hostLabel(target.host)}${target.label ? `, ${target.label},` : ''} in ${target.project.name}. Change` : sessions ? 'To: choose an agent' : 'To: looking for live agents'}
                  onClick={() => sessions && setPicker((open) => !open)}
                >
                  {target ? (
                    <>
                      <HostMark host={target.host} />
                      <b>{hostLabel(target.host)}</b>
                      <SessionDetail name={target.project.name} root={target.project.root} label={target.label} />
                    </>
                  ) : (
                    <span className="ib-cp-tod">{sessions ? 'Choose an agent' : 'Looking for live agents…'}</span>
                  )}
                  <Icon name="chevD" size={14} />
                </button>
              )}
            </>
          ) : (
            <>
              <span className="ib-ncd-l">In</span>
              <ProjectPicker projects={projects} project={projectRow} home={home} onPick={setProject} />
            </>
          )}
          {fixed === null && initiativeName && (
            // Made on a Board filtered to an initiative: the card starts in it; × takes it out.
            <span className="ib-bflt-tok ib-ncd-ini" data-new-card-initiative={initiative ?? ''}>
              <Icon name="hash" size={13} />
              <span className="ib-bflt-tok-l" dir="auto">
                {initiativeName}
              </span>
              <button type="button" className="ib-bflt-tok-x" aria-label={`Not in ${initiativeName}`} onClick={() => setInitiative(null)} data-new-card-initiative-clear="">
                <Icon name="x" size={12} />
              </button>
            </span>
          )}
        </div>
        {picker && mode === 'send' && (
          <div className="ib-ncd-pick">
            <ToPicker
              groups={groups}
              selected={chosen}
              home={home}
              phone={phone}
              onPick={(picked) => {
                setChosen(picked.session);
                setPicker(false);
                setError(null);
                toRef.current?.focus();
              }}
              onClose={() => {
                setPicker(false);
                toRef.current?.focus();
              }}
            />
          </div>
        )}
        {error && (
          <p className="ib-error ib-ncd-err" role="alert" data-new-card-error="">
            {error}
          </p>
        )}
        <div className="ib-ncd-foot">
          {fixed === null && (
            <div className="ib-ncd-modes" role="radiogroup" aria-label="Where it goes">
              {modeButton('backlog', 'board', 'Backlog', 'Backlog')}
              {modeButton('send', 'send', 'Send to an agent', 'Agent')}
            </div>
          )}
          {!phone && (
            <>
              <span className="ib-bsp" />
              <button type="button" className="ib-btn ib-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="ib-btn ib-pri" disabled={busy} data-new-card-add="">
                {mode === 'send' && <Icon name="send" size={15} />}
                {action}
              </button>
            </>
          )}
        </div>
      </form>
    </Modal>
  );
}

/** The project a Backlog card goes in: a menu of the sidebar's projects. */
function ProjectPicker({ projects, project, home, onPick }: { projects: readonly ProjectFolder[]; project: ProjectFolder | null; home: string | null; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!project) return <span className="ib-ncd-none">No project yet</span>;
  const label = (
    <>
      <Icon name="folder" size={15} />
      <b dir="auto" className="ib-ncd-pname">
        {project.name}
      </b>
      <span className="ib-cp-tod">{tildePath(project.root, home)}</span>
    </>
  );
  if (projects.length < 2) return <span className="ib-ncd-proj">{label}</span>;
  return (
    <Menu.Root open={open} onOpenChange={setOpen} modal={false}>
      <Menu.Trigger className="ib-cp-tobtn" aria-label={`Project: ${project.name}. Change`} data-new-card-project={project.id}>
        {label}
        <Icon name="chevD" size={14} />
      </Menu.Trigger>
      <Menu.Portal container={typeof document !== 'undefined' ? (document.querySelector('dialog[data-dialog="new-card"]') as HTMLElement | null) ?? undefined : undefined}>
        <Menu.Positioner className="ib-pm-pos" side="top" align="start" sideOffset={4}>
          <Menu.Popup className="ib-pm" aria-label="Project">
            {projects.map((p) => (
              <Menu.Item key={p.id} className="ib-pmi" label={p.name} onClick={() => onPick(p.id)}>
                <Icon name={p.id === project.id ? 'check' : 'folder'} size={15} />
                <span dir="auto">{p.name}</span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
