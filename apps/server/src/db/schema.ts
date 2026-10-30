/**
 * ============================================================
 * 数据库 Schema（Drizzle ORM / MySQL 8.4）
 * ------------------------------------------------------------
 * 设计要点：
 * 1. 主键统一 ULID 字符串（26 位）：可按时间排序，索引局部性好，
 *    且不像自增 ID 那样泄露用户/消息总量；
 * 2. 时间统一存 bigint 毫秒时间戳：跨时区无歧义，JS 侧零转换；
 * 3. 消息序号 seq 在会话内单调递增：客户端用它做增量拉取与已读游标，
 *    比 offset 分页稳定（不会因新消息插入而错位）；
 * 4. 私聊会话用 directKey（两用户 id 排序拼接）唯一索引做去重，
 *    避免同一对人建出多个会话；
 * 5. 附件与消息解耦：先上传拿到 attachmentId，再发消息绑定，
 *    这样失败重试不会重复上传大文件。
 * ============================================================
 */

import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  int,
  json,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

/* ------------------------------------------------------------------ */
/* 用户                                                                 */
/* ------------------------------------------------------------------ */

export const users = mysqlTable(
  'users',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    email: varchar('email', { length: 254 }).notNull(),
    /** 注册流程强制验证邮箱，此字段用于风控与兜底 */
    emailVerified: boolean('email_verified').notNull().default(false),
    /** argon2id 哈希，绝不存明文 */
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    nickname: varchar('nickname', { length: 32 }).notNull(),
    avatarUrl: varchar('avatar_url', { length: 512 }),
    bio: varchar('bio', { length: 120 }),
    /** 剩余可发放的邀请名额 */
    inviteQuota: int('invite_quota').notNull().default(0),
    /** 邀请人 id，用于追溯增长来源 */
    invitedBy: varchar('invited_by', { length: 26 }),
    /** active | disabled */
    status: varchar('status', { length: 16 }).notNull().default('active'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastSeenAt: bigint('last_seen_at', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('uk_users_email').on(t.email),
    index('idx_users_invited_by').on(t.invitedBy),
    index('idx_users_status').on(t.status),
  ],
);

/* ------------------------------------------------------------------ */
/* 邮箱验证码                                                           */
/* ------------------------------------------------------------------ */

export const emailCodes = mysqlTable(
  'email_codes',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    email: varchar('email', { length: 254 }).notNull(),
    /** register | reset | rebind */
    purpose: varchar('purpose', { length: 16 }).notNull(),
    /**
     * 验证码哈希（HMAC-SHA256）。
     * 为什么哈希：数据库泄露时验证码不能直接被用来重置密码；
     * 因为验证码只有 6 位，必须加服务端密钥做 HMAC，否则彩虹表秒破。
     */
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    /** 已尝试次数，超过上限直接作废 */
    attempts: int('attempts').notNull().default(0),
    consumedAt: bigint('consumed_at', { mode: 'number' }),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    /** 请求来源 IP，用于风控与限流排查 */
    ip: varchar('ip', { length: 45 }),
  },
  (t) => [
    index('idx_email_codes_lookup').on(t.email, t.purpose, t.createdAt),
    index('idx_email_codes_expires').on(t.expiresAt),
  ],
);

/* ------------------------------------------------------------------ */
/* 邀请码                                                               */
/* ------------------------------------------------------------------ */

export const inviteCodes = mysqlTable(
  'invite_codes',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    /** 8 位大写字母+数字，排除 0/O/1/I 等易混淆字符 */
    code: varchar('code', { length: 16 }).notNull(),
    creatorId: varchar('creator_id', { length: 26 }).notNull(),
    maxUses: int('max_uses').notNull().default(1),
    usedCount: int('used_count').notNull().default(0),
    /** null 表示永久有效 */
    expiresAt: bigint('expires_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('uk_invite_codes_code').on(t.code),
    index('idx_invite_codes_creator').on(t.creatorId),
  ],
);

