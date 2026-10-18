import {
  GtcrnWorkletNode,
  loadGtcrn,
  loadRnnoise,
  NoiseGateWorkletNode,
  RnnoiseWorkletNode,
} from '@sapphi-red/web-noise-suppressor';
import gtcrnWasmUrl from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url';
// The worklets are self-contained modules, so they are shipped as they are. Bundling them as
// workers (`?worker&url`) rewrites `import.meta.url` to `self.location`, and an AudioWorklet has
// no `self`: the production build then failed to register the processor.
import gtcrnWorkletUrl from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url';
import noiseGateWorkletUrl from '@sapphi-red/web-noise-suppressor/noiseGateWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import highbandRestoreUrl from './highband-restore.worklet.js?url';

/** Both models run at this rate. */
const SAMPLE_RATE = 48_000;
const RESUME_TIMEOUT_MS = 1500;
/** How long the gate stays open after the voice drops below the threshold. */
const GATE_HOLD_MS = 180;
/** The gate closes a little below where it opens, so it does not flutter at the edge. */
const GATE_HYSTERESIS_DB = 6;
/** Below the lowest voices (a deep male voice starts around 85 Hz, and is carried by its harmonics). */
const RUMBLE_CUTOFF_HZ = 100;
/**
 * Two biquads with these Q values in series make a fourth-order Butterworth filter. Web Audio
 * reads the Q of a high-pass in decibels: given as plain numbers (until 2026-10-18) both
 * sections resonated and lifted 100-200 Hz by up to 3.7 dB, a boomy, muffled voice.
 */
const RUMBLE_FILTER_Q = [0.5412, 1.3066].map((q) => 20 * Math.log10(q));

/**
 * The neural models that can clean the microphone. RNNoise works on the full band (48 kHz).
 * GTCRN removes more, but it is a 16 kHz model: everything above 8 kHz leaves it, and on its own
 * the voice sounds like a phone line. Behind it, `highband-restore.worklet.js` gives that treble
 * back wherever the model kept the voice.
 */
export type DenoiseModel = 'rnnoise' | 'gtcrn';

export interface MicrophoneProcessing {
  /** Neural model to run, or `null` to leave the cleaning to the browser (or to nobody). */
  model: DenoiseModel | null;
  /**
   * Level (dB) the cleaned signal must reach for anything to be sent, or `null` for no gate.
   * What a model lets through between words (a key press, a click) is quiet: the gate drops it.
   */
  gateThresholdDb: number | null;
  /** Evens out loud and quiet moments and raises the whole voice. */
  leveler: boolean;
  /** Volume chosen by the user for their own microphone (1 = as captured). */
  gain: number;
}

export interface ProcessedTrack {
  track: MediaStreamTrack;
  close: () => void;
}

/** Whether the settings ask for anything at all; when not, the capture is sent as it is. */
export const needsProcessing = ({ model, leveler, gain }: MicrophoneProcessing) =>
  model !== null || leveler || gain !== 1;

const binaries = new Map<DenoiseModel, Promise<ArrayBuffer>>();

function loadModel(model: DenoiseModel): Promise<ArrayBuffer> {
  let binary = binaries.get(model);
  if (!binary) {
    binary = (
      model === 'gtcrn'
        ? loadGtcrn({ url: gtcrnWasmUrl })
        : loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl })
    ).catch((error: unknown) => {
      binaries.delete(model);
      throw error;
    });
    binaries.set(model, binary);
  }
  return binary;
}

/**
 * Runs a microphone track through the chosen chain — denoiser, gate, leveler, volume — and
 * returns the resulting track. The source track stays owned by the caller. Throws when the
 * browser cannot run the chain (no AudioWorklet, no 48 kHz context, audio blocked); the caller
 * falls back.
 */
export async function processMicrophone(
  source: MediaStreamTrack,
  { model, gateThresholdDb, leveler, gain }: MicrophoneProcessing,
): Promise<ProcessedTrack> {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  try {
    const binary = await loadChainModules(context, { model, gateThresholdDb, leveler, gain });
    // A context created outside a user gesture can start suspended and never produce audio.
    await Promise.race([
      context.resume(),
      new Promise((resolve) => window.setTimeout(resolve, RESUME_TIMEOUT_MS)),
    ]);
    if (context.state !== 'running') throw new Error(`audio context is ${context.state}`);

    const chain = buildChain(
      context,
      context.createMediaStreamSource(new MediaStream([source])),
      { model, gateThresholdDb, leveler, gain },
      binary,
    );
    const { nodes, denoiser } = chain;
    const output = context.createMediaStreamDestination();
    nodes.at(-1)?.connect(output);
    nodes.push(output);
    const [track] = output.stream.getAudioTracks();
    if (!track) throw new Error('audio graph produced no track');

    // Mobile browsers suspend the context on interruptions (a phone call, another app).
    const onStateChange = () => {
      if (context.state !== 'running' && context.state !== 'closed') {
        context.resume().catch(() => undefined);
      }
    };
    context.addEventListener('statechange', onStateChange);

    return {
      track,
      close: () => {
        context.removeEventListener('statechange', onStateChange);
        for (const node of nodes) node.disconnect();
        denoiser?.destroy();
        track.stop();
        context.close().catch(() => undefined);
      },
    };
  } catch (error) {
    context.close().catch(() => undefined);
    throw error;
  }
}

