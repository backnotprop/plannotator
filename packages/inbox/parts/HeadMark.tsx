import { LetterMark, ProjectMark, showsProjects, showsThreads, useRowMarks } from '../letterMarks';

export function HeadMark({ thread, where }: { thread: { thread_id: string; subject: string | null; thread_name?: string | null; project: { id: string; name: string } }; where: 'bar' | 'body' }) {
  const { marks } = useRowMarks();
  if (marks.what === 'off') return null;
  const style = marks.style;
  const name = thread.thread_name?.trim() ? thread.thread_name : (thread.subject ?? '');
  const threads = showsThreads(marks.what);
  const projects = showsProjects(marks.what);
  if (where === 'bar' && style !== 'dot') {
    return (
      <span className="ib-lm-head" data-take={style} aria-hidden="true">
        {threads ? <LetterMark name={name} seed={thread.thread_id} size={20} solid={style === 'avatar'} /> : <ProjectMark projectId={thread.project.id} name={thread.project.name} size={20} solid={style === 'avatar'} />}
        {style === 'avatar' && threads && projects && <ProjectMark projectId={thread.project.id} name={thread.project.name} size={12} solid className="ib-lm-badge" />}
      </span>
    );
  }
  if (where === 'body' && style === 'dot') {
    return (
      <div className="ib-lm-hero" aria-hidden="true">
        {threads && <LetterMark name={name} seed={thread.thread_id} size={30} />}
        {projects && <ProjectMark projectId={thread.project.id} name={thread.project.name} size={threads ? 16 : 30} className={threads ? 'ib-lm-heroP' : undefined} />}
      </div>
    );
  }
  return null;
}
