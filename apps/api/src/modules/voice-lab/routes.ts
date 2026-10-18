import {
  apiErrorSchema,
  idSchema,
  VOICE_LAB_RECORDING_MAX_BYTES,
  voiceLabResultCreatedSchema,
  voiceLabResultSchema,
} from '@frequencia/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { badRequest } from '../../errors';

/** The blind voice test: which version of their own voice people prefer. */
export const voiceLabRoutes: FastifyPluginAsyncZod = async (app) => {
  const { voiceLab } = app.ctx;
  const security = [{ bearerAuth: [] }];

  app.addHook('onRequest', app.authenticate);
  // Recordings arrive as raw bytes; this parser exists only inside this plugin.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: VOICE_LAB_RECORDING_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.post(
    '/voice-lab/results',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
      schema: {
        tags: ['voice-lab'],
        summary: 'Send the verdict of a blind voice test',
        security,
        body: voiceLabResultSchema,
        response: { 201: voiceLabResultCreatedSchema },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await voiceLab.record(request.auth.userId, request.body)),
  );

  app.put(
    '/voice-lab/results/:resultId/recording',
    {
      bodyLimit: VOICE_LAB_RECORDING_MAX_BYTES,
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
      schema: {
        tags: ['voice-lab'],
        summary: 'Attach the untouched recording to your verdict, for analysis',
        description:
          'Only with the consent of the person. The body is a 16-bit mono WAV file sent as ' +
          '`application/octet-stream`; it is deleted after 30 days.',
        security,
        consumes: ['application/octet-stream'],
        params: z.object({ resultId: idSchema }),
        response: { 204: z.null(), 404: apiErrorSchema },
      },
    },
    async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) throw badRequest('the body must be a WAV file');
      await voiceLab.attachRecording(request.auth.userId, request.params.resultId, request.body);
      return reply.code(204).send(null);
    },
  );
};
