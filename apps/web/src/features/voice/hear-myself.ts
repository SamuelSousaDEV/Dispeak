import recorderUrl from './recorder.worklet.js?url';
import { openMicrophone, type MicrophoneSettings, type NoiseEngine } from './microphone';
import { withCallOpus } from './voice-codec';

const SAMPLE_RATE = 48_000;
/**
 * The models and the codec take a moment to start, and send silence meanwhile: the recording
 * begins with the first sound that arrives, or after this long if the user stays quiet.
 */
const START_WAIT_SECONDS = 3;

export interface HeardRecording {
  samples: Float32Array;
  sampleRate: number;
  /** What cleaned the voice, which can differ from what the settings ask for. */
  noiseSuppression: NoiseEngine;
}

/**
 * Sends `track` from one peer connection to another inside this page, with Opus set as in a
 * call, and returns the track as it arrives.
 */
async function throughOpus(track: MediaStreamTrack): Promise<{
  received: MediaStreamTrack;
  close: () => void;
}> {
  const sender = new RTCPeerConnection();
  const receiver = new RTCPeerConnection();
  const close = () => {
    sender.close();
    receiver.close();
  };
  try {
    sender.onicecandidate = ({ candidate }) => {
      if (candidate) void receiver.addIceCandidate(candidate).catch(() => undefined);
    };
    receiver.onicecandidate = ({ candidate }) => {
      if (candidate) void sender.addIceCandidate(candidate).catch(() => undefined);
    };
    const arrived = new Promise<MediaStreamTrack>((resolve) => {
      receiver.ontrack = (event) => resolve(event.track);
    });
    sender.addTransceiver(track, { direction: 'sendonly' });
    const offer = await sender.createOffer();
    await sender.setLocalDescription(offer);
    await receiver.setRemoteDescription(offer);
    const answer = await receiver.createAnswer();
    await receiver.setLocalDescription(answer);
    // The answer tells the sender how to encode: here is where a call's settings go in.
    await sender.setRemoteDescription({ type: 'answer', sdp: withCallOpus(answer.sdp ?? '') });
    return { received: await arrived, close };
  } catch (error) {
    close();
    throw error;
  }
}

/**
 * Records `seconds` of the user's voice as the others hear it in a call: the microphone opened
 * as a call opens it (same filters, same chain), sent through Opus at a call's settings, and
 * taken where it arrives. Played back only afterwards: heard live, the echo cancellation would
 * take the user's own voice for an echo and remove it. `onLevel` gets the level (0–1) of what
 * arrives, from the moment the recording begins.
 */
export async function recordAsHeard(
  settings: MicrophoneSettings,
  seconds: number,
  onLevel: (level: number) => void,
  signal: AbortSignal,
): Promise<HeardRecording> {
  const microphone = await openMicrophone(settings);
  let loop: { received: MediaStreamTrack; close: () => void } | null = null;
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  // Chromium hands a remote track to the audio graph only while a media element plays it.
  const sink = new Audio();
  sink.muted = true;
  try {
    loop = await throughOpus(microphone.track);
    const stream = new MediaStream([loop.received]);
    sink.srcObject = stream;
    void sink.play().catch(() => undefined);
    await context.audioWorklet.addModule(recorderUrl);
    await context.resume();
    const recorder = new AudioWorkletNode(context, 'pcm-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    context.createMediaStreamSource(stream).connect(recorder);

    const length = Math.round(seconds * context.sampleRate);
    const samples = new Float32Array(length);
    let recorded = 0;
    let waited = 0;
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) reject(new DOMException('aborted', 'AbortError'));
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      recorder.port.onmessage = (event: MessageEvent<Array<Float32Array | null>>) => {
        const [piece] = event.data;
        if (!piece) return;
        if (recorded === 0 && waited < START_WAIT_SECONDS * context.sampleRate) {
          waited += piece.length;
          if (!piece.some((sample) => sample !== 0)) return;
        }
        samples.set(piece.subarray(0, length - recorded), recorded);
        recorded += piece.length;
        let peak = 0;
        for (const sample of piece) peak = Math.max(peak, Math.abs(sample));
        onLevel(peak);
        if (recorded >= length) resolve();
      };
    });
    return {
      samples,
      sampleRate: context.sampleRate,
      noiseSuppression: microphone.noiseSuppression,
    };
  } finally {
    sink.srcObject = null;
    loop?.close();
    microphone.close();
    void context.close().catch(() => undefined);
  }
}

/** 16-bit mono WAV of `samples`. */
export function toWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Blob {
  const header = new DataView(new ArrayBuffer(44));
  const text = (position: number, value: string) => {
    for (let index = 0; index < value.length; index++) {
      header.setUint8(position + index, value.charCodeAt(index));
    }
  };
  const pcm = new Int16Array(samples.length);
  for (const [index, sample] of samples.entries()) {
    pcm[index] = Math.round(Math.max(-1, Math.min(1, sample)) * 32_767);
  }
  text(0, 'RIFF');
  header.setUint32(4, 36 + pcm.byteLength, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, 'data');
  header.setUint32(40, pcm.byteLength, true);
  return new Blob([header, pcm], { type: 'audio/wav' });
}
