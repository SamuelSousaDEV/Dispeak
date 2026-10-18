import type { StreamReport, StreamSample } from '@frequencia/shared';

/** Below this share of the expected rate, a stage is losing frames. */
const SHORTFALL = 0.85;

export function median(values: Array<number | null | undefined>): number | null {
  const sorted = values.filter((value): value is number => typeof value === 'number');
  if (sorted.length === 0) return null;
  sorted.sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  return Math.round(value * 10) / 10;
}

/** The value below which the worst 5% of the samples sit. */
export function low(values: Array<number | null | undefined>): number | null {
  const sorted = values
    .filter((value): value is number => typeof value === 'number')
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.floor((sorted.length - 1) * 0.05)] ?? null;
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** The value seen most often; ties go to the first one seen. */
function mostCommon(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | null = null;
  for (const [value, count] of counts) if (!best || count > (counts.get(best) ?? 0)) best = value;
  return best;
}

/** `1080p60` → 60. */
export function presetFrameRate(preset: string | null): number | null {
  const match = preset?.match(/p(\d+)$/);
  return match ? Number(match[1]) : null;
}

/** What the graphics card was busy with, from the desktop app; `null` where unknown. */
export interface MachineLoad {
  gpuApp3d: number | null;
  gpuAppVideo: number | null;
  gpu3d: number | null;
  gpuVideo: number | null;
  /** Streams the machine was receiving, most of the time. */
  watching: number | null;
}

type LoadSample = Partial<Record<keyof MachineLoad, number | null>>;

function summarizeLoad(samples: LoadSample[]): MachineLoad {
  return {
    gpuApp3d: median(samples.map((sample) => sample.gpuApp3d)),
    gpuAppVideo: median(samples.map((sample) => sample.gpuAppVideo)),
    gpu3d: median(samples.map((sample) => sample.gpu3d)),
    gpuVideo: median(samples.map((sample) => sample.gpuVideo)),
    watching: median(samples.map((sample) => sample.watching)),
  };
}

export interface SenderSummary {
  load: MachineLoad;
  preset: string | null;
  captureFps: number | null;
  sentFps: number | null;
  encodeMs: number | null;
  limitation: string | null;
  encoder: string | null;
  /** Where the sound came from (`program`, `mix`, `system`), when known. */
  audio: string | null;
}

export interface ServerSummary {
  fps: number | null;
  lowFps: number | null;
  gapP95Ms: number | null;
  worstGapMs: number | null;
  packetsLost: number;
  plis: number;
  kbps: number | null;
}

export interface ViewerSummary {
  load: MachineLoad;
  userId: string;
  name: string;
  fps: number | null;
  lowFps: number | null;
  freezes: number;
  freezeMs: number;
  framesDropped: number;
  decodeMs: number | null;
  decoder: string | null;
}

export interface StreamSummary {
  /** Frames per second the stream aimed at. */
  target: number | null;
  sender: SenderSummary | null;
  server: ServerSummary;
  viewers: ViewerSummary[];
  /** Where frames are lost, most upstream first; one line each. */
  findings: string[];
}

function summarizeSender(samples: StreamSample[]): SenderSummary | null {
  const sent = samples.flatMap((sample) => (sample.sender ? [sample.sender] : []));
  if (sent.length === 0) return null;
  return {
    load: summarizeLoad(sent),
    preset: mostCommon(sent.map((sample) => sample.preset)),
    captureFps: median(sent.map((sample) => sample.captureFps)),
    sentFps: median(sent.map((sample) => sample.sentFps)),
    encodeMs: median(sent.map((sample) => sample.encodeMs)),
    limitation: mostCommon(sent.map((sample) => sample.limitation)),
    encoder: mostCommon(sent.map((sample) => sample.encoder)),
    audio: mostCommon(sent.map((sample) => sample.audio ?? null)),
  };
}

function summarizeServer(samples: StreamSample[]): ServerSummary {
  const servers = samples.map((sample) => sample.server);
  const gaps = servers.map((server) => server.gapMaxMs);
  return {
    fps: median(servers.map((server) => server.fps)),
    lowFps: low(servers.map((server) => server.fps)),
    gapP95Ms: median(servers.map((server) => server.gapP95Ms)),
    worstGapMs: gaps.some((gap) => gap !== null) ? Math.max(...gaps.map((gap) => gap ?? 0)) : null,
    packetsLost: sum(servers.map((server) => server.packetsLost)),
    plis: sum(servers.map((server) => server.plis)),
    kbps: median(servers.map((server) => server.kbps)),
  };
}

