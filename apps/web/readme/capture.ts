// The README pictures, with fictional data: node readme/capture.ts [scene,scene,...]
// Before: `pnpm dev` and `node readme/seed.ts`. Each person is a logged-in browser context; the
// call is real (SFU, gateway), only the camera, microphone and screen are synthetic.
//   STREAM_IMAGE=<jpg>  what Beatriz shares (a slow pan over it); without it, a test pattern
//   FFMPEG=<exe>        for the GIFs (default: the one the desktop app ships)
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

const BASE = 'http://localhost:5173';
const ROOT = path.resolve(import.meta.dirname, '../../..');
const OUT = path.join(ROOT, 'docs/readme');
const FFMPEG = process.env.FFMPEG ?? path.join(ROOT, 'apps/desktop/vendor/ffmpeg/ffmpeg.exe');
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

type Demo = {
  password: string;
  guildId: string;
  dmId: string;
  requestId: string;
  channels: Record<string, string>;
  users: Record<string, { id: string; name: string }>;
};
const demo = JSON.parse(
  await readFile(path.join(import.meta.dirname, '.demo.json'), 'utf8'),
) as Demo;
const DEMO_PASSWORD = demo.password;
const scenes = process.argv[2]?.split(',');
const wanted = (name: string) => !scenes || scenes.includes(name);
const channelUrl = (key: string) => {
  const id = demo.channels[key];
  if (!id) throw new Error(`no channel ${key} in .demo.json`);
  return `${BASE}/app/${demo.guildId}/${id}`;
};

const streamImage = process.env.STREAM_IMAGE
  ? `data:image/jpeg;base64,${(await readFile(process.env.STREAM_IMAGE)).toString('base64')}`
  : null;

/** getDisplayMedia becomes a 1080p canvas: a slow pan over the image, new frames all the time. */
function fakeScreen(image: string | null) {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 1920, height: 1080 });
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    const picture = new Image();
    if (image) {
      picture.src = image;
      await picture.decode();
    }
    const started = performance.now();
    const draw = () => {
      const t = (performance.now() - started) / 1000;
      if (image) {
        const zoom = 1.12 + 0.04 * Math.sin(t / 6);
        const scale = Math.max(1920 / picture.width, 1080 / picture.height) * zoom;
        const width = picture.width * scale;
        const height = picture.height * scale;
        const x = (1920 - width) / 2 + Math.sin(t / 5) * (width - 1920) * 0.45;
        const y = (1080 - height) / 2 + Math.cos(t / 7) * (height - 1080) * 0.4;
        context.drawImage(picture, x, y, width, height);
      } else {
        context.fillStyle = `hsl(${(t * 20) % 360} 40% 20%)`;
        context.fillRect(0, 0, 1920, 1080);
      }
      requestAnimationFrame(draw);
    };
    draw();
    return canvas.captureStream(60);
  };
}

const browser: Browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

type Options = { phone?: boolean; streams?: boolean; speaks?: boolean; viewport?: typeof DESKTOP };

async function login(username: string, options: Options = {}): Promise<Page> {
  const context: BrowserContext = await browser.newContext({
    ...(options.phone
      ? { viewport: PHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
      : { viewport: options.viewport ?? DESKTOP, deviceScaleFactor: 2 }),
    locale: 'pt-BR',
    timezoneId: 'America/Fortaleza',
    permissions: ['microphone', 'camera'],
  });
  if (options.streams) await context.addInitScript(fakeScreen, streamImage);
  // The synthetic microphone beeps, which the noise suppression removes: whoever "speaks" sends it
  // as captured, so the speaking outline shows.
  await context.addInitScript((speaks: boolean) => {
    localStorage.setItem(
      'frequencia.settings',
      JSON.stringify({
        state: {
          noiseSuppression: !speaks,
          keybinds: {
            mute: 'Ctrl+Shift+M',
            deafen: 'Ctrl+Shift+D',
            share: 'Ctrl+Shift+S',
            leave: 'Ctrl+Shift+H',
          },
        },
        version: 4,
      }),
    );
  }, options.speaks ?? false);
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel('USUÁRIO').fill(username);
  await page.getByLabel('SENHA').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: /ENTRAR/ }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
  await settle(page);
  return page;
}

/** Waits for the opening screen to leave and the gateway to be up. */
async function settle(page: Page) {
  await page
    .getByTestId('boot-screen')
    .waitFor({ state: 'detached', timeout: 20_000 })
    .catch(() => {});
  await page.waitForTimeout(600);
}

async function open(page: Page, url: string) {
  await page.goto(url);
  await settle(page);
}

async function shot(page: Page, name: string, wait = 1200) {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`ok ${name}.png`);
}

