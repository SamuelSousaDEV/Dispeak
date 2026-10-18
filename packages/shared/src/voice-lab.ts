import { z } from 'zod';

/**
 * The versions of one recording the voice test plays, blind and in random order: the chain of a
 * call today, the alternatives under study, and the microphone untouched as a reference.
 */
export const VOICE_LAB_VARIANTS = [
  /** What a call sends today: the browser's gain, GTCRN, the treble restore, gate, leveler. */
  'current',
  /** DeepFilterNet 3 (full band) and a limiter, nothing else. */
  'deepfilter',
  /** DeepFilterNet 3 with a gentle leveler. */
  'deepfilterLeveled',
  /** RNNoise (full band) and a limiter. */
  'rnnoise',
  /** The microphone as captured, without any cleaning. */
  'raw',
] as const;
export const voiceLabVariantSchema = z.enum(VOICE_LAB_VARIANTS);
export type VoiceLabVariant = z.infer<typeof voiceLabVariantSchema>;

const decibels = z.number().min(-200).max(20).nullable();

/** One person's verdict after listening to every version of their own recording. */
export const voiceLabResultSchema = z
  .object({
    best: voiceLabVariantSchema,
    worst: voiceLabVariantSchema,
    /** The versions as they were offered, first one being "A". */
    order: z.array(voiceLabVariantSchema).length(VOICE_LAB_VARIANTS.length),
    /** The microphone's name as the browser lists it. */
    inputDevice: z.string().max(200).nullable(),
    /** Desktop app version; `null` in a browser. */
    appVersion: z.string().max(32).nullable(),
    /** Level of the voice and of the room between words, in the untouched recording (dBFS). */
    speechDb: decibels,
    noiseDb: decibels,
    comment: z.string().max(1000).nullable(),
  })
  .refine((result) => result.best !== result.worst, 'best and worst must differ');
export type VoiceLabResult = z.infer<typeof voiceLabResultSchema>;

export const voiceLabResultCreatedSchema = z.object({ id: z.string().uuid() });

/** The untouched recording, sent only when the person agrees: 16-bit mono WAV, 48 kHz. */
export const VOICE_LAB_RECORDING_MAX_BYTES = 3 * 1024 * 1024;
/** Recordings are deleted after this many days. */
export const VOICE_LAB_RETENTION_DAYS = 30;
