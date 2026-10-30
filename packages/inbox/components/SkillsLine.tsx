/**
 * The quiet skills line under a person's message (approval
 * "inbox-skills-line", option B, 2026-10-29): the box icon, then the names of
 * the skills the reply used as a comma list. Nothing to open: no label, no
 * size, no Show. The block the window pasted at the end of the message is
 * split off by Thread.tsx's MessageBody; the agent's text is shown whole.
 * The line sits in the message body, above the Delivered line, so it is in
 * the same place whatever the state (sent, queued, answered). A long list
 * wraps between names, never inside one.
 */
import type { InboxSkillsSplit } from '@plannotator/core/skill-reference-block';

export function SkillsLine({ split }: { split: InboxSkillsSplit }) {
  const names = split.skills.map((s) => s.name).join(', ');
  return (
    <div className="ib-skills" data-skills-line="" title={`Skills you referenced: ${names}`}>
      <SkillCube />
      <span className="ib-sr">Skills: </span>
      <span className="ib-skills-n">
        {split.skills.map((s, i) => (
          <span key={s.name}>
            <span className="ib-skill-nm" data-skill-name="">{s.name}</span>
            {i < split.skills.length - 1 ? ', ' : ''}
          </span>
        ))}
      </span>
    </div>
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
