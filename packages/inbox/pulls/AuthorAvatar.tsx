/**
 * A PR author's profile picture, read through the Inbox's own route (`GET /api/inbox/pulls/avatar`): the window's CSP
 * never loads a remote image. The initials show while it loads and stay when it cannot. The list's rows (RowLead) and
 * the review's byline draw it.
 */
import { forwardRef, useEffect, useState, type HTMLAttributes } from 'react';
import { inboxApi } from '../api';
import { initials } from './labels';

/** Pictures that failed or drew nothing in this window, so a picture drawn again never asks twice. */
const failedAvatars = new Set<string>();

/** Other props (a tooltip trigger's handlers) and the ref reach the picture's span. */
export const AuthorAvatar = forwardRef<HTMLSpanElement, { host: string; author: string } & HTMLAttributes<HTMLSpanElement> & { [attr: `data-${string}`]: string | undefined }>(function AuthorAvatar(
  { host, author, className = 'ib-pr-av', ...rest },
  ref,
) {
  const src = inboxApi.pullAvatarUrl(host, author);
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState(() => failedAvatars.has(src));
  useEffect(() => {
    setShown(false);
    setFailed(failedAvatars.has(src));
  }, [src]);
  const fail = () => {
    failedAvatars.add(src);
    setFailed(true);
  };
  return (
    <span {...rest} ref={ref} className={className} role="img" aria-label={author} data-pulls-avatar={failed ? 'none' : shown ? 'shown' : 'loading'}>
      {!shown && <span aria-hidden="true">{initials(author)}</span>}
      {!failed && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          data-shown={shown ? '' : undefined}
          onLoad={(event) => {
            const img = event.currentTarget;
            if (img.naturalWidth > 1 && img.naturalHeight > 1) setShown(true);
            else fail();
          }}
          onError={fail}
        />
      )}
    </span>
  );
});
