/**
 * A person's small picture, the one component every small face in Reviews, the Pull requests board and the PR page
 * uses (the Details panel, the comments on lines, and a face by every name: the owner, q-331c0466). Read through the
 * Inbox's own route (`GET /api/inbox/pulls/avatar`): the window's CSP never loads a remote image. The initial shows
 * while it loads and stays when there is no picture; a deleted account is a grey person; an app or a team is a soft
 * square, as on the forge, and a team has no picture to ask for.
 */
import { Fragment, useState } from 'react';
import type { InboxPullReviewState } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { Icon } from '../icons';
import { isPerson, type Words } from './words';

/** Pictures that failed or drew nothing in this window, so a face drawn again never asks twice. */
const failedPictures = new Set<string>();

/**
 * A picture's state, shared by every face (and the Reviews row's left circle): loading, shown, or none (it failed,
 * drew nothing, or there is no address). `onLoad` and `onError` go on the `<img>`.
 */
export function usePicture(src: string | null) {
  // Kept by the address they are for, never reset in an effect: a picture the browser already holds loads before an
  // effect runs, and a reset then would leave the face on its initial for good.
  const [shownSrc, setShownSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const shown = src !== null && shownSrc === src;
  const failed = src === null || failedSrc === src || failedPictures.has(src);
  const fail = () => {
    if (src) failedPictures.add(src);
    setFailedSrc(src);
  };
  return {
    shown,
    failed,
    state: (failed ? 'none' : shown ? 'shown' : 'loading') as 'none' | 'shown' | 'loading',
    onLoad: (event: { currentTarget: HTMLImageElement }) => {
      const img = event.currentTarget;
      if (img.naturalWidth > 1 && img.naturalHeight > 1) setShownSrc(src);
      else fail();
    },
    onError: fail,
  };
}

const initial = (login: string) => (login.includes('/') ? login.split('/')[1]! : login).replace(/\[bot\]$/, '').slice(0, 1).toUpperCase();

export function Face({
  login,
  host,
  size,
  bot,
  team,
  state,
  initialSize,
  inline,
}: {
  login: string;
  host: string;
  size: number;
  bot?: boolean;
  team?: boolean;
  state?: InboxPullReviewState;
  /** The initial's size in px; a face's size × 0.42 when not given. */
  initialSize?: number;
  /**
   * In a line of words (`Person`): the initial is drawn by CSS, not written, so the line's text stays exactly its words
   * for a copy, a find, a tooltip and the tests.
   */
  inline?: boolean;
}) {
  const isTeam = team || login.includes('/');
  const square = bot || isTeam || login.endsWith('[bot]');
  const src = login && !isTeam ? inboxApi.pullAvatarUrl(host, login) : null;
  const picture = usePicture(src);
  return (
    <span
      className="ib-prd-face"
      data-square={square ? '' : undefined}
      data-gone={login ? undefined : ''}
      data-face={login || undefined}
      data-face-state={picture.state}
      style={{ width: size, height: size, fontSize: initialSize ?? Math.round(size * 0.42) }}
      aria-hidden="true"
    >
      <span className="ib-prd-pic" data-initial={inline && login && !picture.shown ? initial(login) : undefined}>
        {!login ? <Icon name="user" size={Math.round(size * 0.6)} /> : !inline && !picture.shown && initial(login)}
        {src && !picture.failed && (
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            draggable={false}
            data-shown={picture.shown ? '' : undefined}
            onLoad={picture.onLoad}
            onError={picture.onError}
          />
        )}
      </span>
      {state && state !== 'waiting' && (
        <span className="ib-prd-pip" data-state={state}>
          <Icon name={state === 'approved' ? 'check' : state === 'changes' ? 'x' : 'comment'} size={8} />
        </span>
      )}
    </span>
  );
}

/** The face beside a name in a line of text: 16px, the line's own size. */
const INLINE_FACE = 16;

/** A name with its face before it, kept on one line with it (and with the "'s" that rides on it). */
export function Person({ login, host, tail, face = true }: { login: string; host: string; tail?: string; face?: boolean }) {
  return (
    <span className="ib-person" data-person={login}>
      {face && <Face login={login} host={host} size={INLINE_FACE} initialSize={9} inline />}
      {login}
      {tail}
    </span>
  );
}

/**
 * Words in parts (`words.ts`): the text as it is, each person with their face, unless `facesOnce` took it off because
 * the row already pictures them. With no host to ask, the names show without faces.
 */
export function Named({ words, host }: { words: Words; host: string | null }) {
  return (
    <>
      {words.map((part, i) =>
        isPerson(part) ? (
          host ? (
            <Person key={i} login={part.person} host={host} tail={part.tail} face={part.face !== false} />
          ) : (
            <Fragment key={i}>{part.person + (part.tail ?? '')}</Fragment>
          )
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
