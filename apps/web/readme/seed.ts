// Fictional data for the README pictures: node readme/seed.ts [baseURL]
// Creates (or reuses) six demo accounts, a server with channels, a conversation, a poll, a thread
// and a pending message request, and writes readme/.demo.json for capture.ts. Local stack only:
// against production the accounts would be real.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:5173';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE + '/')) {
  throw new Error('the README seed only runs against a local stack');
}
const API = `${BASE}/api`;
const OUT = path.resolve(import.meta.dirname, '.demo.json');
/** Shared with the portfolio's captures, which use the same demo accounts. */
const DEMO_PASSWORD = 'demo-portfolio-2026';

type Json = Record<string, unknown>;

async function call<T = Json>(method: string, route: string, token?: string, body?: unknown) {
  const binary = body instanceof Uint8Array;
  const response = await fetch(API + route, {
    method,
    headers: {
      ...(body === undefined
        ? {}
        : { 'content-type': binary ? 'application/octet-stream' : 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : binary ? new Uint8Array(body) : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${method} ${route} -> ${response.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

type Person = { username: string; displayName: string; token: string; id: string };
type Channel = { id: string; type: string; name: string };
type Message = { id: string; poll?: { options: Array<{ id: string }> } | null };

const PEOPLE = [
  ['samuel.demo', 'Samuel'],
  ['ana.demo', 'Ana Clara'],
  ['beatriz.demo', 'Beatriz'],
  ['leo.demo', 'Leonardo'],
  ['caio.demo', 'Caio'],
  ['rafaela.demo', 'Rafaela'],
] as const;

const people: Person[] = [];
for (const [username, displayName] of PEOPLE) {
  type Auth = { accessToken: string; user: { id: string } };
  const auth = await call<Auth>('POST', '/auth/register', undefined, {
    username,
    displayName,
    password: DEMO_PASSWORD,
  }).catch(() =>
    call<Auth>('POST', '/auth/login', undefined, { username, password: DEMO_PASSWORD }),
  );
  people.push({ username, displayName, token: auth.accessToken, id: auth.user.id });
}
const [sam, ana, bia, leo, caio, rafa] = people as [Person, Person, Person, Person, Person, Person];

// --- the server, from scratch on every run ------------------------------------------------------
const GUILD = 'Turma do Sábado';
for (const guild of await call<Array<{ id: string; name: string }>>('GET', '/guilds', sam.token)) {
  if (guild.name === GUILD) await call('DELETE', `/guilds/${guild.id}`, sam.token);
}
const { id: guildId } = await call<{ id: string }>('POST', '/guilds', sam.token, { name: GUILD });
const loadChannels = async () =>
  (await call<{ channels: Channel[] }>('GET', `/guilds/${guildId}`, sam.token)).channels;
const find = (channels: Channel[], type: string, name: string) => {
  const channel = channels.find((c) => c.type === type && c.name === name);
  if (!channel) throw new Error(`no ${type} channel ${name}`);
  return channel.id;
};
let channels = await loadChannels();
const textCategory = find(channels, 'category', 'Texto');
const voiceCategory = find(channels, 'category', 'Voz');
for (const [type, name, parentId] of [
  ['text', 'clipes', textCategory],
  ['text', 'jogos', textCategory],
  ['voice', 'Jogatina', voiceCategory],
  ['voice', 'Cinema', voiceCategory],
] as const) {
  await call('POST', `/guilds/${guildId}/channels`, sam.token, { name, type, parentId });
}
channels = await loadChannels();

const invite = await call<{ code: string }>('POST', `/guilds/${guildId}/invites`, sam.token, {
  maxUses: 10,
  expiresInSeconds: 3600,
});
for (const person of [ana, bia, leo, caio, rafa]) {
  await call('POST', `/invites/${invite.code}/accept`, person.token);
}
const role = await call<{ id: string }>('POST', `/guilds/${guildId}/roles`, sam.token, {
  name: 'Moderação',
});
await call('PATCH', `/guilds/${guildId}/members/${bia.id}`, sam.token, { roleIds: [role.id] });

// --- friends: everyone but Rafaela -------------------------------------------------------------
type Request = { id: string; direction: string };
for (const person of [ana, bia, leo, caio]) {
  await call('POST', '/friends/requests', sam.token, { username: person.username }).catch(() => {});
  const { requests } = await call<{ requests: Request[] }>(
    'GET',
    '/friends/requests',
    person.token,
  );
  for (const request of requests.filter((r) => r.direction === 'incoming')) {
    await call('POST', `/friends/requests/${request.id}/accept`, person.token);
  }
}

// --- #geral -----------------------------------------------------------------------------------
const geral = find(channels, 'text', 'geral');
const say = (person: Person, channel: string, content: string, extra: Json = {}) =>
  call<Message>('POST', `/channels/${channel}/messages`, person.token, { content, ...extra });
const react = (person: Person, message: Message, emoji: string) =>
  call('PUT', `/messages/${message.id}/reactions/${encodeURIComponent(emoji)}`, person.token);

await say(caio, geral, 'alguém online pra jogatina hoje?');
await say(leo, geral, 'eu! mas só depois das 21h');
const tested = await say(
  bia,
  geral,
  'testei a transmissão em 1080p60 ontem, ficou liso até com o jogo em tela cheia',
);
await say(ana, geral, 'pelo app de desktop né? no navegador o meu caía pra 30 fps', {
  replyToId: tested.id,
});
await say(bia, geral, 'isso, pelo app. a diferença é absurda');
const plan = await say(
  sam,
  geral,
  `boa! <@${bia.id}> transmite o campeonato hoje à noite pra gente assistir no Cinema?`,
);
await say(bia, geral, 'fechado, 21h no canal Cinema 🍿');
for (const [person, emoji] of [
  [ana, '🔥'],
  [leo, '🔥'],
  [caio, '👍'],
  [bia, '🔥'],
] as const) {
  await react(person, plan, emoji);
}
const poll = await say(caio, geral, '', {
  poll: {
    question: 'Qual jogo depois do campeonato?',
    options: ['Sea of Thieves', 'Valorant', 'Minecraft'],
  },
});
const options = poll.poll?.options ?? [];
for (const [person, index] of [
  [ana, 0],
  [leo, 0],
  [bia, 1],
  [sam, 0],
] as const) {
  const option = options[index];
  if (option) {
    await call('PUT', `/messages/${poll.id}/poll/votes`, person.token, { optionIds: [option.id] });
  }
}

// --- #clipes: a picture and a thread hanging from it ------------------------------------------
const clipes = find(channels, 'text', 'clipes');
const picture = process.env.STREAM_IMAGE;
if (picture) {
  const bytes = new Uint8Array(await readFile(picture));
  const upload = await call<{ id: string }>(
    'POST',
    `/channels/${clipes}/attachments?filename=${encodeURIComponent('night-city.jpg')}`,
    bia.token,
    bytes,
  );
  const clip = await say(bia, clipes, 'print da transmissão de ontem, olha essa luz', {
    attachmentIds: [upload.id],
  });
  await react(leo, clip, '😍');
  await react(sam, clip, '🔥');
}
await say(leo, clipes, 'vou abrir um tópico pros melhores momentos do campeonato');
const thread = await call<{ id: string }>('POST', `/channels/${clipes}/threads`, leo.token, {
  name: 'melhores momentos',
});
await say(leo, thread.id, 'a virada no último round 😱');
await say(caio, thread.id, 'a Bia narrando foi o melhor da noite');
await say(bia, thread.id, 'hahaha amanhã tem mais');

// --- a private conversation, and a request from someone who is not a friend -------------------
// Conversations outlive the server, so the previous run's messages go first.
async function conversationText(from: Person, to: Person) {
  const { id } = await call<{ id: string }>('POST', `/users/${to.id}/conversation`, from.token);
  const { channels: own } = await call<{ channels: Channel[] }>('GET', `/guilds/${id}`, from.token);
  const text = own.find((c) => c.type === 'text')?.id;
  if (!text) throw new Error('the conversation has no text channel');
  const { messages } = await call<{ messages: Array<{ id: string; author: { id: string } }> }>(
    'GET',
    `/channels/${text}/messages`,
    from.token,
  );
  for (const message of messages) {
    const author = people.find((p) => p.id === message.author.id);
    if (author) await call('DELETE', `/messages/${message.id}`, author.token);
  }
  return { id, text };
}

const { id: dmId, text: dmText } = await conversationText(ana, sam);
for (const [person, content] of [
  [ana, 'ei, me manda o link do instalador do app?'],
  [sam, 'tá na página de download, ele se atualiza sozinho depois'],
  [ana, 'instalei! o atalho de mutar funciona até com o jogo aberto'],
  [sam, 'isso, os atalhos são globais. define os teus em Configurações → Atalhos'],
  [ana, 'perfeito, te vejo às 21h no Cinema'],
] as const) {
  await say(person, dmText, content);
}
const request = await conversationText(rafa, sam);
await say(
  rafa,
  request.text,
  'oi Samuel! a Bia me chamou pro servidor, posso entrar na call de hoje?',
);

const ids = Object.fromEntries(channels.map((c) => [`${c.type}:${c.name}`, c.id]));
await writeFile(
  OUT,
  JSON.stringify(
    {
      password: DEMO_PASSWORD,
      guildId,
      dmId,
      requestId: request.id,
      channels: { ...ids, 'thread:melhores momentos': thread.id },
      users: Object.fromEntries(people.map((p) => [p.username, { id: p.id, name: p.displayName }])),
    },
    null,
    2,
  ),
);
console.log(`ok: ${GUILD} (${guildId}), ${channels.length} channels, ${people.length} people`);
