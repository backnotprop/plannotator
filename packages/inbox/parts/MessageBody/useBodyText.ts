/** MessageBody's text (parts/MessageBody/MessageBody.tsx). */
import { useCallback, useMemo, useRef } from 'react';
import { inboxNoteBlocks } from '@plannotator/core/inbox-context-notes';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { withoutInboxActionsSection } from '@plannotator/core/inbox-actions';
import { withoutInboxReplyQuoteLead } from '@plannotator/core/inbox-reply-quote';
import { linkReplyFeedback } from '../../replyFileLinks';
import { splitReplyFeedback } from '../../replyFeedback';
import { sentReplyParts } from '../../sentReply';
import { splitInboxSkillsBlock } from '@plannotator/core/skill-reference-block';
import { linkHashtags, useLiveInitiatives } from '../../hashtags';
import type { MessageBodyProps } from './types';

/** The body's text as drawn: the person's own words apart from what a Send added, links, notes and the parsed blocks. */
export function useBodyText({ message, sentActions, sentAnswers, replyFiles, projectRoot, contextNotes }: Pick<MessageBodyProps, 'message' | 'sentActions' | 'sentAnswers' | 'replyFiles' | 'projectRoot' | 'contextNotes'>) {
  // A person's message ends with the skills block the window pasted when it
  // was sent: folded behind one quiet line (SkillsLine). An agent's message
  // is shown whole, whatever it says.
  const skills = useMemo(() => (message.author.kind === 'person' ? splitInboxSkillsBlock(message.body) : null), [message.author.kind, message.body]);
  const actionsSent = (sentActions?.length ?? 0) > 0;
  const sent = useMemo(() => {
    const raw = skills ? skills.before : message.body;
    const words = message.author.kind === 'person' && message.quote ? withoutInboxReplyQuoteLead(raw) : raw;
    return actionsSent ? withoutInboxActionsSection(words) : words;
  }, [skills, message.body, message.author.kind, message.quote, actionsSent]);
  const replyParts = useMemo(() => sentReplyParts(message, sent, sentAnswers ?? []), [message, sent, sentAnswers]);
  // The files the reply's feedback names, as links (display only; replyFileLinks.ts).
  // Only the person's own message: an agent's text is drawn as it wrote it, whatever its headings say.
  const ownReply = message.author.kind === 'person';
  const replyFileList = ownReply ? replyFiles?.files : undefined;
  const replyPeople = ownReply ? replyFiles?.personMessageIds : undefined;
  // `#Shape` naming a live initiative links to the Board filtered to it (approval "board-hashtags"; display only).
  const tagInitiatives = useLiveInitiatives();
  const linkFiles = useCallback(
    (text: string) =>
      linkHashtags(
        replyFileList && replyPeople
          ? linkReplyFeedback(text, { files: replyFileList, projectRoot, personMessageIds: replyPeople, replyAt: message.created_at })
          : text,
        tagInitiatives,
      ),
    [replyFileList, replyPeople, projectRoot, message.created_at, tagInitiatives],
  );
  // The feedback the Send wrote after the person's words ("# Feedback on the attached files"…): a block of
  // its own, its headings at text size (replyFeedback.ts; display only). The person's own message only.
  const wordsText = replyParts ? replyParts.words : sent;
  const restText = replyParts ? replyParts.rest : '';
  const feedback = useMemo(() => (ownReply ? splitReplyFeedback(replyParts ? restText : wordsText) : null), [ownReply, replyParts, restText, wordsText]);
  const linked = useMemo(() => linkFiles(feedback && !replyParts ? feedback.words : wordsText), [linkFiles, feedback, replyParts, wordsText]);
  // An agent's `:::note path#L…` blocks: the opening line becomes a plain `:::note` (the same lines, so every other
  // block keeps its place) and the block draws as the note's chip and words (`directiveBlock`).
  const noteBlocks = useMemo(() => (contextNotes && message.author.kind === 'agent' ? inboxNoteBlocks(linked) : []), [contextNotes !== undefined, message.author.kind, linked]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => {
    if (noteBlocks.length === 0) return linked;
    const lines = linked.split('\n');
    for (const note of noteBlocks) lines[note.from] = ':::note';
    return lines.join('\n');
  }, [linked, noteBlocks]);
  const noteAtLine = useMemo(() => new Map(noteBlocks.map((note) => [note.from + 1, note] as const)), [noteBlocks]);
  const notesRef = useRef(contextNotes);
  notesRef.current = contextNotes;
  const restShown = useMemo(() => (replyParts ? linkFiles(feedback ? feedback.words : restText) : ''), [linkFiles, feedback, replyParts, restText]);
  const feedbackShown = useMemo(() => (feedback ? linkFiles(feedback.feedback) : ''), [linkFiles, feedback]);
  const blocks = useMemo(() => parseMarkdownToBlocks(shown, { frontmatter: false, keepBlankLines: ownReply }), [shown, ownReply]);
  const restBlocks = useMemo(() => (restShown ? parseMarkdownToBlocks(restShown, { frontmatter: false, keepBlankLines: ownReply }) : []), [restShown, ownReply]);
  const feedbackBlocks = useMemo(() => (feedbackShown ? parseMarkdownToBlocks(feedbackShown, { frontmatter: false, keepBlankLines: ownReply }) : []), [feedbackShown, ownReply]);
  return { skills, actionsSent, replyParts, ownReply, replyFileList, shown, noteBlocks, noteAtLine, notesRef, restShown, feedbackShown, blocks, restBlocks, feedbackBlocks };
}