async function joinVoice(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Canais' })
    .getByRole('link', { name: new RegExp(name) })
    .first()
    .click();
  await page
    .getByTestId('voice-status')
    .filter({ hasText: 'CONECTADO' })
    .first()
    .waitFor({ timeout: 20_000 });
}

/** Records a page through the DevTools screencast and turns it into a GIF. */
async function record(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const frames: Array<{ data: Buffer; at: number }> = [];
  cdp.on('Page.screencastFrame', (frame) => {
    frames.push({ data: Buffer.from(frame.data, 'base64'), at: frame.metadata.timestamp ?? 0 });
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 90,
    maxWidth: DESKTOP.width * 2,
    maxHeight: DESKTOP.height * 2,
  });
  return {
    async stop(name: string, { width = 1000, fps = 10, hold = 2 } = {}) {
      await cdp.send('Page.stopScreencast');
      await cdp.detach();
      const directory = await mkdtemp(path.join(os.tmpdir(), 'readme-gif-'));
      const lines = ['ffconcat version 1.0'];
      for (const [index, frame] of frames.entries()) {
        const file = path.join(directory, `${String(index).padStart(5, '0')}.jpg`);
        await writeFile(file, frame.data);
        const next = frames[index + 1];
        const duration = next ? Math.max(next.at - frame.at, 0.001) : hold;
        lines.push(`file '${file.replaceAll('\\', '/')}'`, `duration ${duration.toFixed(3)}`);
      }
      const last = lines.at(-2);
      if (last) lines.push(last); // the concat demuxer ignores the last duration otherwise
      const list = path.join(directory, 'list.txt');
      await writeFile(list, lines.join('\n'));
      execFileSync(FFMPEG, [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        list,
        '-vf',
        `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];` +
          '[a]palettegen=max_colors=128:stats_mode=diff[p];' +
          '[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
        path.join(OUT, `${name}.gif`),
      ]);
      await rm(directory, { recursive: true, force: true });
      console.log(`ok ${name}.gif (${frames.length} frames)`);
    },
  };
}

/** What the desktop app tells the gateway about a running game, sent here by hand. */
async function playing(username: string, game: string) {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: DEMO_PASSWORD }),
  });
  const { accessToken: token } = (await response.json()) as { accessToken: string };
  const socket = new WebSocket(`${BASE.replace('http', 'ws')}/api/gateway`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('error', () => reject(new Error('gateway socket failed')));
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as { op: number; t?: string };
      if (frame.op === 10) socket.send(JSON.stringify({ op: 2, d: { token } }));
      if (frame.t === 'READY') {
        socket.send(JSON.stringify({ op: 3, d: { game } }));
        resolve();
      }
    });
  });
  return socket;
}

await mkdir(OUT, { recursive: true });

// --- the group: online for every scene, in the Cinema call, Beatriz streaming ---------------------
const crowd = { viewport: { width: 960, height: 640 } };
const bia = await login('beatriz.demo', { ...crowd, streams: true });
const ana = await login('ana.demo', crowd);
const leo = await login('leo.demo', { ...crowd, speaks: true });
const caio = await login('caio.demo', crowd);
for (const page of [bia, ana, leo, caio]) {
  await open(page, channelUrl('text:geral'));
  await joinVoice(page, 'Cinema');
}
await bia.getByRole('button', { name: 'TRANSMITIR', exact: true }).first().click();
await bia.getByRole('menuitem', { name: /1080P60/ }).click();
await bia.getByRole('button', { name: 'PARAR TRANSMISSÃO' }).first().waitFor({ timeout: 20_000 });
await ana.getByRole('button', { name: 'MUTAR' }).first().click();
for (const page of [leo, caio])
  await page.getByRole('button', { name: 'Assistir Beatriz' }).click();
const game = await playing('caio.demo', 'Cyberpunk 2077');
const streamingSince = Date.now();

const sam = await login('samuel.demo');

// --- the call (demo.gif, voz.png, chamada-chat.png) ------------------------------------------
if (wanted('voz')) {
  await open(sam, channelUrl('text:geral'));
  await sam.waitForTimeout(800);
  const video = await record(sam);
  await sam.waitForTimeout(1500);
  await joinVoice(sam, 'Cinema');
  await sam.waitForTimeout(1500);
  await sam.getByRole('button', { name: 'Assistir Beatriz' }).click();
  await sam.waitForTimeout(4500);
  await sam.locator('[data-stream="Beatriz"]').click({ button: 'right' });
  await sam.waitForTimeout(700);
  await sam.getByRole('menuitem', { name: 'Estatísticas' }).click();
  await sam.waitForTimeout(3500);
  await video.stop('demo');
  await shot(sam, 'voz', 2500);

  await sam.getByTestId('voice-chat-toggle').click();
  await shot(sam, 'chamada-chat', 1800);
  await sam.getByTestId('voice-chat-toggle').click();
  await sam.getByRole('button', { name: 'Desligar voz' }).first().click();
}

