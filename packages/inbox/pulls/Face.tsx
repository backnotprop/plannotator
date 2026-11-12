import { Fragment, useState } from 'react';
import type { InboxPullReviewState } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { Icon } from '../icons';
import { isPerson, type Words } from './words';

const failedPictures = new Set<string>();

export function usePicture(src: string | null) {
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
  initialSize?: number;
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

const INLINE_FACE = 16;

export function Person({ login, host, tail, face = true }: { login: string; host: string; tail?: string; face?: boolean }) {
  return (
    <span className="ib-person" data-person={login}>
      {face && <Face login={login} host={host} size={INLINE_FACE} initialSize={9} inline />}
      {login}
      {tail}
    </span>
  );
}

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