/** The nodes of a chain, wired in order from the input; the last one is its output. */
export interface Chain {
  nodes: AudioNode[];
  denoiser: GtcrnWorkletNode | RnnoiseWorkletNode | null;
}

/**
 * Wires the chain — rumble filter, model, treble restore, gate, leveler, volume, limiter —
 * behind `input`, in any audio context: the live one of a call, or an offline one that renders
 * a recording the same way (the voice test). The worklets of the chain must be loaded already
 * (`loadChainModules`), and `binary` is the model's.
 */
export function buildChain(
  context: BaseAudioContext,
  input: AudioNode,
  { model, gateThresholdDb, leveler, gain }: MicrophoneProcessing,
  binary: ArrayBuffer | null,
): Chain {
  const gated = model !== null && gateThresholdDb !== null;
  const nodes: AudioNode[] = [input];
  if (model) {
    // Wind, breath on the capsule and desk thumps live below the voice, where the models are
    // at their weakest: a steep high-pass (24 dB per octave) takes them out before the model.
    for (const q of RUMBLE_FILTER_Q) {
      const highpass = context.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = RUMBLE_CUTOFF_HZ;
      highpass.Q.value = q;
      nodes.push(highpass);
    }
  }
  // The library types ask for an AudioContext, but only hand it on to AudioWorkletNode, which
  // takes an offline context just as well.
  const workletContext = context as AudioContext;
  const denoiser =
    model && binary
      ? model === 'gtcrn'
        ? new GtcrnWorkletNode(workletContext, { maxChannels: 1, wasmBinary: binary })
        : new RnnoiseWorkletNode(workletContext, { maxChannels: 1, wasmBinary: binary })
      : null;
  // What goes into the model, for the treble it cannot keep.
  const beforeModel = nodes.at(-1);
  if (denoiser) nodes.push(denoiser);
  if (model === 'gtcrn' && beforeModel) {
    const restore = new AudioWorkletNode(context, 'highband-restore', {
      numberOfInputs: 2,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    // Input 0 (the model's output) is wired with the rest of the chain below.
    beforeModel.connect(restore, 0, 1);
    nodes.push(restore);
  }
  if (gated) {
    nodes.push(
      new NoiseGateWorkletNode(workletContext, {
        openThreshold: gateThresholdDb,
        closeThreshold: gateThresholdDb - GATE_HYSTERESIS_DB,
        holdMs: GATE_HOLD_MS,
        maxChannels: 1,
      }),
    );
  }
  if (leveler) {
    // Brings the loud moments down and raises the rest: the node makes up for what it takes
    // away by itself, so no gain is added here. Measured: a voice captured at -25 dBFS (where
    // browsers leave it, faint next to other apps) goes out at -15, a quiet one at -40 goes
    // out at -29, and a shout at -3 stays at -7.
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -30;
    compressor.knee.value = 12;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.2;
    nodes.push(compressor);
  }
  const volume = context.createGain();
  volume.gain.value = gain;
  nodes.push(volume);
  // A wall just below full scale: a shout or a boosted microphone never clips.
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.1;
  nodes.push(limiter);
  for (const [index, node] of nodes.entries()) {
    const next = nodes[index + 1];
    if (next) node.connect(next);
  }
  return { nodes, denoiser };
}

/** Loads the model and the worklets a chain needs into `context`; answers the model's binary. */
export async function loadChainModules(
  context: BaseAudioContext,
  { model, gateThresholdDb }: MicrophoneProcessing,
): Promise<ArrayBuffer | null> {
  const gated = model !== null && gateThresholdDb !== null;
  const [binary] = await Promise.all([
    model ? loadModel(model) : null,
    model
      ? context.audioWorklet.addModule(model === 'gtcrn' ? gtcrnWorkletUrl : rnnoiseWorkletUrl)
      : null,
    model === 'gtcrn' ? context.audioWorklet.addModule(highbandRestoreUrl) : null,
    gated ? context.audioWorklet.addModule(noiseGateWorkletUrl) : null,
  ]);
  return binary;
}
