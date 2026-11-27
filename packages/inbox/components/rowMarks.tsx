/**
 * A list row's letter marks (letterMarks.tsx), moved out of InboxList.tsx. In a list's rows the marks are the list's,
 * read once for every row (`ListRowMarks`, given through `useGivenRowMarks`); a row drawn anywhere else reads them itself.
 */
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { LetterMark, ProjectMark, showsProjects, showsThreads, useGivenRowMarks, useRowMarks, type MarksChoice } from '../letterMarks';
import { titleOf } from './rowParts';

type AvatarProps = { row: InboxListRow; size: 24 | 30 };

/** Letter marks, style "Avatar": one mark per row in a column of its own, the thread's with the project's on its corner. */
export function RowAvatar(props: AvatarProps) {
  const given = useGivenRowMarks();
  return given ? drawRowAvatar(props, given.marks) : <OwnRowAvatar {...props} />;
}

function OwnRowAvatar(props: AvatarProps) {
  return drawRowAvatar(props, useRowMarks().marks);
}

function drawRowAvatar({ row, size }: AvatarProps, marks: MarksChoice) {
  if (marks.style !== 'avatar' || marks.what === 'off') return null;
  const project = row.project?.name ?? '';
  const threads = showsThreads(marks.what);
  const projects = showsProjects(marks.what);
  return (
    <span className="ib-lm-av" data-size={size} aria-hidden="true">
      {threads ? <LetterMark name={titleOf(row)} seed={row.thread_id} size={size} solid /> : <ProjectMark projectId={row.project_id} name={project} size={size} solid />}
      {threads && projects && project && <ProjectMark projectId={row.project_id} name={project} size={size === 30 ? 14 : 12} solid className="ib-lm-badge" />}
    </span>
  );
}

/** Letter marks, style "Inline": the project's mark before its name in a row. */
export function RowProjectMark(props: { row: InboxListRow }) {
  const given = useGivenRowMarks();
  return given ? drawRowProjectMark(props.row, given.marks) : <OwnRowProjectMark {...props} />;
}

function OwnRowProjectMark({ row }: { row: InboxListRow }) {
  return drawRowProjectMark(row, useRowMarks().marks);
}

function drawRowProjectMark(row: InboxListRow, marks: MarksChoice) {
  if (marks.style !== 'inline' || !showsProjects(marks.what) || !row.project?.name) return null;
  return <ProjectMark projectId={row.project_id} name={row.project.name} size={16} className="ib-lm-rowp" />;
}

/** Whether the row leads with an avatar (style "Avatar", some marks on): three-line and phone rows make room for it. */
export function useAvatarRow(): boolean {
  const { marks } = useRowMarks();
  return marks.style === 'avatar' && marks.what !== 'off';
}
