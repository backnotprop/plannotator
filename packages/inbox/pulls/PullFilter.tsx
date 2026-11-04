/**
 * The Pull requests list's filter (approval "pr-list-filters", take B Joined): one bordered control on the right of
 * the list's head, holding the on-you count and the filter.
 *
 * - At rest: "5 on you │ [filter]". The count follows the project, never the view, and hides at 0; its tooltip says
 *   what "on you" means.
 * - Narrowed: "2 on you │ [eye] To review [book] web-app ×": the view and the project, each by its icon and words,
 *   and × clears both. Too narrow for that (the list's head under 330px), the picks drop their words and keep their
 *   icons; "on you" is never cut.
 * - The menu, drawn like Linear's: the views (All, Mine, To review, Others), then the projects (only when more than
 *   one has PRs here), each with its icon, its count and a tick on the chosen one; "Clear filters" while narrowed. A
 *   phone draws it as a bottom sheet titled "Filter".
 *
 * Base UI carries the keys (arrows, Home/End, type-ahead, Escape and Tab close, focus back to the trigger). No
 * shortcut of its own.
 */
import { useEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import type { InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { formatCount } from '@plannotator/core/inbox-format';
import type { ProjectFolder } from '../api';
import { Icon, type IconName } from '../icons';
import { Tip } from '../components/Tip';
import { PULL_FILTERS, pullCount, pullFilterWords, type PullFilter } from './model';

/** Marks the Inbox's icon set has no match for, drawn as its icons are (24-unit view, stroked). */
const GLYPHS = {
  // Lucide list-filter (ISC): Linear's filter mark.
  filter: 'M3 6h18M7 12h10M10 18h4',
  // Heroicons outline users (MIT): other people's.
  users:
    'M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z',
  // Lucide book-marked (ISC): a repository, as GitHub draws one.
  repo: 'M10 2v8l3-3 3 3V2M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20',
  // Heroicons outline squares-2x2 (MIT): every project.
  grid: 'M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z',
} as const;

type GlyphName = keyof typeof GLYPHS | IconName;

function Glyph({ name }: { name: GlyphName }) {
  if (name in GLYPHS) {
    return (
      <svg className="ib-ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-icon={name}>
        <path d={GLYPHS[name as keyof typeof GLYPHS]} />
      </svg>
    );
  }
  return <Icon name={name as IconName} />;
}

/** Each view's mark: every PR, the person's pen, their eye on others' work, other people. */
const VIEW_GLYPH: Record<PullFilter, GlyphName> = { all: 'pullRequest', mine: 'pen', review: 'eye', others: 'users' };

/**
 * What "on you" means, in the words of the On you band's own definition (docs/agent-guides/inbox-files-and-guides.md),
 * said to the person, with the PRs assigned to them.
 */
export const ON_YOU_TIP = "On you: a review requested from you, changes requested or checks failed on your own PR, your agent's PR, or one assigned to you";

export interface PullFilterProps {
  model: InboxPullsAnswer;
  filter: PullFilter;
  project: string | null;
  /** The projects offered: those with a GitHub or GitLab remote here. The project rows show when there are two or more. */
  projects: readonly ProjectFolder[];
  names: ReadonlyMap<string, string>;
  phone: boolean;
  /** The On you rows of the chosen project (every view). */
  onYou: number;
  /** A new view and project, in one step (Clear filters sets both). */
  onChange: (next: { filter: PullFilter; project: string | null }) => void;
}

export function PullFilterControl({ model, filter, project, projects, names, phone, onYou, onChange }: PullFilterProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // The menu is drawn inside the window's root, so the window's styles (and theme) reach it.
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useEffect(() => setPortal(trigger.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);

  const projectName = project ? (names.get(project) ?? 'Project') : null;
  const viewWords = filter === 'all' ? null : pullFilterWords(filter);
  const narrowed = !!viewWords || !!projectName;
  // The trigger's name says everything its icons stand for ("5 on you. Filter: To review, web-app").
  const said = [viewWords, projectName].filter(Boolean).join(', ');
  const name = `${onYou > 0 ? `${formatCount(onYou)} on you. ` : ''}${narrowed ? `Filter: ${said}` : 'Filter'}`;
  const clear = () => {
    onChange({ filter: 'all', project: null });
    // Back on the trigger: the × goes with the filter.
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const tick = (on: boolean) => <span className="ib-pc-tick">{on && <Icon name="check" />}</span>;

  return (
    <div className="ib-pc" data-both={viewWords && projectName ? '' : undefined} data-pulls-filter-said={said || 'none'}>
      <span className="ib-pc-grp" data-set={narrowed ? '' : undefined}>
        <Menu.Root open={open} onOpenChange={setOpen} modal={false}>
          <Menu.Trigger ref={trigger} className="ib-pc-btn" aria-label={name} data-pulls-filter-trigger="">
            {onYou > 0 && (
              <>
                <Tip content={ON_YOU_TIP}>
                  <span className="ib-pc-you" data-pulls-on-you={onYou}>
                    <span className="ib-pc-n">{formatCount(onYou)}</span> on you
                  </span>
                </Tip>
                <span className="ib-pc-div" aria-hidden="true" />
              </>
            )}
            {!narrowed && <Glyph name="filter" />}
            {viewWords && (
              <span className="ib-pc-val" data-pulls-filter-view={filter}>
                <Glyph name={VIEW_GLYPH[filter]} />
                <span className="ib-pc-w">{viewWords}</span>
              </span>
            )}
            {projectName && (
              <span className="ib-pc-val ib-pc-proj" data-pulls-filter-project={project}>
                <Glyph name="repo" />
                <span className="ib-pc-w" dir="auto">
                  {projectName}
                </span>
              </span>
            )}
          </Menu.Trigger>
          <Menu.Portal container={portal ?? undefined}>
            {phone && <Menu.Backdrop className="ib-pm-scrim" />}
            <Menu.Positioner className="ib-pm-pos" side="bottom" align="end" sideOffset={6} data-phone={phone ? '' : undefined}>
              <Menu.Popup className="ib-pm ib-pc-menu" aria-label="Filter" data-pulls-filter-menu="">
                <div className="ib-pm-title" aria-hidden="true">
                  Filter
                </div>
                <Menu.RadioGroup value={filter} onValueChange={(next: PullFilter) => next !== filter && onChange({ filter: next, project })}>
                  {PULL_FILTERS.map(([value, words]) => (
                    <Menu.RadioItem key={value} value={value} closeOnClick className="ib-pmi" label={words} data-pulls-filter={value}>
                      <Glyph name={VIEW_GLYPH[value]} />
                      <span className="ib-pmi-l">{words}</span>
                      <span className="ib-pmi-n">{formatCount(pullCount(model, project, value))}</span>
                      {tick(filter === value)}
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
                {projects.length > 1 && (
                  <>
                    <Menu.Separator className="ib-pm-sep" />
                    <Menu.RadioGroup value={project ?? ''} onValueChange={(next: string) => next !== (project ?? '') && onChange({ filter, project: next || null })}>
                      <Menu.RadioItem value="" closeOnClick className="ib-pmi" label="All projects" data-pulls-filter-project-option="">
                        <Glyph name="grid" />
                        <span className="ib-pmi-l">All projects</span>
                        <span className="ib-pmi-n">{formatCount(pullCount(model, null, filter))}</span>
                        {tick(project === null)}
                      </Menu.RadioItem>
                      {projects.map((p) => {
                        const shown = names.get(p.id) ?? p.name;
                        return (
                          <Menu.RadioItem key={p.id} value={p.id} closeOnClick className="ib-pmi" label={shown} data-pulls-filter-project-option={p.id}>
                            <Glyph name="repo" />
                            <span className="ib-pmi-l" dir="auto">
                              {shown}
                            </span>
                            <span className="ib-pmi-n">{formatCount(pullCount(model, p.id, filter))}</span>
                            {tick(project === p.id)}
                          </Menu.RadioItem>
                        );
                      })}
                    </Menu.RadioGroup>
                  </>
                )}
                {narrowed && (
                  <>
                    <Menu.Separator className="ib-pm-sep" />
                    <Menu.Item className="ib-pmi" data-pulls-filter-clear-item="" onClick={clear}>
                      <Icon name="x" />
                      <span className="ib-pmi-l">Clear filters</span>
                    </Menu.Item>
                  </>
                )}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        {narrowed && (
          <button type="button" className="ib-pc-x" aria-label="Clear filters" onClick={clear} data-pulls-filter-clear="">
            <Icon name="x" />
          </button>
        )}
      </span>
    </div>
  );
}
