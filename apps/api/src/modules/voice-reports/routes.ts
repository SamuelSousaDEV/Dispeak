import {
  apiErrorSchema,
  idSchema,
  voiceReportListSchema,
  voiceReportSchema,
} from '@frequencia/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

/** Telemetry of voices in past calls, for the speaker and the owner of the server. */
export const voiceReportRoutes: FastifyPluginAsyncZod = async (app) => {
  const { voiceReports } = app.ctx;
  const security = [{ bearerAuth: [] }];

  app.addHook('onRequest', app.authenticate);

  app.get(
    '/voice-reports',
    {
      schema: {
        tags: ['voice'],
        summary: 'Recent voices of yours in calls, or of calls in a server you own',
        security,
        response: { 200: voiceReportListSchema },
      },
    },
    async (request) => ({ reports: await voiceReports.list(request.auth.userId) }),
  );

  app.get(
    '/voice-reports/:reportId',
    {
      schema: {
        tags: ['voice'],
        summary: 'One voice in a call, measured at the speaker, the server and each listener',
        security,
        params: z.object({ reportId: idSchema }),
        response: { 200: voiceReportSchema, 404: apiErrorSchema },
      },
    },
    (request) => voiceReports.get(request.auth.userId, request.params.reportId),
  );
};
