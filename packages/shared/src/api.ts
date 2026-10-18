import { z } from 'zod';
import { permissionBitsSchema } from './permissions';

/** REST contracts: request bodies and response payloads of the API. */

export const idSchema = z.uuid();

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(24)
  .regex(/^[a-z0-9_.]+$/, 'only lowercase letters, numbers, _ and . are allowed');

export const passwordSchema = z.string().min(8).max(128);
export const displayNameSchema = z.string().trim().min(1).max(32);

/** Profile pictures and server icons: small square images, prepared by the client. */
export const PICTURE_MAX_BYTES = 1024 * 1024;
/** Side, in pixels, clients resize a picture to before sending it. */
export const PICTURE_SIZE = 256;

export const userSchema = z.object({
  id: idSchema,
  username: z.string(),
  displayName: z.string(),
  /** Id of the profile picture, served at `/images/:id`; a new id for every upload. */
  avatar: idSchema.nullable(),
  /** Id of the wide picture on top of the profile card. */
  banner: idSchema.nullable(),
  /** "About me". */
  bio: z.string().nullable(),
  /** A line the user wrote about what they are up to. */
  customStatus: z.string().nullable(),
  /** `#rrggbb` that tints the profile card. */
  accentColor: z.string().nullable(),
  /** How the user wants to be seen while online. Who is online at all is a separate list. */
  status: z.enum(['online', 'idle', 'dnd']),
});
export type User = z.infer<typeof userSchema>;

/** What the user picks; `invisible` shows them as offline to everyone else. */
export const presenceModeSchema = z.enum(['online', 'idle', 'dnd', 'invisible']);
export type PresenceMode = z.infer<typeof presenceModeSchema>;

/** The signed-in user, with what only they are told. */
export const selfSchema = userSchema.extend({ presence: presenceModeSchema });
export type Self = z.infer<typeof selfSchema>;

export const BIO_MAX_LENGTH = 190;
export const CUSTOM_STATUS_MAX_LENGTH = 80;
/** Side of the banner clients send, in pixels (width x height). */
export const BANNER_SIZE = { width: 680, height: 240 } as const;

export const updateProfileRequestSchema = z
  .object({
    displayName: displayNameSchema,
    bio: z.string().trim().max(BIO_MAX_LENGTH).nullable(),
    customStatus: z.string().trim().max(CUSTOM_STATUS_MAX_LENGTH).nullable(),
    accentColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .nullable(),
    presence: presenceModeSchema,
  })
  .partial();
export type UpdateProfileRequest = z.input<typeof updateProfileRequestSchema>;

/** How long a password reset link works. */
export const PASSWORD_RESET_TTL_SECONDS = 60 * 60;

/** A one-time link the owner of a server hands to a member who forgot their password. */
export const passwordResetLinkSchema = z.object({
  /** Goes in the address of the reset page; shown once and never stored as it is. */
  token: z.string(),
  expiresAt: z.iso.datetime(),
});
export type PasswordResetLink = z.infer<typeof passwordResetLinkSchema>;

export const resetPasswordRequestSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword: passwordSchema,
});

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

// --- auth -----------------------------------------------------------------------------------

export const registerRequestSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema.optional(),
  password: passwordSchema,
  /** Asked for by servers that only take new accounts from people who were given the code. */
  accessCode: z.string().max(128).optional(),
});
export type RegisterRequest = z.input<typeof registerRequestSchema>;

/** What someone about to create an account has to know about this server. */
export const registrationInfoSchema = z.object({
  /** New accounts need the access code the owner of the server hands out. */
  accessCodeRequired: z.boolean(),
});
export type RegistrationInfo = z.infer<typeof registrationInfoSchema>;

export const loginRequestSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.input<typeof loginRequestSchema>;

