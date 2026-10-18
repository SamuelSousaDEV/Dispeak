import { voiceLabResultCreatedSchema, type VoiceLabResult } from '@frequencia/shared';
import { api } from '../../lib/http';

export const voiceLabApi = {
  send: (result: VoiceLabResult) =>
    api('POST', '/voice-lab/results', { body: result, schema: voiceLabResultCreatedSchema }),
  attachRecording: (resultId: string, wav: Blob) =>
    api('PUT', `/voice-lab/results/${resultId}/recording`, {
      body: new Blob([wav], { type: 'application/octet-stream' }),
    }),
};
