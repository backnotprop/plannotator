/**
 * The quiet "Skills: …" line under a person's message (approval
 * "inbox-skill-references", the Quiet look): the skills block the window
 * pasted at the end of the message when it was sent, folded behind one muted
 * line. Open, it shows the block exactly as the agent received it: the list,
 * and each human-only skill's SKILL.md between its markers. Only the person's
 * own messages are read this way (Thread.tsx's MessageBody); an agent's
 * message is shown whole.
 */
import type { InboxSkillsSplit } from '@plannotator/core/skill-reference-block';

/** "0.4 KB": the size of the instructions that went with the message. */
function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** "readback's instructions went with this reply (0.4 KB)", or '' when none did. */
export function skillsLineDetail(split: InboxSkillsSplit): string {
  const included = split.skills.filter((s) => s.included);
  if (included.length === 0) return '';
  const bytes = included.reduce((sum, s) => sum + s.bytes, 0);
  const what = included.length === 1 ? `${included[0]!.name}'s instructions` : `the instructions for ${included.map((s) => s.name).join(', ')}`;
  return `${what} went with this ${split.subject} (${kilobytes(bytes)})`;
}

export function SkillsLine({ split }: { split: InboxSkillsSplit }) {
  const names = split.skills.map((s) => s.name).join(', ');
  const detail = skillsLineDetail(split);
  return (
    <details className="ib-skills" data-skills-line="">
      <summary>
        <SkillCube />
        <span className="ib-skills-l">
          Skills: <span className="ib-skills-n">{names}</span>
          {detail ? <span className="ib-skills-d"> · {detail}</span> : null}
        </span>
        <span className="ib-skills-t" aria-hidden="true" />
      </summary>
      <pre className="ib-skills-block" data-skills-block="" tabIndex={0} aria-label={`What went with this ${split.subject}`}>
        {split.block}
      </pre>
    </details>
  );
}

/** The cube Plannotator's skill picker shows beside each skill. */
function SkillCube() {
  return (
    <svg className="ib-skills-i" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="M3.29 7 12 12l8.71-5" />
      <path d="M12 22V12" />
    </svg>
  );
}
