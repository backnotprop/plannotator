import React, { useEffect, useState } from 'react';

export function Avatar({ src, name, size = 22 }: { src?: string; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
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
