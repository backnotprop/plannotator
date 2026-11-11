import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { parseInboxGitUrl, type InboxGitRepo } from '@plannotator/core/inbox-git-url';
import { inboxPermissionCodeSpans } from '@plannotator/core/inbox-permission';
import { inboxApi, type CloneReach, type CloneTargetAnswer } from '../api';
import { Icon } from '../icons';
import { tildePath } from '../format';
import { FolderPath } from './ToPicker';
import { filterLaunchProjects, otherFolderMatches, scratchMatches, SCRATCH_PICK, type LaunchProject } from './model';
import { HomeFolderBrowser } from './HomeFolderBrowser';
import { cleanPastedPath, drivePathOf, homeRelative, looksLikePath, placeOf, unpluggedDrive, type FolderDrive } from './homeFolders';

/**
 * The folder menu (launch, UX screen 03): where a new session starts, picked
 * from the Inbox's own projects (the most recently active first, ✓ on the
 * one To names), so a typo can never start an agent in the wrong folder.
 * The To picker's look and keys: a filter, ↓ ↑ and Enter, Escape closes the
 * menu only. A project whose folder is gone is listed struck through, and
 * picking it gets compose's folder-missing note (screen 13).
 *
 * Last, under a line: "New scratch folder" and the folder a Send would make
 * (`<root>/<thread-name slug>`). While the agent does not trust the root yet
 * and no press of Trust and start can (a guest, a root at home) it reads "New
 * scratch folder · trust it once", shows the root, and says under it that the
 * first start asks to trust the root once: that start fails as untrusted, and
 * its run line trusts the root (Trust folder, or Open in Terminal), so one
 * trust covers every scratch folder after it.
 *
 * Linked machines (remote launch, the picker's A): `groups` lists the projects
 * by machine, each under its machine's caption ("MacBook · this computer",
 * "Mac mini · asleep"), the machine the person started an agent on last first,
 * a project on several machines under each. A group's own scratch row ends it.
 * A machine where the agent can't start shows one disabled line, with its
 * command to copy when there is one. The filter matches a project's name or
 * path, or the machine's name; the keys walk every row of every group.
 *
 * "Another folder on <machine>…" (approval addendum "existing folders", `onFolder`): the quiet last row of each
 * group ("Another folder…" with no machine words when there is only this computer). Picked, the menu turns into
 * that machine's folder browser (HomeFolderBrowser.tsx) until a folder is picked or the person goes back.
 *
 * A path in the filter (approval "launch-create-clone", B4: typed or pasted, `~/…`, `/…`, quoted or `file://`): only
 * the projects under that path stay, and each machine's "Another folder…" row carries the path and opens its browser
 * there. The browser's path is kept per machine while compose is open (`kept`), so going back and in again keeps it (D2).
 *
 * A git URL in the filter (approval "launch-create-clone", C1-C17, `onClone`): each machine offers "Clone <repo> and
 * start" into the folder where that machine would clone it (asked of it: its last clone folder, else where its
 * projects live, else home; the repo's name, or the next free one), or "Start in <name> · already cloned" where that
 * repo is there already, then "Clone into another folder…" (its folder browser in clone mode). Under them one line
 * says how. A quiet check after the paste dims a machine whose git can't sign in to the host, still pickable (C11). An
 * unknown host is checked before it is offered ("Checking git.acme.dev…"); an account or a page that isn't a repo is
 * said in one line. An asleep machine's row is still offered, with no "another folder" row (its folders can't be read).
 *
 * Drives (approval "inbox-launch-any-folder"): after "Another folder…", one quiet row per drive the machine has
 * mounted ("Studio SSD…", "Backup… · network drive"); picked, the folder browser opens at that drive. A project whose
 * drive isn't plugged in is struck through with "· Archive isn't connected"; one on a network drive that isn't
 * answering says "· Backup isn't responding".
 */
/** "New scratch folder" in one place: the folder a Send would make, its root, and whether the agent trusts the root. */
export interface ScratchRow {
  folder: string;
  root: string;
  trusted: boolean;
  agentName: string;
}

/** One machine's group (remote launch). */
export interface FolderGroup {
  /** The machine's id, or null for this computer. */
  machine: string | null;
  name: string;
  /** After the name in the caption: "this computer", "asleep". */
  quiet: string | null;
  home: string | null;
  projects: readonly LaunchProject[];
  /** The project the person last started an agent in there: "· you started it here last". */
  last: string | null;
  scratch: ScratchRow | null;
  /** The agent can't start there: one disabled line instead of its projects, with what to do there (`fix`) under it. */
  notice: { line: string; command: string | null; fix?: string | null } | null;
  /** That machine is asleep: its folder browser reads nothing. */
  asleep?: boolean;
  /** Where that machine clones a repo with no setting (`~/…`, from its launch block), for its row while it can't be asked. */
  cloneInto?: string | null;
  /** The drives it has mounted (its launch block's): a row each, and the browser's places. Absent: an older Inbox. */
  drives?: readonly FolderDrive[] | null;
  /** "Choose in Finder…" in its browser: this computer, its own window, macOS. */
  finder?: boolean;
}

