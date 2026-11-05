/// ============================================================
/// 数据模型（与后端 DTO 一一对应）
/// ------------------------------------------------------------
/// 约定：
/// 1. 字段名与 packages/shared/src/types.ts 保持一致，
///    后端改字段时只需同步改这里；
/// 2. 所有 fromJson 都做防御式取值，缺字段不至于崩；
/// 3. 只读模型用 final 字段，消息额外带本地发送状态（乐观更新用）。
/// ============================================================
library;

Map<String, dynamic> _map(dynamic v) =>
    v is Map<String, dynamic> ? v : <String, dynamic>{};

List<dynamic> _list(dynamic v) => v is List ? v : const [];

int _int(dynamic v, [int fallback = 0]) {
  if (v is int) return v;
  if (v is num) return v.toInt();
  if (v is String) return int.tryParse(v) ?? fallback;
  return fallback;
}

int? _intOrNull(dynamic v) {
  if (v == null) return null;
  if (v is int) return v;
  if (v is num) return v.toInt();
  if (v is String) return int.tryParse(v);
  return null;
}

String _str(dynamic v, [String fallback = '']) {
  if (v is String) return v;
  if (v == null) return fallback;
  return v.toString();
}

String? _strOrNull(dynamic v) {
  if (v == null) return null;
  if (v is String) return v.isEmpty ? null : v;
  return v.toString();
}

/* ------------------------------------------------------------------ */
/* 用户与认证                                                           */
/* ------------------------------------------------------------------ */

class UserProfile {
  const UserProfile({
    required this.id,
    required this.email,
    required this.nickname,
    this.avatarUrl,
    this.bio,
    this.lastSeenAt,
    this.createdAt = 0,
  });

  final String id;
  final String email;
  final String nickname;
  final String? avatarUrl;
  final String? bio;
  final int? lastSeenAt;
  final int createdAt;

  factory UserProfile.fromJson(Map<String, dynamic> j) => UserProfile(
        id: _str(j['id']),
        email: _str(j['email']),
        nickname: _str(j['nickname'], '用户'),
        avatarUrl: _strOrNull(j['avatarUrl']),
        bio: _strOrNull(j['bio']),
        lastSeenAt: _intOrNull(j['lastSeenAt']),
        createdAt: _int(j['createdAt']),
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'email': email,
        'nickname': nickname,
        'avatarUrl': avatarUrl,
        'bio': bio,
        'lastSeenAt': lastSeenAt,
        'createdAt': createdAt,
      };
}

class AuthUser extends UserProfile {
  const AuthUser({
    required super.id,
    required super.email,
    required super.nickname,
    super.avatarUrl,
    super.bio,
    super.lastSeenAt,
    super.createdAt,
    required this.emailFull,
    required this.inviteQuota,
    required this.emailVerified,
  });

  /// 本人可见完整邮箱
  final String emailFull;
  final int inviteQuota;
  final bool emailVerified;

  factory AuthUser.fromJson(Map<String, dynamic> j) => AuthUser(
        id: _str(j['id']),
        email: _str(j['email']),
        nickname: _str(j['nickname'], '用户'),
        avatarUrl: _strOrNull(j['avatarUrl']),
        bio: _strOrNull(j['bio']),
        lastSeenAt: _intOrNull(j['lastSeenAt']),
        createdAt: _int(j['createdAt']),
        emailFull: _str(j['emailFull'], _str(j['email'])),
        inviteQuota: _int(j['inviteQuota']),
        emailVerified: j['emailVerified'] == true,
      );

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'emailFull': emailFull,
        'inviteQuota': inviteQuota,
        'emailVerified': emailVerified,
      };
}

class AuthResult {
  const AuthResult({
    required this.accessToken,
    required this.refreshToken,
    required this.accessTokenExpiresAt,
    required this.user,
  });

  final String accessToken;
  final String refreshToken;
  final int accessTokenExpiresAt;
  final AuthUser user;

