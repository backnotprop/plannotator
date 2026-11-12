import { debugNote } from './debugLog';
import { inboxUrl } from './inboxUrl';

export type VoiceOpenNote = (fields: { step: 'context' | 'stream' | 'worklet' | 'ready'; ok: boolean; ms: number; audio?: string; error?: string }) => void;

const noteOpen: VoiceOpenNote = (fields) => debugNote('voice_open', fields);
const errorName = (cause: unknown): string => {
  const name = (cause as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : 'Error';
};

export interface VoiceRecorder {
  rate: number;
  db(): number;
  stop(): Promise<Float32Array[]>;
  abort(): void;
  onEnded(listener: () => void): void;
}

const FLUSH_WAIT_MS = 500;

export function microphoneUsable(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === true && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof AudioWorkletNode !== 'undefined';
}

export async function microphoneWillPrompt(): Promise<boolean> {
  try {
    return (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state === 'prompt';
  } catch {
    return true;
  }
}

const aborted = () => new DOMException('The take ended before the microphone opened', 'AbortError');

export function openVoiceRecorder(signal?: AbortSignal, note: VoiceOpenNote = noteOpen): Promise<VoiceRecorder> {
  const started = performance.now();
  const ms = () => Math.max(0, Math.round(performance.now() - started));
  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch (cause) {
    note({ step: 'context', ok: false, ms: ms(), error: errorName(cause) });
    throw cause;
  }
  note({ step: 'context', ok: true, ms: ms(), audio: context.state });
  const close = () => void context.close().catch(() => {});
  if (signal?.aborted) {
    close();
    return Promise.reject(aborted());
  }
  signal?.addEventListener('abort', close, { once: true });
  void context.resume().catch(() => {});
  return record(context, signal, (step, ok, error) => note({ step, ok, ms: ms(), audio: context.state, error })).then(
    (recorder) => {
      signal?.removeEventListener('abort', close);
      return recorder;
    },
    (cause: unknown) => {
      signal?.removeEventListener('abort', close);
      close();
      throw cause;
    },
  );
}

async function record(context: AudioContext, signal: AbortSignal | undefined, step: (name: 'stream' | 'worklet' | 'ready', ok: boolean, error?: string) => void): Promise<VoiceRecorder> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  } catch (cause) {
    step('stream', false, errorName(cause));
    throw cause;
  }
  if (signal?.aborted) {
    for (const track of stream.getTracks()) track.stop();
    step('stream', false, 'AbortError');
    throw aborted();
  }
  step('stream', true);
  const release = () => {
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
  };
  let at: 'worklet' | 'ready' = 'worklet';
  try {
    await context.audioWorklet.addModule(inboxUrl('/voice/worklet.js'));
    if (signal?.aborted) throw aborted();
    step('worklet', true);
    at = 'ready';
    await context.resume();
    if (signal?.aborted) throw aborted();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const tap = new AudioWorkletNode(context, 'plannotator-voice-tap', { numberOfInputs: 1, numberOfOutputs: 1 });
    const chunks: Float32Array[] = [];
    let flushed: (() => void) | null = null;
    tap.port.onmessage = (event: MessageEvent<Float32Array | string>) => {
      if (event.data === 'flushed') flushed?.();
      else if (event.data instanceof Float32Array) chunks.push(event.data);
    };
    source.connect(tap);
    tap.connect(context.destination);
    const level = new Float32Array(analyser.fftSize);
    step('ready', true);
    return {
      rate: context.sampleRate,
      db: () => {
        analyser.getFloatTimeDomainData(level);
        let sum = 0;
        for (const sample of level) sum += sample * sample;
        return 20 * Math.log10(Math.sqrt(sum / level.length) + 1e-6);
      },
      stop: async () => {
        await new Promise<void>((resolve) => {
          flushed = resolve;
          setTimeout(resolve, FLUSH_WAIT_MS);
          tap.port.postMessage('flush');
        });
        release();
        return chunks;
      },
      abort: () => {
        chunks.length = 0;
        release();
      },
      onEnded: (listener) => stream.getAudioTracks()[0]?.addEventListener('ended', listener, { once: true }),
    };
  } catch (cause) {
    step(at, false, errorName(cause));
    release();
    throw cause;
  }
}
