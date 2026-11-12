import { useEffect, useRef, useState, type RefObject } from 'react';
import { Menu } from '@base-ui/react/menu';
import { formatCount } from '@plannotator/core/inbox-format';
import type { ProjectFolder } from '../api';
import { Icon, type IconName } from '../icons';
import { Tip } from '../components/Tip';
import { PULL_FILTERS, pullFilterWords, type PullFilter } from './model';

const GLYPHS = {
  filter: 'M3 6h18M7 12h10M10 18h4',
  users:
    'M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z',
  repo: 'M10 2v8l3-3 3 3V2M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20',
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

const VIEW_GLYPH: Record<PullFilter, GlyphName> = { all: 'pullRequest', mine: 'pen', review: 'eye', others: 'users' };

export interface PullFilterProps {
  count: (project: string | null, filter: PullFilter) => number;
  filter: PullFilter;
  project: string | null;
  projects: readonly ProjectFolder[];
  names: ReadonlyMap<string, string>;
  phone: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onChange: (next: { filter: PullFilter; project: string | null }) => void;
}

export function pullScopeWords(filter: PullFilter, projectName: string | null): string {
  return [filter === 'all' ? null : pullFilterWords(filter), projectName].filter(Boolean).join(', ');
}

export function PullFilterControl({ count, filter, project, projects, names, phone, triggerRef, onChange }: PullFilterProps) {
  const [open, setOpen] = useState(false);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useEffect(() => setPortal(triggerRef.current?.closest<HTMLElement>('.pn-inbox') ?? null), [triggerRef]);
  const [keyed, setKeyed] = useState(false);

  const projectName = project ? (names.get(project) ?? projects.find((p) => p.id === project)?.name ?? null) : null;
  const said = pullScopeWords(filter, projectName);
  const narrowed = said !== '';
  const name = narrowed ? `Filter: ${said}` : 'Filter';
  const clear = () => {
    onChange({ filter: 'all', project: null });
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const tick = (on: boolean) => <span className="ib-pc-tick">{on && <Icon name="check" />}</span>;

  return (
    <Menu.Root open={open} onOpenChange={setOpen} modal={phone}>
      <Menu.Trigger
        ref={triggerRef}
        className="ib-pf-ico"
        aria-label={name}
        data-set={narrowed ? '' : undefined}
        onFocus={(e) => setKeyed(e.currentTarget.matches(':focus-visible'))}
        onBlur={() => setKeyed(false)}
        data-pulls-filter-trigger=""
      >
        <Tip key={open ? 'menu' : 'rest'} content={name} open={keyed && !open && !phone ? true : undefined}>
          <span className="ib-pf-mark">
            <Glyph name="filter" />
          </span>
        </Tip>
        {narrowed && <span className="ib-pf-dot" aria-hidden="true" />}
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
                  <span className="ib-pmi-n">{formatCount(count(project, value))}</span>
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
                    <span className="ib-pmi-n">{formatCount(count(null, filter))}</span>
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
                        <span className="ib-pmi-n">{formatCount(count(p.id, filter))}</span>
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
  );
}

export function PullScopeLine({ filter, projectName, triggerRef, onClear }: { filter: PullFilter; projectName: string | null; triggerRef: RefObject<HTMLButtonElement | null>; onClear: () => void }) {
  const view = filter === 'all' ? null : filter;
  if (!view && !projectName) return null;
  return (
    <div className="ib-pscope" data-pulls-scope="">
      {view && (
        <span className="ib-pscope-v" data-pulls-scope-view={view}>
          <Glyph name={VIEW_GLYPH[view]} />
          {pullFilterWords(view)}
        </span>
      )}
      {projectName && (
        <span className="ib-pscope-p" data-pulls-scope-project="">
          <Glyph name="repo" />
          <span className="ib-pscope-n" dir="auto">
            {projectName}
          </span>
        </span>
      )}
      <button
        type="button"
        className="ib-pscope-x"
        aria-label="Clear filters"
        onClick={() => {
          onClear();
          requestAnimationFrame(() => triggerRef.current?.focus());
        }}
        data-pulls-filter-clear=""
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

export function useFilterTrigger() {
  return useRef<HTMLButtonElement | null>(null);
}
