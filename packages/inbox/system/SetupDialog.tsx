import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  SYSTEM_AGENT_NAMES,
  SYSTEM_SETUP_AGENTS,
  systemAgentModels,
  systemModelForAgent,
  systemRecommendedModel,
  parseSystemDocSite,
  parseSystemRepo,
  systemDocLabel,
  systemRepoHost,
  systemRepoLabel,
  withSystemEntry,
  type SystemSetup,
  type SystemSetupAgent,
  type SystemSetupAnswer,
  type SystemSetupInput,
  type SystemSetupProject,
} from '@plannotator/core/inbox-system-setup';
import { Icon } from '../icons';
import { tildePath } from '../format';
import { Modal } from '../components/Updates';
import { systemFirstDrawPrompt } from './firstDraw';

const STEPS = ['Project', 'What to read', 'Keep it current'] as const;

export interface SystemSetupDialogProps {
  phone: boolean;
  /** The home folder, so folders read `~/…`. */
  home: string | null;
  /**
   * The agents the Inbox can start here (`GET /api/inbox/sessions` `launch.agents`; none while launch is off). Every
   * agent System knows is offered; the last step ends at Draw it for one of these, else at Copy prompt (the fallback).
   */
  loadAgents: () => Promise<SystemSetupAgent[]>;
  /** The project to start on; null: the first one found. */
  startProject: string | null;
  load: () => Promise<SystemSetupAnswer>;
  save: (input: SystemSetupInput) => Promise<SystemSetup>;
  /** Draw it, after the save (launch on). */
  onDrawIt: (project: SystemSetupProject, setup: SystemSetup) => void;
  /** Copy prompt (launch off): starts the copy inside the click, as the clipboard needs; resolves whether it copied. */
  copy: (text: string) => Promise<boolean>;
  /** After Copy prompt copied the prompt and saved. */
  onCopied: (project: SystemSetupProject, setup: SystemSetup) => void;
  onClose: () => void;
}

/**
 * System → Set up a project (approval "system-inbox", screens 2b to 2d): pick the project, what the agent should
 * read, and who keeps the drawing current. Nothing to type but extra repos and doc sites. The last step saves
 * `<data dir>/system/<key>/setup.json`, then Draw it (an agent the Inbox can start) or Copy prompt (the fallback). Cancel saves nothing.
 */