export const inviteUsages = mysqlTable(
  'invite_usages',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    inviteCodeId: varchar('invite_code_id', { length: 26 }).notNull(),
    inviteeId: varchar('invitee_id', { length: 26 }).notNull(),
    inviterId: varchar('inviter_id', { length: 26 }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('uk_invite_usages_invitee').on(t.inviteeId),
    index('idx_invite_usages_inviter').on(t.inviterId),
    index('idx_invite_usages_code').on(t.inviteCodeId),
  ],
);

/* ------------------------------------------------------------------ */
/* 刷新令牌（可吊销的长期登录态）                                        */
/* ------------------------------------------------------------------ */

export const refreshTokens = mysqlTable(
  'refresh_tokens',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    userId: varchar('user_id', { length: 26 }).notNull(),
    /** 只存哈希：即使库泄露也无法直接冒用 */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    deviceId: varchar('device_id', { length: 128 }).notNull(),
    platform: varchar('platform', { length: 16 }).notNull(),
    deviceName: varchar('device_name', { length: 64 }),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastUsedAt: bigint('last_used_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('uk_refresh_tokens_hash').on(t.tokenHash),
    index('idx_refresh_tokens_user').on(t.userId),
    index('idx_refresh_tokens_device').on(t.userId, t.deviceId),
  ],
);

/* ------------------------------------------------------------------ */
/* 会话                                                                 */
/* ------------------------------------------------------------------ */

export const conversations = mysqlTable(
  'conversations',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    /** direct | group */
    type: varchar('type', { length: 8 }).notNull(),
    /** 群名；私聊为 null（由客户端展示对方昵称） */
    title: varchar('title', { length: 64 }),
    avatarUrl: varchar('avatar_url', { length: 512 }),
    ownerId: varchar('owner_id', { length: 26 }),
    /**
     * 私聊去重键：两个 userId 排序后拼接。
     * 唯一索引保证同一对用户只会存在一个私聊会话。
     */
    directKey: varchar('direct_key', { length: 64 }),
    /** 会话内消息序号水位，发消息时原子递增 */
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    lastMessageAt: bigint('last_message_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    /**
     * 最后变更时间（建会话 / 改群资料 / 成员变动 / 新消息）
     * 增量同步的核心：客户端只拉 updatedAt > since 的会话，
     * 避免每次全量扫全部会话。
     */
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    uniqueIndex('uk_conversations_direct').on(t.directKey),
    index('idx_conversations_last_message').on(t.lastMessageAt),
    /** 增量同步扫描用：按用户 + 更新时间定位变化会话 */
    index('idx_conversations_updated').on(t.updatedAt),
  ],
);

export const conversationMembers = mysqlTable(
  'conversation_members',
  {
    conversationId: varchar('conversation_id', { length: 26 }).notNull(),
    userId: varchar('user_id', { length: 26 }).notNull(),
    /** owner | admin | member */
    role: varchar('role', { length: 8 }).notNull().default('member'),
    /** 已读水位：该用户已读到会话内第几条 */
    lastReadSeq: bigint('last_read_seq', { mode: 'number' }).notNull().default(0),
    pinned: boolean('pinned').notNull().default(false),
    muted: boolean('muted').notNull().default(false),
    joinedAt: bigint('joined_at', { mode: 'number' }).notNull(),
    /** 退群时间；null 表示仍在群内（软删除保留历史） */
    leftAt: bigint('left_at', { mode: 'number' }),
    /**
     * 成员级别的最后变更时间（已读水位推进、置顶、静音、角色变化）。
     * 增量同步靠它发现「我的会话列表有变化」，
     * 而不必去看 conversations 表。
     */
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    index('idx_members_user').on(t.userId),
    index('idx_members_active').on(t.userId, t.leftAt),
    /** 增量同步：按用户 + 变更时间扫 */
    index('idx_members_updated').on(t.userId, t.updatedAt),
  ],
);

/* ------------------------------------------------------------------ */
/* 消息                                                                 */
/* ------------------------------------------------------------------ */