  factory AuthResult.fromJson(Map<String, dynamic> j) => AuthResult(
        accessToken: _str(j['accessToken']),
        refreshToken: _str(j['refreshToken']),
        accessTokenExpiresAt: _int(j['accessTokenExpiresAt']),
        user: AuthUser.fromJson(_map(j['user'])),
      );
}

/* ------------------------------------------------------------------ */
/* 会话                                                                 */
/* ------------------------------------------------------------------ */

class ConversationMember {
  const ConversationMember({
    required this.userId,
    required this.nickname,
    this.avatarUrl,
    this.role = 'member',
    this.lastReadSeq = 0,
  });

  final String userId;
  final String nickname;
  final String? avatarUrl;
  final String role;
  final int lastReadSeq;

  factory ConversationMember.fromJson(Map<String, dynamic> j) => ConversationMember(
        userId: _str(j['userId']),
        nickname: _str(j['nickname'], '用户'),
        avatarUrl: _strOrNull(j['avatarUrl']),
        role: _str(j['role'], 'member'),
        lastReadSeq: _int(j['lastReadSeq']),
      );
}

class MessagePreview {
  const MessagePreview({
    required this.id,
    required this.type,
    required this.senderId,
    required this.senderName,
    required this.summary,
    required this.createdAt,
  });

  final String id;
  final String type;
  final String senderId;
  final String senderName;
  final String summary;
  final int createdAt;

  factory MessagePreview.fromJson(Map<String, dynamic> j) => MessagePreview(
        id: _str(j['id']),
        type: _str(j['type'], 'text'),
        senderId: _str(j['senderId']),
        senderName: _str(j['senderName']),
        summary: _str(j['summary']),
        createdAt: _int(j['createdAt']),
      );
}

class ConversationSummary {
  const ConversationSummary({
    required this.id,
    required this.type,
    required this.title,
    this.avatarUrl,
    this.peerId,
    this.memberCount = 0,
    this.lastMessage,
    this.lastMessageAt,
    this.unreadCount = 0,
    this.pinned = false,
    this.muted = false,
    this.createdAt = 0,
  });

  final String id;
  final String type;
  final String title;
  final String? avatarUrl;
  final String? peerId;
  final int memberCount;
  final MessagePreview? lastMessage;
  final int? lastMessageAt;
  final int unreadCount;
  final bool pinned;
  final bool muted;
  final int createdAt;

  bool get isGroup => type == 'group';

  ConversationSummary copyWith({int? unreadCount, MessagePreview? lastMessage, int? lastMessageAt}) =>
      ConversationSummary(
        id: id,
        type: type,
        title: title,
        avatarUrl: avatarUrl,
        peerId: peerId,
        memberCount: memberCount,
        lastMessage: lastMessage ?? this.lastMessage,
        lastMessageAt: lastMessageAt ?? this.lastMessageAt,
        unreadCount: unreadCount ?? this.unreadCount,
        pinned: pinned,
        muted: muted,
        createdAt: createdAt,
      );

  factory ConversationSummary.fromJson(Map<String, dynamic> j) => ConversationSummary(
        id: _str(j['id']),
        type: _str(j['type'], 'direct'),
        title: _str(j['title'], '会话'),
        avatarUrl: _strOrNull(j['avatarUrl']),
        peerId: _strOrNull(j['peerId']),
        memberCount: _int(j['memberCount']),
        lastMessage: j['lastMessage'] == null ? null : MessagePreview.fromJson(_map(j['lastMessage'])),
        lastMessageAt: _intOrNull(j['lastMessageAt']),
        unreadCount: _int(j['unreadCount']),
        pinned: j['pinned'] == true,
        muted: j['muted'] == true,
        createdAt: _int(j['createdAt']),
      );
}

class ConversationDetail {
  const ConversationDetail({
    required this.id,
    required this.type,
    required this.title,
    this.avatarUrl,
    this.ownerId,
    required this.members,
    this.myRole = 'member',
    this.pinned = false,
    this.muted = false,
  });

