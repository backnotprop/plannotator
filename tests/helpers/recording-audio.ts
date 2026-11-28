export interface AudioRecord {
  contexts: number;
  freqs: number[];
  autoplay: boolean;
}

export function newAudioRecord(): AudioRecord {
  return { contexts: 0, freqs: [], autoplay: false };
}

export function recordingAudioContext(record: AudioRecord) {
  const param = (onSet?: (value: number) => void) => ({
    value: 1,
    setValueAtTime(value: number) {
      onSet?.(value);
    },
    exponentialRampToValueAtTime() {},
  });
  return class RecordingAudioContext {
    state: AudioContextState = record.autoplay ? 'running' : 'suspended';
    currentTime = 0;
    destination = {};
    constructor() {
      record.contexts++;
    }
    resume() {
      this.state = 'running';
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
    createGain() {
      return { gain: param(), connect: (to: unknown) => to };
    }
    createOscillator() {
      return { type: 'sine', frequency: param((value) => record.freqs.push(value)), connect: (to: unknown) => to, start() {}, stop() {} };
    }
  };
}

export function timesPlayed(record: AudioRecord, freq: number): number {
  return record.freqs.filter((value) => Math.abs(value - freq) < 0.01).length;
}
