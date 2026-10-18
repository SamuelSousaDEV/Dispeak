import type { SoundEvent } from './sound-events';

const SAMPLE_RATE = 44_100;

interface Note {
  /** Hz. */
  frequency: number;
  /** Seconds. */
  duration: number;
}

/** The built-in sounds: rising notes for things starting, falling notes for things ending. */
const TONES: Record<SoundEvent, Note[]> = {
  join: [
    { frequency: 523.25, duration: 0.09 },
    { frequency: 783.99, duration: 0.16 },
  ],
  leave: [
    { frequency: 783.99, duration: 0.09 },
    { frequency: 523.25, duration: 0.16 },
  ],
  streamStart: [
    { frequency: 659.25, duration: 0.07 },
    { frequency: 880, duration: 0.07 },
    { frequency: 1046.5, duration: 0.14 },
  ],
  streamStop: [
    { frequency: 880, duration: 0.07 },
    { frequency: 659.25, duration: 0.07 },
    { frequency: 440, duration: 0.14 },
  ],
  watchStart: [
    { frequency: 587.33, duration: 0.06 },
    { frequency: 880, duration: 0.12 },
  ],
  watchStop: [
    { frequency: 880, duration: 0.06 },
    { frequency: 587.33, duration: 0.12 },
  ],
  // Higher and shorter than the rest: a small tap while the streamer plays.
  viewerJoin: [
    { frequency: 1174.66, duration: 0.05 },
    { frequency: 1567.98, duration: 0.09 },
  ],
  viewerLeave: [
    { frequency: 1567.98, duration: 0.05 },
    { frequency: 1174.66, duration: 0.09 },
  ],
};

/** Mono 16-bit samples of a sequence of sine notes, each with a soft attack and decay. */
function synthesize(notes: Note[]): Int16Array<ArrayBuffer> {
  const total = notes.reduce((sum, note) => sum + Math.round(note.duration * SAMPLE_RATE), 0);
  const samples = new Int16Array(new ArrayBuffer(total * 2));
  let offset = 0;
  for (const note of notes) {
    const length = Math.round(note.duration * SAMPLE_RATE);
    const attack = Math.min(length, Math.round(0.006 * SAMPLE_RATE));
    for (let index = 0; index < length; index++) {
      const envelope = Math.min(1, index / attack) * Math.exp((-4 * index) / length);
      const value = Math.sin((2 * Math.PI * note.frequency * index) / SAMPLE_RATE);
      samples[offset + index] = Math.round(value * envelope * 0.5 * 32_767);
    }
    offset += length;
  }
  return samples;
}

/** A friend calling: two rising pairs and a pause, meant to be played in a loop. */
const RING: Note[] = [
  { frequency: 659.25, duration: 0.14 },
  { frequency: 880, duration: 0.22 },
  { frequency: 659.25, duration: 0.14 },
  { frequency: 880, duration: 0.3 },
];
const RING_PAUSE_SECONDS = 1.4;

/** A WAV file holding the built-in sound of an event. */
export function toneWav(event: SoundEvent): Blob {
  return wav(synthesize(TONES[event]));
}

/** A WAV file with one cycle of the ring of an incoming call, silence included. */
export function ringWav(): Blob {
  const notes = synthesize(RING);
  const samples = new Int16Array(
    new ArrayBuffer((notes.length + Math.round(RING_PAUSE_SECONDS * SAMPLE_RATE)) * 2),
  );
  samples.set(notes);
  return wav(samples);
}

function wav(samples: Int16Array<ArrayBuffer>): Blob {
  const header = new DataView(new ArrayBuffer(44));
  const text = (position: number, value: string) => {
    for (let index = 0; index < value.length; index++) {
      header.setUint8(position + index, value.charCodeAt(index));
    }
  };
  text(0, 'RIFF');
  header.setUint32(4, 36 + samples.byteLength, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, SAMPLE_RATE, true);
  header.setUint32(28, SAMPLE_RATE * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, 'data');
  header.setUint32(40, samples.byteLength, true);
  return new Blob([header, samples], { type: 'audio/wav' });
}
