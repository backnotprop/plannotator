/**
 * Compose: send a new message to a connected agent (approval record
 * "inbox-compose-to-agent", 2026-10-14; variant Compose). A modal dialog
 * pinned to the upper part of the window like the search palette (a
 * full-screen sheet on a phone): To above the message.
 *
 * - A plain New message opens with To EMPTY and focus on To, so the person
 *   picks the agent before writing (the owner: "I keep sending messages to the
 *   wrong agent"). Send says "Choose an agent to send it." until one is picked.
 *   To is filled only where the person already chose: a reopened draft, and
 *   "Message <host>" (the palette, the first-run screen) (`composeOpening`).
 *
 * - Sending needs a live session. With none, Send stays visible but does
 *   nothing except say so, and Save draft is offered.
 * - Closing with words or files keeps them as a draft, with no question
 *   (approval "inbox-compose-escape-keeps", 2026-11-09: one Escape always
 *   leaves and costs nothing). Escape, Cancel and the backdrop all do it; the
 *   toast's Reopen brings it back as it was. An empty compose keeps nothing.
 * - A reopened draft keeps the session it was for, struck through when that
 *   session has ended: it is never re-addressed on its own.
 * - Files: the paperclip, a drop or a paste (paste.ts), uploaded at once (ComposeFiles.tsx).
 * - Launch on (`inboxLaunch.enabled`, on unless Settings → Agents turned it off; docs/agent-guides/inbox-launch.md): To can
 *   also name a new session ("New Claude Code session ▾ in <project> ▾"); Send
 *   writes the thread, then the Inbox starts the agent in the project's folder.
 *   A folder that is gone turns Send off and says so (UX screen 13).
 * - Trust and start (approval "inbox-launch-trust-compose"): for a folder the
 *   agent does not trust that the owner can trust from here, Send reads "Trust
 *   and start" and the press is the consent: there is no confirm step. A question
 *   circle beside it opens the facts, when there are any.
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { INBOX_DRAFT_BODY_MAX, INBOX_PULL_OWNER_KEYS_MAX, inboxId, type InboxDraft, type InboxDraftTo, type InboxReviewChanges, type InboxReviewLinkAnswer } from '@plannotator/core/inbox-types';
import { InboxApiError, InboxHeldError, inboxApi, type DraftView, type StartThreadInput } from '../api';
import { tildePath, whenTime } from '../format';
import { HostMark, Icon } from '../icons';
import type { ReuseSource } from '../reuse';
import { AttachFilesButton, ComposeFileTiles, attachedAnnouncement, useComposeFiles, useFileDrop } from './ComposeFiles';
import { SessionDetail, ToPicker, startKey } from './ToPicker';
import { FolderMenu, type FolderGroup } from './FolderMenu';
import { unpluggedDrive } from './homeFolders';
import { THREAD_NAME_ATTACHED_NOTE, ThreadNameChip } from './ThreadNameChip';
import { TrustDetails } from './TrustDetails';
import { isLongPaste } from './pastedText';
import { useComposeSessions, type ComposeSessionsLoader } from './useComposeSessions';
import { useMachineLaunches } from './useMachineLaunches';
import { InboxComposerField, type CaretMenuOptions } from '../components/ComposerField';
import { ARM_MS } from '../components/PermissionCard';
import { VoiceFoot } from '../components/VoiceMic';
import { useVoiceSession } from '../voice';
import { Tip } from '../components/Tip';
import { useShortcutAria } from '../shortcuts/hint';
import { inboxThreadShortcuts } from '../shortcuts/thread.shortcuts';
import { INBOX_MESSAGE_SKILL_AUDIENCE, inboxSkillsBlock, withSkillsBlock } from '../skills';
import { registerReloadFlush } from '../stalePage';
import {
  DRAFT_TOO_LONG,
  NOTHING_SENT_NO_AGENT,
  composeGroups,
  composeTargets,
  draftSnapshot,
  draftThreadName,
  draftTo,
  findTarget,
  hostLabel,
  isDirty,
  composeOpening,
  composeBoardChoice,
  rememberComposeBoardChoice,
  statusLine,
  startStatusLine,
  scratchFolderOf,
  scratchProject,
  folderProject,
  untildePath,
  SCRATCH_PICK,
  sendThreadName,
  suggestThreadName,
  threadNameStateOf,
  type ThreadNameState,
  type ComposeTarget,
  type ComposeStart,
  type ComposeClone,
  type ComposeCloneRequest,
  cloneOfUrl,
  defaultStartProject,
  launchGroups,
  type LaunchHistory,
  type MachineLaunchProject,
} from './model';
import { newUuid } from '../uuid';
import { handoffKeys, pullHandoffAskLine, pullHandoffMessage, pullHandoffThreadName, pullLaunchAsk } from '../pulls/model';
import { forgetUnsentReview, keepUnsentReview, localReviewMessage, localReviewName, walkthroughMessage, reviewDefaultTo, reviewLinkListed, reviewLinkStack, reviewToWithChanges, unsentReview, type ReviewBoxPull, type ReviewKind, type ReviewPullsRead, type ReviewBoxRequest, type ReviewSummary } from './reviewBox';
import { ReviewRows } from './ReviewRows';
import { LaunchTipCard } from './LaunchTipCard';
import { LAUNCH_TIP_SAID, LAUNCH_TIP_TIMES, launchTipPlace, launchTipPlainOpen, type LaunchTipPlace } from './launchTip';

/** How long after the last keystroke a pasted link is read. */
const REVIEW_LINK_PAUSE_MS = 300;
/** A phone's picker shows at most 4½ rows of 44 px (the reply box's rule, inbox.css). */
const PHONE_SKILL_LIST_HEIGHT = 198;

export interface ComposeRequest {
  /** A draft to reopen (the Drafts page). */
  draft?: DraftView | null;
  /** Words the message starts with (the tour's suggested request). */
  body?: string;
  /** A session to put in To (the palette's "Message <host> in <project>"). */
  session?: string | null;
  /**
   * A Board card with no thread (its opened card's "Create thread"): the
   * message starts with the card's title, so the thread's subject is the
   * title, and the window links the sent thread to the card (`ComposeSent.cardId`).
   * Saved as a draft, the draft keeps the card (`InboxDraft.card`), so sending
   * it later from Drafts still links the thread.
   */
  card?: { id: string; title: string } | null;
  /**
   * Pull requests' Launch an agent: the PRs (a stack's open layers) the new thread is for, with the hand-off's words
   * in `body`. The window keeps the sent thread as their agent's (`ComposeSent.pullKeys`). Not kept with a draft.
   */
  pulls?: InboxDraft['pulls'] | null;
  /** The thread's name as compose opens (Launch an agent: `pullHandoffThreadName`), as if the person had typed it. */
  threadName?: string;
  /** Files already in the Inbox this message starts with (an archived thread's reuse button). */
  reuse?: readonly ReuseSource[];
  /** New review: the box's rows above To (`reviewBox.ts`), filled in with a PR from its own page. */
  review?: ReviewBoxRequest | null;
  /** A failed clone's Change the URL (E5): To the same agent and machine, the folder menu open with the URL in its filter. */
  clone?: ComposeCloneRequest | null;
  /**
   * "+" on a project row (approval "launch-create-clone", F3, F5, F7): To reads "New <agent> session in <project>", the
   * agent the person started last when that machine has it (`agent`), else its first; the cursor is in the message.
   */
  start?: { projectId: string; machine: string | null; agent: string | null } | null;
  /**
   * The sidebar's Add agent (approval "inbox-agents-section"): To reads "New <agent> session" in the project the
   * person is looking at, else the most recently active (`defaultStartProject`), once the launch block is read; the
   * agent the person started last when it can start (`agent`), else the first. Nothing to start: To stays empty.
   */
  launch?: { agent: string | null } | null;
}

export interface ComposeSent {
  threadId: string;
  session: string;
  host: string;
  projectName: string;
  /** The draft it was sent from (it is deleted with the Send), or null. */
  draftId: string | null;
  /** The Board card the thread was created for (`ComposeRequest.card`): link the thread to it. */
  cardId?: string | null;
  /** It started a new agent session (launch), rather than going to a live one. */
  launched?: boolean;
  /** The PRs the thread was started for (`ComposeRequest.pulls`): hand them to it. */
  pullKeys?: readonly string[] | null;
  /** The linked machine the agent was started on (remote launch), or absent for this computer. */
  machine?: string | null;
  /** What the hand-off asked for: its guided-review line still in the words, or the person's own curation. */
  pullAsk?: 'guide' | 'custom' | null;
}

/**
 * Where compose reads and sends (tour v2): the live sessions and the new
 * thread, and whether it keeps drafts and takes files. Absent: the Inbox's own
 * routes, drafts and uploads, exactly as always. The onboarding tour passes
 * one that writes nothing (`drafts: false`: closing asks nothing and Save
 * draft is gone; `uploads: false`: no paperclip, drop or paste).
 */
/**
 * A new session for a linked machine that its Inbox could not take yet (remote launch, `InboxHeldError`): it waits
 * in this Inbox's outbox, and the agent starts there when that machine is back. Cancel takes it back while `queued`.
 */
export interface ComposeHeld {
  /** The outbox entry's key (`inboxApi.cancelOutbox`). */
  key: string;
  /** It never left yet: Cancel can take it back. */
  queued: boolean;
  machineName: string;
  /** That machine is asleep (offline), not just slow to answer. */
  asleep: boolean;
  /** "Claude Code". */
  agentName: string;
  /** What that machine does before the agent starts: "clones acme/billing-api", "makes pricing-page" (E9). */
  first?: string;
  draftId: string | null;
  /** What was written, kept so Cancel can put it back in Drafts (the one it was sent from is gone here). */
  words: { body: string; thread_name?: string; card?: InboxDraft['card']; pulls?: InboxDraft['pulls']; board_request?: true };
}

export interface ComposeTransport {
  sessions: ComposeSessionsLoader;
  startThread: (input: StartThreadInput) => Promise<{ thread_id: string; project?: { id: string; name: string; root: string } }>;
  drafts: boolean;
  uploads: boolean;
}

