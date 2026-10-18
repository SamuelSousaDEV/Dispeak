import path from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import { API_PREFIX, GATEWAY_PATH } from '@frequencia/shared';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Config } from './config';
import './context';
import { connectDatabase, runMigrations } from './db/client';
import { errorHandler, unauthorized } from './errors';
import { GatewayBus } from './gateway/bus';
import { GatewayHub } from './gateway/hub';
import { ActivityService } from './gateway/activity';
import { PresenceService } from './gateway/presence';
import { labRoutes } from './lab/routes';
import { registerMetrics } from './metrics';
import { authRoutes } from './modules/auth/routes';
import { GifSearch } from './modules/embeds/gifs';
import { LinkPreviews } from './modules/embeds/link-preview';
import { embedRoutes } from './modules/embeds/routes';
import { AuthService } from './modules/auth/service';
import { guildRoutes } from './modules/guilds/routes';
import { friendRoutes } from './modules/friends/routes';
import { FriendService } from './modules/friends/service';
import { GuildService } from './modules/guilds/service';
import { AttachmentFiles } from './modules/messages/attachment-files';
import { messageRoutes } from './modules/messages/routes';
import { MessageService } from './modules/messages/service';
import { meetingRoutes } from './modules/meetings/routes';
import { MeetingService } from './modules/meetings/service';
import { MediaLink } from './modules/voice/media-link';
import { PictureStore } from './modules/users/pictures';
import { userRoutes } from './modules/users/routes';
import { UserService } from './modules/users/service';
import { UserSettingsService } from './modules/users/settings';
import { conversationRoutes } from './modules/conversations/routes';
import { ConversationService } from './modules/conversations/service';
import { streamReportRoutes } from './modules/streams/routes';
import { StreamReportService } from './modules/streams/service';
import { voiceRoutes } from './modules/voice/routes';
import { voiceLabRoutes } from './modules/voice-lab/routes';
import { VoiceLabService } from './modules/voice-lab/service';
import { VoiceAccess } from './modules/voice/voice-access';
import { VoiceStateStore } from './modules/voice/voice-state';
import { connectRedis } from './redis';