  final String id;
  final String type;
  final String title;
  final String? avatarUrl;
  final String? ownerId;
  final List<ConversationMember> members;
  final String myRole;
  final bool pinned;
  final bool muted;

  factory ConversationDetail.fromJson(Map<String, dynamic> j) => ConversationDetail(
        id: _str(j['id']),
        type: _str(j['type'], 'direct'),
        title: _str(j['title'], '会话'),
        avatarUrl: _strOrNull(j['avatarUrl']),
        ownerId: _strOrNull(j['ownerId']),
        members: _list(j['members'])
            .map((e) => ConversationMember.fromJson(_map(e)))
            .toList(growable: false),
        myRole: _str(j['myRole'], 'member'),
        pinned: j['pinned'] == true,
        muted: j['muted'] == true,
      );
}

/* ------------------------------------------------------------------ */
/* 附件与消息                                                           */
/* ------------------------------------------------------------------ */

class Attachment {
  const Attachment({
    required this.id,
    required this.kind,
    required this.filename,
    required this.mime,
    required this.size,
    required this.url,
    this.thumbUrl,
    this.width,
    this.height,
    this.durationMs,
    this.waveform,
    this.expiresAt,
    this.expired = false,
    this.expiringSoon = false,
  });

  final String id;
  final String kind;
  final String filename;
  final String mime;
  final int size;
  final String url;
  final String? thumbUrl;
  final int? width;
  final int? height;
  final int? durationMs;
  final List<int>? waveform;
  final int? expiresAt;
  final bool expired;
  final bool expiringSoon;

  factory Attachment.fromJson(Map<String, dynamic> j) => Attachment(
        id: _str(j['id']),
        kind: _str(j['kind'], 'file'),
        filename: _str(j['filename'], '文件'),
        mime: _str(j['mime'], 'application/octet-stream'),
        size: _int(j['size']),
        url: _str(j['url']),
        thumbUrl: _strOrNull(j['thumbUrl']),
        width: _intOrNull(j['width']),
        height: _intOrNull(j['height']),
        durationMs: _intOrNull(j['durationMs']),
        waveform: j['waveform'] == null
            ? null
            : _list(j['waveform']).map((e) => _int(e)).toList(growable: false),
        expiresAt: _intOrNull(j['expiresAt']),
        expired: j['expired'] == true,
        expiringSoon: j['expiringSoon'] == true,
      );
}

/// 本地发送状态（仅客户端使用）
enum LocalStatus { none, sending, sent, failed }

class Message {
  Message({
    required this.id,
    required this.conversationId,
    required this.seq,
    required this.senderId,
    required this.senderName,
    this.senderAvatarUrl,
    required this.type,
    this.text,
    this.attachments = const [],
    this.replyToId,
    this.replyToPreview,
    required this.createdAt,
    this.editedAt,
    this.deletedAt,
    this.localStatus = LocalStatus.none,
    this.localProgress,
    this.clientId,
    this.deleted = false,
    this.localFilePath,
  });

  final String id;
  final String conversationId;
  final int seq;
  final String senderId;
  final String senderName;
  final String? senderAvatarUrl;
  final String type;
  final String? text;
  final List<Attachment> attachments;
  final String? replyToId;
  final MessagePreview? replyToPreview;
  final int createdAt;
  final int? editedAt;
  final int? deletedAt;

  /// 服务端标记已撤回（内容已清空，只保留占位）
  final bool deleted;

  // ------------- 本地状态（不来自服务端） -------------
  LocalStatus localStatus;
  double? localProgress;
  final String? clientId;

  /// 本地文件路径：上传完成前用于即时预览（图片/视频气泡不空着）
  final String? localFilePath;

  bool get isMedia => type != 'text' && type != 'system' && type != 'call';

  Attachment? get firstAttachment => attachments.isEmpty ? null : attachments.first;

