/**
 * The notes of one review in a thread (the Inbox's code review): the guide's
 * own and the thread agent's `:::note` blocks, each where it lands in this
 * review's diff (model.ts).
 * Earlier reviews' files are read once, only when a note was written on one.
 */
import { useEffect, useMemo, useState } from 'react';
import { parseDiffToFiles } from '@plannotator/core/diff-files';
import { parseGuideSnapshot, type GuideSnapshot } from '@plannotator/core/guide-format';
import { inboxNoteBlocks } from '@plannotator/core/inbox-context-notes';
import { inboxReviewRound } from '@plannotator/core/inbox-review';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { agentName } from '../format';
import { guideNotes, orderNotes, reviewDrawnOn, threadNotes, type ContextNote, type NoteFile } from './model';

/** Each earlier review's files, read once (an empty list when it can't be read: it anchors nothing). */
function useReviewFiles(ids: readonly string[]): Record<string, NoteFile[]> {
  const [read, setRead] = useState<Record<string, NoteFile[]>>({});
  const key = [...new Set(ids)].sort().join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    for (const id of key.split(',')) {
      if (read[id]) continue;
      inboxApi.guide(id).then(
        (answer) => {
          const parsed = parseGuideSnapshot(answer.snapshot);
          if (live) setRead((was) => ({ ...was, [id]: parsed.ok ? parseDiffToFiles(parsed.value.review.rawPatch) : [] }));
        },
        () => {
          if (live) setRead((was) => ({ ...was, [id]: [] }));
        },
      );
    }
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return read;
}

export function useReviewNotes(input: {
  /** Off (a resolved thread's reader, Code review's pane not on screen): no note is worked out. */
  enabled: boolean;
  messages: readonly InboxMessageWire[];
  message: InboxMessageWire;
  snapshot: GuideSnapshot | null;
  files: readonly NoteFile[];
}): ContextNote[] {
  const { enabled, messages, message, snapshot, files } = input;
  const at = messages.findIndex((m) => m.id === message.id);
  // Earlier reviews a note was written on: their files tell where its lines are now.
  const notedOn = useMemo(() => {
    if (!enabled) return [];
    const out: string[] = [];
    for (const m of messages) {
      if (m.author.kind !== 'agent' || !m.body?.includes(':::note') || inboxNoteBlocks(m.body).length === 0) continue;
      const drawnOn = reviewDrawnOn(m.id, messages, m.created_at);
      const drawnAt = drawnOn ? messages.findIndex((x) => x.id === drawnOn) : -1;
      if (drawnOn && drawnAt >= 0 && drawnAt < at) out.push(drawnOn);
    }
    return out;
  }, [enabled, messages, at]);
  const earlier = useReviewFiles(enabled ? notedOn : []);

  return useMemo(() => {
    if (!enabled || !snapshot) return [];
    const author = agentName(message.author);
    const guide = guideNotes(snapshot, files, author);
    const thread = threadNotes({
      messages,
      reviewId: message.id,
      files,
      agent: (m) => agentName((m as InboxMessageWire).author),
      round: (id) => inboxReviewRound(messages, id),
      earlier: (id) => earlier[id],
    });
    return orderNotes([...guide, ...thread], files);
  }, [enabled, snapshot, files, messages, message, earlier]);
}
