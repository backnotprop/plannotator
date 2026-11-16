import { LetterMark, ProjectMark, showsProjects, showsThreads, useRowMarks } from '../letterMarks';

/** The thread's or project's mark before the title in the thread's bar, in the rows' mark style (letterMarks.ts). */
export function HeadMark({ thread }: { thread: { thread_id: string; subject: string | null; thread_name?: string | null; project: { id: string; name: string } } }) {
  const { marks } = useRowMarks();
  if (marks.what === 'off') return null;
  const style = marks.style;
  const name = thread.thread_name?.trim() ? thread.thread_name : (thread.subject ?? '');
  const threads = showsThreads(marks.what);
  const projects = showsProjects(marks.what);
  return (
    <span className="ib-lm-head" data-take={style} aria-hidden="true">
      {threads ? <LetterMark name={name} seed={thread.thread_id} size={20} solid={style === 'avatar'} /> : <ProjectMark projectId={thread.project.id} name={thread.project.name} size={20} solid={style === 'avatar'} />}
      {style === 'avatar' && threads && projects && <ProjectMark projectId={thread.project.id} name={thread.project.name} size={12} solid className="ib-lm-badge" />}
    </span>
  );
}