export const messages = mysqlTable(
  'messages',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    conversationId: varchar('conversation_id', { length: 26 }).notNull(),
    /** 会话内单调递增序号 */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    senderId: varchar('sender_id', { length: 26 }).notNull(),
    /** 客户端生成的幂等 id，用于网络重试去重 */
    clientId: varchar('client_id', { length: 40 }),
    /** text | image | video | audio | file | system | call */
    type: varchar('type', { length: 8 }).notNull(),
    text: text('text'),
    replyToId: varchar('reply_to_id', { length: 26 }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    editedAt: bigint('edited_at', { mode: 'number' }),
    /** 软删除：保留序号连续性，客户端显示「已撤回」 */
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('uk_messages_seq').on(t.conversationId, t.seq),
    uniqueIndex('uk_messages_client').on(t.conversationId, t.senderId, t.clientId),
    index('idx_messages_conversation').on(t.conversationId, t.seq),
    index('idx_messages_sender').on(t.senderId),
    /**
     * 全文索引（MySQL FULLTEXT + ngram 分词）
     *
     * 为什么用 ngram 而不是默认分词：
     * MySQL 内置分词器按空格切词，中文整句会被当成一个词，搜不到。
     * ngram 按 2 字滑窗切分（ngram_token_size=2），中文检索准确率较高。
     *
     * 为什么用 FULLTEXT 而不是 LIKE '%kw%'：
     * LIKE 前导通配符无法走索引，10 万条消息会全表扫描，
     * 在 2 核机器上能直接卡死服务；FULLTEXT 走倒排索引，毫秒级返回。
     *
     * 注意：需要在迁移 SQL 里手动改成 WITH PARSER ngram，
     * drizzle-kit 生成的普通 FULLTEXT 对中文无效（见 0002 迁移）。
     */
    index('ft_messages_text').on(t.text),
  ],
);

/* ------------------------------------------------------------------ */
/* 附件                                                                 */
/* ------------------------------------------------------------------ */

export const attachments = mysqlTable(
  'attachments',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    uploaderId: varchar('uploader_id', { length: 26 }).notNull(),
    /** image | video | audio | file */
    kind: varchar('kind', { length: 8 }).notNull(),
    filename: varchar('filename', { length: 255 }).notNull(),
    mime: varchar('mime', { length: 128 }).notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    /** 内容哈希：相同文件秒传，且可用于完整性校验 */
    sha256: varchar('sha256', { length: 64 }).notNull(),
    /** 相对 uploads 目录的路径 */
    storagePath: varchar('storage_path', { length: 512 }).notNull(),
    /** 缩略图/视频封面路径 */
    thumbPath: varchar('thumb_path', { length: 512 }),
    width: int('width'),
    height: int('height'),
    durationMs: int('duration_ms'),
    /** 语音波形（0-100），客户端绘制气泡用 */
    waveform: json('waveform').$type<number[]>(),
    /** 绑定的消息 id；null 表示尚未发送（可能是上传后放弃） */
    messageId: varchar('message_id', { length: 26 }),
    /** 同一条消息内多个附件的排序 */
    sortOrder: int('sort_order').notNull().default(0),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    /**
     * 文件在服务器上的过期时间（毫秒时间戳）。
     * 默认 createdAt + ATTACHMENT_TTL_MS（30 天）。
     */
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull().default(0),
    /**
     * 实际删除文件的时间；null 表示文件仍在服务器上。
     * 只删文件、不删本条记录，这样消息与附件元数据完整保留，
     * 客户端可以显示「文件已过期」而不是让聊天记录出现空洞。
     */
    expiredAt: bigint('expired_at', { mode: 'number' }),
  },
  (t) => [
    index('idx_attachments_sha').on(t.sha256),
    index('idx_attachments_message').on(t.messageId),
    index('idx_attachments_uploader').on(t.uploaderId),
    /** 定时清理扫描用：只扫未过期记录的 expires_at */
    index('idx_attachments_expires').on(t.expiredAt, t.expiresAt),
  ],
);

