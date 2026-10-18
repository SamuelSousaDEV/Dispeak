/* global AudioWorkletProcessor, registerProcessor, sampleRate */
// Brings a voice to a steady level the slow way, like a hand on a fader: it follows the level
// of speech over a second or two and moves the gain gently, so the voice keeps its shape. A
// compressor that grabs every syllable (the old leveler) and the browser's own gain both
// lifted breath and hiss by 8 to 16 dB between 4 and 10 kHz (measured on a real microphone,
// 2026-10-18). Only speech moves it: between words (silence after the denoiser) it holds.
//
// Options: targetDb (level of speech it aims at), maxGainDb, minGainDb.

const BLOCK_SECONDS = 0.01;
/** Below this a block is not speech, and the gain holds. */
const SPEECH_DB = -50;
/** How fast the estimate of the speech level follows (seconds). */
const LEVEL_SECONDS = 1.2;
/** How fast the gain may move, in dB per second: up slowly, down faster (a shout). */
const RISE_DB_PER_SECOND = 6;
const FALL_DB_PER_SECOND = 24;
/** Until the first word has set the level, the gain gets there quickly (18 dB in 0.15 s). */
const SETTLE_DB_PER_SECOND = 120;
const SETTLE_SECONDS = 0.3;

class VoiceLeveler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { targetDb = -24, maxGainDb = 18, minGainDb = -12 } = options.processorOptions ?? {};
    this.targetDb = targetDb;
    this.maxGainDb = maxGainDb;
    this.minGainDb = minGainDb;
    this.blockSize = Math.round(sampleRate * BLOCK_SECONDS);
    this.sum = 0;
    this.count = 0;
    this.levelDb = null;
    this.gainDb = 0;
    this.wantedDb = 0;
    /** Seconds of speech heard so far, up to SETTLE_SECONDS. */
    this.heard = 0;
    this.alpha = 1 - Math.exp(-BLOCK_SECONDS / LEVEL_SECONDS);
  }

  endBlock() {
    const db = 10 * Math.log10(this.sum / this.count + 1e-12);
    this.sum = 0;
    this.count = 0;
    if (db < SPEECH_DB) return;
    this.heard += BLOCK_SECONDS;
    // The first word sets the level at once; later ones nudge it.
    this.levelDb = this.levelDb === null ? db : this.levelDb + this.alpha * (db - this.levelDb);
    this.wantedDb = Math.min(
      this.maxGainDb,
      Math.max(this.minGainDb, this.targetDb - this.levelDb),
    );
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }
    const settling = this.heard < SETTLE_SECONDS;
    const rise = (settling ? SETTLE_DB_PER_SECOND : RISE_DB_PER_SECOND) / sampleRate;
    const fall = FALL_DB_PER_SECOND / sampleRate;
    for (let index = 0; index < input.length; index++) {
      const sample = input[index];
      this.sum += sample * sample;
      if (++this.count >= this.blockSize) this.endBlock();
      const step = this.wantedDb - this.gainDb;
      this.gainDb += step > 0 ? Math.min(step, rise) : Math.max(step, -fall);
      output[index] = sample * 10 ** (this.gainDb / 20);
    }
    return true;
  }
}

registerProcessor('voice-leveler', VoiceLeveler);
