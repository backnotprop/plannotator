import type { Annotation } from '@plannotator/ui/types';
import type { InboxAttachmentState, InboxMessageWire, InboxProjectRepo, InboxQuestion } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { actionForBlock } from '../actions';
import { ActionChecklist } from '../components/ActionChecklist';
import { ReplacedQuestionCard, ReplacesLine, type Replacement } from '../components/ReplacedQuestion';
import type { ActionRow } from '../components/ReplyAnswers';
import type { SentAnswerGroup } from '../sentReply';
import { MessageBody } from './MessageBody/MessageBody';
import type { MessageActsRef } from './messageActs';

export type MessageBodyData = {
  message: InboxMessageWire;
  answers: ReadonlyMap<string, QuestionAnswer>;
  footers: readonly (string | null)[];
  replaced: readonly (readonly [Replacement | null, QuestionAnswer | null | undefined, InboxQuestion[]])[];
  readOnly: boolean;
  live: boolean;
  sentAnswers: readonly SentAnswerGroup[] | undefined;
  sentActions: readonly ActionRow[] | undefined;
  files: readonly InboxAttachmentState[] | null;
  personMessageIds: ReadonlySet<string> | null;
  root: string;
  repo: InboxProjectRepo | null;
  codeReview: boolean;
  notes: boolean | null;
  refRepo: { display: string; host?: string } | null;
  name: string;
  comments: readonly Annotation[] | null;
  openComment: string | null;
  revealedComment: string | null;
  side: boolean;
  acts: MessageActsRef;
};

export function drawMessageBody(d: MessageBodyData) {
  const { message, acts } = d;
  const id = message.id;
  const isAgent = message.author.kind === 'agent';
  const questions = message.questions ?? [];
  const at = (key: string) => questions.findIndex((q) => q.key === key);
  return (
    <MessageBody
      message={message}
      sentAnswers={d.sentAnswers}
      sentActions={d.sentActions}
      replyFiles={d.files && d.personMessageIds ? { files: d.files, personMessageIds: d.personMessageIds, onOpen: (file, version) => acts.current.openFromReply(file, version) } : undefined}
      onJumpQuestion={(target) => acts.current.jumpTo(target)}
      projectRoot={d.root}
      openInFiles={d.codeReview}
      {...(d.notes === null ? {} : { contextNotes: d.notes ? { onOpen: (note) => acts.current.noteChips(id).onOpen?.(note) } : {} })}
      repo={d.repo}
      onOpenAttachment={(attachment) => acts.current.openFromMessage(attachment)}
      onOpenInlineImage={(image) => acts.current.openFromMessage(image)}
      onOpenOptionSet={(key, image, choice) => acts.current.openOptionSet(id, key, image, choice)}
      onTryPrototype={isAgent ? (key) => acts.current.tryPrototype(id, key) : undefined}
      readOnly={d.readOnly}
      answers={d.answers}
      onPick={(key, answer) => acts.current.pick(id, key, answer)}
      footerFor={(key) => d.footers[at(key)] ?? null}
      renderReplacedCard={(key, number) => {
        const i = at(key);
        const q = questions[i];
        const shown = d.replaced[i];
        if (!q || !shown?.[0]) return undefined;
        return <ReplacedQuestionCard question={q} number={number} total={questions.length} replacement={shown[0]} answer={shown[1] === undefined ? q.answer : shown[1]} onJump={(target) => acts.current.jumpTo(target)} refRepo={d.refRepo} />;
      }}
      renderReplacesLine={(key) => {
        const old = d.replaced[at(key)]?.[2] ?? [];
        return old.length > 0 ? <ReplacesLine old={old} onJump={(target) => acts.current.jumpTo(target)} /> : null;
      }}
      renderActions={
        isAgent && (message.actions?.length ?? 0) > 0
          ? {
              recordFor: (block) => actionForBlock(message.body, message.actions, block),
              render: (records) => <ActionChecklist actions={records} agent={d.name} refRepo={d.refRepo} readOnly={!d.live} onMark={(action, mark) => acts.current.markAction(id, action.key, mark)} />,
            }
          : undefined
      }
      comments={
        d.comments
          ? {
              annotations: d.comments,
              onSave: (annotation) => acts.current.saveMessageComment(id, annotation),
              onUnanchored: (report) => acts.current.noteUnanchored(report),
              onPainted: () => acts.current.repaintHits(id),
              onOpen: (commentId) => acts.current.openListAt(commentId),
              openId: d.openComment,
              revealed: d.revealedComment,
              onSide: d.side ? (selected, source) => acts.current.onSide?.(selected, source) : undefined,
            }
          : undefined
      }
    />
  );
}