  Message copyWith({
    String? id,
    int? seq,
    LocalStatus? localStatus,
    double? localProgress,
    bool clearProgress = false,
  }) =>
      Message(
        id: id ?? this.id,
        conversationId: conversationId,
        seq: seq ?? this.seq,
        senderId: senderId,
        senderName: senderName,
        senderAvatarUrl: senderAvatarUrl,
        type: type,
        text: text,
        attachments: attachments,
        replyToId: replyToId,
        replyToPreview: replyToPreview,
        createdAt: createdAt,
        editedAt: editedAt,
        deletedAt: deletedAt,
        localStatus: localStatus ?? this.localStatus,
        localProgress: clearProgress ? null : (localProgress ?? this.localProgress),
        clientId: clientId,
        deleted: deleted,
        localFilePath: localFilePath,
      );

  factory Message.fromJson(Map<String, dynamic> j) => Message(
        id: _str(j['id']),
        conversationId: _str(j['conversationId']),
        seq: _int(j['seq']),
        senderId: _str(j['senderId']),
        senderName: _str(j['senderName'], '用户'),
        senderAvatarUrl: _strOrNull(j['senderAvatarUrl']),
        type: _str(j['type'], 'text'),
        text: _strOrNull(j['text']),
        attachments: _list(j['attachments'])
            .map((e) => Attachment.fromJson(_map(e)))
            .toList(growable: false),
        replyToId: _strOrNull(j['replyToId']),
        replyToPreview:
            j['replyToPreview'] == null ? null : MessagePreview.fromJson(_map(j['replyToPreview'])),
        createdAt: _int(j['createdAt']),
        editedAt: _intOrNull(j['editedAt']),
        deletedAt: _intOrNull(j['deletedAt']),
        clientId: _strOrNull(j['clientId']),
        deleted: j['deletedAt'] != null || j['deleted'] == true,
      );
}

class MessagePage {
  const MessagePage({required this.items, required this.hasMore, this.nextCursor});

  final List<Message> items;
  final bool hasMore;
  final String? nextCursor;

  factory MessagePage.fromJson(Map<String, dynamic> j) => MessagePage(
        items: _list(j['items']).map((e) => Message.fromJson(_map(e))).toList(growable: false),
        hasMore: j['hasMore'] == true,
        nextCursor: _strOrNull(j['nextCursor']),
      );
}

/* ------------------------------------------------------------------ */
/* 联系人                                                               */
/* ------------------------------------------------------------------ */

class FriendItem {
  const FriendItem({
    required this.userId,
    required this.nickname,
    this.avatarUrl,
    this.remark,
    this.conversationId,
    this.lastSeenAt,
  });

  final String userId;
  final String nickname;
  final String? avatarUrl;
  final String? remark;
  final String? conversationId;
  final int? lastSeenAt;

  String get displayName => (remark != null && remark!.isNotEmpty) ? remark! : nickname;

  factory FriendItem.fromJson(Map<String, dynamic> j) => FriendItem(
        userId: _str(j['userId']),
        nickname: _str(j['nickname'], '用户'),
        avatarUrl: _strOrNull(j['avatarUrl']),
        remark: _strOrNull(j['remark']),
        conversationId: _strOrNull(j['conversationId']),
        lastSeenAt: _intOrNull(j['lastSeenAt']),
      );
}

/* ------------------------------------------------------------------ */
/* 上传与通话                                                           */
/* ------------------------------------------------------------------ */

class UploadResult {
  const UploadResult({required this.attachment, this.deduplicated = false});

  final Attachment attachment;
  final bool deduplicated;

  factory UploadResult.fromJson(Map<String, dynamic> j) => UploadResult(
        attachment: Attachment.fromJson(_map(j['attachment'])),
        deduplicated: j['deduplicated'] == true,
      );
}

class IceConfig {
  const IceConfig({required this.iceServers, this.maxParticipants = 8});

  final List<Map<String, dynamic>> iceServers;
  final int maxParticipants;

  factory IceConfig.fromJson(Map<String, dynamic> j) => IceConfig(
        iceServers: _list(j['iceServers'])
            .map((e) => _map(e))
            .toList(growable: false),
        maxParticipants: _int(j['maxParticipants'], 8),
      );
}