export interface ComposeDialogProps {
  request: ComposeRequest;
  phone: boolean;
  /** The project the person is looking at: the list's filter, or the open thread's. */
  current: { id: string | null; root: string | null; name: string | null } | null;
  /** The session the person last sent to: listed first in the picker while it is live; never put in To by itself. */
  lastSent: string | null;
  home: string | null;
  onSent: (sent: ComposeSent) => void;
  onSaved: (draft: DraftView) => void;
  onDeleted: (draft: DraftView) => void;
  onClose: () => void;
  transport?: ComposeTransport;
  /**
   * Drawn inside the dialog, after its own content (the tour's coach card): a
   * modal dialog is the top layer, so anything meant to show over it lives in
   * it. Absent: nothing.
   */
  aside?: React.ReactNode;
  /** The Board is on (Settings): compose offers the Board chip. Absent: off, no chip. */
  board?: boolean;
  /** Remote launch: where the person last started an agent on each machine (`launchHistory` of the list). */
  launched?: LaunchHistory;
  /** Remote launch: a new session for a linked machine is held until that machine is back. Absent: said as an error. */
  onHeld?: (held: ComposeHeld) => void;
  /** New review: the pull requests Reviews lists (`request.review`). */
  reviewPulls?: readonly ReviewBoxPull[];
  /** How the read behind `reviewPulls` went: an empty list only means "none" once it was read. */
  reviewPullsRead?: ReviewPullsRead;
  /** New review: a PR already in review was picked, so its thread opens rather than a second one starting. */
  onOpenReviewThread?: (threadId: string) => void;
  /**
   * The Launch tip (approval "launch-tip"; launchTip.ts): the Inbox has it for this page (settings `reveal.launch_tip`).
   * Compose shows it only at a plain New message whose To can start an agent, and `claim` stamps it as it shows (true:
   * this page shows it). Absent: never.
   */
  launchTip?: { claim: () => Promise<boolean> } | null;
  /**
   * This computer's own window (not over the tailnet): the folder browser may offer "Choose in Finder…" (macOS, approval
   * "inbox-launch-any-folder"). Absent: no.
   */
  localWindow?: boolean;
}

/**
 * The Board chip (approval "inbox-compose-board-chip", v3): at the right of
 * the Thread row, a plain toggle (`aria-pressed`) named "Track on Board",
 * with a component tooltip. On, the Send asks the agent to track the work on
 * the Board (`board_request`); the agent makes the card(s). No shortcut.
 */
function BoardChip(props: { on: boolean; onToggle: () => void }) {
  return (
    <Tip content={props.on ? 'On your Board when sent' : 'Track on your Board'}>
      <button type="button" className="ib-cp-board" aria-pressed={props.on} aria-label="Track on Board" data-compose-board="" onClick={props.onToggle}>
        <span className="ib-cp-board-box" aria-hidden="true">
          {props.on && <Icon name="check" size={11} />}
        </span>
        Board
      </button>
    </Tip>
  );
}

