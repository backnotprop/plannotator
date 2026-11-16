/**
 * Editing a plan and approving it, on its page (approval "plans-editing", .product/approved/plans-editing/approval.md):
 * - Only the newest version of a Markdown page can be edited: Edit, in the reading line's start, opens the shared
 *   Markdown editor (PlanEditor.tsx, loaded then) on its text, with Done and Cancel. Never a diagram or an HTML page.
 * - Done makes a new newest version, the person's (`POST /api/plans/:id/versions`, `source: "person"`), and the agent
 *   is sent what changed, plan review's "# Direct Edits" (deliver.ts: the plan's thread, else New message to the
 *   agent live in the plan's project, else the page says no agent is running there). Nothing changed (line endings
 *   aside): no version. A newer version came while the person was editing: nothing is written, the newest shows, and
 *   their text is kept here to copy or edit again.
 * - An open edit and a kept text live in the tab's sessionStorage per plan and page (`planEditKey`), so another page,
 *   a read that failed or a reload brings them back. Typing is written a moment after it pauses (`EDIT_KEEP_MS`), and
 *   at once when the editor loses focus, the page is hidden or left, and before Done.
 * - An older version cannot be edited: it is read, compared, or Restored (the reading line's restore slot), which
 *   makes a new newest version holding its text, sent to the agent the same way.
 * - Approve names the version on screen and is refused once a newer one came (the newest then shows). An approval
 *   belongs to the current version only: the reading line says "Approved by you" on it, and on a new version that
 *   holds none, "v4 is new and not approved. You approved v3, and that does not carry over."; when the person's own
 *   edit carried their approval, "Your approval moved to v4." until the next version or its Dismiss.
 * No keyboard shortcut (one for Edit needs the owner).
 */
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import type { MarkdownEditorHandle } from '@plannotator/ui/components/MarkdownEditor';
import { planApprovalState, planTextLines, type PlanApprovalState, type PlanDocument, type PlanVersion } from '@plannotator/core/plans';
import { storage } from '@plannotator/ui/utils/storage';
import { FrameButton } from '@plannotator/ui/components/frame';
import { InboxApiError } from '../apiError';
import { Icon } from '../icons';
import { plansApi, type PlanRead } from './client';
import { deliverToPlanAgent, noAgentWords, planAgentNow } from './deliver';
import { approvalClearedLine, approvalMovedLine, approverList } from './words';

const PlanEditor = lazy(() => import('./PlanEditor'));

/** The moved approval's line the person dismissed, per plan and page: the version it was about. */
export const planMovedDismissedKey = (plan: string, doc: string) => `plannotator-inbox-plan-moved-dismissed-${plan}-${doc}`;

