import type { StreamReport, StreamReportSummary } from '@frequencia/shared';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Loading } from '../components/Loading';
import { cx } from '../lib/cx';
import { describeError } from '../lib/http';
import { clock, FpsChart } from '../features/streams/FpsChart';
import { streamApi } from '../features/streams/stream-api';
import {
  summarize,
  type MachineLoad,
  type StreamSummary,
} from '../features/streams/stream-summary';

const WHEN = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

const PATHS: Record<StreamReportSummary['path'], string> = {
  browser: 'NAVEGADOR',
  native: 'CAPTURA NATIVA',
};

/** What `audio` of a sender sample means, in the words of the panel. */
const AUDIO_SOURCES: Record<string, string> = {
  program: 'SÓ O PROGRAMA',
  mix: 'O PC, SEM CHAMADAS DE VOZ',
  system: 'O PC INTEIRO (COM CHAMADAS)',
};

function duration(report: StreamReportSummary): string | null {
  if (!report.endedAt) return null;
  return clock((Date.parse(report.endedAt) - Date.parse(report.startedAt)) / 1000);
}

function Section({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-line">
      <h2 className="label border-b border-line bg-surface-2 px-4 py-2 text-fg">
        <span className="text-muted">{number}.</span> {title}
      </h2>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** One stage of the frame's way, as a column of label/value rows. */
function Stage({ title, rows }: { title: string; rows: Array<[string, string | number | null]> }) {
  return (
    <div className="min-w-0 bg-surface p-3">
      <h3 className="label mb-2 truncate text-fg">{title}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="label text-muted">{label}</dt>
            <dd className="m-0 truncate text-right font-mono text-[12px] tabular-nums text-fg">
              {value ?? '—'}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const fps = (value: number | null) => (value === null ? null : `${value}`);
const millis = (value: number | null) => (value === null ? null : `${value} ms`);
const engines = (threeD: number | null, video: number | null) =>
  threeD === null && video === null ? null : `3D ${threeD ?? '—'}% · VÍDEO ${video ?? '—'}%`;

/** The graphics card of a machine, when its desktop app measured it. */
function loadRows(load: MachineLoad | undefined): Array<[string, string | number | null]> {
  if (!load || (load.gpuApp3d === null && load.gpu3d === null)) return [];
  return [
    ['GPU DO APP', engines(load.gpuApp3d, load.gpuAppVideo)],
    ['GPU DO PC', engines(load.gpu3d, load.gpuVideo)],
    ['RECEBENDO', load.watching === null ? null : `${load.watching} transmissão(ões)`],
  ];
}

function Stages({ summary }: { summary: StreamSummary }) {
  const { sender, server, viewers } = summary;
  return (
    <div className="grid gap-px border border-line bg-line sm:grid-cols-2 xl:grid-cols-3">
      <Stage
        title="1 · QUEM TRANSMITE"
        rows={[
          ['PRESET', sender?.preset ?? null],
          ['CAPTURADO', fps(sender?.captureFps ?? null)],
          ['ENVIADO', fps(sender?.sentFps ?? null)],
          ['POR QUADRO', millis(sender?.encodeMs ?? null)],
          ['LIMITE', sender?.limitation?.toUpperCase() ?? null],
          ['COMPRESSOR', sender?.encoder ?? null],
          ['SOM', sender?.audio ? (AUDIO_SOURCES[sender.audio] ?? sender.audio) : null],
          ...loadRows(sender?.load),
        ]}
      />
      <Stage
        title="2 · SERVIDOR"
        rows={[
          ['CHEGARAM', fps(server.fps)],
          ['PIORES 5%', fps(server.lowFps)],
          ['INTERVALO P95', millis(server.gapP95Ms)],
          ['MAIOR PAUSA', millis(server.worstGapMs)],
          ['PACOTES PERDIDOS', server.packetsLost],
          ['TAXA', server.kbps === null ? null : `${Math.round(server.kbps)} kbps`],
        ]}
      />
      {viewers.map((viewer, index) => (
        <Stage
          key={viewer.userId}
          title={`${3 + index} · ${viewer.name.toUpperCase()} ASSISTINDO`}
          rows={[
            ['EXIBIDOS', fps(viewer.fps)],
            ['PIORES 5%', fps(viewer.lowFps)],
            ['TRAVADAS', viewer.freezes],
            ['TEMPO PARADO', `${(viewer.freezeMs / 1000).toFixed(1)} s`],
            ['DESCARTADOS', viewer.framesDropped],
            ['DECODIFICAR', millis(viewer.decodeMs)],
            ...loadRows(viewer.load),
          ]}
        />
      ))}
    </div>
  );
}

function SamplesTable({ report }: { report: StreamReport }) {
  const viewerIds = [
    ...new Set(report.samples.flatMap((sample) => sample.viewers.map((viewer) => viewer.userId))),
  ];
  const cell = 'border-b border-line px-2 py-1 text-right font-mono text-[12px] tabular-nums';
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {['TEMPO', 'CAPTURADO', 'ENVIADO', 'SERVIDOR', 'INTERVALO P95', 'PERDIDOS'].map(
              (label) => (
                <th
                  key={label}
                  className="label border-b border-line px-2 py-1 text-right text-muted"
                >
                  {label}
                </th>
              ),
            )}
            {viewerIds.map((id) => (
              <th key={id} className="label border-b border-line px-2 py-1 text-right text-muted">
                {(report.viewerNames[id] ?? 'ALGUÉM').toUpperCase()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.samples.map((sample) => (
            <tr key={sample.t}>
              <td className={cell}>{clock(sample.t)}</td>
              <td className={cell}>{sample.sender?.captureFps ?? '—'}</td>
              <td className={cell}>{sample.sender?.sentFps ?? '—'}</td>
              <td className={cell}>{sample.server.fps}</td>
              <td className={cell}>{sample.server.gapP95Ms ?? '—'}</td>
              <td className={cell}>{sample.server.packetsLost}</td>
              {viewerIds.map((id) => {
                const seen = sample.viewers.find((viewer) => viewer.userId === id);
                return (
                  <td key={id} className={cell}>
                    {seen
                      ? `${seen.fps ?? '—'}${seen.freezes > 0 ? ` · ${seen.freezes}×` : ''}`
                      : '—'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportDetail({ reportId }: { reportId: string }) {
  const [showTable, setShowTable] = useState(false);
  const query = useQuery({
    queryKey: ['stream-report', reportId],
    queryFn: () => streamApi.get(reportId),
    // A stream still on gains a chunk about once a minute.
    refetchInterval: (state) => (state.state.data && !state.state.data.endedAt ? 30_000 : false),
  });
  if (query.isPending) return <Loading label="CARREGANDO MEDIÇÃO" className="p-4" />;
  if (query.isError) return <p className="p-4 text-sm text-muted">{describeError(query.error)}</p>;

  const report = query.data;
  const summary = summarize(report);
  const charts: Array<{ title: string; points: Array<{ t: number; value: number | null }> }> = [];
  if (report.samples.some((sample) => typeof sample.sender?.captureFps === 'number')) {
    charts.push({
      title: 'CAPTURADO POR QUEM TRANSMITE',
      points: report.samples.map((sample) => ({
        t: sample.t,
        value: sample.sender?.captureFps ?? null,
      })),
    });
  }
  charts.push({
    title: 'CHEGANDO AO SERVIDOR',
    points: report.samples.map((sample) => ({ t: sample.t, value: sample.server.fps })),
  });
  for (const viewer of summary.viewers) {
    charts.push({
      title: `EXIBIDO PARA ${viewer.name.toUpperCase()}`,
      points: report.samples.map((sample) => ({
        t: sample.t,
        value: sample.viewers.find((seen) => seen.userId === viewer.userId)?.fps ?? null,
      })),
    });
  }

  return (
    <article className="anim-view">
      <header className="border-b border-line px-4 py-4">
        <p className="label text-muted">
          {report.guildName.toUpperCase()} / {report.channelName.toUpperCase()} ·{' '}
          {WHEN.format(Date.parse(report.startedAt))}
        </p>
        <h1 className="display mt-1 text-xl text-fg">{report.userName}</h1>
        <p className="label mt-1 text-muted">
          {PATHS[report.path]}
          {report.codec ? ` · ${report.codec.toUpperCase()}` : ''}
          {` · ${duration(report) ?? 'AO VIVO'}`}
          {` · ${report.samples.length} AMOSTRAS`}
        </p>
      </header>

      <Section number="01" title="ONDE OS QUADROS SE PERDEM">
        {report.samples.length === 0 ? (
          <p className="text-sm text-muted">Ainda não há medições desta transmissão.</p>
        ) : summary.findings.length === 0 ? (
          <p className="text-sm text-fg">
            Nenhum gargalo: os quadros saem, chegam e são exibidos no ritmo esperado.
          </p>
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

      <Section number="02" title="CAMINHO DO QUADRO · MEDIANAS">
        <Stages summary={summary} />
      </Section>

      <Section number="03" title="QUADROS POR SEGUNDO">
        <div className="grid gap-3 lg:grid-cols-2">
          {charts.map((chart) => (
            <FpsChart
              key={chart.title}
              title={chart.title}
              points={chart.points}
              target={summary.target}
            />
          ))}
        </div>
      </Section>

      <Section number="04" title="AMOSTRAS">
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
 * Measured screen shares: the user's own, and every one in a server the user owns. Each one
 * follows the frames from capture to the viewers' screens and says where they go missing.
 */
export function StreamReportsPage() {
  const { reportId } = useParams();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ['stream-reports'], queryFn: streamApi.list });
  const selected = reportId ?? list.data?.[0]?.id;

  return (
    <main className="flex min-h-dvh flex-col bg-bg">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <h1 className="label-lg text-fg">TRANSMISSÕES MEDIDAS</h1>
        <Link to="/app" className="label text-muted transition-colors hover:text-accent">
          ← VOLTAR
        </Link>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label="Transmissões"
          className="max-h-64 shrink-0 overflow-y-auto border-b border-line md:max-h-none md:w-72 md:border-r md:border-b-0"
        >
          {list.isPending && <Loading label="CARREGANDO" className="p-4" />}
          {list.isError && <p className="p-4 text-sm text-muted">{describeError(list.error)}</p>}
          {list.data?.length === 0 && (
            <p className="p-4 text-sm text-muted">
              Nenhuma transmissão medida ainda. Elas aparecem aqui quando você transmite, ou quando
              alguém transmite num servidor seu.
            </p>
          )}
          <ul className="m-0 list-none p-0">
            {list.data?.map((report, index) => (
              <li key={report.id}>
                <button
                  type="button"
                  aria-current={report.id === selected ? 'true' : undefined}
                  onClick={() => navigate(`/transmissoes/${report.id}`, { replace: true })}
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
                    {PATHS[report.path]} · {duration(report) ?? 'AO VIVO'}
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