export function ComposeDialog(props: ComposeDialogProps) {
  const { request, phone, current, lastSent, home, transport } = props;
  // New review keeps no draft: its words are a few, and what it reviews is chosen again in a moment.
  const box = request.review ?? null;
  const keepsDrafts = (transport?.drafts ?? true) && !box;
  const takesFiles = transport?.uploads ?? true;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const toRef = useRef<HTMLButtonElement>(null);
  const toRowRef = useRef<HTMLDivElement>(null);
  const opening = useRef(composeOpening(request)).current;
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const titleId = `ib-cp-title-${uid}`;
  const statusId = `ib-cp-status-${uid}`;
  const tipLineId = `ib-cp-tip-${uid}`;

  const [draft, setDraft] = useState<DraftView | null>(request.draft ?? null);
  const [typed] = useState(() => unsentReview(box?.pick));
  const [body, setBody] = useState(request.draft?.body ?? request.body ?? (request.card ? `${request.card.title}\n\n` : box ? typed.body : ''));
  // The Board card this thread is for (Create thread), kept on its draft so a draft sent later still links it.
  const card = request.card ?? request.draft?.card ?? null;
  // The pull requests this thread is for (Launch an agent), kept on its draft: To offers only their projects' agents.
  const [reviewKind, setReviewKind] = useState<ReviewKind>(box?.pick ? 'pr' : typed.kind);
  // A pull request link: what the picker's search holds while it looks like one, or the one chosen from it.
  const [reviewLink, setReviewLink] = useState(() => (box ? typed.link : ''));
  const [linkChosen, setLinkChosen] = useState(() => !!box && !!typed.link);
  const linkKept = useRef(typed.link ?? '');
  const [linkRead, setLinkRead] = useState<InboxReviewLinkAnswer | null>(null);
  const [reviewChanges, setReviewChanges] = useState<InboxReviewChanges>('uncommitted');
  const [reviewPick, setReviewPick] = useState<ReviewBoxPull | null>(box?.pick ?? typed.pick);
  const [reviewMenu, setReviewMenu] = useState(false);
  // A pick kept or opened earlier that has since gone into review (handed elsewhere, say): its thread answers for it now. The words stay.
  useEffect(() => {
    if (box && reviewPick && props.reviewPulls?.find((pull) => pull.id === reviewPick.id)?.thread) setReviewPick(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!box, reviewPick?.id, props.reviewPulls]);
  const [reviewSummary, setReviewSummary] = useState<ReviewSummary>(null);
  // A link: the picker's own way when the list has that PR, else a PR the Inbox knows only from this link.
  const linkFound = box && reviewKind === 'pr' && linkChosen && linkRead?.ok ? linkRead : null;
  const linkListed = linkFound ? reviewLinkListed(linkFound, props.reviewPulls ?? []) : null;
  // Its review thread, chosen or not: the search's row says so, and choosing it opens the thread.
  const linkThreadOf = (read: InboxReviewLinkAnswer | null) => (read?.ok ? (reviewLinkListed(read, props.reviewPulls ?? [])?.thread?.id ?? read.thread_id ?? null) : null);
  const linkThread = linkFound ? linkThreadOf(linkFound) : null;
  const linkOnly = linkFound && !linkListed && !linkThread ? linkFound : null;
  const boxPull = !box || reviewKind !== 'pr' ? null : linkChosen ? (linkListed && !linkThread ? linkListed : null) : reviewPick;
  const pulls = request.pulls ?? request.draft?.pulls ?? (boxPull ? { keys: handoffKeys(boxPull.stack), projects: [...boxPull.projects], ask_line: pullHandoffAskLine(boxPull.stack, { kind: 'guide' }) } : null);
  // The Board chip: a draft's own choice, else this browser's last one. Never in Create thread (the card is the Board's
  // already), and shown only while the Board is on; a draft keeps its choice while the Board is off.
  const [boardOn, setBoardOn] = useState(() => (request.draft ? request.draft.board_request === true : composeBoardChoice()));
  const boardChip = props.board === true && !card && !box;
  const boardRequest = !card && boardOn;
  // The thread's name (its chip): follows the message until the person types in it (ThreadNameChip).
  const [nameState, setNameState] = useState<ThreadNameState>(() => threadNameStateOf(request.draft ?? (request.threadName ?? (box && typed.threadName) ? { thread_name: request.threadName ?? typed.threadName! } : null)));
  const [chosen, setChosen] = useState<string | null>(opening.chosen);
  // A paste is said in the dialog's own polite region (the window's is outside the modal dialog).
  const [pasteSaid, setPasteSaid] = useState('');
  const say = (words: string) => {
    setPasteSaid('');
    setTimeout(() => setPasteSaid(words), 30);
  };
  // A paste of 32 KB or more becomes a pasted text tile (approval "inbox-paste-attachment"), put back by its tile.
  const files = useComposeFiles(request.draft?.files ?? [], {
    onPasted: (names) => say(attachedAnnouncement(names)),
    onAlready: (name) => say(`${name} is already in this message`),
    onPutBack: () => say('The pasted text is back in your message.'),
    text: { value: body, set: setBody },
  });
  // A drop anywhere on the dialog attaches the files ("Drop files to attach").
  const drop = useFileDrop(files.add, takesFiles);
  const reuseStarted = useRef(false);
  useEffect(() => {
    if (reuseStarted.current) return;
    reuseStarted.current = true;
    for (const source of request.reuse ?? []) files.addExisting(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // `machine`: the linked machine the project is on (remote launch); null for this computer. `folder`: a folder under
  // that machine's home picked in "Another folder…" (`~/…`, with its `name`), in place of a project; `create`: the Send
  // makes it (Create a folder); `clone`: the Send clones a repo into it first (Clone from a git URL). A draft's own
  // folder pick comes back with it (D9), checked again below.
  const [startPick, setStartPick] = useState<{ agent: string; projectId: string; machine: string | null; folder?: { path: string; name: string; create?: boolean; clone?: ComposeClone } } | null>(() => {
    if (request.start) return { agent: request.start.agent ?? '', projectId: request.start.projectId, machine: request.start.machine };
    const again = request.clone ? cloneOfUrl(request.clone.url) : null;
    if (request.clone && again) {
      const path = request.clone.folder ?? `~/${again.slug.split('/').pop()}`;
      return { agent: request.clone.agent, projectId: `folder:${path}`, machine: request.clone.machine, folder: { path, name: path.split('/').pop() ?? path, clone: again } };
    }
    const kept = request.draft?.start;
    const clone = kept?.clone ? cloneOfUrl(kept.clone.url, kept.clone.branch) : null;
    return kept
      ? { agent: kept.agent, projectId: `folder:${kept.folder}`, machine: kept.machine, folder: { path: kept.folder, name: kept.name, ...(kept.create ? { create: true } : {}), ...(clone ? { clone } : {}) } }
      : null;
  });
  // A reopened draft's new folder that is there by now is no longer made or cloned (D9): one read, when the draft opens.
  useEffect(() => {
    const kept = request.draft?.start;
    if (!kept?.create && !kept?.clone) return;
    const read = new AbortController();
    inboxApi.homeFolders(kept.folder, kept.machine, read.signal).then(
      (answer) => {
        if (answer.exists) setStartPick((pick) => (pick?.folder?.path === kept.folder && (pick.folder.create || pick.folder.clone) ? { ...pick, folder: { path: kept.folder, name: kept.name } } : pick));
      },
      () => {},
    );
    return () => read.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The folder browser's path per machine, kept while compose is open (D2).
  const keptPaths = useRef(new Map<string, string>());
  // A typed folder has no project id, so no sessions read can look at its files (Trust and start is not offered for it).
  const trustPick = startPick && !startPick.folder ? startPick : null;
  const { model, load: loadHere } = useComposeSessions(true, transport?.sessions, trustPick && !trustPick.machine ? { agent: trustPick.agent, project: trustPick.projectId } : null);
  // Linked machines (remote launch): each one's launch block, read through the forward while launch is on here.
  const there = useMachineLaunches(!transport && !!model?.launch, trustPick?.machine ? { agent: trustPick.agent, project: trustPick.projectId, machine: trustPick.machine } : null);
  const load = async () => {
    await Promise.all([loadHere(), startPick?.machine ? there.readOne(startPick.machine) : null]);
  };
  const voice = useVoiceSession();
  const onlyProjects = pulls?.projects ?? (linkOnly && linkOnly.projects.length > 0 ? linkOnly.projects : null);
  // A link's PR in no project: nowhere is wrong, and a new scratch folder is the default where launching can.
  const linkScratch = !!linkOnly && linkOnly.projects.length === 0;
  const projects = useMemo(() => (model?.projects ?? []).filter((g) => !onlyProjects || (g.project.id !== null && onlyProjects.includes(g.project.id))), [model, onlyProjects?.join()]);
  const target = findTarget(projects, chosen);
  const anyLive = composeTargets(projects).length > 0;
  const groups = useMemo(() => composeGroups(projects, current, lastSent), [projects, current, lastSent]);
  // Launch: a new session To names instead of a live one (the agent, and the project it starts in).
  // For a pull request (`pulls`): only its projects and no scratch folder, so the default start is where its agent works and nothing else is offered.
  // Linked machines (remote launch): the folder menu groups every machine's projects (`launchGroups`); with none, or
  // none with anything to offer, `grouped` is false and everything below is exactly this computer's.
  const selfView = there.machines.find((m) => m.self) ?? null;
  const machineGroups = useMemo(() => {
    const here = model?.launch;
    const anyAgent = startPick?.agent ?? here?.agents[0]?.agent ?? [...there.reads.values()].find((r) => r.launch?.agents[0])?.launch?.agents[0]?.agent ?? null;
    const made = launchGroups({
      agent: (anyAgent as ComposeStart['agent'] | null) ?? null,
      self: { launch: here, home, id: selfView?.id ?? null, name: selfView?.name ?? null },
      machines: there.machines,
      reads: there.reads,
      history: props.launched,
    });
    // New review reads the changes it reviews on this computer: its folder menu is this computer's alone.
    if (box) return { grouped: false, groups: [] };
    if (!pulls) return made;
    return { grouped: made.grouped, groups: made.groups.map((g) => ({ ...g, scratch: null, projects: g.projects.filter((p) => pulls.projects.includes(p.id)) })) };
  }, [model?.launch, startPick?.agent, there.machines, there.reads, selfView?.id, selfView?.name, home, props.launched, pulls, box]);
  const grouped = machineGroups.grouped;
  const launch = useMemo(() => {
    const offered = model?.launch;
    if (!grouped) {
      // A link's PR in no project keeps the scratch folder (`linkScratch`).
      if (!offered || (!onlyProjects && !box) || linkScratch) return offered;
      // New review reviews a project's changes, which a new scratch folder has none of.
      return { agents: offered.agents, projects: onlyProjects ? offered.projects.filter((p) => onlyProjects.includes(p.id)) : offered.projects };
    }
    // Every machine's projects in the menu's order, each with its machine; the agents any of them can start.
    const agents = [...(offered?.agents ?? [])];
    for (const read of there.reads.values()) for (const a of read.launch?.agents ?? []) if (!agents.some((b) => b.agent === a.agent)) agents.push({ agent: a.agent, name: a.name });
    // The default start (the first project, when the person is looking at none) is never an asleep machine's while an
    // awake one has projects: those come last here, and the folder menu keeps its own order.
    const projects: MachineLaunchProject[] = [...machineGroups.groups.filter((g) => !g.asleep), ...machineGroups.groups.filter((g) => g.asleep)].flatMap((g) => g.projects);
    return { agents, projects, ...(offered?.scratch && !pulls ? { scratch: offered.scratch } : {}) };
  }, [model?.launch, pulls, onlyProjects?.join(), box, linkScratch, grouped, machineGroups, there.reads]);
  const canStart = !!launch && launch.agents.length > 0 && (launch.projects.length > 0 || (grouped && machineGroups.groups.some((g) => !!g.scratch)));
  // The launch block of the machine a pick is on: this computer's, or that machine's last good read.
  const blockOf = (machine: string | null) => (machine ? there.reads.get(machine)?.launch : model?.launch);
  const start: (ComposeStart & { machine: string | null }) | null = useMemo(() => {
    if (!startPick) return null;
    const block = startPick.machine ? there.reads.get(startPick.machine)?.launch : model?.launch;
    const agent = block?.agents.find((a) => a.agent === startPick.agent);
    // "Another folder…": a folder under that machine's home; the Send names it, and the far side makes it a project.
    if (agent && startPick.folder && !pulls && !box) {
      return {
        agent: agent.agent,
        name: agent.name,
        project: folderProject(startPick.folder.path, startPick.folder.name),
        folder: startPick.folder.path,
        ...(startPick.folder.create ? { create: true as const } : {}),
        ...(startPick.folder.clone ? { clone: startPick.folder.clone } : {}),
        machine: startPick.machine,
      };
    }
    // "New scratch folder": its root stands in for the project; the folder is made when the person sends.
    if (agent && startPick.projectId === SCRATCH_PICK && block?.scratch && ((!pulls && !box) || linkScratch)) return { agent: agent.agent, name: agent.name, project: scratchProject(block.scratch.root), scratch: true, machine: startPick.machine };
    const project = block?.projects.find((p) => p.id === startPick.projectId && (!onlyProjects || onlyProjects.includes(p.id)));
    return agent && project ? { agent: agent.agent, name: agent.name, project, machine: startPick.machine } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startPick, model?.launch, there.reads, pulls, box, onlyProjects?.join(), linkScratch]);
  // Add agent: the default start, once the launch block is read, unless the person chose To already.
  const launchPicked = useRef(false);
  useEffect(() => {
    if (!request.launch || launchPicked.current || startPick || chosen || !launch || !canStart) return;
    const project = defaultStartProject(launch, current);
    if (!project) return;
    launchPicked.current = true;
    const agent = launch.agents.find((a) => a.agent === request.launch!.agent) ?? launch.agents[0]!;
    setStartPick({ agent: agent.agent, projectId: project.id, machine: (project as MachineLaunchProject).machine ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.launch, launch, canStart, startPick, chosen, current]);
  // "+" on a project row and Add agent: an agent that machine doesn't have (or none started yet) becomes its first,
  // once its block is read.
  useEffect(() => {
    if (!(request.start || request.launch) || !startPick || startPick.folder) return;
    const block = blockOf(startPick.machine);
    if (!block || block.agents.length === 0 || block.agents.some((a) => a.agent === startPick.agent)) return;
    setStartPick({ ...startPick, agent: block.agents[0]!.agent });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.start, request.launch, startPick, model?.launch, there.reads]);
  // The linked machine To's project is on (null: this computer), its home for `~/…` paths, and whether it is asleep.
  const startMachine = start?.machine ? (there.machines.find((m) => m.id === start.machine) ?? null) : null;
  const startMachineName = start?.machine ? (startMachine?.name ?? machineGroups.groups.find((g) => g.machine === start.machine)?.name ?? null) : null;
  const startHome = start?.machine ? (there.reads.get(start.machine)?.home ?? null) : home;
  // A project on a drive that isn't mounted now: the drive's name, said as "isn't connected" rather than "moved or deleted".
  const startUnplugged = start && !start.project.exists ? unpluggedDrive(start.project.root, blockOf(start.machine ?? null)?.drives) : null;
  const startAsleep = !!startMachine && startMachine.state === 'offline';
  const [folderMenu, setFolderMenu] = useState(!!request.clone);
  const startAgent = start ? blockOf(start.machine)?.agents.find((a) => a.agent === start.agent) : undefined;
  // Trust and start: the folder To names, when the agent does not trust it and the owner can from here. No entry (a
  // trusted folder, home, a guest): plain Send. Its facts follow the pick by a read, so a press can come before them.
  const trust = (start?.project.exists ? startAgent?.untrusted?.[start.project.id] : undefined) ?? null;
  const trustFacts = trust?.facts ?? [];
  // The question circle's details.
  const [trustInfo, setTrustInfo] = useState(false);
  const trustInfoOpen = trustInfo && trustFacts.length > 0;
  const trustCircleRef = useRef<HTMLButtonElement>(null);
  // A press made on a reading that had gone stale: when its details opened on the new one.
  const trustChangedAt = useRef(0);
  useEffect(() => setTrustInfo(false), [start?.agent, start?.project.id]);
  useEffect(() => {
    if (!trustInfoOpen) return;
    const onDown = (event: PointerEvent) => {
      const at = event.target as Element | null;
      if (at && !at.closest('[data-compose-trust-ask], [data-compose-trust-circle]')) setTrustInfo(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [trustInfoOpen]);

  // New review opens with To filled in (a plain New message never does): the choice above it already says what it is for.
  // `toFilled`: To is the box's own choice, not the person's, so it may move to an agent with changes to review (below).
  const [toFilled, setToFilled] = useState(false);
  useEffect(() => {
    if (!box || !model || chosen || startPick) return;
    const to = reviewDefaultTo(composeTargets(projects), launch, current?.id ?? null, lastSent, linkScratch && launch?.scratch ? SCRATCH_PICK : undefined);
    if (!to) return;
    setToFilled(true);
    if ('session' in to) setChosen(to.session);
    else setStartPick({ ...to, machine: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box, model, chosen, startPick, projects, launch]);
  // What it reviews changed: To follows, since a PR is reviewed from its own project.
  const toFollowsReview = () => {
    setChosen(null);
    setStartPick(null);
    setError(null);
  };
  const reviewProject = target?.project ?? start?.project ?? null;
  // What a pasted link is, a moment after the typing stops.
  useEffect(() => {
    setLinkRead(null);
    if (!box || reviewKind !== 'pr' || !reviewLink.trim()) return;
    const read = new AbortController();
    const pause = setTimeout(() => {
      inboxApi.reviewLink(reviewLink.trim(), read.signal).then(
        setLinkRead,
        () => {
          if (!read.signal.aborted) setLinkRead({ ok: false, reason: 'failed' });
        },
      );
    }, REVIEW_LINK_PAUSE_MS);
    return () => {
      clearTimeout(pause);
      read.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!box, reviewKind, reviewLink]);
  useEffect(() => {
    if (!box || reviewKind !== 'local' || !reviewProject?.id) {
      setReviewSummary(null);
      return;
    }
    // Never the last project's: its branch would go into the message if Start came before this read.
    setReviewSummary(null);
    const read = new AbortController();
    inboxApi.reviewChanges(reviewProject.id, reviewChanges, read.signal).then(setReviewSummary, () => setReviewSummary(null));
    return () => read.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!box, reviewKind, reviewProject?.id, reviewChanges]);
  // The project To was filled in with has no changes of this kind: another live agent's project that has some, if any.
  const noChanges = !!box && reviewKind === 'local' && !!reviewSummary?.git && reviewSummary.files === 0;
  useEffect(() => {
    if (!noChanges || !toFilled || !target?.project.id) return;
    const others = composeTargets(projects).filter((t) => t.project.id && t.project.id !== target.project.id);
    const ids = [...new Set(others.map((t) => t.project.id!))];
    if (ids.length === 0) return;
    const read = new AbortController();
    void Promise.all(ids.map((id) => inboxApi.reviewChanges(id, reviewChanges, read.signal).then((a) => [id, a.git ? a.files : 0] as const, () => [id, 0] as const))).then((files) => {
      if (read.signal.aborted) return;
      const session = reviewToWithChanges(others, new Map(files), lastSent);
      if (session) setChosen(session);
    });
    return () => read.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noChanges, toFilled, target?.project.id, reviewChanges]);

  // To is never filled by itself. Focus that started on To moves to the message when the
  // first read finds no live agent (To is then a line of text, not a button).
  useEffect(() => {
    if (box || !model || anyLive || canStart || opening.focus !== 'to') return;
    const dialog = dialogRef.current;
    const active = document.activeElement;
    if (dialog && (!active || active === document.body || active === dialog || !dialog.contains(active))) textRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, anyLive, canStart]);

  // A draft's chosen session that is not live: struck through, never re-addressed on its own.
  const endedTo: InboxDraftTo | null = model && chosen && !target && draft?.to?.session === chosen ? draft.to : null;
  // A session picked in this dialog that stopped polling meanwhile.
  const [lost, setLost] = useState<ComposeTarget | null>(null);
  const lastTarget = useRef<ComposeTarget | null>(null);
  useEffect(() => {
    if (target) {
      lastTarget.current = target;
      setLost(null);
    } else if (model && chosen && lastTarget.current?.session === chosen) setLost(lastTarget.current);
  }, [target, model, chosen]);

  const [picker, setPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What is wrong with the name the person typed (409 `thread_name_taken`, or not a valid name): said on the chip until it changes.
  const [nameError, setNameError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<DraftView | null>(null);
  const [busy, setBusy] = useState<null | 'send' | 'save' | 'delete'>(null);

  // A phone's To sheet takes the row, status and Cancel with it: no microphone stays open behind it. Choosing an agent
  // is part of writing, so To ends a take and keeps what was said; a take already on its way isn't a recording, and its
  // words still land.
  const footCovered = picker && phone;
  useEffect(() => {
    if (!footCovered) return;
    voice.session.stop();
    if (voice.session.view().phase !== 'sending') voice.session.covered();
  }, [footCovered, voice.session]);

  // ── the Launch tip (launchTip.ts): once, at a plain New message whose To can start an agent ──
  const [tip, setTip] = useState<'wait' | 'shown' | 'leaving' | 'done'>(() => (props.launchTip && !transport && !box && launchTipPlainOpen(request) ? 'wait' : 'done'));
  const [tipTime, setTipTime] = useState(false);
  const [tipPlace, setTipPlace] = useState<LaunchTipPlace | null>(null);
  const tipLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipClaim = useRef(props.launchTip?.claim);
  useEffect(() => {
    if (tip !== 'wait') return;
    const timer = setTimeout(() => setTipTime(true), LAUNCH_TIP_TIMES.delayMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => {
    if (tipLeaveTimer.current) clearTimeout(tipLeaveTimer.current);
  }, []);
  // To opened, or something in To, before the tip came: not needed this time, and not used up (no claim was made).
  const toTouched = picker || !!chosen || !!startPick;
  useEffect(() => {
    if (toTouched && tip === 'wait') setTip('done');
  }, [toTouched, tip]);
  // The Inbox's answer to the claim: null while it is on its way.
  const [tipClaimed, setTipClaimed] = useState<boolean | null>(null);
  // It shows in the same render the claim is sent, so a stamp always means it was on screen (opening To while the
  // answer is on its way never uses it up unseen). Refused (another window or the phone showed it): it goes at once.
  useEffect(() => {
    if (tip !== 'wait' || !tipTime || !model || !canStart || toTouched || busy) return;
    setTip('shown');
    tipClaim.current?.().then(
      (show) => {
        setTipClaimed(show);
        if (!show) setTip((now) => (now === 'shown' || now === 'leaving' ? 'done' : now));
      },
      // A lost answer (retried once already): it stays for this open; the Inbox may not have kept it.
      () => setTipClaimed(true),
    );
  }, [tip, tipTime, model, canStart, toTouched, busy]);
  // Said once the Inbox kept it, in compose's own polite region (the window's is outside the modal dialog).
  useEffect(() => {
    if (tip === 'shown' && tipClaimed === true) say(LAUNCH_TIP_SAID);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tip === 'shown' && tipClaimed === true]);
  const leaveTip = () => {
    if (tip !== 'shown') return false;
    setTip('leaving');
    tipLeaveTimer.current = setTimeout(() => setTip('done'), LAUNCH_TIP_TIMES.leaveMs);
    return true;
  };
  // Escape on the tip: it leaves, and focus on its Got it (which is going) moves to To, as Got it from the keyboard does.
  const escapeTip = () => {
    const onTip = !!(document.activeElement as Element | null)?.closest?.('.ib-ctip');
    if (!leaveTip()) return false;
    if (onTip) (toRef.current ?? textRef.current)?.focus();
    return true;
  };
  // Opening To is what it asked for: it leaves.
  useEffect(() => {
    if (picker) leaveTip();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker]);
  const tipUp = tip === 'shown' || tip === 'leaving';
  useLayoutEffect(() => {
    if (!tipUp) return;
    const measure = () => {
      const dialog = dialogRef.current;
      const row = toRowRef.current;
      if (!dialog || !row) return;
      setTipPlace(launchTipPlace({ phone, viewportWidth: window.innerWidth, dialog: dialog.getBoundingClientRect(), row: row.getBoundingClientRect(), to: toRef.current?.getBoundingClientRect() ?? null }));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [tipUp, phone]);

  // The idempotency key of one Send: new whenever what would be sent changes.
  const sendKey = useRef(newUuid());
  const uploadIds = files.uploaded.map((u) => u.upload_id);
  // The chip's suggestion, worked out a moment after typing stops; the same name again changes nothing on screen.
  const fileNames = files.files.map((file) => file.name).join('\n');
  const [suggested, setSuggested] = useState(() => suggestThreadName(body, fileNames ? fileNames.split('\n') : []));
  useEffect(() => {
    const timer = setTimeout(() => setSuggested(suggestThreadName(body, fileNames ? fileNames.split('\n') : [])), 250);
    return () => clearTimeout(timer);
  }, [body, fileNames]);
  // New review names its thread from what it reviews, not from the words.
  const reviewName = !box ? null : boxPull ? pullHandoffThreadName(boxPull.stack, null) : linkOnly ? pullHandoffThreadName(reviewLinkStack(linkOnly.pull), null) : reviewKind !== 'local' ? null : localReviewName(reviewChanges, reviewProject?.name ?? null, reviewSummary?.branch ?? null, reviewSummary?.base ?? null);
  const threadName = draftThreadName(nameState);
  // Kept from the first change: opening the box on another PR doesn't wipe the words kept for this one.
  const keptAny = useRef(false);
  useEffect(() => {
    if (!box) return;
    if (keptAny.current) keepUnsentReview({ body, threadName: threadName || null, kind: reviewKind, pick: reviewKind === 'pr' && !linkChosen ? reviewPick : null, link: reviewKind === 'pr' && linkChosen ? reviewLink : '' });
    keptAny.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!box, body, nameState, reviewKind, reviewPick, reviewLink, linkChosen]);
  useEffect(() => {
    sendKey.current = newUuid();
  }, [body, chosen, start?.agent, start?.project.id, start?.machine, threadName, nameState.edited ? '' : suggested, uploadIds.join(','), boardChip && boardRequest, reviewKind, reviewChanges, boxPull?.id]);
  const draftId = useRef(request.draft?.id ?? inboxId('drf'));
  // When an Escape last ended an IME composition: the native cancel that may follow it is not a close.
  const imeEscape = useRef(-Infinity);

  // Nothing written: no words, no files, no typed thread name. An empty compose is never kept as a draft.
  // A Board card's Create thread starts with the card's title: left as it was, that is nothing written either.
  const cardStart = request.card && !request.draft ? `${request.card.title}\n\n` : null;
  const untouched = cardStart !== null && body === cardStart && files.files.length === 0 && threadName.trim() === '';
  const empty = untouched || (body.trim() === '' && files.files.length === 0 && threadName.trim() === '');
  const saved = draftSnapshot(draft);
  const dirty = !untouched && (isDirty({ body, session: chosen, files: uploadIds, threadName, board: boardRequest }, saved, draft !== null) || files.uploading);
  const projectName = current?.name ?? null;

  // ── the dialog ──
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute('open', '');
      }
    } else dialog.setAttribute('open', '');
    // A plain New message starts on To (empty: the person picks first); a draft or "Message <host>" starts in the message.
    if (!box && opening.focus === 'to' && toRef.current) {
      toRef.current.focus();
      return;
    }
    const text = textRef.current;
    if (text) {
      text.focus();
      text.setSelectionRange(text.value.length, text.value.length);
    }
  }, []);

  const requestClose = () => {
    if (trustInfoOpen) {
      setTrustInfo(false);
      if (document.activeElement !== textRef.current) trustCircleRef.current?.focus();
      return;
    }
    if (picker || folderMenu || reviewMenu) {
      setPicker(false);
      setFolderMenu(false);
      setReviewMenu(false);
      return;
    }
    // Something written that was not saved: keep it as a draft and close, with no question (approval
    // "inbox-compose-escape-keeps"). A failed save keeps compose open and says why, so the words are never lost.
    // An empty compose (a draft emptied too) is never kept, so it just closes; a reopened draft emptied this way stays
    // saved as it was. No drafts (the tour): nothing to keep.
    if (keepsDrafts && dirty && !empty) {
      void keepDraft();
      return;
    }
    props.onClose();
  };

  // ── sending ──
  const send = async () => {
    leaveTip();
    // Still reading the live sessions: nothing to say yet, the status line says it. Dictation still running: the words are not in yet.
    if (busy || !model || voice.busy) return;
    // The details just opened on a changed folder: a double press or a held key never answers what it hasn't shown.
    if (Date.now() - trustChangedAt.current < ARM_MS) return;
    setError(null);
    if (start && !start.project.exists) {
      setError('Nothing sent: pick a folder to start in.');
      return;
    }
    // A new session (launch) is held to the same rule as a live one: it starts in the pull request's project.
    const sendProject = target ? target.project.id : (start?.project.id ?? null);
    if ((target || start) && pulls && !(sendProject && pulls.projects.includes(sendProject))) {
      setError("Nothing sent: the pull request's agent works in its own project.");
      return;
    }
    if (linkThread) {
      props.onClose();
      props.onOpenReviewThread?.(linkThread);
      return;
    }
    if (!target && !start) {
      // The error is an alert, which says it: no second announcement.
      setError(anyLive || canStart ? 'Nothing sent: choose a live agent first.' : box ? 'Nothing sent: no live agent is chosen.' : NOTHING_SENT_NO_AGENT);
      return;
    }
    if (box && reviewKind === 'pr' && !boxPull && !linkOnly) {
      setError('Nothing sent: choose a pull request first.');
      return;
    }
    if (box && reviewKind === 'walkthrough' && !body.trim()) {
      setError('Nothing sent: say what to walk you through first.');
      return;
    }
    // "No changes" beside the choice says why: nothing for an agent to review.
    if (noChanges) return;
    if (boxPull && pulls && pulls.keys.length > INBOX_PULL_OWNER_KEYS_MAX) {
      setError(`A stack of more than ${INBOX_PULL_OWNER_KEYS_MAX} open pull requests can't go to one review thread.`);
      return;
    }
    // Words or files, as a reply takes: a message of a pasted text tile alone goes. New review's empty words are a guided review.
    if (!box && !body.trim() && !files.files.some((file) => file.state !== 'refused')) {
      setError('Write a message first.');
      textRef.current?.focus();
      return;
    }
    if (files.uploading) {
      setError('Wait for the files to finish uploading.');
      return;
    }
    // Files wait on this computer: a new session on another machine can't take them yet.
    if (start?.machine && files.files.some((file) => file.state !== 'refused')) {
      setError(`Files can't go with a new session on ${startMachineName ?? 'another machine'} yet. Remove them to start it there.`);
      return;
    }
    // The chip's suggestion as it would be once typing settles: never one a moment old.
    const named = sendThreadName(nameState, nameState.edited ? '' : (reviewName ?? suggestThreadName(body, fileNames ? fileNames.split('\n') : [])));
    if ('error' in named) {
      setNameError(named.error);
      return;
    }
    setBusy('send');
    try {
      // The skills the words reference go with the message as one block at its end, as New message's do (skills.ts).
      const words = !box
        ? body
        : reviewKind === 'walkthrough'
          ? walkthroughMessage(body)
          : boxPull || linkOnly
          ? pullHandoffMessage(boxPull?.stack ?? reviewLinkStack(linkOnly!.pull), body.trim() ? { kind: 'custom', words: body } : { kind: 'guide' })
          : localReviewMessage({ changes: reviewChanges, project: reviewProject?.name ?? null, branch: reviewSummary?.branch ?? null, base: reviewSummary?.base ?? null, words: body });
      // Checked first: a PR the Inbox can't keep for that agent is never sent to it.
      if (boxPull && sendProject) await inboxApi.pullOwnerCheck(pulls!.keys, sendProject);
      const skills = transport ? null : await inboxSkillsBlock([words], INBOX_MESSAGE_SKILL_AUDIENCE);
      const machine = start?.machine ?? null;
      const input: StartThreadInput = {
        to: start
          ? {
              launch: {
                ...(start.scratch
                  ? { agent: start.agent, scratch: true as const }
                  : start.folder
                    ? {
                        agent: start.agent,
                        folder: start.folder,
                        ...(start.create ? { create: true as const } : {}),
                        ...(start.clone ? { clone: { url: start.clone.url, ...(start.clone.branch ? { branch: start.clone.branch } : {}) } } : {}),
                      }
                    : { agent: start.agent, project_id: start.project.id }),
                // The press is the consent, to what it was offered: the server refuses a folder that changed since.
                ...(trust ? { trust: { folder: trust.folder, facts: trustFacts } } : {}),
              },
            }
          : { host: target!.host, session: target!.session },
        body: skills ? withSkillsBlock(words, skills) : words,
        idempotency_key: sendKey.current,
        ...(linkOnly ? { review: { kind: 'link' as const, url: linkOnly.pull.url, title: linkOnly.pull.title, mine: linkOnly.pull.mine, ask: body.trim() ? ('custom' as const) : ('guide' as const) } } : {}),
        ...(box && reviewKind === 'walkthrough' ? { review: { kind: 'walkthrough' as const } } : {}),
        ...(box && reviewKind === 'local' ? { review: { kind: 'local' as const, changes: reviewChanges, branch: reviewSummary?.branch ?? null, base: reviewSummary?.base ?? null, ask: body.trim() ? ('custom' as const) : ('guide' as const) } } : {}),
        uploads: uploadIds,
        ...named,
        // A second review of the same changes is named too: "… (2)" rather than the request's first line.
        ...(box && 'thread_name_auto' in named ? { thread_name_numbered: true as const } : {}),
        ...(draft ? { draft_id: draft.id } : {}),
        ...(boardChip && boardRequest ? { board_request: true as const } : {}),
      };
      // Another machine's project (remote launch): through the forward, so that machine's Inbox starts the agent there.
      const result = transport ? await transport.startThread(input) : await inboxApi.startThread(input, machine);
      // Drafts stay on this computer (the forward drops `draft_id`): the one this was sent from is done here.
      if (machine && draft) void inboxApi.deleteDraft(draft.id).catch(() => {});
      // A launch's answer names its launch (the window's own startThread; a transport never starts one).
      const launchId = (result as { launch?: { id: string } }).launch?.id ?? null;
      const sentTo = start
        ? {
            // The placeholder the root is addressed to until the start settles: `launch:<launch id>`.
            session: launchId ? `launch:${launchId}` : '',
            host: start.agent as string,
            // Another machine's project reads as the list's row does: "infra · Mac mini".
            projectName: startMachineName ? `${start.project.name} · ${startMachineName}` : start.project.name,
          }
        : { session: target!.session, host: target!.host, projectName: target!.project.name };
      if (box) forgetUnsentReview();
      props.onSent({ threadId: result.thread_id, session: sentTo.session, host: sentTo.host, projectName: start?.machine ? sentTo.projectName : (result.project?.name ?? sentTo.projectName), draftId: draft?.id ?? null, cardId: card?.id ?? null, pullKeys: pulls?.keys ?? null, pullAsk: boxPull ? (body.trim() ? 'custom' : 'guide') : pulls ? pullLaunchAsk(body, pulls.ask_line) : null, ...(start ? { launched: true } : {}), ...(start?.machine ? { machine: start.machine } : {}) });
    } catch (cause) {
      if (cause instanceof InboxHeldError && start?.machine && props.onHeld) {
        // That machine's Inbox could not take it now (asleep, or slow): it waits in this Inbox's outbox and starts there
        // when it is back. Compose closes; the window's toast offers Cancel while it has not left.
        if (draft) void inboxApi.deleteDraft(draft.id).catch(() => {});
        props.onHeld({
          key: cause.outbox.key,
          queued: cause.outbox.state === 'queued',
          machineName: cause.machine?.name ?? startMachineName ?? 'the other machine',
          asleep: cause.machine ? cause.machine.state === 'offline' : startAsleep,
          agentName: start.name,
          // E9: what that machine does first when it's back.
          ...(start.clone ? { first: `clones ${start.clone.slug}` } : start.create ? { first: `makes ${start.project.name}` } : {}),
          draftId: draft?.id ?? null,
          words: { body, ...(threadName ? { thread_name: threadName } : {}), ...(card ? { card } : {}), ...(pulls ? { pulls } : {}), ...(boardRequest ? { board_request: true as const } : {}) },
        });
      } else if (cause instanceof InboxApiError && cause.code === 'session_not_live') {
        void load();
        setError('That session is not live any more: nothing was sent. Pick a live session, or save it as a draft.');
      } else if (cause instanceof InboxApiError && (cause.code === 'folder_missing' || cause.code === 'agent_unavailable')) {
        // Checked before anything is written: nothing was sent. The re-read strikes the folder through, or drops the agent's row.
        void load();
        setError(cause.message);
      } else if (cause instanceof InboxApiError && cause.code === 'trust_warning_changed') {
        // The folder changed since its reading: nothing was trusted or sent. The new reading, shown; the next press is on it.
        await load();
        trustChangedAt.current = Date.now();
        setTrustInfo(true);
        setError(cause.message);
      } else if (cause instanceof InboxApiError && cause.code === 'thread_name_taken') {
        setNameError('Another open thread in this project has this name.');
      } else if (cause instanceof InboxApiError && cause.code === 'project_unresolved') {
        // git did not answer in time (#1919): the server's words are for an agent; the person presses Send again.
        setError('Could not tell which project that session works in: git did not answer in time. Nothing was sent; press Send again.');
      } else setError(cause instanceof InboxApiError ? cause.message : 'The message was not sent. Send again to retry.');
    } finally {
      setBusy(null);
    }
  };

  // ── drafts ──
  const save = async (base: string | null = draft?.updated_at ?? null): Promise<DraftView | null> => {
    if (empty) return null;
    if (files.uploading) {
      setError('Wait for the files to finish uploading.');
      return null;
    }
    // Said plainly, before the Inbox refuses it with its own field words.
    if (body.length > INBOX_DRAFT_BODY_MAX) {
      setError(DRAFT_TOO_LONG);
      return null;
    }
    setBusy('save');
    setError(null);
    try {
      const to = target ? draftTo(target) : chosen && draft?.to?.session === chosen ? draft.to : null;
      // A draft keeps the project a new session would start in, not the start itself: reopened, To is chosen again.
      const project = target
        ? { id: target.project.id, root: target.project.root, name: target.project.name }
        : start?.folder
          ? // A folder picked in "Another folder…" is no project yet: its path (absolute when that machine's home is known) and name.
            { id: null, root: untildePath(start.folder, startHome), name: start.project.name }
        : start && !start.scratch
          ? { id: start.project.id, root: start.project.root, name: start.project.name }
        : (draft?.project ?? (current?.root ? { id: current.id, root: current.root, name: current.name ?? current.root } : null));
      // A long paste keeps where it goes back in the words, so a reopened draft still offers Put back.
      const pasted = new Map(files.pastedDraft(body).map((file) => [file.upload_id, file]));
      const draftFiles = uploadIds.map((id) => pasted.get(id) ?? id);
      // A folder that is no project yet (Another folder…, Create a folder) is kept as the pick itself, so it comes back (D8).
      const keptStart =
        start?.folder && !target
          ? {
              agent: start.agent,
              machine: start.machine,
              folder: start.folder,
              name: start.project.name,
              ...(start.create ? { create: true as const } : {}),
              ...(start.clone ? { clone: { url: start.clone.url, ...(start.clone.branch ? { branch: start.clone.branch } : {}) } } : {}),
            }
          : null;
      const result = await inboxApi.saveDraft(draftId.current, { body, to, project, files: draftFiles, base, thread_name: threadName, ...(card ? { card } : {}), ...(pulls ? { pulls } : {}), ...(boardRequest ? { board_request: true as const } : {}), ...(keptStart ? { start: keptStart } : {}) });
      setDraft(result.draft);
      setConflict(null);
      return result.draft;
    } catch (cause) {
      if (cause instanceof InboxApiError && cause.code === 'draft_conflict') {
        try {
          const newer = (await inboxApi.drafts()).drafts.find((d) => d.id === draftId.current) ?? null;
          setConflict(newer);
          setError(newer ? 'This draft changed in another window since you opened it.' : 'This draft was deleted in another window.');
        } catch {
          setError('This draft changed in another window.');
        }
      } else if (cause instanceof InboxApiError && cause.code === 'validation_error' && cause.message.startsWith('body:')) setError(DRAFT_TOO_LONG);
      else setError(cause instanceof InboxApiError ? cause.message : 'The draft was not saved.');
      return null;
    } finally {
      setBusy(null);
    }
  };

  const keepDraft = async () => {
    // Dictation running (Escape never gets here then: the voice control takes it and cancels the take; Cancel or the
    // backdrop do). Words on their way are waited for, then it closes keeping them (`closeAfterWords`); a take still
    // listening is let go, as the voice control's own Cancel does, and what is written is kept.
    if (voice.busy) {
      if (voice.view.phase === 'sending') {
        setCloseAfterWords(true);
        return;
      }
      voice.session.cancel();
    }
    if (busy) return;
    const result = await save(conflict ? conflict.updated_at : (draft?.updated_at ?? null));
    if (result) props.onSaved(result);
  };

  // Closed while dictated words were on their way: once they land, close keeping them. A take that ended without words
  // stays, its line saying why (with Retry when a clip is kept).
  const [closeAfterWords, setCloseAfterWords] = useState(false);
  useEffect(() => {
    if (!closeAfterWords || voice.busy) return;
    setCloseAfterWords(false);
    if (voice.view.trouble) return;
    requestClose();
  }, [closeAfterWords, voice.busy]);

  // The stale page notice's Reload (stalePage.ts): what is written here is kept as a draft first, as Close's Save draft
  // keeps it. A draft another window changed, a file still uploading or a running take stops the reload instead.
  const reloadFlush = useRef<() => Promise<boolean>>(async () => true);
  reloadFlush.current = async () => {
    if (!keepsDrafts || empty || !dirty) return true;
    if (voice.busy || conflict) return false;
    return (await save()) !== null;
  };
  useEffect(() => registerReloadFlush(() => reloadFlush.current()), []);

  const deleteDraft = async () => {
    if (!draft) return;
    setBusy('delete');
    try {
      await inboxApi.deleteDraft(draft.id);
      props.onDeleted(draft);
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The draft was not deleted.');
    } finally {
      setBusy(null);
    }
  };

  // The skill picker's room. A desktop: the whole window (the visual viewport), so the picker floats over
  // everything in the dialog, the footer included, and past the dialog's bottom edge when it needs to; it is
  // in the dialog's top layer and painted after the footer, so nothing covers it. A phone (a full-screen
  // sheet): below its top bar, above its footer and the keyboard.
  const caretMenu = useMemo<CaretMenuOptions>(
    () => ({
      prefer: phone ? 'above' : 'below',
      maxListHeight: phone ? PHONE_SKILL_LIST_HEIGHT : undefined,
      bounds: () => {
        const viewport = window.visualViewport;
        const seen = viewport ? { top: viewport.offsetTop, bottom: viewport.offsetTop + viewport.height } : { top: 0, bottom: window.innerHeight };
        if (!phone) return seen;
        const dialog = dialogRef.current;
        if (!dialog) return null;
        const box = dialog.getBoundingClientRect();
        const bar = dialog.querySelector('.ib-cp-bar')?.getBoundingClientRect();
        const foot = dialog.querySelector('.ib-cp-foot')?.getBoundingClientRect();
        return { top: Math.max(seen.top, bar ? bar.bottom : box.top), bottom: Math.min(foot ? foot.top : box.bottom, seen.bottom) };
      },
    }),
    [phone],
  );

  // ── keys ──
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    // A key the skill picker took (Escape closing it, Enter on a row) is not the dialog's.
    // An Escape that ends an IME composition is the IME's (Safari sends it with isComposing false and keyCode 229).
    const imeKey = event.nativeEvent.isComposing || (event.key === 'Escape' && event.keyCode === 229);
    if (imeKey) {
      if (event.key === 'Escape') imeEscape.current = event.timeStamp;
      return;
    }
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      // Never the window's Escape (it would close the thread under the dialog).
      event.preventDefault();
      event.stopPropagation();
      // The Launch tip up: the first Escape closes only the tip (a popover's own dismissal, not a new shortcut).
      if (!escapeTip()) requestClose();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (!event.repeat) void send();
      return;
    }
    // A key held on the focused button clicks it again and again: a held key never presses it twice.
    if (event.repeat && (event.key === 'Enter' || event.key === ' ') && (event.target as Element).closest('[data-compose-send]')) event.preventDefault();
  };

  const sendable = !!linkThread || ((!!target || (!!start && start.project.exists)) && !(box && reviewKind === 'pr' && !boxPull && !linkOnly) && !noChanges && !(box && reviewKind === 'walkthrough' && !body.trim()));
  const attached = files.files.filter((file) => file.state !== 'refused').length;
  const sendKeys = useShortcutAria({ scope: inboxThreadShortcuts, action: 'send' });
  // While the sessions are read, neither Save draft nor a dead To: a neutral "Looking…" state.
  const loading = !model;
  // Save draft only for something written: an empty compose offers none.
  const saveOffered = keepsDrafts && !sendable && !loading && !empty;
  const title = box ? 'New review' : draft ? 'Draft' : 'New message';
  // A scratch start names the folder a Send would make now (from the thread's name).
  const scratchFolder = launch?.scratch ? scratchFolderOf(launch.scratch.root, threadName.trim() || (reviewName ?? suggested)) : null;
  // Linked machines: the folder menu's groups, each scratch row named for its own machine's root and the thread's name.
  const folderGroups: FolderGroup[] = machineGroups.groups.map((g) => {
    const agentThere = start ? blockOf(g.machine)?.agents.find((a) => a.agent === start.agent) : undefined;
    const folder = g.scratch ? scratchFolderOf(g.scratch.root, threadName.trim() || (reviewName ?? suggested)) : null;
    return {
      machine: g.machine,
      name: g.name,
      quiet: g.quiet,
      home: g.home,
      projects: g.projects,
      last: g.last,
      notice: g.notice,
      asleep: g.asleep,
      cloneInto: blockOf(g.machine)?.clone?.into ? tildePath(blockOf(g.machine)!.clone!.into, g.home) : null,
      drives: blockOf(g.machine)?.drives ?? null,
      finder: g.machine === null && props.localWindow === true && !phone && model?.launch?.finder === true,
      scratch:
        g.scratch && folder && start
          ? { folder: tildePath(folder, g.home), root: tildePath(g.scratch.root, g.home), trusted: agentThere?.scratch_trusted !== false || !!agentThere.untrusted?.[SCRATCH_PICK], agentName: start.name }
          : null,
    };
  });
  // Another machine asleep: the Send waits for it, and says so.
  const sendLabel = trust ? 'Trust and start' : start && startAsleep && startMachineName ? `Start when ${startMachineName} is back` : box ? (reviewKind === 'walkthrough' ? 'Start walkthrough' : 'Start review') : 'Send';
  // The details cover the error line, and on a phone the whole footer: open, they say it.
  const errorInDetails = trustInfoOpen && !conflict;
  const status = start
    ? startStatusLine(start)
    : statusLine({ target, anyLive: anyLive || canStart, ended: endedTo, projectName: target?.project.name ?? projectName, loading: loading && !target });
  const endedNote = endedTo ?? (lost && !target ? { host: lost.host, session: lost.session, project_root: lost.project.root, project_name: lost.project.name, started_at: lost.started_at } : null);

  // Back from the picker: to the message. In the tour on a phone, to To: a focused message raises the keyboard, and in
  // the room it leaves "Press Send" would have no card to read.
  const afterPicker = () => (phone && transport ? toRef.current : textRef.current)?.focus();

  const toRow = (
    <div ref={toRowRef} className="ib-cp-to" data-start={start ? '' : undefined}>
      <span className="ib-cp-tol">To</span>
      {model && !anyLive && !canStart && !endedNote ? (
        <span className="ib-cp-none-to" data-compose-to="none">
          <Icon name="info" size={15} />
          No agent is running
        </span>
      ) : (
        <button
          ref={toRef}
          type="button"
          className="ib-cp-tobtn"
          data-compose-to={target ? target.session : start ? 'start' : endedNote ? 'ended' : 'choose'}
          aria-haspopup="listbox"
          aria-expanded={picker}
          aria-label={
            target
              ? `To: ${hostLabel(target.host)}${target.label ? `, ${target.label},` : ''} in ${target.project.name}. Change`
              : start
                ? `To: a new ${start.name} session. Change`
                : endedNote
                ? `To: ${hostLabel(endedNote.host)}, ended. Pick a session`
                : loading
                  ? 'To: looking for live agents'
                  : 'To: choose an agent'
          }
          aria-disabled={loading || undefined}
          // The Launch tip's line describes To while it is up; To wears its own hover fill, never a ring.
          aria-describedby={tip === 'shown' ? tipLineId : undefined}
          data-launch-tip={tip === 'shown' ? '' : undefined}
          data-loading={loading ? '' : undefined}
          // Focusable while the sessions are read (Tab still reaches it); it opens once they are.
          onClick={() => !loading && setPicker((open) => !open)}
          disabled={!loading && !anyLive && !canStart && !endedNote}
        >
          {start ? (
            <>
              <HostMark host={start.agent} />
              <b>New {start.name} session</b>
            </>
          ) : target ? (
            <>
              <HostMark host={target.host} />
              <b>{hostLabel(target.host)}</b>
              <SessionDetail name={target.project.name} root={target.project.root} label={target.label} />
            </>
          ) : endedNote ? (
            <>
              <HostMark host={endedNote.host} />
              <s>{hostLabel(endedNote.host)}</s>
              {endedNote.project_name ? (
                <SessionDetail name={endedNote.project_name} root={endedNote.project_root} suffix="ended" />
              ) : (
                <span className="ib-cp-tod">· ended</span>
              )}
            </>
          ) : (
            <span className="ib-cp-tod">{model ? 'Choose an agent' : 'Looking for live agents…'}</span>
          )}
          <Icon name="chevD" size={15} />
        </button>
      )}
      {tipUp && (
        <LaunchTipCard
          place={tipPlace}
          phone={phone}
          leaving={tip === 'leaving'}
          titleId={`${titleId}-tip`}
          lineId={tipLineId}
          onOk={(keyboard) => {
            leaveTip();
            // From the keyboard, focus was on Got it, which is going: to To, the thing the tip was about.
            if (keyboard) (toRef.current ?? textRef.current)?.focus();
          }}
        />
      )}
      {start && (
        <span className="ib-cp-startin">
          <span className="ib-cp-in">in</span>
          <button
            type="button"
            className="ib-cp-tobtn"
            data-compose-folder={start.project.id}
            data-missing={start.project.exists ? undefined : ''}
            aria-haspopup="listbox"
            aria-expanded={folderMenu}
            data-compose-folder-machine={start.machine ?? undefined}
            data-compose-folder-new={start.create ? '' : undefined}
            data-compose-folder-clone={start.clone ? start.clone.slug : undefined}
            aria-label={`Start in: ${start.project.name}, ${start.create ? `a new folder at ${start.folder}, made when you send` : start.clone ? `${start.folder}, cloned from ${start.clone.host}/${start.clone.slug} when you send` : tildePath(start.project.root, startHome)}${startMachineName ? `, on ${startMachineName}${startAsleep ? ', asleep' : ''}` : ''}${start.project.exists ? '' : ', not there any more'}. Change`}
            onClick={() => {
              setPicker(false);
              setFolderMenu((open) => !open);
            }}
          >
            {/* A13: a folder the Send makes carries the new-folder mark until then. */}
            {start.create && <Icon name="folderPlus" size={15} />}
            {/* C13: a clone carries the git mark until the Send clones it. */}
            {start.clone && <Icon name="gitBranch" size={15} />}
            {start.project.exists ? <bdi>{start.project.name}</bdi> : <s>{start.project.name}</s>}
            {/* Another machine's project names its machine, as the list's rows do ("billing-svc · Mac mini"). */}
            {startMachineName && (
              <span className="ib-cp-on" data-compose-machine={start.machine ?? undefined}>
                · <bdi>{startMachineName}</bdi>
              </span>
            )}
            <Icon name="chevD" size={15} />
          </button>
        </span>
      )}
      {(boxPull || (linkOnly && !linkScratch)) && (target || start) && !phone && <span className="ib-cp-rvfrompull">· from the pull request</span>}
      {draft && !phone && <span className="ib-cp-dsaved">Draft · saved {whenTime(draft.updated_at)}</span>}
    </div>
  );

  const reviewRows = box && (
    <ReviewRows
      kind={reviewKind}
      onKind={(kind) => {
        setReviewKind(kind);
        setReviewMenu(false);
        toFollowsReview();
        // The words are the walkthrough.
        if (kind === 'walkthrough') textRef.current?.focus();
      }}
      changes={reviewChanges}
      onChanges={setReviewChanges}
      summary={reviewSummary}
      pulls={props.reviewPulls ?? []}
      pullsRead={props.reviewPullsRead ?? 'read'}
      pick={reviewPick}
      onPick={(pull) => {
        setReviewMenu(false);
        if (pull.thread) {
          props.onClose();
          props.onOpenReviewThread?.(pull.thread.id);
          return;
        }
        setReviewPick(pull);
        linkKept.current = '';
        toFollowsReview();
        textRef.current?.focus();
      }}
      linkChosen={linkChosen}
      onUseLink={() => {
        setReviewMenu(false);
        if (linkThreadOf(linkRead)) {
          props.onClose();
          props.onOpenReviewThread?.(linkThreadOf(linkRead)!);
          return;
        }
        setLinkChosen(true);
        linkKept.current = reviewLink;
        toFollowsReview();
        textRef.current?.focus();
      }}
      phone={phone}
      menu={reviewMenu}
      link={reviewLink}
      onLink={(text) => {
        setReviewLink(text);
        setLinkChosen(false);
      }}
      linkRead={linkRead}
      linkInReview={!!linkThreadOf(linkRead)}
      onMenu={(open) => {
        setPicker(false);
        setFolderMenu(false);
        setReviewMenu(open);
        // Closed without choosing: the link already chosen stays, as a list pick does.
        if (!open && !linkChosen && linkKept.current) {
          setReviewLink(linkKept.current);
          setLinkChosen(true);
        }
      }}
    />
  );

  return (
    <dialog
      ref={dialogRef}
      className="ib-cp"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-compose=""
      data-review-box={box ? '' : undefined}
      data-phone={phone ? '' : undefined}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        // The browser's own close request for an Escape the IME took (same press, so within a frame or two): not a close.
        if (event.timeStamp - imeEscape.current < 100) return;
        if (!escapeTip()) requestClose();
      }}
      // A phone's tip covers Thread and the message: a tap into either lets it go (it was stamped when it showed).
      onFocus={(event) => {
        if (phone && tip === 'shown' && (event.target as Element).matches?.('textarea, input') && (event.target as Element).closest('[data-compose-text], [data-compose-thread-row]')) leaveTip();
      }}
      onClick={(event) => {
        const dialog = dialogRef.current;
        if (!dialog || event.target !== dialog) return;
        const r = dialog.getBoundingClientRect();
        if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) requestClose();
      }}
      {...drop.handlers}
      // A paste anywhere in the dialog that carries files attaches them; text pastes as text.
      onPaste={(event) => {
        if (takesFiles && files.paste(event)) setError(null);
      }}
    >
      {phone ? (
        // One box, so To can take the top bar's line while the keyboard is up (inbox.css).
        <div className="ib-cp-head">
          <div className="ib-cp-bar">
            <button type="button" className="ib-cp-barb" onClick={requestClose} data-compose-cancel="">
              Cancel
            </button>
            <h2 id={titleId}>{title}</h2>
            {/* Only when nothing can be sent, and a saved draft that has not changed has nothing to save. */}
            {saveOffered && (!draft || dirty) && (
              <button type="button" className="ib-cp-barb ib-strong" onClick={() => void keepDraft()} disabled={busy !== null || voice.busy} data-compose-save="">
                Save draft
              </button>
            )}
          </div>
          {reviewRows}
          {toRow}
        </div>
      ) : (
        <>
          <h2 id={titleId} className="ib-sr">
            {title}
          </h2>
          {reviewRows}
          {toRow}
        </>
      )}
      {card && (
        <p className="ib-cp-card" data-compose-card={card.id}>
          <span>
            A thread for the Board card <b dir="auto">{card.title}</b>. Sending links it to the card.
          </span>
        </p>
      )}
      {picker && (
        <ToPicker
          groups={groups}
          selected={target?.session ?? (start ? startKey(start.agent) : null)}
          home={home}
          phone={phone}
          start={launch && canStart && launch.projects.length > 0 ? { launch, current: start && !start.scratch ? { id: start.project.id, root: start.project.root } : current } : null}
          onStart={(picked) => {
            setToFilled(false);
            setStartPick({ agent: picked.agent, projectId: picked.project.id, machine: (picked.project as MachineLaunchProject).machine ?? null });
            // Reads the login shell ahead, so the Send need not wait on it (answer unused; a phone is refused).
            void inboxApi.launchSettingsRead(true).catch(() => {});
            setChosen(null);
            setPicker(false);
            setError(null);
            textRef.current?.focus();
          }}
          onPick={(picked) => {
            setToFilled(false);
            setChosen(picked.session);
            setStartPick(null);
            setPicker(false);
            setError(null);
            afterPicker();
          }}
          onClose={() => {
            setPicker(false);
            // Still nobody in To: back on To, where the choice is made.
            if (target) afterPicker();
            else (toRef.current ?? textRef.current)?.focus();
          }}
        />
      )}
      {folderMenu && start && launch && (
        <FolderMenu
          projects={launch.projects}
          selected={start.project.id}
          selectedMachine={start.machine}
          groups={grouped ? folderGroups : null}
          drives={model?.launch?.drives ?? null}
          finder={props.localWindow === true && !phone && model?.launch?.finder === true}
          scratch={
            launch.scratch && scratchFolder
              ? {
                  folder: tildePath(scratchFolder, home),
                  root: tildePath(launch.scratch.root, home),
                  // Trust is the agent's own: an agent that never asks for it (no `scratch_trusted`) trusts it. Trust and
                  // start says it at the button, so the row speaks only where a press can't (a guest, a root at home).
                  trusted: startAgent?.scratch_trusted !== false || !!startAgent.untrusted?.[SCRATCH_PICK],
                  agentName: start.name,
                }
              : null
          }
          onFolder={
            pulls || box
              ? undefined
              : (folder, name, machine, create) => {
                  // A folder that is one of that machine's projects already is that project (its trust facts and all).
                  const machineHome = machine ? (there.reads.get(machine)?.home ?? null) : home;
                  const known = create ? undefined : blockOf(machine)?.projects.find((p) => p.exists && tildePath(p.root, machineHome) === folder);
                  setStartPick(known ? { agent: start.agent, projectId: known.id, machine } : { agent: start.agent, projectId: `folder:${folder}`, machine, folder: { path: folder, name, ...(create ? { create: true } : {}) } });
                  setFolderMenu(false);
                  setError(null);
                  if (create) say(`Starts in ${name}, a new folder made when you send.`);
                  textRef.current?.focus();
                }
          }
          onClone={
            pulls || box
              ? undefined
              : (pick) => {
                  const clone: ComposeClone = { url: pick.url, host: pick.repo.host, slug: pick.repo.slug, ...(pick.repo.branch ? { branch: pick.repo.branch } : {}) };
                  setStartPick({ agent: start.agent, projectId: `folder:${pick.folder}`, machine: pick.machine, folder: { path: pick.folder, name: pick.name, clone } });
                  setFolderMenu(false);
                  setError(null);
                  const on = pick.machine ? (machineGroups.groups.find((g) => g.machine === pick.machine)?.name ?? null) : null;
                  say(`Starts in ${pick.name}${on ? ` on ${on}` : ''}, cloned when you send.`);
                  textRef.current?.focus();
                }
          }
          agentName={start.name}
          cloneInto={model?.launch?.clone?.into ? tildePath(model.launch.clone.into, home) : null}
          initialQuery={start.clone?.url ?? ''}
          clonePicked={start.clone && start.folder ? { folder: start.folder, machine: start.machine } : null}
          folderPicked={start.folder ? { folder: start.folder, machine: start.machine } : null}
          kept={keptPaths.current}
          onScratch={(machine) => {
            setStartPick({ agent: start.agent, projectId: SCRATCH_PICK, machine });
            setFolderMenu(false);
            setError(null);
            textRef.current?.focus();
          }}
          home={home}
          phone={phone}
          onPick={(project, machine) => {
            setStartPick({ agent: start.agent, projectId: project.id, machine });
            setFolderMenu(false);
            setError(null);
            textRef.current?.focus();
          }}
          onClose={() => {
            setFolderMenu(false);
            (dialogRef.current?.querySelector<HTMLButtonElement>('[data-compose-folder]') ?? textRef.current)?.focus();
          }}
        />
      )}
      <div className="ib-cp-thread" data-compose-thread-row="">
        <span className="ib-cp-tol">Thread</span>
        <ThreadNameChip
          state={nameState}
          suggested={reviewName ?? suggested}
          hint={box ? 'Named from what it reviews until you type here.' : undefined}
          error={nameError}
          onChange={(next) => {
            setNameState(next);
            setNameError(null);
          }}
          onDone={() => textRef.current?.focus()}
          onOverflow={(text) => {
            setError(null);
            const lead = body.trim() ? (/[\r\n]/.test(text) ? '\n' : ' ') : '';
            if (takesFiles && isLongPaste(text)) {
              // 32 KB or more goes to the message as a pasted text tile, at its end, as the words would have
              // (never where the dialog takes no files, the tour: the words go to the message as before).
              files.takeText(text, body.trim() ? body.replace(/\s+$/, '').length : body.length, { field: textRef.current, lead });
              requestAnimationFrame(() => {
                const area = textRef.current;
                if (!area) return;
                area.focus();
                area.setSelectionRange(area.value.length, area.value.length);
              });
              return THREAD_NAME_ATTACHED_NOTE;
            }
            setBody((current) => (current.trim() ? `${current.replace(/\s+$/, '')}${/[\r\n]/.test(text) ? '\n' : ' '}${text}` : text));
            // Dictation goes on in the message from here.
            requestAnimationFrame(() => {
              const area = textRef.current;
              if (!area) return;
              area.focus();
              area.setSelectionRange(area.value.length, area.value.length);
            });
          }}
          idBase={`ib-cp-tname-${uid}`}
        />
        {boardChip && (
          <BoardChip
            on={boardOn}
            onToggle={() => {
              setBoardOn(!boardOn);
              rememberComposeBoardChoice(!boardOn);
            }}
          />
        )}
      </div>
      {start && !start.project.exists && (
        <div className="ib-cp-note ib-warn" data-compose-note="folder-missing">
          <Icon name="warn" size={16} />
          <div>
            {startUnplugged ? (
              <b>
                <bdi>{startUnplugged}</bdi> isn't connected.
              </b>
            ) : (
              <b>
                <bdi>{tildePath(start.project.root, startHome)}</bdi> isn't there any more.
              </b>
            )}
            <p>
              {startUnplugged ? (
                <>
                  Connect it to start {start.name} in <bdi>{start.project.name}</bdi>, or pick another project. Nothing is sent until you do.
                </>
              ) : (
                <>
                  It was moved or deleted. Pick another project{launch?.scratch ? ', or a new scratch folder,' : ''} to start {start.name} in. Nothing is sent until you do.
                </>
              )}
            </p>
            <button type="button" className="ib-btn ib-sm" onClick={() => setFolderMenu(true)} data-compose-pick-folder="">
              Pick a project
            </button>
          </div>
        </div>
      )}
      {model && !anyLive && !canStart && !endedNote && (
        <div className="ib-cp-note" data-compose-note="none">
          <Icon name="info" size={16} />
          <div>
            <b>No agent is running{projectName ? ` in ${projectName}` : ''}.</b>
            <p>{box ? `A review needs one. Start Claude Code, Pi or OpenCode in the project and it shows up here.` : <>Nothing can be sent until one is. Save it as a draft; it waits under Drafts, and you send it when Claude Code, Pi or OpenCode is running.</>}</p>
          </div>
        </div>
      )}
      {endedNote && !target && (
        <div className="ib-cp-note ib-warn" data-compose-note="ended">
          <Icon name="warn" size={16} />
          <div>
            <b>The {hostLabel(endedNote.host)} session this {draft ? 'draft' : 'message'} was for has ended.</b>
            <p>
              {endedNote.project_name ? `It was in ${endedNote.project_name}` : 'It'}
              {endedNote.started_at ? `, started ${whenTime(endedNote.started_at)}` : ''}. Pick a live session to send it, or keep it as a draft.
            </p>
            {anyLive && (
              <button type="button" className="ib-btn ib-sm" onClick={() => setPicker(true)} data-compose-pick="">
                Pick a session
              </button>
            )}
          </div>
        </div>
      )}
      <div className="ib-cp-body">
        {/* The Inbox's composer field (#1914): the / and $ skill picker; the Send composes the block. */}
        <div className="ib-cp-field" data-compose-text="">
          <InboxComposerField
            textareaRef={textRef}
            voice={voice}
            ariaLabel="Message"
            ariaDescribedBy={status ? statusId : undefined}
            destination="your message"
            placeholder={box ? (reviewKind === 'walkthrough' ? 'What should it walk you through?' : 'A guided review, by default. Add words to curate it your way, or ask for a full review.') : 'Write an idea or a request. It starts a new thread.'}
            // The field is tall and sits in a scrolling body above the footer: the picker opens at the
            // caret, inside the dialog and above its footer, and Escape closes it before the dialog.
            caretMenu={caretMenu}
            escapeClosesMenu
            value={body}
            onChange={(value) => {
              setBody(value);
              if (error) setError(null);
            }}
          />
        </div>
        <ComposeFileTiles
          files={files.files}
          onRemove={(key) => {
            files.remove(key);
            // The × goes with its tile: focus stays in the dialog, in the message.
            textRef.current?.focus();
          }}
          onPutBack={(key) => files.putBack(key, textRef.current)}
        />
      </div>
      {start && startAsleep && startMachineName && (
        <p className="ib-cp-asleep" data-compose-note="asleep">
          <Icon name="moon" size={15} />
          <span>
            {startMachineName} is asleep (since {whenTime(startMachine!.since)}). Your message waits here, and {start.name} starts on {startMachineName} when it's back. You can cancel it until then.
          </span>
        </p>
      )}
      {error && (
        // Kept, unseen, while the details say it: the button under a press that closes them must not move.
        <div className="ib-cp-error" role={errorInDetails ? undefined : 'alert'} data-compose-error={errorInDetails ? undefined : ''} data-in-details={errorInDetails ? '' : undefined}>
          {error}
          {conflict && (
            <span className="ib-cp-conflict">
              <button type="button" className="ib-lnk" onClick={() => void keepDraft()}>
                Keep mine
              </button>
              <button
                type="button"
                className="ib-lnk"
                onClick={() => {
                  setDraft(conflict);
                  setBody(conflict.body);
                  setNameState(threadNameStateOf(conflict));
                  setChosen(conflict.to?.session ?? null);
                  setConflict(null);
                  setError(null);
                }}
              >
                Use the other
              </button>
            </span>
          )}
        </div>
      )}
      <div className="ib-cp-foot">
        {trust && trustInfoOpen && <TrustDetails folder={tildePath(trust.folder, startHome)} facts={trustFacts} said={errorInDetails ? error : null} />}
        {takesFiles ? (
          // On a phone what the picker hands over is named as a paste is (`image.jpg` -> `pasted-image-<stamp>.jpg`).
          <AttachFilesButton className="ib-cp-clip" iconSize={17} phone={phone} inputData="data-compose-attach" onFiles={(list) => (phone ? files.attach : files.add)(list)} />
        ) : (
          <Tip content="Files: not in the tour">
            <span className="ib-cp-clip" role="img" aria-label="Files: not in the tour" aria-disabled="true" data-compose-attach-off="">
              <Icon name="clip" size={17} />
            </span>
          </Tip>
        )}
        {/* With the keyboard up the tiles step aside, so a phone's row says how many (inbox.css). */}
        {phone && attached > 0 && (
          <span className="ib-cp-clipn" data-compose-file-count="">
            {attached}
            <span className="ib-sr"> attached</span>
          </span>
        )}
        {/* On a desktop the To line already says "Draft · saved". A phone's row drops the time, then the word; the check stays. */}
        {draft && !dirty && phone && (
          <span className="ib-cp-savedline" role="img" aria-label={`Saved as a draft ${whenTime(draft.updated_at)}`} data-compose-saved="">
            <Icon name="check" size={14} />
            <span>Saved</span>
            <span>{whenTime(draft.updated_at)}</span>
          </span>
        )}
        {/* A phone deletes a draft from its row on the Drafts page. */}
        {draft && !phone && (
          <button type="button" className="ib-cp-del" onClick={() => void deleteDraft()} disabled={busy !== null} data-compose-delete="">
            Delete draft
          </button>
        )}
        <span className="ib-sp" />
        {/* On a phone To and its note say this already; it stays for a screen reader (the message field's description). */}
        {status && (
          <span className={phone ? 'ib-sr' : 'ib-cp-status'} id={statusId} data-compose-status="">
            {status}
          </span>
        )}
        {/* The mic where the reply box has it, at the row's right end; Send keeps the end itself. */}
        <VoiceFoot voice={voice} phone={phone}>
          {box && !phone && (
            <button type="button" className="ib-btn ib-ghost" onClick={requestClose} data-compose-cancel="">
              Cancel
            </button>
          )}
          {saveOffered && !phone && (
            <button type="button" className="ib-btn" onClick={() => void keepDraft()} disabled={busy !== null || voice.busy} data-compose-save="">
              Save draft
            </button>
          )}
        </VoiceFoot>
        {trustFacts.length > 0 && (
          <button
            type="button"
            ref={trustCircleRef}
            className="ib-iconbtn ib-cp-trustcircle"
            aria-label="What trusting this folder means"
            aria-haspopup="dialog"
            aria-expanded={trustInfoOpen}
            aria-controls={trustInfoOpen ? 'ib-cp-trust-pop' : undefined}
            onClick={() => setTrustInfo((open) => !open)}
            data-compose-trust-circle=""
            data-warning={trust?.warns ? '' : undefined}
          >
            <Icon name="question" size={18} />
          </button>
        )}
        <button
          type="button"
          className={`ib-btn ib-pri${phone ? ' ib-cp-send' : ''}${sendable ? '' : ' ib-dis'}`}
          aria-disabled={!sendable || undefined}
          aria-keyshortcuts={sendKeys}
          onClick={() => void send()}
          disabled={busy !== null || voice.busy}
          data-compose-send=""
        >
          <Icon name="send" size={15} />
          {phone ? <span className="ib-cp-sendl">{sendLabel}</span> : sendLabel}
        </button>
      </div>
      <div className="ib-sr" aria-live="polite" data-compose-paste-live="">
        {pasteSaid}
      </div>
      {props.aside}
      {drop.over && (
        <div className="ib-cp-drop" aria-hidden="true">
          <Icon name="clip" size={20} />
          Drop files to attach
        </div>
      )}
    </dialog>
  );
}