/* ------------------------------------------------------------------ */
/* 通话                                                                 */
/* ------------------------------------------------------------------ */

export const callSessions = mysqlTable(
  'call_sessions',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    conversationId: varchar('conversation_id', { length: 26 }).notNull(),
    /** audio | video */
    mode: varchar('mode', { length: 8 }).notNull(),
    /** ringing | active | ended | missed | rejected */
    status: varchar('status', { length: 12 }).notNull(),
    initiatorId: varchar('initiator_id', { length: 26 }).notNull(),
    /** mediasoup Router id，通话结束后即可销毁 */
    routerId: varchar('router_id', { length: 64 }),
    startedAt: bigint('started_at', { mode: 'number' }).notNull(),
    answeredAt: bigint('answered_at', { mode: 'number' }),
    endedAt: bigint('ended_at', { mode: 'number' }),
    /** hangup | reject | timeout | busy | error */
    endReason: varchar('end_reason', { length: 16 }),
  },
  (t) => [
    index('idx_calls_conversation').on(t.conversationId, t.startedAt),
    index('idx_calls_status').on(t.status),
  ],
);

export const callParticipants = mysqlTable(
  'call_participants',
  {
    callId: varchar('call_id', { length: 26 }).notNull(),
    userId: varchar('user_id', { length: 26 }).notNull(),
    /** invited | joined | left | rejected | missed */
    state: varchar('state', { length: 12 }).notNull(),
    joinedAt: bigint('joined_at', { mode: 'number' }),
    leftAt: bigint('left_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.callId, t.userId] }),
    index('idx_call_participants_user').on(t.userId),
  ],
);

/* ------------------------------------------------------------------ */
/* 推送令牌                                                             */
/* ------------------------------------------------------------------ */

export const pushTokens = mysqlTable(
  'push_tokens',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    userId: varchar('user_id', { length: 26 }).notNull(),
    platform: varchar('platform', { length: 16 }).notNull(),
    /** hms | xiaomi | oppo | vivo | apns | harmony */
    provider: varchar('provider', { length: 16 }).notNull(),
    deviceId: varchar('device_id', { length: 128 }).notNull(),
    token: varchar('token', { length: 512 }).notNull(),
    appVersion: varchar('app_version', { length: 32 }),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('uk_push_provider_token').on(t.provider, t.token),
    index('idx_push_user').on(t.userId),
  ],
);

/* ------------------------------------------------------------------ */
/* 关系定义（仅供 drizzle 查询辅助，不强制使用）                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 好友关系                                                             */
/* ------------------------------------------------------------------ */

/**
 * 好友关系
 * ============================================================
 * 【为什么双向存两条记录】
 * 单条记录（A,B 有序对）查「我的好友」需要 WHERE a=me OR b=me，
 * 无法有效利用索引；双向存两条后只需 WHERE user_id=me，
 * 配合 idx_friendships_user 直接命中。
 * 另外单向拉黑（我拉黑他、他没拉黑我）也只有双向模型能表达。
 *
 * status 语义：
 *   pending  —— 请求中（requesterId 是发起方）
 *   accepted —— 已成为好友
 *   blocked  —— userId 拉黑了 friendId（单向，不影响对方那条记录）
 * ============================================================
 */
export const friendships = mysqlTable(
  'friendships',
  {
    /** 关系拥有者（"我的好友列表里有哪些人" 就是查这个字段） */
    userId: varchar('user_id', { length: 26 }).notNull(),
    /** 对方 */
    friendId: varchar('friend_id', { length: 26 }).notNull(),
    /** pending | accepted | blocked */
    status: varchar('status', { length: 10 }).notNull(),
    /** 请求发起方，用于区分「我发出的」与「我收到的」 */
    requesterId: varchar('requester_id', { length: 26 }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    acceptedAt: bigint('accepted_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.friendId] }),
    index('idx_friendships_user').on(t.userId, t.status),
    index('idx_friendships_friend').on(t.friendId, t.status),
  ],
);

/**
 * 联系人备注名
 * ============================================================
 * 独立于好友关系存在，原因：
 * 1. 删除好友后重新添加，备注名仍然保留（符合用户直觉）；
 * 2. 未来可扩展群昵称（加 scope 字段区分 friend / group）。
 * ============================================================
 */
export const contactRemarks = mysqlTable(
  'contact_remarks',
  {
    /** 备注的拥有者 */
    ownerId: varchar('owner_id', { length: 26 }).notNull(),
    /** 被备注的人 */
    targetId: varchar('target_id', { length: 26 }).notNull(),
    /** 自定义显示名；空串等价于清除 */
    remark: varchar('remark', { length: 32 }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.targetId] }),
  ],
);