/** An open edit, or the text a newer version kept from being saved (`kept`), per plan and page, in the tab's sessionStorage. */
export const planEditKey = (plan: string, doc: string) => `plannotator-inbox-plan-edit-${plan}-${doc}`;
interface KeptEdit {
  base: number;
  text: string;
  kept?: true;
}
function readKeptEdit(key: string): KeptEdit | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(key) ?? 'null') as KeptEdit | null;
    return value && typeof value.base === 'number' && typeof value.text === 'string' ? value : null;
  } catch {
    return null;
  }
}
/** How long typing pauses before the open edit's text is written to sessionStorage. */
const EDIT_KEEP_MS = 400;
function keepEdit(key: string, value: KeptEdit | null): void {
  try {
    if (value) window.sessionStorage.setItem(key, JSON.stringify(value));
    else window.sessionStorage.removeItem(key);
  } catch {
    // A full or closed storage only means the text is not kept past this page.
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const codeOf = (error: unknown) => (error instanceof InboxApiError ? error.code : null);

/** "Approved by you", "Approved by you and Dana, with notes": the frame's words for an approval, on the newest version. */
export function approvedByLine(state: Extract<PlanApprovalState, { kind: 'approved' }>): string {
  const who = approverList(state.names);
  return `Approved by ${who.startsWith('You') ? `you${who.slice(3)}` : who}${state.notes ? ', with notes' : ''}`;
}

interface Notice {
  kind: 'saved' | 'unchanged' | 'refused';
  alert: boolean;
  words: string;
}

export interface PlanEditing {
  /** The editor is open. */
  editing: boolean;
  /** The reading line's start: Edit and Approve, or Done and Cancel while editing. */
  start: ReactNode;
  /** The reading line's approval slot (the newest version only). */
  approved: ReactNode;
  /** The older version's Restore (the reading line's restore slot). */
  restore: ReactNode;
  /** What the last edit, Restore or Approve did, or the text a newer version kept from being saved. */
  banner: ReactNode;
  /** A newer version kept the person's text from being saved: its banner carries "Show changes", so the page's own does not show. */
  kept: boolean;
  /** The editor, in the page's place, while editing. */
  editor: ReactNode;
}

export function usePlanEditing(p: { read: PlanRead; document: PlanDocument; docRef: string | null; versions: readonly PlanVersion[]; head: number; shown: number; comparing: boolean; onChanged: () => void; toNewest: () => void; showChanges: (from: number, to: number) => void }): PlanEditing {
  const { read, document, docRef, versions, head, shown, comparing, onChanged, toNewest, showChanges } = p;
  const id = read.plan.id;
  const project = read.plan.project_name;
  const editKey = planEditKey(id, document.id);
  const [editing, setEditingNow] = useState<{ base: number; original: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** The person's text a newer version kept from being saved, and the version they had edited. */
  const [kept, setKept] = useState<{ text: string; base: number } | null>(null);
  const typed = useRef('');
  const handle = useRef<MarkdownEditorHandle | null>(null);
  /** The typed text not written yet (written `EDIT_KEEP_MS` after typing pauses, or by `flushTyped`). */
  const pending = useRef<{ key: string; value: KeptEdit; timer: ReturnType<typeof setTimeout> } | null>(null);
  const dropTyped = () => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
  };
  const flushTyped = () => {
    const due = pending.current;
    dropTyped();
    if (due) keepEdit(due.key, due.value);
  };
  const keepTyped = (value: KeptEdit) => {
    dropTyped();
    pending.current = { key: editKey, value, timer: setTimeout(flushTyped, EDIT_KEEP_MS) };
  };
  // The page hidden, left, closed or turned to another page of the plan: the typed text is written now.
  useEffect(() => {
    const onHide = () => flushTyped();
    const onVisibility = () => {
      if (window.document.visibilityState === 'hidden') flushTyped();
    };
    window.addEventListener('pagehide', onHide);
    window.document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.document.removeEventListener('visibilitychange', onVisibility);
      flushTyped();
    };
    // The handlers read refs only; a new page writes the last one's text first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editKey]);
  const setEditing = (next: { base: number; original: string; text: string } | null) => {
    dropTyped();
    setEditingNow(next);
    keepEdit(editKey, next ? { base: next.base, text: next.text } : null);
  };
  const keep = (next: { text: string; base: number } | null) => {
    dropTyped();
    setKept(next);
    keepEdit(editKey, next ? { ...next, kept: true } : null);
  };
  // Back on this page: the open edit comes back on the newest (its version still the newest), else as kept text.
  useEffect(() => {
    const saved = readKeptEdit(editKey);
    if (!saved || document.kind !== 'markdown') return;
    if (saved.kept || saved.base !== head) {
      keep({ text: saved.text, base: saved.base });
      return;
    }
    let live = true;
    plansApi.version(id, saved.base, docRef).then(
      (original) => {
        if (!live) return;
        typed.current = saved.text;
        if (shown !== head || comparing) toNewest();
        setEditing({ base: saved.base, original, text: saved.text });
      },
      () => live && keep({ text: saved.text, base: saved.base }),
    );
    return () => {
      live = false;
    };
    // Once per page: the edit kept for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editKey]);
  const movedKey = planMovedDismissedKey(id, document.id);
  const [dismissed, setDismissed] = useState(() => storage.getItem(movedKey));
  const approval = planApprovalState(read.events, document.id, head, { cleared: read.plan.last_approval_cleared, moved: read.plan.last_approval_moved });
  const onNewest = !comparing && shown === head;

  /** Send the agent what changed (to the agent found now), and say how it went after `lead` ("Saved as v5."). */
  const tell = async (lead: string, words: string, told: number) => {
    // The agent already holds this text (a Restore of what it last knew): nothing to send.
    if (!words) {
      setNotice({ kind: 'saved', alert: false, words: `${lead} The agent already has this text, so nothing was sent.` });
      return;
    }
    const agent = await planAgentNow(read.plan, versions);
    const label = agent.kind === 'none' ? 'the agent' : agent.label;
    try {
      const how = await deliverToPlanAgent({ plan: read.plan, agent, words, comments: [], told: { doc: document.id, version: told }, onSent: onChanged });
      const after =
        how === 'replied' ? `${label.charAt(0).toUpperCase()}${label.slice(1)} was sent what changed.`
        : how === 'held' ? `It goes to ${label} when that machine is back.`
        : how === 'composing' ? (agent.kind === 'pick' ? 'What changed is in New message: choose the agent there.' : `What changed is in New message to ${label}: send it there.`)
        : `${noAgentWords(project)}, so the agent was not told.`;
      setNotice({ kind: 'saved', alert: false, words: `${lead} ${after}` });
    } catch (error) {
      setNotice({ kind: 'saved', alert: true, words: `${lead} It could not be sent to ${label}: ${messageOf(error)}` });
    }
  };

  const edit = async (text: string | null) => {
    if (busy) return;
    setNotice(null);
    setBusy(true);
    try {
      const original = await plansApi.version(id, head, docRef);
      typed.current = text ?? original;
      // From the kept text's banner the page may be showing changes: the editor is on the newest.
      if (comparing) toNewest();
      setKept(null);
      setEditing({ base: head, original, text: text ?? original });
    } catch (error) {
      setNotice({ kind: 'refused', alert: true, words: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const done = async () => {
    if (!editing || busy) return;
    // A Done that fails still finds the text kept.
    flushTyped();
    const text = handle.current?.getMarkdown() ?? typed.current;
    const unchanged: Notice = { kind: 'unchanged', alert: false, words: 'Nothing changed, so no new version was made.' };
    // Line endings are not a change (the editor gives `\r\n` back as `\n`).
    if (planTextLines(text) === planTextLines(editing.original)) {
      setEditing(null);
      setNotice(unchanged);
      return;
    }
    setBusy(true);
    try {
      const saved = await plansApi.saveVersion(id, editing.base, { text }, docRef);
      setEditing(null);
      toNewest();
      onChanged();
      await tell(`Saved as v${saved.version.version_number}.`, saved.direct_edits, saved.version.version_number);
    } catch (error) {
      if (codeOf(error) === 'moved_on') {
        // Nothing is written over unseen: the newest shows, and the person's words wait here.
        setEditingNow(null);
        keep({ text, base: editing.base });
        setNotice(null);
        toNewest();
        onChanged();
      } else if (codeOf(error) === 'unchanged') {
        setEditing(null);
        setNotice(unchanged);
      } else {
        setNotice({ kind: 'refused', alert: true, words: messageOf(error) });
      }
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (busy) return;
    const from = shown;
    setNotice(null);
    setBusy(true);
    try {
      const saved = await plansApi.saveVersion(id, head, { restore: from }, docRef);
      toNewest();
      onChanged();
      await tell(`Restored v${from} as v${saved.version.version_number}.`, saved.direct_edits, saved.version.version_number);
    } catch (error) {
      if (codeOf(error) === 'moved_on') onChanged();
      setNotice({ kind: 'refused', alert: true, words: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (busy) return;
    setNotice(null);
    setBusy(true);
    try {
      await plansApi.approve(id, shown, docRef);
      onChanged();
    } catch (error) {
      if (codeOf(error) === 'moved_on') {
        toNewest();
        onChanged();
      }
      setNotice({ kind: 'refused', alert: true, words: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const canEdit = document.kind === 'markdown' && onNewest;
  const start = editing ? (
    <>
      <FrameButton size="xs" onClick={() => void done()} disabled={busy} data-plan-edit-done="">
        Done
      </FrameButton>
      <FrameButton variant="ghost" size="xs" onClick={() => setEditing(null)} disabled={busy} data-plan-edit-cancel="">
        Cancel
      </FrameButton>
    </>
  ) : canEdit || (onNewest && approval.kind !== 'approved') ? (
    <>
      {canEdit && (
        <FrameButton variant="outline" size="xs" onClick={() => void edit(null)} disabled={busy} data-plan-edit="">
          Edit
        </FrameButton>
      )}
      {onNewest && approval.kind !== 'approved' && (
        <FrameButton variant="outline" size="xs" onClick={() => void approve()} disabled={busy} data-plan-approve="">
          Approve
        </FrameButton>
      )}
    </>
  ) : null;

  let approved: ReactNode = null;
  if (onNewest && !editing) {
    if (approval.kind === 'approved') {
      const moved = approval.moved && dismissed !== String(approval.moved.version_number) ? approval.moved : null;
      approved = (
        <span className="ib-plan-approval" data-plan-approval={moved ? 'moved' : 'approved'}>
          <Icon name="check" />
          <span>{moved ? approvalMovedLine(moved) : approvedByLine(approval)}</span>
          {moved && (
            <button
              type="button"
              className="ib-plans-quiet ib-plan-approval-x"
              aria-label="Dismiss"
              onClick={() => {
                storage.setItem(movedKey, String(moved.version_number));
                setDismissed(String(moved.version_number));
              }}
              data-plan-approval-dismiss=""
            >
              <Icon name="x" />
            </button>
          )}
        </span>
      );
    } else if (approval.kind === 'cleared') {
      approved = (
        <span className="ib-plan-approval" data-plan-approval="cleared">
          <span>{approvalClearedLine(approval)}</span>
        </span>
      );
    }
  }

  const restoreButton =
    !comparing && shown !== head && !editing ? (
      <FrameButton variant="outline" size="xs" onClick={() => void restore()} disabled={busy} data-plan-restore="">
        Restore v{shown}
      </FrameButton>
    ) : null;

  const banner =
    kept !== null ? (
      <div className="ib-plan-banner" data-plan-banner="stale" role="alert">
        <Icon name="warn" />
        <p>
          <b>v{head} came while you were editing,</b> so your edit was not saved. Your text is kept here.
        </p>
        {!comparing && kept.base < head && (
          <button type="button" className="ib-plans-quiet" onClick={() => showChanges(kept.base, head)} data-plan-show-changes="">
            Show changes
          </button>
        )}
        <button type="button" className="ib-plans-quiet" onClick={() => void navigator.clipboard?.writeText(kept.text).catch(() => {})} data-plan-kept-copy="">
          Copy your text
        </button>
        {document.kind === 'markdown' && (
          <button type="button" className="ib-plans-soft" onClick={() => void edit(kept.text)} data-plan-kept-edit="">
            Edit v{head} with your text
          </button>
        )}
        <button type="button" className="ib-plans-quiet" onClick={() => keep(null)} data-plan-kept-discard="">
          Discard your text
        </button>
      </div>
    ) : notice ? (
      <div className="ib-plan-banner" data-plan-banner={notice.kind} role={notice.alert ? 'alert' : 'status'}>
        <Icon name={notice.alert ? 'warn' : 'check'} />
        <p>{notice.words}</p>
        <button type="button" className="ib-plans-quiet ib-plan-approval-x" aria-label="Dismiss" onClick={() => setNotice(null)} data-plan-notice-dismiss="">
          <Icon name="x" />
        </button>
      </div>
    ) : null;

  const editor = editing ? (
    <Suspense
      fallback={
        <div className="ib-plan-docstate" role="status" aria-busy="true">
          <p>Opening the editor…</p>
        </div>
      }
    >
      <PlanEditor
        text={editing.text}
        documentId={`plan-edit:${id}:${document.id}:${editing.base}`}
        handle={handle}
        onChange={(markdown) => {
          typed.current = markdown;
          keepTyped({ base: editing.base, text: markdown });
        }}
        onBlur={flushTyped}
      />
    </Suspense>
  ) : null;

  return { editing: editing !== null, start, approved, restore: restoreButton, banner, kept: kept !== null, editor };
}
