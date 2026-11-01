/**
 * The browser's half of voice dictation: the microphone, the samples and the level. Audio stays in this page's memory
 * until the clip is posted to this page's own Inbox.
 *
 * The worklet comes from the Inbox's own origin (`/api/inbox/voice/worklet.js`): the window's CSP refuses one from
 * `blob:` or `data:`, on purpose.
 */
import { inboxUrl } from './inboxUrl';

export interface VoiceRecorder {
  rate: number;
  /** The loudness now, dBFS. */
  db(): number;
  /** Stop and hand over every sample. */
  stop(): Promise<Float32Array[]>;
  /** Stop and drop everything. */
  abort(): void;
  /** The microphone went away (unplugged, a phone call). */
  onEnded(listener: () => void): void;
}

/** The worklet's last samples arrive within a render quantum; never wait long for them. */
const FLUSH_WAIT_MS = 500;

/** Whether this page can reach a microphone at all: browsers allow it only on https or on the computer itself. */
export function microphoneUsable(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === true && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof AudioWorkletNode !== 'undefined';
}

/** Whether the browser will ask first. Unknown (a browser with no such query) counts as yes: the press is then a tap. */
export async function microphoneWillPrompt(): Promise<boolean> {
  try {
    return (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state === 'prompt';
  } catch {
    return true;
  }
}

/**
 * Open the microphone. Called inside the press: the AudioContext is made before the first await, or iOS leaves it
 * suspended. The browser's own echo, noise and gain handling stay on.
 */
export function openVoiceRecorder(): Promise<VoiceRecorder> {
  const context = new AudioContext();
  void context.resume().catch(() => {});
  return record(context).catch((cause: unknown) => {
    void context.close().catch(() => {});
    throw cause;
  });
}

async function record(context: AudioContext): Promise<VoiceRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const release = () => {
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
  };
  try {
    await context.audioWorklet.addModule(inboxUrl('/voice/worklet.js'));
    await context.resume();
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
    // The tap writes nothing to its output, so this plays silence: it only keeps the node pulled in every browser.
    tap.connect(context.destination);
    const level = new Float32Array(analyser.fftSize);
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
    release();
    throw cause;
  }
}
