import { useEffect, useMemo, useState } from 'react';
import { parseDiffToFiles } from '@plannotator/core/diff-files';
import { parseGuideSnapshot, type GuideSnapshot } from '@plannotator/core/guide-format';
import { inboxNoteBlocks } from '@plannotator/core/inbox-context-notes';
import { inboxReviewRound } from '@plannotator/core/inbox-review';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { parseShapeCodeTarget, type ShapeVersion } from '@plannotator/core/shape';
import { inboxApi } from '../api';
import { agentName } from '../format';
import { anchorLines, partLanding, partName, reviewDrawnOn, reviewLines } from '../review-drawing/showMeModel';
import { guideNotes, orderNotes, pictureNotes, threadNotes, type ContextNote, type NoteFile, type PicturePart } from './model';

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
  }, [key]);
  return read;
}

export function codeParts(html: string): { code: string; name: string; words: string }[] {
  if (typeof DOMParser === 'undefined' || !html.includes('data-code')) return [];
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return [...doc.querySelectorAll('[data-code]')].map((el) => {
    const name = partName(el);
    const pieces: string[] = [];
    const walk = doc.createTreeWalker(el, 4);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) pieces.push(text);
    }
    const all = pieces.join(' ');
    const rest = all.startsWith(name.replace(/…$/, '')) ? all.slice(name.replace(/…$/, '').length).trim() : all;
    return { code: el.getAttribute('data-code') ?? '', name, words: rest.replace(/^[·:,.\-–—\s]+/, '') };
  });
}

function useBoards(ids: readonly string[], subscribe: (listener: (ids: string[]) => void) => () => void): Record<string, { title: string; version: ShapeVersion; agent: string }> {
  const [boards, setBoards] = useState<Record<string, { title: string; version: ShapeVersion; agent: string }>>({});
  const key = [...new Set(ids)].sort().join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    const wanted = key.split(',');
    const read = (id: string) =>
      inboxApi.shape(id).then(
        (loaded) => {
          if (live) setBoards((was) => ({ ...was, [id]: { title: loaded.shape.title, version: loaded.version, agent: loaded.session.agent } }));
        },
        () => {},
      );
    wanted.forEach(read);
    const stop = subscribe((changed) => {
      for (const id of wanted) if (changed.length === 0 || changed.includes(id)) void read(id);
    });
    return () => {
      live = false;
      stop();
    };
  }, [key, subscribe]);
  return boards;
}

export function useReviewNotes(input: {
  enabled: boolean;
  messages: readonly InboxMessageWire[];
  message: InboxMessageWire;
  snapshot: GuideSnapshot | null;
  files: readonly NoteFile[];
  boards: readonly string[];
  askedOn: (board: string) => string | undefined;
  subscribeBoards: (listener: (ids: string[]) => void) => () => void;
}): ContextNote[] {
  const { enabled, messages, message, snapshot, files, boards } = input;
  const at = messages.findIndex((m) => m.id === message.id);
  const notedOn = useMemo(() => {
    if (!enabled) return [];
    const out: string[] = [];
    for (const m of messages) {
      if (m.author.kind !== 'agent' || !m.body?.includes(':::note') || inboxNoteBlocks(m.body).length === 0) continue;
      const drawnOn = reviewDrawnOn(m.id, messages, undefined, m.created_at);
      const drawnAt = drawnOn ? messages.findIndex((x) => x.id === drawnOn) : -1;
      if (drawnOn && drawnAt >= 0 && drawnAt < at) out.push(drawnOn);
    }
    return out;
  }, [enabled, messages, at]);
  const loaded = useBoards(enabled ? boards : [], input.subscribeBoards);
  const boardReviews = useMemo(() => {
    const out: string[] = [];
    for (const [id, board] of Object.entries(loaded)) {
      const drawnOn = reviewDrawnOn(board.version.through, messages, input.askedOn(id), board.version.at);
      if (drawnOn && drawnOn !== message.id) out.push(drawnOn);
    }
    return out;
  }, [loaded, messages, message.id]);
  const earlier = useReviewFiles(enabled ? [...notedOn, ...boardReviews] : []);

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
    const now = reviewLines(files);
    const parts: PicturePart[] = [];
    for (const [id, board] of Object.entries(loaded)) {
      const drawnOn = reviewDrawnOn(board.version.through, messages, input.askedOn(id), board.version.at);
      const views = board.version.views;
      const html = [views.picture, views.how].flatMap((view) => (view ? [view.html, view.tall?.html ?? '', view.more?.html ?? ''] : []));
      for (const part of html.flatMap(codeParts)) {
        const target = parseShapeCodeTarget(part.code);
        if (!target) continue;
        const earlierFiles = drawnOn && drawnOn !== message.id ? earlier[drawnOn] : undefined;
        const landing = partLanding(target, now, drawnOn === message.id ? undefined : drawnOn ? { lines: earlierFiles ? reviewLines(earlierFiles) : undefined } : null);
        if (!Array.isArray(landing)) continue;
        const was: [number, number] = [target.line, target.lineEnd ?? target.line];
        const changed = earlierFiles && drawnOn && !anchorLines(was, reviewLines(earlierFiles).get(target.path), now.get(target.path));
        parts.push({
          board: id,
          title: board.title,
          part: part.name,
          words: part.words,
          lines: landing,
          path: target.path,
          agent: board.agent,
          ...(changed ? { stale: { round: inboxReviewRound(messages, drawnOn), lines: was } } : {}),
        });
      }
    }
    return orderNotes([...guide, ...thread, ...pictureNotes(parts, files)], files);
  }, [enabled, snapshot, files, messages, message, earlier, loaded]);
}