const WS_MAX_PAYLOAD_BYTES = 256 * 1024;
const ATTACHMENT_SWEEP_MS = 30 * 60 * 1000;

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    // Behind Caddy the client address comes from X-Forwarded-For.
    trustProxy: config.NODE_ENV === 'production',
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: config.LOG_LEVEL,
            ...(config.NODE_ENV === 'development'
              ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
              : {}),
          },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);

  // --- infrastructure -----------------------------------------------------------------------
  const database = connectDatabase(config.DATABASE_URL, config.DATABASE_POOL_SIZE);
  if (config.RUN_MIGRATIONS) await runMigrations(database.db);
  const { redis, subscriber, close: closeRedis } = connectRedis(config.REDIS_URL);

  // --- services -----------------------------------------------------------------------------
  const bus = new GatewayBus(redis, subscriber);
  await bus.start();
  // Presence entries outlive two missed heartbeats plus the resume window.
  const presence = new PresenceService(
    redis,
    config.GATEWAY_HEARTBEAT_MS * 2 + config.GATEWAY_RESUME_WINDOW_MS + 5000,
  );
  const voiceStates = new VoiceStateStore(redis);
  const activity = new ActivityService(redis);
  const live = { presence, activity, voiceStates };
  const auth = new AuthService(database.db, redis, bus, config);
  const voice = new VoiceAccess({
    db: database.db,
    redis,
    bus,
    voiceStates,
    config,
    log: app.log,
  });
  const meetings = new MeetingService({
    db: database.db,
    redis,
    subscriber,
    config,
    log: app.log,
  });
  await meetings.start();
  const streamReports = new StreamReportService({ db: database.db, redis, log: app.log });
  const voiceLab = new VoiceLabService(database.db);
  const media = new MediaLink({
    url: config.MEDIA_INTERNAL_URL,
    sharedSecret: config.MEDIA_SHARED_SECRET,
    log: app.log,
    onConnected: async (snapshot) => {
      // One snapshot for both voice channels and meeting calls, taken when the voice mirror
      // asks for it (it reads its clock first).
      let peers: Awaited<ReturnType<typeof snapshot>> = [];
      await voice.resync(async () => (peers = await snapshot()));
      await meetings.resync(peers);
    },
    onVoiceState: (event) =>
      MeetingService.owns(event.roomId)
        ? meetings.applyVoiceState(event)
        : voice.applyVoiceState(event),
    onStreamReport: (event) => streamReports.record(event),
  });
  voice.attach(media);
  meetings.attach(media);
  // Subdirectories are out of reach of the attachment sweep.
  const pictures = new PictureStore(
    new AttachmentFiles(path.resolve(config.UPLOADS_DIR, 'pictures')),
  );
  const users = new UserService(database.db, bus, pictures);
  const userSettings = new UserSettingsService(database.db, bus);
  const guilds = new GuildService({
    db: database.db,
    bus,
    live,
    voice,
    pictures,
    soundFiles: new AttachmentFiles(path.resolve(config.UPLOADS_DIR, 'sounds')),
  });
  const conversations = new ConversationService({
    db: database.db,
    bus,
    live,
    voice,
    settings: userSettings,
  });
  const friends = new FriendService({ db: database.db, bus, conversations });
  const messages = new MessageService(
    database.db,
    bus,
    new AttachmentFiles(path.resolve(config.UPLOADS_DIR)),
    conversations,
  );
  const linkPreviews = new LinkPreviews({ allowPrivate: config.LINK_PREVIEW_ALLOW_PRIVATE });
  const gifs = new GifSearch({ apiKey: config.GIPHY_API_KEY, baseUrl: config.GIPHY_API_URL });
  // Uploads that never made it into a message, files whose message is gone, old stream
  // reports and old voice test recordings.
  const sweepAttachments = () =>
    Promise.all([
      messages.sweepAttachments().catch((error: unknown) => {
        app.log.warn({ err: error }, 'attachment sweep failed');
      }),
      streamReports.sweep().catch((error: unknown) => {
        app.log.warn({ err: error }, 'stream report sweep failed');
      }),
      voiceLab.sweep().catch((error: unknown) => {
        app.log.warn({ err: error }, 'voice test recording sweep failed');
      }),
    ]);
  const sweepTimer = setInterval(() => void sweepAttachments(), ATTACHMENT_SWEEP_MS);
  sweepTimer.unref();
  void sweepAttachments();
  const hub = new GatewayHub({
    db: database.db,
    bus,
    auth,
    userSettings,
    conversations,
    live,
    config,
    log: app.log,
  });
  hub.start();
  media.start();

  app.decorate('ctx', {
    config,
    log: app.log,
    db: database.db,
    redis,
    bus,
    presence,
    voiceStates,
    auth,
    guilds,
    friends,
    conversations,
    messages,
    users,
    userSettings,
    pictures,
    linkPreviews,
    gifs,
    voice,
    media,
    hub,
    streamReports,
    voiceLab,
    meetings,
  });
  app.decorateRequest('auth');
  app.decorate('authenticate', async (request) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const claims = token ? await auth.authenticate(token) : null;
    if (!claims) throw unauthorized();
    request.auth = claims;
  });

  app.addHook('onClose', async () => {
    clearInterval(sweepTimer);
    meetings.stop();
    media.stop();
    await hub.close();
    await closeRedis();
    await database.close();
  });

  // --- plugins ------------------------------------------------------------------------------
  await app.register(cors, { origin: config.CORS_ORIGINS, credentials: true });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD_BYTES } });
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    redis,
    nameSpace: 'ratelimit:',
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Dispeaker API',
        description:
          'REST API of Dispeaker. Realtime events are delivered over the WebSocket gateway ' +
          `at \`${API_PREFIX}${GATEWAY_PATH}\`; media signaling is served by the media service.`,
        version: '1.0.0',
      },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // --- routes -------------------------------------------------------------------------------
  registerMetrics(app);
  await app.register(
    async (api) => {
      api.get('/health', { schema: { hide: true } }, async () => ({
        status: 'ok',
        service: 'api',
        uptime: process.uptime(),
        media: media.connected,
      }));

      api.get(GATEWAY_PATH, { websocket: true, schema: { hide: true } }, (socket) =>
        hub.accept(socket),
      );

      await api.register(authRoutes);
      await api.register(guildRoutes);
      await api.register(friendRoutes);
      await api.register(messageRoutes);
      await api.register(embedRoutes);
      await api.register(userRoutes);
      await api.register(conversationRoutes);
      await api.register(voiceRoutes);
      await api.register(streamReportRoutes);
      await api.register(voiceLabRoutes);
      await api.register(meetingRoutes);
      if (config.LAB_ENABLED) await api.register(labRoutes);
    },
    { prefix: API_PREFIX },
  );

  return app;
}
