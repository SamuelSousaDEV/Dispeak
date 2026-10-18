import type { VoiceLabVariant } from '@frequencia/shared';
import type { DeepFilter } from '@lofcz/deepfilternet-web';
import dfWasmUrl from '@lofcz/deepfilternet-web/df_bg.wasm?url';
import {
  buildChain,
  loadChainModules,
  type MicrophoneProcessing,
} from '../voice/noise-suppression';
import { LAB_SAMPLE_RATE, type LabRecording } from './record';

/** The same as a call: `microphone.ts`. */
const GATE_THRESHOLD_DB = -50;
/** Rendered past the end, for the delay of the models (GTCRN holds back 32 ms). */
const TAIL_SECONDS = 0.1;
/** Every version is played at this level of speech, so none wins by being louder. */
const TARGET_SPEECH_DB = -20;

export interface LabSettings {
  noiseSuppression: boolean;
  voiceLeveler: boolean;
  micGain: number;
}

const rms = (samples: Float32Array, from: number, to: number) => {
  let sum = 0;
  for (let index = from; index < to; index++) sum += (samples[index] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
};
const toDb = (value: number) => 20 * Math.log10(Math.max(value, 1e-10));

/** Levels (dBFS) of 20 ms pieces, quietest first. */
function frameLevels(samples: Float32Array): number[] {
  const size = LAB_SAMPLE_RATE / 50;
  const levels: number[] = [];
  for (let start = 0; start + size <= samples.length; start += size) {
    levels.push(toDb(rms(samples, start, start + size)));
  }
  return levels.sort((a, b) => a - b);
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? -200;

/** Level of the voice (loud pieces) and of the room (quiet pieces) in a recording. */
export function measureLevels(samples: Float32Array): { speechDb: number; noiseDb: number } {
  const levels = frameLevels(samples);
  const round = (value: number) => Math.round(value * 10) / 10;
  return { speechDb: round(percentile(levels, 0.9)), noiseDb: round(percentile(levels, 0.1)) };
}

/** Brings the voice to the common level, without letting a peak clip. */
function matchLoudness(samples: Float32Array): Float32Array {
  const speech = percentile(frameLevels(samples), 0.9);
  let gain = 10 ** ((TARGET_SPEECH_DB - speech) / 20);
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak * gain > 0.98) gain = 0.98 / peak;
  return samples.map((sample) => sample * gain);
}

/**
 * Renders `input` through the chain of a call, offline. The models start in their worklets
 * asynchronously: the rendering waits at its very start until they answer, or the beginning
 * (sometimes all of it) comes out silent.
 */
async function throughChain(
  input: Float32Array,
  processing: MicrophoneProcessing,
  warmupMs = 600,
): Promise<Float32Array> {
  const length = input.length + Math.round(TAIL_SECONDS * LAB_SAMPLE_RATE);
  const context = new OfflineAudioContext(1, length, LAB_SAMPLE_RATE);
  const binary = await loadChainModules(context, processing);
  const buffer = context.createBuffer(1, input.length, LAB_SAMPLE_RATE);
  buffer.copyToChannel(new Float32Array(input), 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  const { nodes, denoiser } = buildChain(context, source, processing, binary);
  nodes.at(-1)?.connect(context.destination);
  source.start(0);
  void context.suspend(0).then(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, warmupMs));
    await context.resume();
  });
  const rendered = await context.startRendering();
  denoiser?.destroy();
  const output = rendered.getChannelData(0);
  // A model that was still not ready leaves silence where there was a voice: once more, longer.
  if (
    processing.model &&
    rms(output, 0, output.length) < 1e-5 &&
    rms(input, 0, input.length) > 1e-4
  ) {
    if (warmupMs < 3000) return throughChain(input, processing, warmupMs * 3);
    throw new Error(`the ${processing.model} model did not start`);
  }
  return output;
}

let deepFilter: Promise<DeepFilter> | null = null;

/** Loads DeepFilterNet 3 (34 MB, kept by the browser after the first time). */
export function loadDeepFilter() {
  deepFilter ??= import('@lofcz/deepfilternet-web')
    .then((module) => module.DeepFilter.create({ wasmUrl: dfWasmUrl }))
    .catch((error: unknown) => {
      deepFilter = null;
      throw error;
    });
  return deepFilter;
}

async function throughDeepFilter(input: Float32Array): Promise<Float32Array> {
  const filter = await loadDeepFilter();
  const size = filter.frameLength;
  const output = new Float32Array(input.length);
  for (let start = 0; start + size <= input.length; start += size) {
    output.set(filter.process(input.slice(start, start + size)), start);
  }
  return output;
}

/** One version of the recording, at the common level. */
export async function renderVariant(
  variant: VoiceLabVariant,
  recording: LabRecording,
  settings: LabSettings,
): Promise<Float32Array> {
  const plain = (leveler: boolean): MicrophoneProcessing => ({
    model: null,
    gateThresholdDb: null,
    leveler,
    gain: settings.micGain,
  });
  let samples: Float32Array;
  switch (variant) {
    case 'current':
      samples = await throughChain(recording.asCall, {
        model: settings.noiseSuppression ? 'gtcrn' : null,
        gateThresholdDb: GATE_THRESHOLD_DB,
        leveler: settings.voiceLeveler,
        gain: settings.micGain,
      });
      break;
    case 'deepfilter':
      samples = await throughChain(await throughDeepFilter(recording.raw), plain(false));
      break;
    case 'deepfilterLeveled':
      samples = await throughChain(await throughDeepFilter(recording.raw), plain(true));
      break;
    case 'rnnoise':
      samples = await throughChain(recording.raw, {
        model: 'rnnoise',
        gateThresholdDb: null,
        leveler: false,
        gain: settings.micGain,
      });
      break;
    case 'raw':
      samples = recording.raw;
      break;
  }
  return matchLoudness(samples);
}

/** 16-bit mono WAV at the lab's rate. */
export function toWav(samples: Float32Array): Blob {
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
  header.setUint32(24, LAB_SAMPLE_RATE, true);
  header.setUint32(28, LAB_SAMPLE_RATE * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, 'data');
  header.setUint32(40, pcm.byteLength, true);
  return new Blob([header, pcm], { type: 'audio/wav' });
}
