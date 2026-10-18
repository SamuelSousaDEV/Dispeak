import type { VoiceReport, VoiceReportSummary } from '@frequencia/shared';
import { expect, test, type Browser } from '@playwright/test';

async function signUp(browser: Browser, displayName: string) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 820 } });
  const username = `${displayName.toLowerCase()}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const response = await context.request.post('/api/auth/register', {
    data: { username, displayName, password: 'correct horse battery' },
  });
  const { accessToken } = (await response.json()) as { accessToken: string };
  const headers = { authorization: `Bearer ${accessToken}` };
  const post = async (path: string, data?: unknown) => {
    const result = await context.request.post(`/api${path}`, { headers, data });
    expect(result.ok(), `${path} -> ${result.status()}`).toBe(true);
    return result.status() === 204 ? null : result.json();
  };
  const get = async <T>(path: string) => {
    const result = await context.request.get(`/api${path}`, { headers });
    expect(result.ok(), `${path} -> ${result.status()}`).toBe(true);
    return (await result.json()) as T;
  };
  return { context, page: await context.newPage(), post, get };
}

test('a voice is measured at the speaker, the server and each listener', async ({ browser }) => {
  test.setTimeout(120_000);
  const ana = await signUp(browser, 'Ana');
  const bia = await signUp(browser, 'Bia');
  const guild = (await ana.post('/guilds', { name: 'Medição' })) as {
    id: string;
    channels: Array<{ id: string; type: string }>;
  };
  const text = guild.channels.find((channel) => channel.type === 'text')?.id ?? '';
  const invite = (await ana.post(`/guilds/${guild.id}/invites`, {})) as { code: string };
  await bia.post(`/invites/${invite.code}/accept`);

  for (const { page } of [ana, bia]) {
    await page.goto(`/app/${guild.id}/${text}`);
    await page
      .getByRole('navigation', { name: 'Canais' })
      .getByRole('link', { name: /Geral/ })
      .click();
    await expect(page.getByTestId('voice-status')).toHaveText('CONECTADO');
  }

  // Two whole windows of the media service, then Ana closes the app: her voice ends.
  await ana.page.waitForTimeout(22_000);
  await ana.page.close();

  let summary: VoiceReportSummary | undefined;
  await expect
    .poll(async () => {
      const { reports } = await ana.get<{ reports: VoiceReportSummary[] }>('/voice-reports');
      summary = reports.find((report) => report.userName === 'Ana');
      return summary?.endedAt ? summary.sampleCount : 0;
    })
    .toBeGreaterThanOrEqual(2);
  expect(summary).toMatchObject({ channelName: 'Geral', guildName: 'Medição' });

  const report = await ana.get<VoiceReport>(`/voice-reports/${summary?.id ?? ''}`);
  const [first] = report.samples;
  expect(first?.server.packets).toBeGreaterThan(100);
  expect(first?.server.kbps).toBeGreaterThan(0);
  expect(first?.speaker).toMatchObject({ echoCancellation: true, autoGainControl: true });
  expect(first?.speaker?.noiseSuppression).not.toBeNull();
  expect(first?.listeners).toHaveLength(1);
  // Nothing is lost on this machine's own network.
  expect(first?.listeners[0]?.lossPercent).toBe(0);
  expect(first?.listeners[0]?.concealedPercent).toBeLessThan(1);
  expect(report.listenerNames).toEqual({ [first?.listeners[0]?.userId ?? '']: 'Bia' });
  // Bia only listened; the voice is not hers and the server is not hers.
  const own = await bia.get<{ reports: VoiceReportSummary[] }>('/voice-reports');
  expect(own.reports.every((entry) => entry.userName === 'Bia')).toBe(true);

  // The page follows the voice from Ana to Bia.
  const page = await ana.context.newPage();
  await page.goto(`/vozes/${report.id}`);
  await expect(page.getByRole('heading', { name: 'Ana', exact: true })).toBeVisible();
  await expect(page.getByText('BIA OUVINDO')).toBeVisible();
  await expect(page.getByText('Nada: a voz chegou inteira a todos que ouviram.')).toBeVisible();
  if (process.env.E2E_SCREENSHOT_DIR) {
    await page.screenshot({
      path: `${process.env.E2E_SCREENSHOT_DIR}/voice-report.png`,
      fullPage: true,
    });
  }
});
