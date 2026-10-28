/**
 * The first-run entry screen, "Two paths" (approval "inbox-onboarding-tour",
 * entry: Two paths): the tour and connecting as two equal cards. "Connect my
 * agents" is a first-class path, not a skip link: it opens the real
 * first-run screen (EmptyState, "One next step"), unchanged.
 */
import type { InboxAgentsModel } from '@plannotator/core/inbox-types';
import { HostMark, Icon } from '../icons';
import { SidebarTrigger } from '../shell/sidebar';
import { connectPlan, PLUGIN_HOSTS } from '../connectSteps';
import { tourAssetUrl } from './model';
import { TourFitPicture, TourFitText } from './Fit';

export interface TourEntryModel {
  /** The agents' marks, each with whether it reaches the Inbox (null: unknown here, the tailnet page). */
  marks: { id: string; ready: boolean | null }[];
  /** "2 of 4 ready", or null when the agents are not known. */
  count: string | null;
  line: string;
}

/** What the connect card says about the agents on this computer. */
export function tourEntryModel(agents: InboxAgentsModel | null, unavailable: 'tailnet' | 'failed' | null, live: ReadonlySet<string> = new Set()): TourEntryModel {
  const plan = agents ? connectPlan(agents, [], live) : null;
  if (!plan || plan.found.length === 0) {
    return {
      marks: PLUGIN_HOSTS.map((id) => ({ id, ready: null })),
      count: null,
      line:
        unavailable === 'tailnet'
          ? 'Connect them from the computer they run on: there each one is a click or a command to copy.'
          : 'Claude Code, Pi, OpenCode and any MCP client. Most take one click or one command.',
    };
  }
  const done = new Set(plan.done.map((r) => r.id));
  const marks = plan.found.slice(0, 5).map((r) => ({ id: r.id, ready: done.has(r.id) }));
  const n = plan.found.length;
  const first = plan.done[0];
  const line =
    plan.done.length === n
      ? `${n} found on this computer, and ${n === 1 ? 'it reaches' : 'all of them reach'} the Inbox.`
      : first
        ? `${n} found on this computer. ${first.label} is already on; most others take one click.`
        : `${n} found on this computer. Most take one click or one command.`;
  return { marks, count: `${plan.done.length} of ${n} ready`, line };
}

export function TourEntry({ model, onStart, onConnect }: { model: TourEntryModel; onStart: () => void; onConnect: () => void }) {
  return (
    <section className="ib-listcol" aria-label="Inbox">
      <div className="ib-lhead">
        <SidebarTrigger />
        <h1>Inbox</h1>
      </div>
      <div className="ib-lbody">
        <div className="ib-empty ib-te-empty" data-tour-entry="">
          <h2 tabIndex={-1}>Two ways to start</h2>
          {/* The bento: how the Inbox fits with your agents, wide on top, then the two paths. */}
          <section className="ib-te-card ib-te-fit" aria-labelledby="ib-te-fit-h" data-tour-fit="">
            <div className="ib-te-fit-pic">
              <TourFitPicture />
            </div>
            <div className="ib-te-body">
              <TourFitText id="ib-te-fit-h" />
            </div>
          </section>
          <div className="ib-te-paths">
            <section className="ib-te-card ib-te-tour" aria-labelledby="ib-te-tour-h">
              <div className="ib-te-pic">
                {/* Not here: the card keeps its calm ground, never a broken image. */}
                <img src={tourAssetUrl('vs-a-thumb.webp')} alt="" onError={(event) => (event.currentTarget.style.visibility = 'hidden')} />
                <span className="ib-te-time">
                  <Icon name="play" size={12} />2 min
                </span>
              </div>
              <div className="ib-te-body">
                <h3 id="ib-te-tour-h">Watch how we built the Inbox with the Inbox</h3>
                <p>A replay of a real thread: Claude Code asks with mockups, Plannotator’s developer picks one, and it builds it.</p>
                <button type="button" className="ib-btn ib-pri" onClick={onStart} data-tour-start="">
                  <Icon name="play" size={15} />
                  Start the tour
                </button>
              </div>
            </section>
            <section className="ib-te-card ib-te-connect" aria-labelledby="ib-te-con-h">
              <div className="ib-te-pic ib-te-marks">
                {model.marks.map((m) => (
                  <span key={m.id} className="ib-te-mk" data-ready={m.ready === null ? undefined : String(m.ready)}>
                    <HostMark host={m.id} big />
                  </span>
                ))}
                {model.count && <span className="ib-te-time ib-te-count">{model.count}</span>}
              </div>
              <div className="ib-te-body">
                <h3 id="ib-te-con-h">Connect my agents</h3>
                <p>{model.line}</p>
                <button type="button" className="ib-btn ib-pri" onClick={onConnect} data-tour-connect="">
                  <Icon name="chevR" size={15} />
                  Connect my agents
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </section>
  );
}
