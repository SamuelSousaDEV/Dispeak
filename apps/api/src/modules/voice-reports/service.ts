import {
  voiceSampleSchema,
  type apiInternalSide,
  type EventData,
  type VoiceReport,
  type VoiceReportSummary,
} from '@frequencia/shared';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { schema, type Database } from '../../db/client';
import { notFound } from '../../errors';
import type { Redis } from '../../redis';

const { voiceReports, channels, guilds, users } = schema;

export type VoiceReportEvent = EventData<typeof apiInternalSide, 'voice-report'>;

const eventKey = (eventId: string) => `voice-report:event:${eventId}`;
const EVENT_DEDUPE_SECONDS = 600;
/** Reports older than this are deleted. */
export const VOICE_REPORT_RETENTION_DAYS = 30;
const LIST_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const summaryColumns = {
  id: voiceReports.id,
  channelId: voiceReports.channelId,
  channelName: channels.name,
  guildName: guilds.name,
  userId: voiceReports.userId,
  userName: users.displayName,
  startedAt: voiceReports.startedAt,
  endedAt: voiceReports.endedAt,
  sampleCount: sql<number>`jsonb_array_length(${voiceReports.samples})`.mapWith(Number),
};

interface SummaryRow extends Omit<VoiceReportSummary, 'startedAt' | 'endedAt'> {
  startedAt: Date;
  endedAt: Date | null;
}

function toSummary(row: SummaryRow): VoiceReportSummary {
  return {
    ...row,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

export interface VoiceReportServiceDeps {
  db: Database;
  redis: Redis;
  log: FastifyBaseLogger;
}

/**
 * Keeps the telemetry the media service sends about voices in calls, and shows it to the
 * people it concerns: the speaker, and the owner of the server the call happened in.
 */
export class VoiceReportService {
  constructor(private readonly deps: VoiceReportServiceDeps) {}

  /** Stores one chunk of a voice: creates its report, or adds to it. */
  async record(event: VoiceReportEvent): Promise<void> {
    // Lab rooms and meetings are not channels, and lab people are not users.
    if (!UUID.test(event.roomId) || !UUID.test(event.userId) || !UUID.test(event.producerId)) {
      return;
    }
    // Every API instance receives the event; only the first one to claim it stores it.
    const claimed = await this.deps.redis.set(
      eventKey(event.eventId),
      '1',
      'EX',
      EVENT_DEDUPE_SECONDS,
      'NX',
    );
    if (!claimed) return;

    const samples = JSON.stringify(event.samples);
    const endedAt = event.endedAt ? new Date(event.endedAt) : null;
    try {
      await this.deps.db
        .insert(voiceReports)
        .values({
          id: event.producerId,
          channelId: event.roomId,
          userId: event.userId,
          startedAt: new Date(event.startedAt),
          endedAt,
          samples: sql`${samples}::jsonb`,
        })
        .onConflictDoUpdate({
          target: voiceReports.id,
          set: {
            samples: sql`${voiceReports.samples} || ${samples}::jsonb`,
            endedAt: sql`coalesce(excluded.ended_at, ${voiceReports.endedAt})`,
          },
        });
    } catch (error) {
      // The channel or the user may be gone already, or it was a meeting: nothing to keep.
      this.deps.log.debug({ err: error, producerId: event.producerId }, 'voice report dropped');
    }
  }

  /** Recent voices of the user, or of calls in a server the user owns. */
  async list(userId: string): Promise<VoiceReportSummary[]> {
    const rows = await this.deps.db
      .select(summaryColumns)
      .from(voiceReports)
      .innerJoin(channels, eq(channels.id, voiceReports.channelId))
      .innerJoin(guilds, eq(guilds.id, channels.guildId))
      .innerJoin(users, eq(users.id, voiceReports.userId))
      .where(this.visibleTo(userId))
      .orderBy(desc(voiceReports.startedAt))
      .limit(LIST_LIMIT);
    return rows.map(toSummary);
  }

  async get(userId: string, reportId: string): Promise<VoiceReport> {
    const [row] = await this.deps.db
      .select({ ...summaryColumns, samples: voiceReports.samples })
      .from(voiceReports)
      .innerJoin(channels, eq(channels.id, voiceReports.channelId))
      .innerJoin(guilds, eq(guilds.id, channels.guildId))
      .innerJoin(users, eq(users.id, voiceReports.userId))
      .where(and(eq(voiceReports.id, reportId), this.visibleTo(userId)));
    if (!row) throw notFound('voice report');
    const { samples, ...summary } = row;
    // Stored as the media service sent them, anything unreadable left out, in order.
    const parsed = z.array(z.unknown()).safeParse(samples);
    const readable = (parsed.success ? parsed.data : [])
      .flatMap((sample) => {
        const result = voiceSampleSchema.safeParse(sample);
        return result.success ? [result.data] : [];
      })
      .sort((a, b) => a.t - b.t);
    const listenerIds = [
      ...new Set(readable.flatMap((sample) => sample.listeners.map((listener) => listener.userId))),
    ].filter((id) => UUID.test(id));
    const listeners =
      listenerIds.length > 0
        ? await this.deps.db
            .select({ id: users.id, name: users.displayName })
            .from(users)
            .where(inArray(users.id, listenerIds))
        : [];
    return {
      ...toSummary(summary),
      samples: readable,
      listenerNames: Object.fromEntries(listeners.map((listener) => [listener.id, listener.name])),
    };
  }

  /** Deletes reports past the retention period. */
  async sweep(): Promise<number> {
    const cutoff = new Date(Date.now() - VOICE_REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const deleted = await this.deps.db
      .delete(voiceReports)
      .where(lt(voiceReports.startedAt, cutoff))
      .returning({ id: voiceReports.id });
    return deleted.length;
  }

  private visibleTo(userId: string) {
    return or(
      eq(voiceReports.userId, userId),
      and(eq(guilds.ownerId, userId), eq(guilds.kind, 'server')),
    );
  }
}