/** A clone picked: the URL as pasted, the repo it names, and its own folder on that machine (`~/…`). */
export interface ClonePick {
  url: string;
  repo: InboxGitRepo;
  folder: string;
  name: string;
  machine: string | null;
}

/** The folder browser's pick key in the keys' walk: never a project id (`prj_…`) or the scratch pick. */
const OTHER_PICK = '~other';
/** A machine's clone row, and its "Clone into another folder…", in the keys' walk. */
const CLONE_PICK = '~clone';
const CLONE_OTHER_PICK = '~clone-other';
/** A drive's row in the keys' walk. */
const drivePick = (drive: FolderDrive) => `~drive:${drive.path}`;

/** One machine's clone row: where it would clone the repo (`target`), or a guess while it can't be asked. */
interface CloneRow {
  path: string;
  name: string;
  already: boolean;
  taken: string | null;
  /** Its quiet check: that machine's git can't sign in to the host (C11). */
  cantSignIn: boolean;
}

type Row =
  | { key: string; kind: 'project'; project: LaunchProject; group: FolderGroup }
  | { key: string; kind: 'scratch'; scratch: ScratchRow; group: FolderGroup }
  | { key: string; kind: 'other'; group: FolderGroup }
  | { key: string; kind: 'drive'; drive: FolderDrive; group: FolderGroup }
  | { key: string; kind: 'clone'; clone: CloneRow; group: FolderGroup }
  | { key: string; kind: 'cloneOther'; group: FolderGroup };

/** How long a pasted URL settles before each machine is asked where it would clone it (a folder read, cheap). */
const CLONE_ASK_MS = 150;
/**
 * How long the URL must stay as it is before each machine checks it can read the repo: a network `git ls-remote`, so
 * a URL being typed (every prefix of `github.com/acme/billing-api` reads as a repo) is checked once, when the typing
 * stops, never per key. A paste settles at once and is checked after this.
 */
const CLONE_CHECK_MS = 700;
/** The checks' answers, by machine and URL, for a minute: the same URL again (typed back, reopened) asks no machine again. */
const reachKnown = new Map<string, { reach: CloneReach; at: number }>();
const REACH_KEEP_MS = 60_000;
/** Tests: each starts with no check answered. */
export function resetCloneChecksForTests(): void {
  reachKnown.clear();
}

/**
 * Each awake machine's answers for a pasted repo: where it would clone it, and the quiet check (C11). Keyed by machine
 * (`''`: this computer); an answer for another URL is dropped.
 */
