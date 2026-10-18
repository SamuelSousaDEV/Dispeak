import type { VoiceReport, VoiceSample } from '@frequencia/shared';

/** Above this share of a voice lost or made up, people hear it. */
const AUDIBLE_PERCENT = 1;
/** A window this bad is a moment someone noticed, even if the average is fine. */
const BAD_WINDOW_PERCENT = 5;

const ENGINES: Record<string, string> = {
  gtcrn: 'SUPRESSÃO GTCRN',
  rnnoise: 'SUPRESSÃO RNNOISE',
  browser: 'FILTRO DO NAVEGADOR',
  off: 'SEM SUPRESSÃO',
};

export interface ListenerSummary {
  userId: string;
  name: string;
  lossPercent: number | null;
  concealedPercent: number | null;
  /** The worst window, by the share of the voice made up. */
  worstConcealedPercent: number | null;
  jitterMs: number | null;
  jitterBufferMs: number | null;
  rttMs: number | null;
}

export interface VoiceSummary {
  speaker: {
    noiseSuppression: string | null;
    echoCancellation: boolean | null;
    autoGainControl: boolean | null;
    rttMs: number | null;
  };
  server: {
    kbps: number | null;
    /** Of the packets sent, those lost before reaching the server. */
    lossPercent: number | null;
    worstLossPercent: number | null;
  };
  listeners: ListenerSummary[];
  /** What went wrong, in plain words, worst first; empty when the voice arrived whole. */
  findings: string[];
}

const tenth = (value: number) => Math.round(value * 10) / 10;

function mean(values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number');
  return present.length > 0
    ? tenth(present.reduce((sum, value) => sum + value, 0) / present.length)
    : null;
}

function max(values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number');
  return present.length > 0 ? Math.max(...present) : null;
}

function lastOf<T>(samples: VoiceSample[], pick: (sample: VoiceSample) => T | null | undefined) {
  for (let index = samples.length - 1; index >= 0; index--) {
    const sample = samples[index];
    const value = sample ? pick(sample) : null;
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

const lossOf = (sample: VoiceSample) => {
  const { packets, packetsLost } = sample.server;
  return packets + packetsLost > 0 ? (packetsLost / (packets + packetsLost)) * 100 : null;
};

/** The numbers of a voice report, and what they mean. */
export function summarizeVoice(report: VoiceReport): VoiceSummary {
  const { samples } = report;
  // Windows in which the voice went out (not muted).
  const talking = samples.filter((sample) => sample.server.packets > 0);
  const sent = talking.reduce((sum, sample) => sum + sample.server.packets, 0);
  const lost = talking.reduce((sum, sample) => sum + sample.server.packetsLost, 0);
  const server = {
    kbps: mean(talking.map((sample) => sample.server.kbps)),
    lossPercent: sent + lost > 0 ? tenth((lost / (sent + lost)) * 100) : null,
    worstLossPercent: (() => {
      const worst = max(talking.map(lossOf));
      return worst === null ? null : tenth(worst);
    })(),
  };

  const ids = [...new Set(samples.flatMap((sample) => sample.listeners.map((l) => l.userId)))];
  const listeners: ListenerSummary[] = ids.map((userId) => {
    const heard = samples.flatMap((sample) =>
      sample.listeners.filter((listener) => listener.userId === userId),
    );
    return {
      userId,
      name: report.listenerNames[userId] ?? 'Alguém',
      lossPercent: mean(heard.map((listener) => listener.lossPercent)),
      concealedPercent: mean(heard.map((listener) => listener.concealedPercent)),
      worstConcealedPercent: max(heard.map((listener) => listener.concealedPercent)),
      jitterMs: mean(heard.map((listener) => listener.jitterMs)),
      jitterBufferMs: mean(heard.map((listener) => listener.jitterBufferMs)),
      rttMs: mean(heard.map((listener) => listener.rttMs)),
    };
  });

  const speaker = {
    noiseSuppression: lastOf(samples, (sample) => sample.speaker?.noiseSuppression),
    echoCancellation: lastOf(samples, (sample) => sample.speaker?.echoCancellation),
    autoGainControl: lastOf(samples, (sample) => sample.speaker?.autoGainControl),
    rttMs: mean(samples.map((sample) => sample.speaker?.rttMs)),
  };

  const findings: string[] = [];
  const who = report.userName;
  const upload = server.lossPercent ?? 0;
  if (upload >= AUDIBLE_PERCENT) {
    findings.push(
      `A internet de ${who} perdeu ${upload}% da voz no caminho até o servidor: todos ouviram as falhas.`,
    );
  } else if ((server.worstLossPercent ?? 0) >= BAD_WINDOW_PERCENT) {
    findings.push(
      `Num momento a internet de ${who} perdeu ${server.worstLossPercent}% da voz no caminho até o servidor: todos ouviram uma falha ali.`,
    );
  }
  for (const listener of [...listeners].sort(
    (a, b) => (b.concealedPercent ?? 0) - (a.concealedPercent ?? 0),
  )) {
    const concealed = listener.concealedPercent ?? 0;
    const worst = listener.worstConcealedPercent ?? 0;
    // Loss on the way up is everyone's; only what is beyond it is this listener's own way down.
    const ownLoss = Math.max(0, (listener.lossPercent ?? 0) - upload);
    const where =
      ownLoss >= AUDIBLE_PERCENT
        ? ` A perda foi no caminho até ${listener.name}: só ${listener.name} ouviu assim.`
        : '';
    if (concealed >= AUDIBLE_PERCENT) {
      findings.push(
        `Para ${listener.name}, ${concealed}% da voz foi preenchida pelo navegador (soa robótica ou picotada).${where}`,
      );
    } else if (worst >= BAD_WINDOW_PERCENT) {
      findings.push(
        `Para ${listener.name}, num momento ${worst}% da voz foi preenchida pelo navegador.${where}`,
      );
    }
  }
  if (speaker.noiseSuppression && speaker.noiseSuppression !== 'gtcrn') {
    findings.push(
      `A voz de ${who} foi limpa com ${ENGINES[speaker.noiseSuppression] ?? speaker.noiseSuppression}, e não com a supressão GTCRN.`,
    );
  }
  return { speaker, server, listeners, findings };
}

export const engineLabel = (engine: string | null) =>
  engine === null ? null : (ENGINES[engine] ?? engine.toUpperCase());