// --- text and people ----------------------------------------------------------------------
if (wanted('chat')) {
  await open(sam, channelUrl('text:geral'));
  await shot(sam, 'chat', 1500);
  await open(sam, channelUrl('text:clipes'));
  await shot(sam, 'clipes', 2000);
}

if (wanted('amigos')) {
  await open(sam, `${BASE}/app/${demo.dmId}`);
  await shot(sam, 'conversa', 1500);
  await open(sam, `${BASE}/app/${demo.requestId}`);
  await shot(sam, 'pedido', 1500);
}

// --- settings and the download page ---------------------------------------------------------
if (wanted('app')) {
  await open(sam, channelUrl('text:geral'));
  await sam.getByRole('button', { name: 'Configurações', exact: true }).click();
  await sam.getByRole('dialog').getByRole('tab', { name: 'ATALHOS' }).click();
  await shot(sam, 'configuracoes', 1200);
  await open(sam, `${BASE}/download`);
  await shot(sam, 'download', 1200);
}

// --- on a phone -----------------------------------------------------------------------------
if (wanted('mobile')) {
  const phone = await login('samuel.demo', { phone: true });
  await open(phone, channelUrl('text:geral'));
  await shot(phone, 'mobile-chat', 1500);
  await phone.getByRole('button', { name: '[ CANAIS ]' }).click();
  await shot(phone, 'mobile-canais', 1200);
  await phone
    .getByRole('navigation', { name: 'Canais' })
    .getByRole('link', { name: /Cinema/ })
    .click();
  await phone.getByTestId('voice-status').filter({ hasText: 'CONECTADO' }).first().waitFor();
  await phone.getByRole('button', { name: 'Assistir Beatriz' }).click();
  await shot(phone, 'mobile-voz', 5000);
  await phone.context().close();
}

// --- stream measurements: Samuel owns the server, so he sees every stream in it ----------------
if (wanted('transmissoes')) {
  await sam.waitForTimeout(Math.max(0, 30_000 - (Date.now() - streamingSince)));
  await open(sam, `${BASE}/transmissoes`);
  const report = sam
    .getByRole('link')
    .filter({ hasText: /Beatriz/ })
    .first();
  if (await report.count()) await report.click();
  await shot(sam, 'transmissoes', 2500);
}

game.close();
for (const page of [bia, ana, leo, caio, sam]) await page.context().close();

// --- a meeting: a guest knocks, the host lets them in (reuniao.gif, reuniao*.png) ---------------
if (wanted('reuniao')) {
  const host = await login('samuel.demo', { speaks: true });
  await host.getByTestId('new-meeting').click();
  await host.waitForURL(/\/reuniao\//);
  await host.getByTestId('voice-status').filter({ hasText: 'CONECTADO' }).waitFor();
  const link = host.url();
  const friend = await login('ana.demo');
  await open(friend, link);
  await friend.getByRole('button', { name: 'PEDIR PARA ENTRAR' }).click();
  await host.getByTestId('knock').getByRole('button', { name: 'ADMITIR' }).click();
  await friend.getByTestId('voice-status').filter({ hasText: 'CONECTADO' }).waitFor();

  const context = await browser.newContext({
    viewport: DESKTOP,
    deviceScaleFactor: 2,
    locale: 'pt-BR',
    permissions: ['microphone', 'camera'],
  });
  const guest = await context.newPage();
  await guest.goto(link);
  await guest.getByLabel('SEU NOME').fill('Marina');
  await shot(guest, 'reuniao-porta', 1000);

  const video = await record(host);
  await host.waitForTimeout(1200);
  await guest.getByRole('button', { name: 'PEDIR PARA ENTRAR' }).click();
  await host.getByTestId('knock').waitFor();
  await host.waitForTimeout(2200);
  await host.getByTestId('knock').getByRole('button', { name: 'ADMITIR' }).click();
  await guest.getByTestId('voice-status').filter({ hasText: 'CONECTADO' }).waitFor();
  await host.waitForTimeout(1200);
  const field = guest.getByLabel('Mensagem para a reunião');
  await field.fill('oi! cheguei pelo link, sem conta mesmo');
  await field.press('Enter');
  await host.waitForTimeout(2500);
  await video.stop('reuniao');
  await shot(host, 'reuniao', 1000);
  await context.close();
  await friend.context().close();
  await host.context().close();
}

await browser.close();