function useCloneReads(repo: InboxGitRepo | null, url: string, machines: readonly (string | null)[]) {
  const [reads, setReads] = useState<{ url: string; targets: Map<string, CloneTargetAnswer>; reach: Map<string, CloneReach> }>({ url: '', targets: new Map(), reach: new Map() });
  const key = machines.map((m) => m ?? '').join(',');
  useEffect(() => {
    if (!repo) return;
    const controller = new AbortController();
    let live = true;
    const known = new Map<string, CloneReach>();
    for (const machine of machines) {
      const answer = reachKnown.get(`${machine ?? ''}|${repo.url}`);
      if (answer && Date.now() - answer.at < REACH_KEEP_MS) known.set(machine ?? '', answer.reach);
    }
    setReads({ url, targets: new Map(), reach: known });
    const timer = setTimeout(() => {
      // An unknown host is only checked (C8): where it would go is asked once it reads as a repo.
      if (repo.unchecked) return;
      for (const machine of machines) {
        const id = machine ?? '';
        inboxApi.cloneTarget(url, null, machine, controller.signal).then(
          (answer) => live && setReads((was) => (was.url === url ? { ...was, targets: new Map(was.targets).set(id, answer) } : was)),
          () => {},
        );
      }
    }, CLONE_ASK_MS);
    const check = setTimeout(() => {
      for (const machine of machines) {
        const id = machine ?? '';
        if (known.has(id)) continue;
        inboxApi.cloneCheck(url, machine, controller.signal).then(
          (answer) => {
            reachKnown.set(`${id}|${repo.url}`, { reach: answer.reach, at: Date.now() });
            if (live) setReads((was) => (was.url === url ? { ...was, reach: new Map(was.reach).set(id, answer.reach) } : was));
          },
          () => {},
        );
      }
    }, CLONE_CHECK_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      clearTimeout(check);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.url, url, key]);
  return reads.url === url ? reads : { url, targets: new Map<string, CloneTargetAnswer>(), reach: new Map<string, CloneReach>() };
}

const rowKey = (machine: string | null, id: string) => `${machine ?? ''}:${id}`;

export function FolderMenu({
  projects,
  selected,
  selectedMachine = null,
  home,
  phone,
  onPick,
  scratch,
  onScratch,
  onClose,
  groups,
  onFolder,
  folderPicked = null,
  kept,
  onClone,
  agentName = null,
  cloneInto = null,
  initialQuery = '',
  clonePicked = null,
  drives = null,
  finder = false,
}: {
  projects: readonly LaunchProject[];
  selected: string | null;
  /** The machine of the project To names (null: this computer). */
  selectedMachine?: string | null;
  home: string | null;
  phone: boolean;
  onPick: (project: LaunchProject, machine: string | null) => void;
  /**
   * "New scratch folder": the folder a Send would make and its root (`~/…`), whether the agent (`agentName`)
   * trusts the root already, else the row names the root and says how the first start asks for it. Null: no row.
   */
  scratch?: ScratchRow | null;
  onScratch?: (machine: string | null) => void;
  onClose: () => void;
  /** Linked machines: the projects grouped by machine, each with its caption. Absent or null: one list, as always. */
  groups?: readonly FolderGroup[] | null;
  /**
   * "Another folder on <machine>…": a folder under that machine's home (`~/…`) was picked; `create`: the Send makes it
   * (Create a folder). Absent: no such row.
   */
  onFolder?: (folder: string, name: string, machine: string | null, create: boolean) => void;
  /** The folder browser's path as last typed, per machine (`''` for this computer), kept while compose is open. */
  kept?: Map<string, string>;
  /** The folder To names now, when it is one of these: the browser opens there on its machine. */
  folderPicked?: { folder: string; machine: string | null } | null;
  /** A git URL's clone row picked (C1-C17). Absent: a URL is words to find a project by. */
  onClone?: (pick: ClonePick) => void;
  /** The agent To names, for the line under the clone rows ("Claude Code starts when the clone is done."). */
  agentName?: string | null;
  /** Without linked machines: where this computer clones a repo with no setting (`~/…`). */
  cloneInto?: string | null;
  /** The filter as it opens: a clone pick's URL, so switching machine is one press (D4, D7). */
  initialQuery?: string;
  /** The clone To names now: ✓ on its machine's clone row. */
  clonePicked?: { folder: string; machine: string | null } | null;
  /** Without linked machines: this computer's drives (its launch block's). */
  drives?: readonly FolderDrive[] | null;
  /** Without linked machines: "Choose in Finder…" in the browser (this computer's own window, macOS). */
  finder?: boolean;
}) {
  const [query, setQuery] = useState(initialQuery);
  // The folder browser open in place of the list, for one machine's group: by its id (null: this computer), so the
  // browser always sees that machine as it is now (asleep since, or gone).
  const [otherId, setOtherId] = useState<string | null | undefined>(undefined);
  const grouped = !!groups;
  // Without linked machines: one group with no caption, so the menu is exactly what it was.
  const all = useMemo<readonly FolderGroup[]>(
    () => groups ?? [{ machine: null, name: '', quiet: null, home, projects, last: null, scratch: scratch && onScratch ? scratch : null, notice: null, cloneInto, drives, finder }],
    [groups, home, projects, scratch, onScratch, cloneInto, drives, finder],
  );
  const other = otherId === undefined ? null : (all.find((group) => group.machine === otherId) ?? null);
  // A path in the filter (B4): the projects under it, and each machine's "Another folder…" opens there.
  // The paste was cleaned once already (its escapes read): what the filter holds keeps its backslashes now.
  const typedPath = looksLikePath(query) ? cleanPastedPath(query, null, { unescape: false }) : null;
  // A git URL in the filter (C1-C17): each machine's clone row. A bare `acme/billing-api` stays a project search (C3).
  const git = onClone && typedPath === null ? parseInboxGitUrl(query) : null;
  const repo = git?.kind === 'repo' ? git : null;
  const askable = useMemo(() => (repo ? all.filter((g) => !g.notice && !g.asleep).map((g) => g.machine) : []), [repo, all]);
  const cloneReads = useCloneReads(repo, query.trim(), askable);
  // An unknown host (C7, C8): offered once a machine's git reads it as a repo; said when none can.
  const checkedReach = repo?.unchecked ? (askable.length > 0 ? cloneReads.reach.get(askable[0] ?? '') : undefined) : 'ok';
  const repoShown = !!repo && (checkedReach === 'ok' || checkedReach === 'auth');
  const gitLine = !git
    ? null
    : git.kind === 'account'
      ? `${git.host}/${git.owner} is an account, not a repo. Paste the repo's URL.`
      : git.kind === 'notrepo'
        ? `${git.text.replace(/^https?:\/\//, '')} isn't a git repo.`
        : repo!.unchecked && checkedReach === undefined
          ? null
          : repoShown
            ? null
            : `${query.trim().replace(/^https?:\/\//, '')} isn't a git repo.`;
  const checking = !!repo?.unchecked && checkedReach === undefined && askable.length > 0 ? `Checking ${repo.host}…` : null;
  /** One machine's clone row: as it answered, else a guess from its clone folder (asleep, or not answered yet). */
  const cloneRowOf = (group: FolderGroup): CloneRow => {
    const id = group.machine ?? '';
    const answer = cloneReads.targets.get(id);
    const cantSignIn = cloneReads.reach.get(id) === 'auth';
    if (answer) return { path: answer.path, name: answer.name, already: answer.state === 'already', taken: answer.taken, cantSignIn };
    const into = (group.cloneInto ?? '~').replace(/\/+$/, '');
    return { path: `${into}/${repo!.repo}`, name: repo!.repo, already: false, taken: null, cantSignIn };
  };
  // Where "Another folder…" opened the browser from: a path in the filter, else the path kept for that machine.
  const [openAt, setOpenAt] = useState<string | null>(null);
  // Its machine left the menu (unlinked): back to the list.
  useEffect(() => {
    if (otherId !== undefined && !other) setOtherId(undefined);
  }, [otherId, other]);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return all
      .map((group) => {
        // A machine's name picks its whole group ("mini").
        const named = grouped && words.length > 0 && words.every((w) => group.name.toLowerCase().includes(w));
        if (git) {
          // A git URL: each machine's clone row (an asleep one's too: it clones when it's back), never its projects.
          const offered = repoShown && !group.notice;
          return { group, projects: [], scratch: null, notice: repoShown ? group.notice : null, other: false, drives: [] as FolderDrive[], path: null as string | null, clone: offered ? cloneRowOf(group) : null, cloneOther: offered && !group.asleep && !cloneRowOf(group).already };
        }
        if (typedPath !== null) {
          // A path: its projects (by where they are on that machine), and "Another folder…" carrying the path.
          const at = homeRelative(typedPath, group.home).replace(/\/+$/, '');
          const under = group.projects.filter((p) => {
            const folder = tildePath(p.root, group.home);
            return folder === at || folder.startsWith(`${at}/`);
          });
          return { group, projects: under, scratch: null, notice: null, other: !!onFolder && !group.notice && !group.asleep, drives: [] as FolderDrive[], path: homeRelative(typedPath, group.home), clone: null, cloneOther: false };
        }
        return {
          group,
          projects: named ? [...group.projects] : filterLaunchProjects(group.projects, query),
          scratch: group.scratch && (named || scratchMatches(query)) ? group.scratch : null,
          notice: group.notice && (named || words.length === 0) ? group.notice : null,
          // A group that offers anything to start in (not a machine's notice) ends with "Another folder on <machine>…".
          // Not for an asleep machine: its folders can't be read, and its caption already says it is asleep.
          other: !!onFolder && !group.notice && !group.asleep && (named || otherFolderMatches(query)),
          // Its drives, after "Another folder…": all of them with no words, else the ones the words name.
          drives:
            onFolder && !group.notice && !group.asleep
              ? (group.drives ?? []).filter((d) => named || words.length === 0 || words.every((w) => d.name.toLowerCase().includes(w) || (d.network === true && 'network drive'.includes(w))))
              : [],
          path: null as string | null,
          clone: null as CloneRow | null,
          cloneOther: false,
        };
      })
      .filter((g) => g.projects.length > 0 || g.scratch || g.notice || g.other || g.drives.length > 0 || g.clone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, grouped, query, onFolder, typedPath, git, repoShown, cloneReads]);
  const rows = useMemo<Row[]>(
    () =>
      shown.flatMap((g) => [
        ...g.projects.map((project) => ({ key: rowKey(g.group.machine, project.id), kind: 'project' as const, project, group: g.group })),
        ...(g.scratch ? [{ key: rowKey(g.group.machine, SCRATCH_PICK), kind: 'scratch' as const, scratch: g.scratch, group: g.group }] : []),
        ...(g.other ? [{ key: rowKey(g.group.machine, OTHER_PICK), kind: 'other' as const, group: g.group }] : []),
        ...g.drives.map((drive) => ({ key: rowKey(g.group.machine, drivePick(drive)), kind: 'drive' as const, drive, group: g.group })),
        ...(g.clone ? [{ key: rowKey(g.group.machine, CLONE_PICK), kind: 'clone' as const, clone: g.clone, group: g.group }] : []),
        ...(g.cloneOther ? [{ key: rowKey(g.group.machine, CLONE_OTHER_PICK), kind: 'cloneOther' as const, group: g.group }] : []),
      ]),
    [shown],
  );
  // The keys walk the projects, then the scratch row, then "Another folder…", group after group.
  const ids = useMemo(() => rows.map((row) => row.key), [rows]);
  // A project on a drive that isn't plugged in is said, never picked: its row is skipped by the keys and the pointer.
  const unpickable = (row: Row | undefined) => row?.kind === 'project' && !row.project.exists && unpluggedDrive(row.project.root, row.group.drives) !== null;
  const [hlId, setHlId] = useState<string | null>(clonePicked && initialQuery ? rowKey(clonePicked.machine, CLONE_PICK) : selected ? rowKey(selectedMachine, selected) : null);
  // The row to highlight when the filter changes next, instead of its first (a URL back from the folder field: B5).
  const nextHl = useRef<string | null>(null);
  // The folder browser in clone mode ("Clone into another folder…"), or as "Another folder…".
  const [browseClone, setBrowseClone] = useState<{ url: string; repo: InboxGitRepo; at: string } | null>(null);
  const found = ids.indexOf(hlId ?? '');
  const hl = ids.length === 0 ? -1 : found >= 0 ? found : 0;
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const optionId = (i: number) => `ib-cp-f-${uid}-${i}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (nextHl.current) {
      setHlId(nextHl.current);
      nextHl.current = null;
    } else if (query !== '' && !(initialQuery && query === initialQuery)) setHlId(ids[0] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  // Back from the folder browser too: the filter, with "Another folder…" still the highlighted row.
  useEffect(() => {
    if (!other) inputRef.current?.focus();
  }, [other]);
  useLayoutEffect(() => {
    document.getElementById(optionId(hl))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hl]);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target && !ref.current?.contains(target) && !target.closest('[data-compose-folder]')) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);

  /** The row the browser's back arrow returns to: "Another folder…", or the drive row it was opened from. */
  const [backTo, setBackTo] = useState<string | null>(null);
  /** Into a machine's folder browser: at the path in the filter, else where it was left (D2). */
  const openOther = (machine: string | null) => {
    const path = shown.find((g) => g.group.machine === machine)?.path ?? null;
    setOpenAt(path);
    setBackTo(null);
    setOtherId(machine);
  };
  /** A drive's row: that machine's folder browser, at the drive. */
  const openDrive = (machine: string | null, drive: FolderDrive) => {
    setBrowseClone(null);
    setOpenAt(`${drive.path}/`);
    setBackTo(rowKey(machine, drivePick(drive)));
    setOtherId(machine);
  };
  /** "Clone into another folder…": that machine's folder browser in clone mode, at its clone folder (C14). */
  const openCloneOther = (group: FolderGroup) => {
    if (!repo) return;
    const answer = cloneReads.targets.get(group.machine ?? '');
    const into = (answer?.into ?? group.cloneInto ?? '~').replace(/\/+$/, '');
    setBrowseClone({ url: query.trim(), repo, at: `${into}/` });
    setOtherId(group.machine);
  };
  const pickClone = (group: FolderGroup, clone: CloneRow) => {
    if (!repo) return;
    // The same repo there already (C9): it starts in that folder, as any folder that is there.
    if (clone.already) onFolder?.(clone.path, clone.name, group.machine, false);
    else onClone?.({ url: query.trim(), repo, folder: clone.path, name: clone.name, machine: group.machine });
  };
  const choose = (row: Row) => {
    if (unpickable(row)) return;
    if (row.kind === 'scratch') onScratch?.(row.group.machine);
    else if (row.kind === 'other') {
      setBrowseClone(null);
      openOther(row.group.machine);
    } else if (row.kind === 'drive') openDrive(row.group.machine, row.drive);
    else if (row.kind === 'clone') pickClone(row.group, row.clone);
    else if (row.kind === 'cloneOther') openCloneOther(row.group);
    else onPick(row.project, row.group.machine);
  };

  // A path pasted into the filter reads as the person meant it (quotes, `file://`, Terminal's escapes); words paste as words.
  const onPaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const raw = event.clipboardData?.getData('text') ?? '';
    if (!looksLikePath(raw)) return;
    event.preventDefault();
    const input = event.currentTarget;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    setQuery(input.value.slice(0, start) + cleanPastedPath(raw) + input.value.slice(end));
  };

  const onKey = (event: ReactKeyboardEvent) => {
    // The folder browser takes its own keys.
    if (event.nativeEvent.isComposing || other) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (ids.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      let next = hl;
      for (let n = 0; n < ids.length; n++) {
        next = (next + step + ids.length) % ids.length;
        if (!unpickable(rows[next])) break;
      }
      setHlId(ids[next]!);
      return;
    }
    if (event.key === 'Enter') {
      // The copy button of a machine's line takes its own Enter.
      if ((event.target as Element).closest?.('[data-compose-folder-copy]')) return;
      event.preventDefault();
      if (hl >= 0 && rows[hl]) choose(rows[hl]);
    }
  };

  const copy = async (command: string, key: string) => {
    const ok = await copyTextToClipboard(command);
    setCopied(ok ? key : null);
    if (ok) setTimeout(() => setCopied((was) => (was === key ? null : was)), 1500);
  };

  let at = 0;
  if (other) {
    const named = grouped ? other.name : null;
    return (
      <div className="ib-cp-picker ib-cp-folders" ref={ref} data-compose-folders="" data-other-folder={other.machine ?? 'self'} data-phone={phone ? '' : undefined}>
        <HomeFolderBrowser
          key={browseClone ? `clone:${browseClone.url}` : 'folder'}
          machine={{ id: other.machine, name: named, asleep: other.asleep === true, home: other.home, drives: other.drives ?? null, finder: other.finder === true && !phone }}
          phone={phone}
          clone={browseClone ? { url: browseClone.url, repo: browseClone.repo.repo } : null}
          initialPath={
            browseClone
              ? browseClone.at
              : (openAt ??
                kept?.get(other.machine ?? '') ??
                (folderPicked && folderPicked.machine === other.machine ? `${folderPicked.folder.replace(/\/+$/, '')}/` : undefined))
          }
          onTyped={(typed) => !browseClone && kept?.set(other.machine ?? '', typed)}
          onBack={() => {
            setHlId(browseClone ? rowKey(other.machine, CLONE_OTHER_PICK) : (backTo ?? rowKey(other.machine, OTHER_PICK)));
            setBrowseClone(null);
            setOtherId(undefined);
          }}
          onGitUrl={
            onClone
              ? (url) => {
                  // A git URL in the folder field (B5): back to the list, on that machine's clone row.
                  nextHl.current = rowKey(other.machine, CLONE_PICK);
                  setQuery(url);
                  setBrowseClone(null);
                  setOtherId(undefined);
                }
              : undefined
          }
          onPick={(folder, name, how) => {
            if (how === 'clone' && browseClone) onClone?.({ url: browseClone.url, repo: browseClone.repo, folder, name, machine: other.machine });
            else onFolder?.(folder, name, other.machine, how === 'create');
          }}
        />
      </div>
    );
  }
  return (
    <div className="ib-cp-picker ib-cp-folders" ref={ref} data-compose-folders="" data-grouped={grouped ? '' : undefined} data-phone={phone ? '' : undefined} onKeyDown={onKey}>
      {phone && (
        <div className="ib-cp-pickhead">
          <button type="button" className="ib-cp-back" onClick={onClose}>
            <Icon name="chevL" size={16} />
            Back
          </button>
          <span>Start in</span>
        </div>
      )}
      <div className="ib-cp-filter">
        <Icon name="search" size={14} />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={`ib-cp-flist-${uid}`}
          aria-activedescendant={hl >= 0 ? optionId(hl) : undefined}
          aria-label={onClone ? 'Find a project or paste a git URL' : 'Find a project'}
          placeholder={onClone ? 'Find a project or paste a git URL' : 'Find a project'}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onPaste={onPaste}
        />
      </div>
      <div className="ib-cp-list" role="listbox" id={`ib-cp-flist-${uid}`} aria-label="Projects">
        {rows.length === 0 && !shown.some((g) => g.notice) && !git && <div className="ib-cp-none">No project matches.</div>}
        {shown.map((g, gi) => {
          const group = g.group;
          const gHome = grouped ? group.home : home;
          const on = grouped ? `${group.name}${group.quiet ? `, ${group.quiet}` : ''}` : null;
          return (
            <Fragment key={group.machine ?? ''}>
              {grouped && (
                <div className={`ib-cp-cap${gi > 0 ? ' ib-cp-cap-line' : ''}`} aria-hidden="true" data-compose-folder-group={group.machine ?? 'self'}>
                  <b dir="auto">{group.name}</b>
                  {group.quiet ? ` · ${group.quiet}` : ''}
                </div>
              )}
              {g.notice && (
                <div
                  className="ib-cp-opt ib-cp-fopt ib-cp-fnotice"
                  role="option"
                  aria-selected={false}
                  aria-disabled="true"
                  // The line names the row; what to do there is its description (read after it).
                  aria-labelledby={`${uid}-notice-${gi}`}
                  aria-describedby={g.notice.fix ? `${uid}-fix-${gi}` : undefined}
                  data-compose-folder-notice={group.machine ?? 'self'}
                >
                  <Icon name="info" size={15} />
                  <span className="ib-cp-op">
                    <span id={`${uid}-notice-${gi}`}>{g.notice.line}</span>
                    {g.notice.fix && (
                      <span className="ib-cp-ffix" id={`${uid}-fix-${gi}`} data-compose-folder-fix="">
                        {inboxPermissionCodeSpans(g.notice.fix).map((part, i) => (part.code ? <code key={i}>{part.text}</code> : <Fragment key={i}>{part.text}</Fragment>))}
                      </span>
                    )}
                  </span>
                  {g.notice.command && (
                    <button
                      type="button"
                      className="ib-lnk ib-cp-fcopy"
                      aria-label={`Copy the command to run on ${group.name}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void copy(g.notice!.command!, group.machine ?? '')}
                      data-compose-folder-copy=""
                    >
                      {copied === (group.machine ?? '') ? 'Copied' : 'Copy'}
                    </button>
                  )}
                </div>
              )}
              {g.projects.map((project) => {
                const i = at++;
                const folder = tildePath(project.root, gHome);
                const last = grouped && project.id === group.last;
                // Its drive isn't plugged in, or (a network drive) isn't answering: said after its name.
                const unplugged = project.exists ? null : unpluggedDrive(project.root, group.drives);
                const slowDrive = project.exists && project.slow ? (placeOf(project.root, group.drives ?? [])?.name ?? null) : null;
                // On a drive: "Studio SSD › footage-tools", not a path cut to "/Volu…".
                const onDrive = drivePathOf(project.root, group.drives);
                return (
                  <div
                    key={project.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={!unplugged && i === hl}
                    aria-disabled={unplugged ? 'true' : undefined}
                    aria-label={`${project.name}${last ? ', you started it here last' : ''}, ${folder}${on ? `, on ${on}` : ''}${unplugged ? `, ${unplugged} isn't connected. Connect it to start here.` : project.exists ? (slowDrive ? `, ${slowDrive} isn't responding` : '') : ', not there any more'}`}
                    className={`ib-cp-opt ib-cp-fopt${unplugged ? ' ib-cp-unplugged' : ''}${!unplugged && i === hl ? ' ib-hl' : ''}`}
                    data-compose-folder-option={project.id}
                    data-compose-folder-machine={group.machine ?? undefined}
                    data-missing={project.exists ? undefined : ''}
                    onPointerMove={() => !unplugged && i !== hl && setHlId(rowKey(group.machine, project.id))}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => !unplugged && onPick(project, group.machine)}
                  >
                    <Icon name="folder" size={15} />
                    {project.exists ? (
                      <span className="ib-cp-op" dir="auto">
                        {project.name}
                        {last && <span className="ib-cp-trust"> · you started it here last</span>}
                        {slowDrive && <span className="ib-cp-trust"> · {slowDrive} isn't responding</span>}
                      </span>
                    ) : unplugged ? (
                      <span className="ib-cp-op" dir="auto" data-compose-folder-unplugged={unplugged}>
                        <s>{project.name}</s>
                        <span className="ib-cp-trust">
                          {' '}
                          · {unplugged} isn't connected<span className="ib-cp-unplug-why">. Connect it to start here.</span>
                        </span>
                      </span>
                    ) : (
                      <s className="ib-cp-op" dir="auto">
                        {project.name}
                      </s>
                    )}
                    {unplugged ? <span className="ib-cp-of">Connect it to start here</span> : <FolderPath path={folder} drive={onDrive} />}
                    <span className="ib-cp-check" aria-hidden="true">
                      {project.id === selected && group.machine === selectedMachine && <Icon name="check" size={15} />}
                    </span>
                  </div>
                );
              })}
              {g.scratch &&
                (() => {
                  const i = at++;
                  const s = g.scratch;
                  return (
                    <>
                      {!grouped && g.projects.length > 0 && <div className="ib-cp-cap-line" role="presentation" />}
                      <div
                        id={optionId(i)}
                        role="option"
                        aria-selected={hl === i}
                        aria-label={`${s.trusted ? `New scratch folder, ${s.folder}` : `New scratch folder in ${s.root}. ${untrustedHint(s)}`}${on ? `, on ${on}` : ''}`}
                        className={`ib-cp-opt ib-cp-fopt ib-cp-scratch${hl === i ? ' ib-hl' : ''}`}
                        data-compose-folder-option={SCRATCH_PICK}
                        data-compose-folder-machine={group.machine ?? undefined}
                        data-untrusted={s.trusted ? undefined : ''}
                        onPointerMove={() => hl !== i && setHlId(rowKey(group.machine, SCRATCH_PICK))}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => onScratch?.(group.machine)}
                      >
                        <Icon name="folderPlus" size={15} />
                        <span className="ib-cp-op">
                          New scratch folder
                          {!s.trusted && <span className="ib-cp-trust"> · trust it once</span>}
                        </span>
                        <FolderPath path={s.trusted ? s.folder : s.root} />
                        <span className="ib-cp-check" aria-hidden="true">
                          {selected === SCRATCH_PICK && group.machine === selectedMachine && <Icon name="check" size={15} />}
                        </span>
                      </div>
                      {!s.trusted && (
                        <div className="ib-cp-scratch-hint" aria-hidden="true" data-compose-scratch-hint="">
                          {untrustedHint(s)}
                        </div>
                      )}
                    </>
                  );
                })()}
              {g.other &&
                (() => {
                  const i = at++;
                  const words = grouped ? `Another folder on ${group.name}…` : 'Another folder…';
                  return (
                    <>
                      {!grouped && !g.scratch && g.projects.length > 0 && <div className="ib-cp-cap-line" role="presentation" />}
                      <div
                        id={optionId(i)}
                        role="option"
                        aria-selected={hl === i}
                        aria-label={`${words.replace(/…$/, '')}${g.path ? `, ${g.path}` : ''}`}
                        className={`ib-cp-opt ib-cp-fopt ib-cp-other${hl === i ? ' ib-hl' : ''}`}
                        data-compose-folder-other={group.machine ?? 'self'}
                        onPointerMove={() => hl !== i && setHlId(rowKey(group.machine, OTHER_PICK))}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => openOther(group.machine)}
                      >
                        <Icon name="folder" size={15} />
                        <span className="ib-cp-op" dir="auto">
                          {words}
                        </span>
                        {g.path ? <FolderPath path={g.path} /> : <span />}
                        <span className="ib-cp-check" aria-hidden="true" />
                      </div>
                    </>
                  );
                })()}
              {g.drives.map((drive) => {
                const i = at++;
                return (
                  <div
                    key={drive.path}
                    id={optionId(i)}
                    role="option"
                    aria-selected={hl === i}
                    aria-label={`${drive.name}${drive.network ? ', network drive' : ''}, ${drive.path}${on ? `, on ${on}` : ''}`}
                    className={`ib-cp-opt ib-cp-fopt ib-cp-other ib-cp-drive${hl === i ? ' ib-hl' : ''}`}
                    data-compose-folder-drive={drive.path}
                    onPointerMove={() => hl !== i && setHlId(rowKey(group.machine, drivePick(drive)))}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => openDrive(group.machine, drive)}
                  >
                    <Icon name={drive.network ? 'globe' : 'drive'} size={15} />
                    <span className="ib-cp-op" dir="auto">
                      {drive.name}…{drive.network && <span className="ib-cp-trust"> · network drive</span>}
                    </span>
                    <FolderPath path={drive.path} />
                    <span className="ib-cp-check" aria-hidden="true" />
                  </div>
                );
              })}
              {g.clone &&
                (() => {
                  const i = at++;
                  const c = g.clone;
                  const r = repo!;
                  const place = `${c.path}${r.branch ? ` · ${r.branch}` : ''}`;
                  const picked = !!clonePicked && clonePicked.machine === group.machine && clonePicked.folder === c.path;
                  const machineName = grouped ? group.name : null;
                  const cant = `${machineName ?? 'This computer'} can't sign in to ${r.host}`;
                  const aria = c.already
                    ? `Start in ${c.name}, ${c.path}, already cloned${machineName ? `, on ${machineName}` : ''}`
                    : c.cantSignIn
                      ? `Clone ${r.slug}${machineName ? ` on ${machineName}` : ''}. ${cant}.`
                      : `Clone ${r.slug} and start, into ${c.path}${r.branch ? `, branch ${r.branch}` : ''}${machineName ? `, on ${machineName}` : ''}${c.taken ? `. ${c.taken} is another folder` : ''}${picked ? ', chosen' : ''}`;
                  return (
                    <div
                      id={optionId(i)}
                      role="option"
                      aria-selected={hl === i}
                      aria-label={aria}
                      className={`ib-cp-opt ib-cp-fopt ib-cp-clone${c.cantSignIn ? ' ib-cp-clone-cant' : ' ib-hfb-start'}${phone ? ' ib-hfb-two' : ''}${hl === i ? ' ib-hl' : ''}`}
                      data-compose-folder-clone={group.machine ?? 'self'}
                      data-clone-path={c.path}
                      data-clone-already={c.already ? '' : undefined}
                      data-clone-cant={c.cantSignIn ? '' : undefined}
                      onPointerMove={() => hl !== i && setHlId(rowKey(group.machine, CLONE_PICK))}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => pickClone(group, c)}
                    >
                      <Icon name={c.already ? 'check' : c.cantSignIn ? 'warn' : 'gitBranch'} size={15} />
                      <span className="ib-cp-op" dir="auto">
                        {c.already ? (
                          <>
                            Start in <b>{c.name}</b>
                            <span className="ib-cp-trust"> · already cloned</span>
                          </>
                        ) : c.cantSignIn ? (
                          <>Clone {r.repo}</>
                        ) : (
                          <>
                            Clone <b>{r.repo}</b> and start
                          </>
                        )}
                        {/* A phone hides the path column: the clone's place goes on a second line (G5). */}
                        {phone && <span className="ib-hfb-sub">{c.cantSignIn ? cant : place}</span>}
                      </span>
                      <FolderPath path={c.cantSignIn ? cant : place} />
                      <span className="ib-cp-check" aria-hidden="true">
                        {picked && <Icon name="check" size={15} />}
                      </span>
                    </div>
                  );
                })()}
              {g.cloneOther &&
                (() => {
                  const i = at++;
                  return (
                    <div
                      id={optionId(i)}
                      role="option"
                      aria-selected={hl === i}
                      aria-label={grouped ? `Clone into another folder on ${group.name}` : 'Clone into another folder'}
                      className={`ib-cp-opt ib-cp-fopt ib-cp-other${hl === i ? ' ib-hl' : ''}`}
                      data-compose-folder-clone-other={group.machine ?? 'self'}
                      onPointerMove={() => hl !== i && setHlId(rowKey(group.machine, CLONE_OTHER_PICK))}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => openCloneOther(group)}
                    >
                      <Icon name="folder" size={15} />
                      <span className="ib-cp-op">Clone into another folder…</span>
                      <span />
                      <span className="ib-cp-check" aria-hidden="true" />
                    </div>
                  );
                })()}
            </Fragment>
          );
        })}
        {checking && (
          <div className="ib-cp-none ib-cp-checking" role="status" data-compose-clone-note="checking">
            <span className="ib-run-spin" aria-hidden="true" />
            {checking}
          </div>
        )}
        {gitLine && (
          <div className="ib-cp-none" role="status" data-compose-clone-note="line">
            {gitLine}
          </div>
        )}
        {repoShown && rows.some((row) => row.kind === 'clone') && (
          <>
            <div className="ib-cp-cap-line" role="presentation" />
            <div className="ib-cp-explain" data-compose-clone-explain="">
              Cloned with that machine's own git sign-in, into the folder where its other projects live.{agentName ? ` ${agentName} starts when the clone is done.` : ''}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Under an untrusted "New scratch folder" row: what "trust it once" asks of the person. */
function untrustedHint(scratch: { root: string; agentName: string }): string {
  return `${scratch.agentName} doesn't trust ${scratch.root} yet. Your first Send asks you to trust it once; after that every scratch folder there starts.`;
}
