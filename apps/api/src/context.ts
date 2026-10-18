import '@fastify/cookie';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config';
import type { Database } from './db/client';
import type { GatewayBus } from './gateway/bus';
import type { GatewayHub } from './gateway/hub';
import type { PresenceService } from './gateway/presence';
import type { AuthService } from './modules/auth/service';
import type { AccessClaims } from './modules/auth/tokens';
import type { GifSearch } from './modules/embeds/gifs';
import type { LinkPreviews } from './modules/embeds/link-preview';
import type { ConversationService } from './modules/conversations/service';
import type { FriendService } from './modules/friends/service';
import type { GuildService } from './modules/guilds/service';
import type { MessageService } from './modules/messages/service';
import type { PictureStore } from './modules/users/pictures';
import type { UserService } from './modules/users/service';
import type { UserSettingsService } from './modules/users/settings';
import type { MeetingService } from './modules/meetings/service';
import type { MediaLink } from './modules/voice/media-link';
import type { StreamReportService } from './modules/streams/service';
import type { VoiceAccess } from './modules/voice/voice-access';
import type { VoiceStateStore } from './modules/voice/voice-state';
import type { Redis } from './redis';

/** Long-lived services of one API instance, shared by routes and the gateway. */
export interface AppContext {
  config: Config;
  log: FastifyBaseLogger;
  db: Database;
  redis: Redis;
  bus: GatewayBus;
  presence: PresenceService;
  voiceStates: VoiceStateStore;
  auth: AuthService;
  guilds: GuildService;
  friends: FriendService;
  conversations: ConversationService;
  messages: MessageService;
  users: UserService;
  userSettings: UserSettingsService;
  pictures: PictureStore;
  linkPreviews: LinkPreviews;
  gifs: GifSearch;
  voice: VoiceAccess;
  media: MediaLink;
  hub: GatewayHub;
  streamReports: StreamReportService;
  meetings: MeetingService;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
    /** `onRequest` hook that requires a valid access token and fills `request.auth`. */
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    auth: AccessClaims;
  }
}
