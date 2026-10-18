import type { MicrophoneSettings } from '../voice/microphone';
import recorderUrl from './recorder.worklet.js?url';

export const LAB_SAMPLE_RATE = 48_000;

export interface LabRecording {
  /** The microphone untouched: no echo cancellation, no gain, no cleaning by the browser. */
  raw: Float32Array;
  /**
   * The same moment as a call captures it (the browser's echo cancellation and gain as the user
   * set them), which is what the chain of a call works on.
   */
  asCall: Float32Array;
  /** The microphone's name, as the browser lists it. */
  device: string | null;
}

function constraints(settings: MicrophoneSettings, asCall: boolean): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: asCall && settings.echoCancellation,
      autoGainControl: asCall && settings.autoGainControl,
      noiseSuppression: false,
      channelCount: { ideal: 1 },
      sampleRate: { ideal: LAB_SAMPLE_RATE },
      ...(settings.inputDeviceId ? { deviceId: { ideal: settings.inputDeviceId } } : {}),
    },
  };
}

function join(pieces: Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length);
  let offset = 0;
  for (const piece of pieces) {
    if (offset >= length) break;
    out.set(piece.subarray(0, length - offset), offset);
    offset += piece.length;
  }
  return out;
}

/**
 * Records `seconds` of the microphone, untouched and as a call captures it, at the same time.
 * `onLevel` gets the untouched level (0–1) as it goes. A browser that cannot open the device
 * twice with different processing gets the untouched recording for both.
 */
export async function recordMicrophone(
  settings: MicrophoneSettings,
  seconds: number,
  onLevel: (level: number) => void,
  signal: AbortSignal,
): Promise<LabRecording> {
  const raw = await navigator.mediaDevices.getUserMedia(constraints(settings, false));
  const asCall = await navigator.mediaDevices
    .getUserMedia(constraints(settings, true))
    .catch(() => null);
  const streams = [raw, ...(asCall ? [asCall] : [])];
  const context = new AudioContext({ sampleRate: LAB_SAMPLE_RATE });
  try {
    await context.audioWorklet.addModule(recorderUrl);
    await context.resume();
    const recorder = new AudioWorkletNode(context, 'voice-lab-recorder', {
      numberOfInputs: 2,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    context.createMediaStreamSource(raw).connect(recorder, 0, 0);
    context.createMediaStreamSource(asCall ?? raw).connect(recorder, 0, 1);

    const length = Math.round(seconds * context.sampleRate);
    const rawPieces: Float32Array[] = [];
    const callPieces: Float32Array[] = [];
    let recorded = 0;
    await new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      recorder.port.onmessage = (event: MessageEvent<Array<Float32Array | null>>) => {
        const [first, second] = event.data;
        if (!first) return;
        rawPieces.push(first);
        callPieces.push(second ?? first);
        recorded += first.length;
        let peak = 0;
        for (const sample of first) peak = Math.max(peak, Math.abs(sample));
        onLevel(peak);
        if (recorded >= length) resolve();
      };
    });
    const track = raw.getAudioTracks()[0];
    return {
      raw: join(rawPieces, length),
      asCall: join(callPieces, length),
      device: track?.label.slice(0, 200) || null,
    };
  } finally {
    for (const stream of streams) for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => undefined);
  }
}
