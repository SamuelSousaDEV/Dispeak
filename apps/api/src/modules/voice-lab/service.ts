import { VOICE_LAB_RETENTION_DAYS, type VoiceLabResult } from '@frequencia/shared';
import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import { badRequest, notFound } from '../../errors';

const { voiceLabResults } = schema;

/** "RIFF....WAVE": the recording is a WAV file, as the page makes it. */
function isWav(data: Buffer): boolean {
  return (
    data.length > 44 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WAVE'
  );
}

/** The verdicts of the blind voice test, and the recordings people chose to send with them. */
export class VoiceLabService {
  constructor(private readonly db: Database) {}

  async record(userId: string, result: VoiceLabResult): Promise<{ id: string }> {
    const { best, worst, ...details } = result;
    const [row] = await this.db
      .insert(voiceLabResults)
      .values({ userId, best, worst, details })
      .returning({ id: voiceLabResults.id });
    if (!row) throw new Error('voice lab result was not stored');
    return row;
  }

  /** Attaches the untouched recording to the person's own verdict, once. */
  async attachRecording(userId: string, resultId: string, data: Buffer): Promise<void> {
    if (!isWav(data)) throw badRequest('the recording must be a WAV file');
    const updated = await this.db
      .update(voiceLabResults)
      .set({ recording: data })
      .where(
        and(
          eq(voiceLabResults.id, resultId),
          eq(voiceLabResults.userId, userId),
          isNull(voiceLabResults.recording),
        ),
      )
      .returning({ id: voiceLabResults.id });
    if (updated.length === 0) throw notFound('voice test result');
  }

  /** Recordings go after a few weeks; the verdicts stay. */
  async sweep(): Promise<number> {
    const cutoff = new Date(Date.now() - VOICE_LAB_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const cleared = await this.db
      .update(voiceLabResults)
      .set({ recording: null })
      .where(and(lt(voiceLabResults.createdAt, cutoff), isNotNull(voiceLabResults.recording)))
      .returning({ id: voiceLabResults.id });
    return cleared.length;
  }
}