export function SystemSetupDialog(props: SystemSetupDialogProps) {
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const [projects, setProjects] = useState<SystemSetupProject[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);
  /** The project whose choices the fields below hold: picking another starts from that project's own. */
  const [filledFor, setFilledFor] = useState<string | null>(null);
  const [repos, setRepos] = useState<string[]>([]);
  const [docs, setDocs] = useState<string[]>([]);
  const [agent, setAgent] = useState<SystemSetupAgent>('claude');
  const [model, setModel] = useState<string | null>(systemRecommendedModel('claude'));
  const [launchable, setLaunchable] = useState<SystemSetupAgent[] | null>(null);
  const [repoDraft, setRepoDraft] = useState<string | null>(null);
  const [docDraft, setDocDraft] = useState('');
  const [repoError, setRepoError] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const repoInputRef = useRef<HTMLInputElement>(null);
  const addRepoRef = useRef<HTMLButtonElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const reposRef = useRef<HTMLUListElement>(null);
  const docsRef = useRef<HTMLUListElement>(null);
  /** A chip just removed: focus goes to the chip now in its place, or to its field when none is left after it. */
  const removed = useRef<{ list: 'repos' | 'docs'; index: number } | null>(null);
  const firstStep = useRef(true);

  const read = () => {
    setLoadError(null);
    setProjects(null);
    props.load().then(
      (answer) => {
        setProjects(answer.projects);
        setChosen((current) => current ?? answer.projects.find((p) => p.id === props.startProject)?.id ?? answer.projects[0]?.id ?? null);
      },
      (cause) => setLoadError(cause instanceof Error && cause.message ? cause.message : 'The projects could not be read.'),
    );
  };
  useEffect(read, []);
  useEffect(() => {
    let live = true;
    props.loadAgents().then(
      (found) => live && setLaunchable(found),
      () => live && setLaunchable([]),
    );
    return () => {
      live = false;
    };
  }, []);
  /** Draw it when the Inbox can start the picked agent here; Copy prompt (the fallback) otherwise. */
  const canLaunch = !!launchable && launchable.includes(agent);
  /** Every agent the Inbox launches itself is offered (none needs connecting first), once the read of which can start is in. */
  const agents = launchable === null ? null : SYSTEM_SETUP_AGENTS;
  const pickAgent = (next: SystemSetupAgent) => {
    setModel((current) => systemModelForAgent(current, agent, next));
    setAgent(next);
  };
  useEffect(() => {
    // A new step's heading takes focus, so a screen reader hears where it is.
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);
  useEffect(() => {
    if (repoDraft !== null) repoInputRef.current?.focus();
  }, [repoDraft !== null]);
  useEffect(() => {
    const gone = removed.current;
    if (!gone) return;
    removed.current = null;
    const list = gone.list === 'repos' ? reposRef.current : docsRef.current;
    const nextChip = list?.querySelectorAll<HTMLButtonElement>('.ib-sys-x')[gone.index];
    if (nextChip) nextChip.focus();
    else if (gone.list === 'repos') (repoInputRef.current ?? addRepoRef.current)?.focus();
    else docInputRef.current?.focus();
  }, [repos, docs]);
  const removeRepo = (index: number) => {
    removed.current = { list: 'repos', index };
    setRepos((list) => list.filter((_, i) => i !== index));
  };
  const removeDoc = (index: number) => {
    removed.current = { list: 'docs', index };
    setDocs((list) => list.filter((_, i) => i !== index));
  };

  const project = projects?.find((p) => p.id === chosen) ?? null;
  const ownHost = project ? systemRepoHost(project.repo) : null;

  const fill = (next: SystemSetupProject) => {
    if (filledFor === next.id) return;
    setFilledFor(next.id);
    setRepos(next.setup?.repos ?? []);
    setDocs(next.setup?.docs ?? []);
    setAgent(next.setup?.agent ?? 'claude');
    setModel(next.setup ? next.setup.model : systemRecommendedModel('claude'));
    setRepoDraft(null);
    setDocDraft('');
    setRepoError(null);
    setDocError(null);
  };

  /** Adds what is typed in the repo field; false (and says why) when it is not a repo. Empty adds nothing. */
  const addRepo = (): boolean => {
    if (!project || repoDraft === null || !repoDraft.trim()) return true;
    const parsed = parseSystemRepo(repoDraft, ownHost ?? undefined);
    if (!parsed.ok) {
      setRepoError(parsed.error);
      repoInputRef.current?.focus();
      return false;
    }
    setRepos((list) => withSystemEntry(list, parsed.value, project.repo));
    setRepoDraft('');
    setRepoError(null);
    return true;
  };
  const addDoc = (): boolean => {
    if (!docDraft.trim()) return true;
    const parsed = parseSystemDocSite(docDraft);
    if (!parsed.ok) {
      setDocError(parsed.error);
      docInputRef.current?.focus();
      return false;
    }
    setDocs((list) => withSystemEntry(list, parsed.value));
    setDocDraft('');
    setDocError(null);
    return true;
  };
  const submit = (add: () => boolean) => (event: FormEvent) => {
    event.preventDefault();
    add();
  };

  const next = () => {
    if (step === 0) {
      if (!project) return;
      fill(project);
      setStep(1);
      return;
    }
    if (step === 1) {
      // Words typed and not yet added go in with Next, so nothing typed is lost.
      if (!addRepo() || !addDoc()) return;
      setStep(2);
    }
  };

  const finish = async () => {
    if (!project || saving || agents === null) return;
    const input: SystemSetupInput = { project_id: project.id, repos, docs, agent, model };
    // The clipboard needs the click: the copy starts before the save.
    const copied = canLaunch ? null : props.copy(systemFirstDrawPrompt(project, input));
    setSaving(true);
    setSaveError(null);
    try {
      const setup = await props.save(input);
      if (copied && !(await copied)) {
        // Saved, not copied: the dialog stays, so the next press copies it.
        setSaving(false);
        setSaveError('Your choices are saved, but the prompt could not be copied. Press Copy prompt again.');
        return;
      }
      if (copied) props.onCopied(project, setup);
      else props.onDrawIt(project, setup);
      props.onClose();
    } catch (cause) {
      setSaving(false);
      setSaveError(cause instanceof Error && cause.message ? cause.message : 'The setup could not be saved.');
    }
  };

  const titleId = `ib-sys-t-${uid}`;
  const heading = step === 0 ? 'Set up System' : step === 1 ? 'What should the agent read?' : 'Who keeps it current?';

  return (
    <Modal
      labelledBy={titleId}
      testId="system-setup"
      ownKeys
      onClose={() => (saving ? undefined : props.onClose())}
      className={`ib-sys${props.phone ? ' ib-sys-phone' : ''}`}
    >
      <ol className="ib-sys-steps" aria-label="Steps" data-system-steps="">
        {STEPS.map((label, i) => (
          <li key={label} aria-current={i === step ? 'step' : undefined} data-done={i < step ? '' : undefined}>
            <span className="ib-sys-n" aria-hidden="true">
              {i < step ? <Icon name="check" size={11} /> : i + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>
      <h2 id={titleId} ref={headingRef} tabIndex={-1} data-system-step={step + 1}>
        {heading}
      </h2>

      {step === 0 && (
        <>
          <p className="ib-sub">Pick the project to draw. One drawing per project.</p>
          {loadError ? (
            <div className="ib-callout ib-err ib-sys-msg" role="alert">
              <Icon name="warn" />
              <span>
                {loadError}{' '}
                <button type="button" className="ib-lnk" onClick={read}>
                  Try again
                </button>
              </span>
            </div>
          ) : projects === null ? (
            <p className="ib-quietline" aria-busy="true">
              Looking for projects on this Mac…
            </p>
          ) : projects.length === 0 ? (
            <p className="ib-quietline" data-system-none="">
              No project here has a git remote yet. A project shows here once an agent writes to the Inbox from a git repository on this Mac.
            </p>
          ) : (
            <div className="ib-sys-picks" role="radiogroup" aria-labelledby={titleId}>
              {projects.map((p) => (
                <label key={p.id} className="ib-sys-pick" data-on={p.id === chosen ? '' : undefined} data-system-project={p.id}>
                  <input type="radio" name={`ib-sys-p-${uid}`} checked={p.id === chosen} onChange={() => setChosen(p.id)} />
                  <span className="ib-sys-nm">{p.name}</span>
                  <span className="ib-sys-lc">
                    <span>{tildePath(p.root, props.home)}</span>
                    <span>{p.repo}</span>
                  </span>
                  <span className="ib-sys-ok">
                    <Icon name="check" size={13} />
                    found on this Mac
                  </span>
                </label>
              ))}
            </div>
          )}
        </>
      )}

      {step === 1 && project && (
        <>
          <p className="ib-sub">Code and docs for {project.name}. Every part it draws names the file it came from.</p>
          <p className="ib-sys-fl" id={`ib-sys-r-${uid}`}>
            Repos
          </p>
          <ul ref={reposRef} className="ib-sys-chips" aria-labelledby={`ib-sys-r-${uid}`} data-system-repos="">
            <li className="ib-sys-chip" data-system-own="">
              <span className="ib-sys-mono">{systemRepoLabel(project.repo, ownHost)}</span>
              <span className="ib-sys-from">this project's repo</span>
            </li>
            {repos.map((repo, index) => (
              <li key={repo} className="ib-sys-chip" data-system-repo={repo}>
                <span className="ib-sys-mono">{systemRepoLabel(repo, ownHost)}</span>
                <button type="button" className="ib-sys-x" aria-label={`Remove ${systemRepoLabel(repo, ownHost)}`} onClick={() => removeRepo(index)}>
                  <Icon name="x" size={12} />
                </button>
              </li>
            ))}
            {repoDraft === null && (
              <li>
                <button type="button" ref={addRepoRef} className="ib-sys-chip ib-sys-add" onClick={() => setRepoDraft('')} data-system-add-repo="">
                  <Icon name="plus" size={12} />
                  Add a repo
                </button>
              </li>
            )}
          </ul>
          {repoDraft !== null && (
            <form className="ib-sys-addrow" onSubmit={submit(addRepo)} noValidate>
              <input
                ref={repoInputRef}
                className="ib-sys-inp"
                type="text"
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                aria-label="Repo"
                placeholder="owner/name or the repo's URL"
                value={repoDraft}
                aria-invalid={repoError ? true : undefined}
                aria-errormessage={repoError ? `ib-sys-re-${uid}` : undefined}
                onChange={(event) => {
                  setRepoDraft(event.target.value);
                  setRepoError(null);
                }}
                data-system-repo-input=""
              />
              <button type="submit" className="ib-btn">
                Add
              </button>
            </form>
          )}
          {repoError && (
            <p className="ib-sys-err" id={`ib-sys-re-${uid}`} role="alert" data-system-repo-error="">
              {repoError}
            </p>
          )}

          <p className="ib-sys-fl ib-sys-fl2" id={`ib-sys-d-${uid}`}>
            Doc sites
          </p>
          {docs.length > 0 && (
            <ul ref={docsRef} className="ib-sys-chips" aria-labelledby={`ib-sys-d-${uid}`} data-system-docs="">
              {docs.map((doc, index) => (
                <li key={doc} className="ib-sys-chip" data-system-doc={doc}>
                  <span className="ib-sys-mono">{systemDocLabel(doc)}</span>
                  <button type="button" className="ib-sys-x" aria-label={`Remove ${systemDocLabel(doc)}`} onClick={() => removeDoc(index)}>
                    <Icon name="x" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form className="ib-sys-addrow" onSubmit={submit(addDoc)} noValidate>
            <input
              ref={docInputRef}
              className="ib-sys-inp"
              type="url"
              inputMode="url"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              aria-label="Doc site"
              placeholder="Paste a URL"
              value={docDraft}
              aria-invalid={docError ? true : undefined}
              aria-errormessage={docError ? `ib-sys-de-${uid}` : undefined}
              onChange={(event) => {
                setDocDraft(event.target.value);
                setDocError(null);
              }}
              data-system-doc-input=""
            />
            <button type="submit" className="ib-btn">
              Add
            </button>
          </form>
          {docError && (
            <p className="ib-sys-err" id={`ib-sys-de-${uid}`} role="alert" data-system-doc-error="">
              {docError}
            </p>
          )}
        </>
      )}

      {step === 2 && project && (
        <>
          <p className="ib-sub" data-system-how={canLaunch ? 'launch' : 'prompt'}>
            {canLaunch
              ? 'The agent you pick runs the drawing phase now, on this Mac, and every redraw after it.'
              : `The Inbox can't start an agent here, so copy the prompt for the drawing phase and paste it into your agent in ${project.name}. Redraws use the same agent.`}
          </p>
          {agents === null ? (
            <p className="ib-quietline" aria-busy="true">
              Looking for agents on this Mac…
            </p>
          ) : (
            <div className="ib-sys-picks" role="radiogroup" aria-label="Agent" data-system-agents="">
              {agents.map((id) => (
                <div key={id} className="ib-sys-agentrow" data-on={agent === id ? '' : undefined} data-system-agent={id}>
                  <label className="ib-sys-pick">
                    <input type="radio" name={`ib-sys-a-${uid}`} checked={agent === id} onChange={() => pickAgent(id)} />
                    <span className="ib-sys-nm">{SYSTEM_AGENT_NAMES[id]}</span>
                  </label>
                  {agent === id && (
                    <div className="ib-sys-rb">
                      <span className="ib-seg ib-sys-model" role="radiogroup" aria-label={`${SYSTEM_AGENT_NAMES[id]}'s model`}>
                        {systemAgentModels(id).map((option) => (
                          <label key={option.id ?? 'default'} className="ib-seg-o" data-on={model === option.id ? '' : undefined} data-system-model={option.id ?? ''}>
                            <input type="radio" name={`ib-sys-m-${uid}`} checked={model === option.id} onChange={() => setModel(option.id)} />
                            {option.name}
                            {option.recommended && <span className="ib-sys-rec">Recommended</span>}
                          </label>
                        ))}
                      </span>
                      <small>
                        A free check looks at main every 15 minutes and wakes the agent only when something changed.
                      </small>
                      <span className="ib-sys-cost">Cost: your own agent's usage, only when main changed.</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {saveError && (
            <p className="ib-callout ib-err ib-sys-msg" role="alert" data-system-save-error="">
              <Icon name="warn" />
              <span>{saveError}</span>
            </p>
          )}
        </>
      )}

      <div className="ib-acts-row ib-sys-acts">
        {step > 0 && (
          <button type="button" className="ib-btn ib-left" onClick={() => setStep(step - 1)} disabled={saving} data-system-back="">
            Back
          </button>
        )}
        <button type="button" className="ib-btn" onClick={props.onClose} disabled={saving} data-system-cancel="">
          Cancel
        </button>
        {step < 2 ? (
          <button type="button" className="ib-btn ib-pri" onClick={next} disabled={step === 0 && !project} data-system-next="">
            Next
          </button>
        ) : canLaunch ? (
          <button type="button" className="ib-btn ib-pri" onClick={() => void finish()} aria-disabled={saving || undefined} data-system-draw="">
            {saving ? 'Saving…' : 'Draw it'}
          </button>
        ) : (
          <button type="button" className="ib-btn ib-pri" onClick={() => void finish()} disabled={agents === null} aria-disabled={saving || undefined} data-system-copy="">
            <Icon name="copy" />
            {saving ? 'Saving…' : 'Copy prompt'}
          </button>
        )}
      </div>
    </Modal>
  );
}