export const authResponseSchema = z.object({
  accessToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int(),
  user: selfSchema,
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

// --- guild structure ------------------------------------------------------------------------

/** A `thread` is a side conversation hanging from a text channel, under the same permissions. */
export const channelTypeSchema = z.enum(['text', 'voice', 'category', 'thread']);
export type ChannelType = z.infer<typeof channelTypeSchema>;

export const overwriteSchema = z.object({
  targetType: z.enum(['role', 'member']),
  targetId: idSchema,
  allow: permissionBitsSchema,
  deny: permissionBitsSchema,
});
export type Overwrite = z.infer<typeof overwriteSchema>;

const channelNameSchema = z.string().trim().min(1).max(48);
const channelTopicSchema = z.string().trim().max(256);

export const channelSchema = z.object({
  id: idSchema,
  guildId: idSchema,
  type: channelTypeSchema,
  name: z.string(),
  topic: z.string().nullable(),
  position: z.number().int(),
  /** Category the channel belongs to; for a thread, the text channel it hangs from. */
  parentId: idSchema.nullable(),
  overwrites: z.array(overwriteSchema),
});
export type Channel = z.infer<typeof channelSchema>;

export const roleColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

export const roleSchema = z.object({
  /** The @everyone role shares its id with the guild. */
  id: idSchema,
  guildId: idSchema,
  name: z.string(),
  permissions: permissionBitsSchema,
  /** Rank in the hierarchy; higher outranks lower, @everyone is 0. */
  position: z.number().int(),
  /** `#rrggbb` shown on the names of its members; `null` leaves them plain. */
  color: roleColorSchema.nullable(),
});
export type Role = z.infer<typeof roleSchema>;

export const memberSchema = z.object({
  user: userSchema,
  nickname: z.string().nullable(),
  /** Roles besides @everyone. */
  roleIds: z.array(idSchema),
  joinedAt: z.iso.datetime(),
  /** Silenced by a moderator: cannot send their microphone in any voice channel of the guild. */
  serverMuted: z.boolean(),
});
export type Member = z.infer<typeof memberSchema>;

export const presenceStatusSchema = z.enum(['online', 'offline']);
export type PresenceStatus = z.infer<typeof presenceStatusSchema>;

export const voiceStateSchema = z.object({
  guildId: idSchema,
  channelId: idSchema,
  userId: idSchema,
  muted: z.boolean(),
  deafened: z.boolean(),
  /** Sharing a screen in the channel. */
  streaming: z.boolean(),
});
export type VoiceState = z.infer<typeof voiceStateSchema>;

/** Moments of a voice channel announced with a sound. */
export const GUILD_SOUND_EVENTS = [
  'join',
  'leave',
  'streamStart',
  'streamStop',
  /** The local user starts or stops watching someone's stream. */
  'watchStart',
  'watchStop',
  /** Someone starts or stops watching the local user's own stream. */
  'viewerJoin',
  'viewerLeave',
] as const;
export const guildSoundEventSchema = z.enum(GUILD_SOUND_EVENTS);
export type GuildSoundEvent = z.infer<typeof guildSoundEventSchema>;

export const GUILD_SOUND_MAX_BYTES = 2 * 1024 * 1024;
/** What the server recognises, from the bytes of the file. */
export const GUILD_SOUND_CONTENT_TYPES = [
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/flac',
  'audio/mp4',
  'audio/webm',
] as const;
export type GuildSoundContentType = (typeof GUILD_SOUND_CONTENT_TYPES)[number];

export const guildSoundSchema = z.object({
  /** Changes whenever the file is replaced, so clients know when to download it again. */
  id: idSchema,
  filename: z.string(),
});
export type GuildSound = z.infer<typeof guildSoundSchema>;

export const uploadGuildSoundQuerySchema = z.object({
  filename: z.string().trim().min(1).max(255),
});

/**
 * `server` is a place people are invited to. `dm` is the private conversation of two friends:
 * the same thing underneath (a text channel and a voice channel), without owner, roles or
 * invites, and never listed among the servers.
 */
/** What someone is doing right now: the game the desktop app sees running. */
export const activitySchema = z.object({
  game: z.string().trim().min(1).max(128),
  /** When it started. */
  since: z.iso.datetime(),
});
export type Activity = z.infer<typeof activitySchema>;

export const guildKindSchema = z.enum(['server', 'dm']);
export type GuildKind = z.infer<typeof guildKindSchema>;

/** A guild as one member sees it: only the channels they can view. */
/**
 * A private conversation as one of its two people sees it. Being friends and talking are
 * separate: people who share a server may talk, and the conversation outlives a friendship.
 */
export const dmStateSchema = z.object({
  friend: z.boolean(),
  /**
   * A first conversation started by someone who is not a friend: `incoming` waits for this user
   * to accept or decline, `outgoing` for the other one. `hidden`: declined by this user, or
   * started by the other without a message yet; not shown.
   */
  request: z.enum(['incoming', 'outgoing', 'hidden']).nullable(),
  /** Nothing can be sent or called while one of the two blocks the other (`you`: this user). */
  blocked: z.enum(['you', 'other']).nullable(),
});
export type DmState = z.infer<typeof dmStateSchema>;

export const guildSchema = z.object({
  id: idSchema,
  kind: guildKindSchema,
  /** Private conversations only. */
  dm: dmStateSchema.nullable(),
  name: z.string(),
  /** Id of the server icon, served at `/images/:id`. */
  icon: idSchema.nullable(),
  ownerId: idSchema,
  channels: z.array(channelSchema),
  roles: z.array(roleSchema),
  members: z.array(memberSchema),
  /** Ids of the members currently online. */
  onlineUserIds: z.array(idSchema),
  /** What the online members are doing (the game they play), by user id. */
  activities: z.record(idSchema, activitySchema),
  voiceStates: z.array(voiceStateSchema),
  /** Sounds chosen by the owner for everyone in the guild; `null` means the built-in one. */
  sounds: z.object({
    join: guildSoundSchema.nullable(),
    leave: guildSoundSchema.nullable(),
    streamStart: guildSoundSchema.nullable(),
    streamStop: guildSoundSchema.nullable(),
    watchStart: guildSoundSchema.nullable(),
    watchStop: guildSoundSchema.nullable(),
    viewerJoin: guildSoundSchema.nullable(),
    viewerLeave: guildSoundSchema.nullable(),
  }),
});
export type Guild = z.infer<typeof guildSchema>;

export const guildSummarySchema = guildSchema.pick({
  id: true,
  name: true,
  icon: true,
  ownerId: true,
});
export type GuildSummary = z.infer<typeof guildSummarySchema>;

const guildNameSchema = z.string().trim().min(2).max(48);
export const createGuildRequestSchema = z.object({ name: guildNameSchema });
export const updateGuildRequestSchema = z.object({ name: guildNameSchema });

export const createChannelRequestSchema = z.object({
  name: channelNameSchema,
  // Threads are created from their channel, with `createThreadRequestSchema`.
  type: channelTypeSchema.exclude(['thread']),
  parentId: idSchema.nullable().optional(),
});
export type CreateChannelRequest = z.input<typeof createChannelRequestSchema>;

export const createThreadRequestSchema = z.object({ name: channelNameSchema });
export type CreateThreadRequest = z.input<typeof createThreadRequestSchema>;

export const updateChannelRequestSchema = z
  .object({
    name: channelNameSchema,
    topic: channelTopicSchema.nullable(),
    parentId: idSchema.nullable(),
  })
  .partial();
export type UpdateChannelRequest = z.input<typeof updateChannelRequestSchema>;

/** New order of channels; positions are assigned from the array order. */
export const reorderChannelsRequestSchema = z.object({
  channels: z
    .array(z.object({ id: idSchema, parentId: idSchema.nullable() }))
    .min(1)
    .max(500),
});
export type ReorderChannelsRequest = z.infer<typeof reorderChannelsRequestSchema>;

export const putOverwriteRequestSchema = overwriteSchema.omit({ targetId: true });
export type PutOverwriteRequest = z.infer<typeof putOverwriteRequestSchema>;

const roleNameSchema = z.string().trim().min(1).max(32);
export const createRoleRequestSchema = z.object({
  name: roleNameSchema,
  permissions: permissionBitsSchema.default('0'),
  color: roleColorSchema.nullable().default(null),
});
export type CreateRoleRequest = z.input<typeof createRoleRequestSchema>;

export const updateRoleRequestSchema = z
  .object({
    name: roleNameSchema,
    permissions: permissionBitsSchema,
    color: roleColorSchema.nullable(),
  })
  .partial();
export type UpdateRoleRequest = z.input<typeof updateRoleRequestSchema>;

/** Role ids from the highest rank to the lowest, @everyone excluded. */
export const reorderRolesRequestSchema = z.object({
  roleIds: z.array(idSchema).min(1).max(250),
});

export const updateMemberRequestSchema = z
  .object({
    roleIds: z.array(idSchema).max(250),
    nickname: z.string().trim().min(1).max(32).nullable(),
    /** MUTE_MEMBERS: silences the member's microphone in the guild's voice channels. */
    serverMuted: z.boolean(),
  })
  .partial();
export type UpdateMemberRequest = z.input<typeof updateMemberRequestSchema>;

// --- bans -----------------------------------------------------------------------------------

/** Someone removed from a guild who cannot come back with an invite. */
export const banSchema = z.object({
  user: userSchema,
  /** Who banned them. */
  bannedBy: idSchema,
  createdAt: z.iso.datetime(),
});
export type Ban = z.infer<typeof banSchema>;

// --- invites --------------------------------------------------------------------------------

export const INVITE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export const inviteSchema = z.object({
  code: z.string(),
  guildId: idSchema,
  creatorId: idSchema,
  /** `null` means unlimited. */
  maxUses: z.number().int().nullable(),
  uses: z.number().int(),
  /** `null` means it never expires. */
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Invite = z.infer<typeof inviteSchema>;

export const createInviteRequestSchema = z.object({
  maxUses: z.number().int().min(1).max(1000).nullable().default(null),
  expiresInSeconds: z.number().int().min(60).max(INVITE_MAX_AGE_SECONDS).nullable().default(null),
});
export type CreateInviteRequest = z.input<typeof createInviteRequestSchema>;

export const invitePreviewSchema = z.object({
  code: z.string(),
  guild: z.object({ id: idSchema, name: z.string(), memberCount: z.number().int() }),
  /** The requesting user already belongs to the guild. */
  alreadyMember: z.boolean(),
});
export type InvitePreview = z.infer<typeof invitePreviewSchema>;

// --- messages ------------------------------------------------------------------------------

export const MESSAGE_MAX_LENGTH = 2000;
export const MESSAGE_PAGE_SIZE = 50;

/** How a user mention is written inside message content: `<@user-id>`. */
export const MENTION_PATTERN = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/g;
/** Mentions every member; honoured only with the MENTION_EVERYONE permission. */
export const EVERYONE_MENTION = '@todos';

export const formatMention = (userId: string) => `<@${userId}>`;

/** Ids of the users mentioned in a piece of content, without duplicates. */
export function extractMentions(content: string): string[] {
  return [...new Set([...content.matchAll(MENTION_PATTERN)].map((match) => match[1] as string))];
}

export const messageContentSchema = z.string().trim().min(1).max(MESSAGE_MAX_LENGTH);

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_MAX_PER_MESSAGE = 4;
/**
 * Images are shown in the conversation; they are identified by their bytes on the server (SVG
 * is left out on purpose). Any other file is kept as it came and only ever offered for download.
 */
export const IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];

export const attachmentSchema = z.object({
  id: idSchema,
  filename: z.string(),
  /** One of `IMAGE_CONTENT_TYPES`, or `application/octet-stream` for everything else. */
  contentType: z.string(),
  /** Bytes. */
  size: z.number().int(),
  /** Pixels, when the file header says so; lets clients reserve the space before loading. */
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const uploadAttachmentQuerySchema = z.object({
  filename: z.string().trim().min(1).max(255),
});

// --- polls ----------------------------------------------------------------------------------

export const POLL_MAX_OPTIONS = 10;

export const pollSchema = z.object({
  question: z.string(),
  /** Whether a voter may pick more than one option. */
  multiple: z.boolean(),
  options: z.array(
    z.object({
      id: idSchema,
      text: z.string(),
      /** Who voted for it, oldest first. */
      voterIds: z.array(idSchema),
    }),
  ),
});
export type Poll = z.infer<typeof pollSchema>;

export const createPollSchema = z.object({
  question: z.string().trim().min(1).max(300),
  options: z.array(z.string().trim().min(1).max(100)).min(2).max(POLL_MAX_OPTIONS),
  multiple: z.boolean().default(false),
});
export type CreatePoll = z.input<typeof createPollSchema>;

/** The options the user stands for now; an empty list takes the vote back. */
export const votePollRequestSchema = z.object({
  optionIds: z.array(idSchema).max(POLL_MAX_OPTIONS),
});

/** Different emojis one message can collect. */
export const REACTION_MAX_PER_MESSAGE = 20;

const EMOJI_PIECES =
  /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[#*0-9]|\u200d|\ufe0f|\u20e3)+$/u;
const EMOJI_CORE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;

/** One emoji, possibly a sequence (skin tone, flag, family). Free text is not a reaction. */
export const reactionEmojiSchema = z
  .string()
  .min(1)
  .max(32)
  .refine((value) => EMOJI_PIECES.test(value) && EMOJI_CORE.test(value), {
    message: 'not an emoji',
  });

export const reactionSchema = z.object({
  emoji: z.string(),
  /** Who reacted, oldest first. */
  userIds: z.array(idSchema),
});
export type Reaction = z.infer<typeof reactionSchema>;

/** How much of the original text a reply carries along. */
export const REPLY_EXCERPT_LENGTH = 200;

/** The message a reply answers, as shown above the reply. */
export const messageReferenceSchema = z.object({
  id: idSchema,
  author: userSchema,
  /** Beginning of the original text. */
  content: z.string(),
  /** How many images the original has. */
  attachments: z.number().int(),
});
export type MessageReference = z.infer<typeof messageReferenceSchema>;

export const messageSchema = z.object({
  /** Time-ordered id; also the pagination cursor. */
  id: idSchema,
  channelId: idSchema,
  guildId: idSchema,
  author: userSchema,
  /** May be empty when the message has attachments. */
  content: z.string(),
  attachments: z.array(attachmentSchema),
  reactions: z.array(reactionSchema),
  /** `null` when the message is not a reply, or the original is gone. */
  replyTo: messageReferenceSchema.nullable(),
  poll: pollSchema.nullable(),
  /** Members mentioned with `<@id>` who can see the channel. */
  mentions: z.array(idSchema),
  mentionEveryone: z.boolean(),
  createdAt: z.iso.datetime(),
  editedAt: z.iso.datetime().nullable(),
});
export type Message = z.infer<typeof messageSchema>;

const optionalContentSchema = z.string().trim().max(MESSAGE_MAX_LENGTH);

export const sendMessageRequestSchema = z
  .object({
    content: optionalContentSchema.default(''),
    /** Ids returned by the upload endpoint, in display order. */
    attachmentIds: z.array(idSchema).max(ATTACHMENT_MAX_PER_MESSAGE).default([]),
    /** A message of the same channel this one answers; its author is notified like a mention. */
    replyToId: idSchema.nullable().default(null),
    poll: createPollSchema.nullable().default(null),
  })
  .refine((value) => value.content.length > 0 || value.attachmentIds.length > 0 || value.poll, {
    message: 'a message needs text, an attachment or a poll',
    path: ['content'],
  });
export type SendMessageRequest = z.input<typeof sendMessageRequestSchema>;

/** The text may only be emptied when the message keeps its attachments. */
export const editMessageRequestSchema = z.object({ content: optionalContentSchema });

export const listMessagesQuerySchema = z.object({
  /** Return messages older than this id. */
  before: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(MESSAGE_PAGE_SIZE),
});

export const messagePageSchema = z.object({
  /** Oldest first. */
  messages: z.array(messageSchema),
  /** Pass as `before` to get the previous page; `null` at the beginning of the channel. */
  nextCursor: idSchema.nullable(),
});
export type MessagePage = z.infer<typeof messagePageSchema>;

// --- unread ---------------------------------------------------------------------------------

/** Messages by other people that arrived in a channel since the user last read it. */
export const unreadChannelSchema = z.object({
  channelId: idSchema,
  guildId: idSchema,
  count: z.number().int(),
  /** How many of them mention the user, answer the user or mention everyone. */
  mentions: z.number().int(),
});
export type UnreadChannel = z.infer<typeof unreadChannelSchema>;

export const unreadResponseSchema = z.object({ channels: z.array(unreadChannelSchema) });

// --- link previews and GIFs -----------------------------------------------------------------

const webUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value), { message: 'only http and https' });

export const unfurlQuerySchema = z.object({ url: webUrlSchema });

export const linkPreviewSchema = z.object({
  url: z.string(),
  /** `image` when the link is the picture itself. */
  kind: z.enum(['page', 'image']),
  title: z.string().nullable(),
  description: z.string().nullable(),
  siteName: z.string().nullable(),
  /** Absolute http(s) URL of the picture to show. */
  image: z.string().nullable(),
});
export type LinkPreview = z.infer<typeof linkPreviewSchema>;

export const gifSearchQuerySchema = z.object({
  /** Empty means "what is trending". */
  q: z.string().trim().max(100).default(''),
});

export const gifSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** What gets posted in the chat. */
  url: z.string(),
  /** Small rendition for the picker. */
  previewUrl: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});
export type Gif = z.infer<typeof gifSchema>;

export const gifPageSchema = z.object({ gifs: z.array(gifSchema) });

/** Optional features of this installation, so clients only offer what works. */
export const featuresSchema = z.object({
  gifs: z.boolean(),
  linkPreviews: z.boolean(),
});
export type Features = z.infer<typeof featuresSchema>;

// --- friends --------------------------------------------------------------------------------

/**
 * A friendship that was asked for and not answered yet, as one of the two sees it. Accepting
 * it opens the private conversation of the pair (a guild of kind `dm`), and that conversation
 * is the friendship from then on.
 */
export const friendRequestSchema = z.object({
  id: idSchema,
  /** The other person. */
  user: userSchema,
  /** `incoming`: they asked; `outgoing`: the reader did. */
  direction: z.enum(['incoming', 'outgoing']),
  createdAt: z.iso.datetime(),
});
export type FriendRequest = z.infer<typeof friendRequestSchema>;

export const friendRequestsResponseSchema = z.object({ requests: z.array(friendRequestSchema) });
export type FriendRequestsResponse = z.infer<typeof friendRequestsResponseSchema>;

export const sendFriendRequestSchema = z.object({ username: usernameSchema });

/** The people this user blocked. */
export const blockListSchema = z.object({ users: z.array(userSchema) });
export type BlockList = z.infer<typeof blockListSchema>;
export type SendFriendRequest = z.infer<typeof sendFriendRequestSchema>;

/** Answer to a request: still pending, or already a conversation when the other had asked too. */
export const sendFriendRequestResponseSchema = z.object({
  request: friendRequestSchema.nullable(),
  guild: guildSchema.nullable(),
});
export type SendFriendRequestResponse = z.infer<typeof sendFriendRequestResponseSchema>;

// --- errors ---------------------------------------------------------------------------------

/** Stable, machine-readable error codes returned as `{ error, message }`. */
export const ApiErrorCode = {
  InvalidRequest: 'invalid_request',
  Unauthorized: 'unauthorized',
  InvalidCredentials: 'invalid_credentials',
  Forbidden: 'forbidden',
  NotFound: 'not_found',
  Conflict: 'conflict',
  UsernameTaken: 'username_taken',
  AccessCodeInvalid: 'access_code_invalid',
  InviteInvalid: 'invite_invalid',
  Banned: 'banned',
  RateLimited: 'rate_limited',
  MediaUnavailable: 'media_unavailable',
  /** The person only takes messages from friends, or shares no server with the sender. */
  DmClosed: 'dm_closed',
  /** One of the two blocks the other. */
  Blocked: 'blocked',
  Internal: 'internal_error',
} as const;
export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
