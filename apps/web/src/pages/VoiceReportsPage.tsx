import type { VoiceReport, VoiceReportSummary } from '@frequencia/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Loading } from '../components/Loading';
import { Section, Stage } from '../components/ReportParts';
import { cx } from '../lib/cx';
import { describeError } from '../lib/http';
import { clock } from '../features/streams/FpsChart';
import { voiceReportApi } from '../features/voice-reports/voice-report-api';
import {
  engineLabel,
  summarizeVoice,
  type VoiceSummary,
} from '../features/voice-reports/voice-summary';

const WHEN = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

function duration(report: VoiceReportSummary): string | null {
  if (!report.endedAt) return null;
  return clock((Date.parse(report.endedAt) - Date.parse(report.startedAt)) / 1000);
}

const percent = (value: number | null) => (value === null ? null : `${value}%`);
const millis = (value: number | null) => (value === null ? null : `${value} ms`);
const onOff = (value: boolean | null) => (value === null ? null : value ? 'LIGADO' : 'DESLIGADO');

function Stages({ summary }: { summary: VoiceSummary }) {
  const { speaker, server, listeners } = summary;
  return (
    <div className="grid gap-px border border-line bg-line sm:grid-cols-2 xl:grid-cols-3">
      <Stage
        title="1 · QUEM FALA"
        rows={[
          ['LIMPEZA', engineLabel(speaker.noiseSuppression)],
          ['CANCELAR ECO', onOff(speaker.echoCancellation)],
          ['GANHO AUTOMÁTICO', onOff(speaker.autoGainControl)],
          ['RTT', millis(speaker.rttMs)],
        ]}
      />
      <Stage
        title="2 · SERVIDOR"
        rows={[
          ['TAXA', server.kbps === null ? null : `${Math.round(server.kbps)} kbps`],
          ['PERDA NA SUBIDA', percent(server.lossPercent)],
          ['PIOR MOMENTO', percent(server.worstLossPercent)],
        ]}
      />
      {listeners.map((listener, index) => (
        <Stage
          key={listener.userId}
          title={`${3 + index} · ${listener.name.toUpperCase()} OUVINDO`}
          rows={[
            ['PERDA', percent(listener.lossPercent)],
            ['PREENCHIDA', percent(listener.concealedPercent)],
            ['PIOR MOMENTO', percent(listener.worstConcealedPercent)],
            ['VARIAÇÃO', millis(listener.jitterMs)],
            ['ESPERA NO BUFFER', millis(listener.jitterBufferMs)],
            ['RTT', millis(listener.rttMs)],
          ]}
        />
      ))}
    </div>
  );
}

