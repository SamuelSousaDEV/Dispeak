import { voiceReportListSchema, voiceReportSchema } from '@frequencia/shared';
import { api } from '../../lib/http';

/** Telemetry of voices in past calls: the user's own, and those in servers the user owns. */
export const voiceReportApi = {
  list: async () => (await api('GET', '/voice-reports', { schema: voiceReportListSchema })).reports,
  get: (reportId: string) =>
    api('GET', `/voice-reports/${reportId}`, { schema: voiceReportSchema }),
};
