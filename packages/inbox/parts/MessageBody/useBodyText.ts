/** MessageBody's text (parts/MessageBody/MessageBody.tsx). */
import { useCallback, useMemo, useRef } from 'react';
import { inboxNoteBlocks } from '@plannotator/core/inbox-context-notes';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { withoutInboxActionsSection } from '@plannotator/core/inbox-actions';
import { withoutInboxReplyQuoteLead } from '@plannotator/core/inbox-reply-quote';
import { linkInboxThreadMentions } from '@plannotator/core/inbox-thread-mention';
import { linkReplyFeedback } from '../../replyFileLinks';
import { splitReplyFeedback, withoutElementDetails } from '../../replyFeedback';
import { sentReplyParts } from '../../sentReply';
import { splitInboxSkillsBlock } from '@plannotator/core/skill-reference-block';
import { splitPullThreadDetails } from '../../pulls/threadDetails';
import { linkHashtags, useLiveInitiatives } from '../../hashtags';
import type { MessageBodyProps } from './types';

/** The body's text as drawn: the person's own words apart from what a Send added, links, notes and the parsed blocks. */
export function useBodyText({ message, sentActions, sentAnswers, replyFiles, projectRoot, contextNotes }: Pick<MessageBodyProps, 'message' | 'sentActions' | 'sentAnswers' | 'replyFiles' | 'projectRoot' | 'contextNotes'>) {
  // A person's message ends with the skills block the window pasted when it
  // was sent: folded behind one quiet line (SkillsLine). An agent's message
  // is shown whole, whatever it says.
  const skills = useMemo(() => (message.author.kind === 'person' ? splitInboxSkillsBlock(message.body) : null), [message.author.kind, message.body]);
  // A thread started from a PR's page: the PR's details that went after the person's words fold into one line too
  // (`PullDetailsLine`).
  const pullDetails = useMemo(() => (message.author.kind === 'person' ? splitPullThreadDetails(skills ? skills.before : message.body) : null), [message.author.kind, message.body, skills]);
  const actionsSent = (sentActions?.length ?? 0) > 0;
  const sent = useMemo(() => {
    const raw = pullDetails ? pullDetails.words : skills ? skills.before : message.body;
    const unquoted = message.author.kind === 'person' && message.quote ? withoutInboxReplyQuoteLead(raw) : raw;
    // A mentioned thread is a link to it; the list the agent reads after the words is left out (inbox-thread-mention.ts).
    const words = message.author.kind === 'person' ? linkInboxThreadMentions(unquoted) : unquoted;
    return actionsSent ? withoutInboxActionsSection(words) : words;
  }, [skills, pullDetails, message.body, message.author.kind, message.quote, actionsSent]);
  const replyParts = useMemo(() => sentReplyParts(message, sent, sentAnswers ?? []), [message, sent, sentAnswers]);
  // The files the reply's feedback names, as links (display only; replyFileLinks.ts).
  // Only the person's own message: an agent's text is drawn as it wrote it, whatever its headings say.
  const ownReply = message.author.kind === 'person';
  const replyFileList = ownReply ? replyFiles?.files : undefined;
  const replyPeople = ownReply ? replyFiles?.personMessageIds : undefined;
  // `#Shape` naming a live initiative links to the Board filtered to it (approval "board-hashtags"; display only).
  const { initiatives: tagInitiatives, href: tagHref } = useLiveInitiatives();
  // A pin on an HTML page: its outline and selector lines are the agent's; the person's own reply is drawn without them
  // (replyFeedback.ts `withoutElementDetails`; display only).
  const linkFiles = useCallback(
    (text: string) => {
      const shownText = ownReply ? withoutElementDetails(text) : text;
      return linkHashtags(
        replyFileList && replyPeople
          ? linkReplyFeedback(shownText, { files: replyFileList, projectRoot, personMessageIds: replyPeople, replyAt: message.created_at })
          : shownText,
        tagInitiatives,
        tagHref,
      );
    },
    [ownReply, replyFileList, replyPeople, projectRoot, message.created_at, tagInitiatives, tagHref],
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
  return { skills, pullDetails: pullDetails?.details ?? null, actionsSent, replyParts, ownReply, replyFileList, shown, noteBlocks, noteAtLine, notesRef, restShown, feedbackShown, blocks, restBlocks, feedbackBlocks };
}