function SamplesTable({ report }: { report: VoiceReport }) {
  const listenerIds = [
    ...new Set(report.samples.flatMap((sample) => sample.listeners.map((l) => l.userId))),
  ];
  const cell = 'border-b border-line px-2 py-1 text-right font-mono text-[12px] tabular-nums';
  const head = 'label border-b border-line px-2 py-1 text-right text-muted';
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {['TEMPO', 'TAXA', 'PERDA NA SUBIDA'].map((label) => (
              <th key={label} className={head}>
                {label}
              </th>
            ))}
            {listenerIds.map((id) => (
              <th key={id} className={head}>
                {(report.listenerNames[id] ?? 'ALGUÉM').toUpperCase()} · PREENCHIDA
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.samples.map((sample) => {
            const { packets, packetsLost } = sample.server;
            const loss =
              packets + packetsLost > 0
                ? `${Math.round((packetsLost / (packets + packetsLost)) * 1000) / 10}%`
                : '—';
            return (
              <tr key={sample.t}>
                <td className={cell}>{clock(sample.t)}</td>
                <td className={cell}>{packets > 0 ? sample.server.kbps : 'MUDO'}</td>
                <td className={cell}>{loss}</td>
                {listenerIds.map((id) => {
                  const heard = sample.listeners.find((listener) => listener.userId === id);
                  return (
                    <td key={id} className={cell}>
                      {heard?.concealedPercent === null || heard === undefined
                        ? '—'
                        : `${heard.concealedPercent}%`}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReportDetail({ reportId }: { reportId: string }) {
  const [showTable, setShowTable] = useState(false);
  const query = useQuery({
    queryKey: ['voice-report', reportId],
    queryFn: () => voiceReportApi.get(reportId),
    // A voice still in the call gains a chunk about once a minute.
    refetchInterval: (state) => (state.state.data && !state.state.data.endedAt ? 30_000 : false),
  });
  if (query.isPending) return <Loading label="CARREGANDO MEDIÇÃO" className="p-4" />;
  if (query.isError) return <p className="p-4 text-sm text-muted">{describeError(query.error)}</p>;

  const report = query.data;
  const summary = summarizeVoice(report);
  return (
    <article className="anim-view">
      <header className="border-b border-line px-4 py-4">
        <p className="label text-muted">
          {report.guildName.toUpperCase()} / {report.channelName.toUpperCase()} ·{' '}
          {WHEN.format(Date.parse(report.startedAt))}
        </p>
        <h1 className="display mt-1 text-xl text-fg">{report.userName}</h1>
        <p className="label mt-1 text-muted">
          {duration(report) ?? 'NA CHAMADA'} · {report.samples.length} AMOSTRAS
        </p>
      </header>

      <Section number="01" title="O QUE ATRAPALHOU A VOZ">
        {report.samples.length === 0 ? (
          <p className="text-sm text-muted">Ainda não há medições desta voz.</p>
        ) : summary.findings.length === 0 ? (
          <p className="text-sm text-fg">Nada: a voz chegou inteira a todos que ouviram.</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {summary.findings.map((finding, index) => (
              <li key={finding} className="flex gap-3 text-sm text-fg">
                <span className="label pt-0.5 text-muted">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span>{finding}</span>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section number="02" title="CAMINHO DA VOZ · MÉDIAS">
        <Stages summary={summary} />
        <p className="mt-3 text-xs text-muted">
          PREENCHIDA: a parte da voz que não chegou e o navegador inventou para cobrir o buraco. É o
          que soa robótico ou picotado. Acima de 1% dá para ouvir.
        </p>
      </Section>

      <Section number="03" title="AMOSTRAS">
        <button
          type="button"
          onClick={() => setShowTable((shown) => !shown)}
          aria-expanded={showTable}
          className="label text-muted transition-colors hover:text-accent"
        >
          {showTable ? '[ ESCONDER TABELA ]' : '[ MOSTRAR TABELA ]'}
        </button>
        {showTable && (
          <div className="mt-3">
            <SamplesTable report={report} />
          </div>
        )}
      </Section>
    </article>
  );
}

/**
 * Measured voices: the user's own in calls, and everyone's in the servers the user owns. Each
 * one follows the voice from the microphone to each listener and says where it broke.
 */
export function VoiceReportsPage() {
  const { reportId } = useParams();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ['voice-reports'], queryFn: voiceReportApi.list });
  const selected = reportId ?? list.data?.[0]?.id;

  return (
    <main className="flex min-h-dvh flex-col bg-bg">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h1 className="label-lg text-fg">VOZES MEDIDAS</h1>
        <nav className="flex items-center gap-4">
          <Link to="/transmissoes" className="label text-muted transition-colors hover:text-accent">
            TRANSMISSÕES
          </Link>
          <Link to="/app" className="label text-muted transition-colors hover:text-accent">
            ← VOLTAR
          </Link>
        </nav>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label="Vozes"
          className="max-h-64 shrink-0 overflow-y-auto border-b border-line md:max-h-none md:w-72 md:border-r md:border-b-0"
        >
          {list.isPending && <Loading label="CARREGANDO" className="p-4" />}
          {list.isError && <p className="p-4 text-sm text-muted">{describeError(list.error)}</p>}
          {list.data?.length === 0 && (
            <p className="p-4 text-sm text-muted">
              Nenhuma voz medida ainda. Elas aparecem aqui depois que você fala numa chamada, ou
              quando alguém fala num servidor seu.
            </p>
          )}
          <ul className="m-0 list-none p-0">
            {list.data?.map((report, index) => (
              <li key={report.id}>
                <button
                  type="button"
                  aria-current={report.id === selected ? 'true' : undefined}
                  onClick={() => navigate(`/vozes/${report.id}`, { replace: true })}
                  className={cx(
                    'flex w-full flex-col items-start gap-0.5 border-b border-l-2 border-line px-4 py-2.5 text-left transition-colors',
                    report.id === selected
                      ? 'border-l-accent bg-surface-2'
                      : 'border-l-transparent hover:bg-surface',
                  )}
                >
                  <span className="label text-muted">
                    {String(index + 1).padStart(2, '0')}.{' '}
                    {WHEN.format(Date.parse(report.startedAt))}
                  </span>
                  <span className="truncate text-sm text-fg">{report.userName}</span>
                  <span className="label truncate text-muted">
                    {report.channelName.toUpperCase()} · {duration(report) ?? 'NA CHAMADA'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1">
          {selected ? <ReportDetail key={selected} reportId={selected} /> : null}
        </div>
      </div>
    </main>
  );
}
