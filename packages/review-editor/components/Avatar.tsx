import React, { useEffect, useState } from 'react';

/** Round author avatar with an initials fallback (and broken-image fallback).
 * Shared by the PR comments timeline and the Commits panel. */
export function Avatar({ src, name, size = 22 }: { src?: string; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  // A new src deserves a fresh attempt — without this, an instance whose
  // image once errored would render initials forever even after being handed
  // a valid URL. Latent today (all callers key by identity, forcing
  // remounts), but this is a shared component and must be safe for callers
  // that update src in place.
  useEffect(() => {
    setFailed(false);
  }, [src]);
  if (!src || failed) {
    return (
      <span
        aria-hidden
        className="shrink-0 inline-flex items-center justify-center rounded-full bg-muted text-muted-foreground font-semibold select-none"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      >
        {(name || '?').charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className="shrink-0 rounded-full bg-muted object-cover"
      style={{ width: size, height: size }}
    />
  );
}
