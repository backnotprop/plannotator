import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { formatInboxVideoTime } from '@plannotator/core/inbox-types';

export const AUDIO_PEAKS_MAX_BYTES = 12 * 1024 * 1024;

export const AUDIO_PEAK_BARS = 160;

const PEAK_SAMPLE_RATE = 8000;

export function audioPeaksOf(channels: readonly Float32Array[], bars = AUDIO_PEAK_BARS): number[] {
  const length = channels[0]?.length ?? 0;
  if (length === 0 || bars <= 0) return [];
  const raw = new Array<number>(bars).fill(0);
  for (const samples of channels) {
    for (let bar = 0; bar < bars; bar++) {
      const start = Math.floor((bar * length) / bars);
      const end = Math.max(start + 1, Math.floor(((bar + 1) * length) / bars));
      let peak = raw[bar]!;
      for (let i = start; i < end && i < samples.length; i++) {
        const v = Math.abs(samples[i]!);
        if (v > peak) peak = v;
      }
      raw[bar] = peak;
    }
  }
  const loudest = Math.max(...raw);
  return raw.map((peak) => (loudest > 0 ? Math.max(0.04, Math.pow(peak / loudest, 0.7)) : 0.04));
}

const peaksCache = new Map<string, number[]>();
const PEAKS_CACHE_MAX = 24;

export function useAudioPeaks(url: string, size: number): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(() => peaksCache.get(url) ?? null);
  useEffect(() => {
    const known = peaksCache.get(url);
    if (known) {
      setPeaks(known);
      return;
    }
    setPeaks(null);
    if (size > AUDIO_PEAKS_MAX_BYTES || typeof OfflineAudioContext === 'undefined' || typeof fetch !== 'function') return;
    const abort = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(url, { signal: abort.signal });
        if (!response.ok) return;
        const bytes = await response.arrayBuffer();
        if (cancelled) return;
        const context = new OfflineAudioContext(1, 1, PEAK_SAMPLE_RATE);
        const buffer = await context.decodeAudioData(bytes);
        if (cancelled) return;
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
        const next = audioPeaksOf(channels);
        if (next.length === 0) return;
        if (peaksCache.size >= PEAKS_CACHE_MAX) peaksCache.delete(peaksCache.keys().next().value!);
        peaksCache.set(url, next);
        setPeaks(next);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [url, size]);
  return peaks;
}

function Bars({ peaks }: { peaks: readonly number[] }) {
  return (
    <svg className="ib-audbars" viewBox={`0 0 ${peaks.length} 100`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      {peaks.map((peak, i) => {
        const height = Math.max(3, peak * 96);
        return <rect key={i} x={i + 0.18} width={0.64} y={50 - height / 2} height={height} />;
      })}
    </svg>
  );
}

const KEY_STEP_SECONDS = 5;

export function AudioScrub({
  name,
  peaks,
  current,
  span,
  onSeek,
  onFocusChange,
  children,
}: {
  name: string;
  peaks: readonly number[] | null;
  current: number;
  span: number | null;
  onSeek: (time: number) => void;
  onFocusChange: (focused: boolean) => void;
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const played = span ? Math.min(100, Math.max(0, (current / span) * 100)) : 0;
  const timeAt = (clientX: number): number | null => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || !span || rect.width <= 0) return null;
    return Math.min(span, Math.max(0, ((clientX - rect.left) / rect.width) * span));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const time = timeAt(event.clientX);
    if (time === null) return;
    dragging.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
    }
    onSeek(time);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const time = timeAt(event.clientX);
    if (time !== null) onSeek(time);
  };
  const stop = () => {
    dragging.current = false;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!span || event.metaKey || event.ctrlKey || event.altKey) return;
    const to =
      event.key === 'ArrowLeft' || event.key === 'ArrowDown'
        ? current - KEY_STEP_SECONDS
        : event.key === 'ArrowRight' || event.key === 'ArrowUp'
          ? current + KEY_STEP_SECONDS
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? span
              : null;
    if (to === null) return;
    event.preventDefault();
    event.stopPropagation();
    onSeek(Math.min(span, Math.max(0, to)));
  };
  return (
    <div
      ref={box}
      className="ib-audwave"
      role="slider"
      tabIndex={0}
      aria-label={`Seek in ${name}`}
      aria-valuemin={0}
      aria-valuemax={span ? Math.round(span) : 0}
      aria-valuenow={Math.round(current)}
      aria-valuetext={span ? `${formatInboxVideoTime(current)} of ${formatInboxVideoTime(span)}` : formatInboxVideoTime(current)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={onKeyDown}
      onFocus={() => onFocusChange(true)}
      onBlur={() => onFocusChange(false)}
      data-audio-scrub=""
      data-waveform={peaks ? '' : undefined}
    >
      {peaks ? <Bars peaks={peaks} /> : <span className="ib-audline" />}
      <span className="ib-audplayed" style={{ clipPath: `inset(0 ${100 - played}% 0 0)` }} aria-hidden="true">
        {peaks ? <Bars peaks={peaks} /> : <span className="ib-audline" />}
      </span>
      {children}
    </div>
  );
}