/* ------------------------------------------------------------------ */
/* 消息表情回应                                                         */
/* ------------------------------------------------------------------ */

/**
 * 消息表情回应
 * 同一个人对同一条消息的同一个表情只能有一条（联合主键保证幂等）。
 */
export const messageReactions = mysqlTable(
  'message_reactions',
  {
    messageId: varchar('message_id', { length: 26 }).notNull(),
    userId: varchar('user_id', { length: 26 }).notNull(),
    /** 单个 emoji 字符，最长 8 字节足够容纳多码位表情 */
    emoji: varchar('emoji', { length: 8 }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId, t.emoji] }),
    index('idx_reactions_message').on(t.messageId),
  ],
);

/**
 * 消息「仅删除自己可见」记录
 * ============================================================
 * 与 messages.deleted_at 的区别（两者语义完全不同）：
 *
 *   deleted_at   撤回：整条消息对所有成员失效，
 *                客户端显示「xxx 撤回了一条消息」，序号仍然占位
 *                （否则 seq 断号，增量同步游标会错乱）。
 *
 *   本表          删除：只对操作者自己隐藏，其他成员照常看到。
 *                这是 Telegram / 微信「删除」的语义，
 *                服务端必须留痕，否则重新拉取历史时消息又会出现。
 *
 * 为什么需要这张表而不是在 messages 上加个数组字段：
 *   群聊里每个人都可能删同一条消息，数组字段无法索引，
 *   且并发写入会互相覆盖。分成关联表既能索引（按 userId 过滤），
 *   也天然支持多端一致（换设备重新拉取时依然被过滤）。
 * ============================================================
 */
export const messageHides = mysqlTable(
  'message_hides',
  {
    messageId: varchar('message_id', { length: 26 }).notNull(),
    userId: varchar('user_id', { length: 26 }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    // 同一用户对同一条消息只留一条记录，重复删除幂等
    primaryKey({ columns: [t.messageId, t.userId] }),
    // 按用户查「我隐藏了哪些消息」，列表查询会走这个索引
    index('idx_hides_user').on(t.userId),
  ],
);

/* ------------------------------------------------------------------ */
/* 关系定义与类型导出                                                   */
/* ------------------------------------------------------------------ */

export const usersRelations = relations(users, ({ many }) => ({
  messages: many(messages),
  memberships: many(conversationMembers),
}));

export const conversationsRelations = relations(conversations, ({ many }) => ({
  members: many(conversationMembers),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  attachments: many(attachments),
  reactions: many(messageReactions),
}));

export const messageReactionsRelations = relations(messageReactions, ({ one }) => ({
  message: one(messages, {
    fields: [messageReactions.messageId],
    references: [messages.id],
  }),
}));

/** 表类型导出：仓储层直接用 */
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type EmailCodeRow = typeof emailCodes.$inferSelect;
export type InviteCodeRow = typeof inviteCodes.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationMemberRow = typeof conversationMembers.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type CallSessionRow = typeof callSessions.$inferSelect;
export type CallParticipantRow = typeof callParticipants.$inferSelect;
export type PushTokenRow = typeof pushTokens.$inferSelect;
export type FriendshipRow = typeof friendships.$inferSelect;
export type ContactRemarkRow = typeof contactRemarks.$inferSelect;
export type MessageReactionRow = typeof messageReactions.$inferSelect;
