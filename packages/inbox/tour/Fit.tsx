/**
 * How the Inbox fits with your agents (the owner, for 0.28.31; copy from the
 * tour v2 brief, step 0, exactly): the top tile of the first-run "Two paths"
 * bento, and the short first card when the tour starts ("a fresh reminder").
 *
 * The picture: your own agents, one line each (their real mark, their
 * name, "(you run this as normal)"), a straight arrow from each into the
 * Inbox card at the same height, and a primary "your reply" arrow back,
 * parallel to Claude Code's. HTML and CSS only, no asset but the card's
 * thumbnail. The reply arrow draws once, 600 ms, not under reduced motion.
 */
import { HostMark, Icon } from '../icons';
import { tourAssetUrl } from './assets';

export const TOUR_FIT_TITLE = 'The Inbox works beside your agents';
export const TOUR_FIT_LINES = [
  'It doesn’t replace them: keep running Claude Code, Pi or OpenCode in your terminal or editor, as you do now.',
  'When they need you, they send their questions, finished work and files here.',
  'Your reply goes back into the same session, and it keeps working.',
] as const;
const PICTURE_ALT = 'Your agents keep running in your terminal and editor. They send questions, work and files to the Inbox; your reply goes back to the same session.';

/** One of your agents, in one line: its mark, its name, and that you run it as normal. */
function Session({ host, name, row }: { host: string; name: string; row: number }) {
  return (
    <div className="tp-win" style={{ gridRow: row }}>
      <HostMark host={host} />
      <b>{name}</b>
      <span className="tp-note">
        <span className="tp-note-long">(you run this as normal)</span>
        <span className="tp-note-short">(run as normal)</span>
      </span>
    </div>
  );
}

/** A straight arrow from a session into the Inbox card, at the session's height; Claude Code's has the reply back beside it. */
function Link({ row, reply }: { row: number; reply?: boolean }) {
  return (
    <div className="tp-link" style={{ gridRow: row }}>
      <i className="tp-to" />
      {reply && (
        <>
          <i className="tp-back tp-ret-draw" />
          <span className="tp-reply">your reply</span>
        </>
      )}
    </div>
  );
}

export function TourFitPicture() {
  return (
    <div className="tp-wrap">
      <div className="tp" role="img" aria-label={PICTURE_ALT}>
        <Session host="claude-code" name="Claude Code" row={1} />
        <Session host="pi" name="Pi" row={2} />
        <Session host="opencode" name="OpenCode" row={3} />
        <Link row={1} reply />
        <Link row={2} />
        <Link row={3} />
        {/* A phone: the sessions on top, then the questions down and the reply up, side by side. */}
        <div className="tp-down" aria-hidden="true">
          <span className="tp-dn">↓ questions, work, files</span>
          <span className="tp-up">↑ your reply</span>
        </div>
        <div className="tp-inbox">
          <div className="tp-ih">
            <Icon name="inbox" size={13} />
            Inbox
          </div>
          <div className="tp-row">
            <HostMark host="claude-code" />
            <b>Which direction?</b>
            <span className="tp-c">1 question</span>
            {/* Not here: the row keeps its words, never a broken image. */}
            <img className="tp-th" src={tourAssetUrl('vs-a-thumb.webp')} alt="" onError={(event) => (event.currentTarget.style.display = 'none')} />
          </div>
          <div className="tp-row">
            <HostMark host="pi" />
            <b>Checkout page is done</b>
            <span className="tp-c">2 files</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The words: the title and its three sentences (the heading level is the host's). */
export function TourFitText({ as: Heading = 'h3', id }: { as?: 'h2' | 'h3'; id?: string }) {
  return (
    <>
      <Heading id={id} tabIndex={-1}>
        {TOUR_FIT_TITLE}
      </Heading>
      {TOUR_FIT_LINES.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </>
  );
}

/**
 * The tour's first card: the same explanation, then Show me. Not modal: the tour bar (and its Exit) stays in
 * reach above it. Focus goes to its title when it opens.
 */
export function TourIntro({ onGo }: { onGo: () => void }) {
  return (
    <div className="ib-tour-intro-scrim">
      <section className="ib-tour-intro" role="region" aria-labelledby="ib-tour-intro-h" data-tour-intro="">
        <div className="ib-ti-pic">
          <TourFitPicture />
        </div>
        <div className="ib-ti-body">
          <TourFitText as="h2" id="ib-tour-intro-h" />
          <div className="ib-ti-acts">
            <button type="button" className="ib-btn ib-pri" onClick={onGo} data-tour-intro-go="">
              Show me
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