function summarizeViewers(report: StreamReport): ViewerSummary[] {
  const byUser = new Map<string, Array<StreamSample['viewers'][number]>>();
  for (const sample of report.samples) {
    for (const viewer of sample.viewers) {
      byUser.set(viewer.userId, [...(byUser.get(viewer.userId) ?? []), viewer]);
    }
  }
  return [...byUser].map(([userId, seen]) => ({
    load: summarizeLoad(seen),
    userId,
    name: report.viewerNames[userId] ?? 'ALGUÉM',
    fps: median(seen.map((viewer) => viewer.fps)),
    lowFps: low(seen.map((viewer) => viewer.fps)),
    freezes: sum(seen.map((viewer) => viewer.freezes)),
    freezeMs: sum(seen.map((viewer) => viewer.freezeMs)),
    framesDropped: sum(seen.map((viewer) => viewer.framesDropped)),
    decodeMs: median(seen.map((viewer) => viewer.decodeMs)),
    decoder: mostCommon(seen.map((viewer) => viewer.decoder)),
  }));
}

const LIMITATIONS: Record<string, string> = {
  cpu: 'o processador não dá conta',
  bandwidth: 'a internet de envio não dá conta',
};

/** Follows a frame from capture to screen and says where the rate drops. */
function diagnose(summary: Omit<StreamSummary, 'findings'>, native: boolean): string[] {
  const { target, sender, server, viewers } = summary;
  const findings: string[] = [];
  const short = (value: number | null, expected: number | null): value is number =>
    value !== null && expected !== null && expected > 0 && value < expected * SHORTFALL;

  let upstream = target;
  if (sender && sender.captureFps !== null) {
    if (short(sender.captureFps, target)) {
      findings.push(
        `A captura entrega ${sender.captureFps} de ${target} quadros por segundo: o PC de quem transmite perde quadros antes de comprimir.`,
      );
    }
    upstream = sender.captureFps;
  }
  if (sender && sender.sentFps !== null) {
    if (short(sender.sentFps, upstream)) {
      const why = sender.limitation ? LIMITATIONS[sender.limitation] : undefined;
      findings.push(
        `O compressor envia ${sender.sentFps} dos ${upstream} quadros capturados${why ? `: ${why}` : ''}${sender.encodeMs !== null ? ` (${sender.encodeMs} ms por quadro)` : ''}.`,
      );
    }
    upstream = sender.sentFps;
  }
  if (short(server.fps, upstream)) {
    findings.push(
      native && !sender?.sentFps
        ? `Chegam ao servidor ${server.fps} de ${upstream} quadros por segundo: a captura do app ou a internet de quem transmite não acompanha.`
        : `Chegam ao servidor ${server.fps} dos ${upstream} quadros enviados: a internet de quem transmite perde quadros.`,
    );
  }
  const interval = server.fps ? 1000 / server.fps : null;
  if (interval !== null && server.gapP95Ms !== null && server.gapP95Ms > interval * 2.5) {
    findings.push(
      `Os quadros chegam irregulares: 5% das vezes o intervalo passa de ${Math.round(server.gapP95Ms)} ms (o normal seria ${Math.round(interval)} ms).`,
    );
  }
  for (const viewer of viewers) {
    if (short(viewer.fps, server.fps)) {
      findings.push(
        `${viewer.name} vê ${viewer.fps} dos ${server.fps} quadros que chegam ao servidor: o PC ou a internet de quem assiste não acompanha${viewer.decodeMs !== null ? ` (${viewer.decodeMs} ms para decodificar cada quadro)` : ''}.`,
      );
    }
    if (viewer.freezes > 0) {
      findings.push(
        `${viewer.name} viu a imagem parar ${viewer.freezes} ${viewer.freezes === 1 ? 'vez' : 'vezes'}, ${(viewer.freezeMs / 1000).toFixed(1)} s no total.`,
      );
    }
  }
  return findings;
}

export function summarize(report: StreamReport): StreamSummary {
  // The last window of a stream that ended is cut short, mid-stop: it would drag every rate
  // down. Kept only when there is little else.
  const steady =
    report.endedAt && report.samples.length > 2 ? report.samples.slice(0, -1) : report.samples;
  const sender = summarizeSender(steady);
  const server = summarizeServer(steady);
  const viewers = summarizeViewers({ ...report, samples: steady });
  const target = presetFrameRate(sender?.preset ?? null);
  const base = { target, sender, server, viewers };
  return { ...base, findings: diagnose(base, report.path === 'native') };
}
