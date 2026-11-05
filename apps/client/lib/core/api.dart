import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';

import 'config.dart';
import 'models.dart';
import 'storage.dart';

/// 业务异常：统一把服务端 {code,message} 与网络错误包成一种形态
class ApiException implements Exception {
  ApiException(this.message, {this.code, this.statusCode, this.fields});

  final String message;
  final int? code;
  final int? statusCode;
  final Map<String, dynamic>? fields;

  /// 登录态失效（需要重新登录）
  bool get isAuthError => code == 11011 || code == 11012 || statusCode == 401;

  @override
  String toString() => message;
}

/// ============================================================
/// REST 客户端
/// ------------------------------------------------------------
/// 设计要点：
/// 1. 统一解包 {code,data,message}，业务层只拿 data；
/// 2. 令牌过期自动刷新并重放（并发刷新只做一次）；
/// 3. 所有请求带稳定的 x-device-id：服务端把刷新令牌绑定在设备上，
///    id 变化会直接导致刷新失败、用户被踢下线；
/// 4. 网络错误重试 2 次（移动网络抖动很常见）。
/// ============================================================
class ApiClient {
  ApiClient._() {
    _dio = Dio(
      BaseOptions(
        baseUrl: AppConfig.apiBase,
        connectTimeout: AppConfig.requestTimeout,
        receiveTimeout: AppConfig.requestTimeout,
        sendTimeout: AppConfig.requestTimeout,
        headers: {'Accept': 'application/json'},
        // 服务端错误码在 body 里，不让 dio 直接抛
        validateStatus: (_) => true,
      ),
    );

    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          options.headers['x-device-id'] = AppStorage.instance.deviceId;
          final token = AppStorage.instance.accessToken;
          if (token != null && token.isNotEmpty) {
            options.headers['Authorization'] = 'Bearer $token';
          }
          handler.next(options);
        },
      ),
    );
  }

  static final ApiClient instance = ApiClient._();

  late final Dio _dio;

  /// 登录态彻底失效时的回调（由 Session 注册，用于跳登录页）
  void Function()? onAuthLost;

  Future<bool>? _refreshing;

  Dio get dio => _dio;

  /* ------------------------------------------------------------------ */
  /* 底层请求                                                            */
  /* ------------------------------------------------------------------ */

  Future<dynamic> _request(
    String method,
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    bool retryOnNetwork = true,
    int attempt = 0,
  }) async {
    try {
      final resp = await _dio.request<dynamic>(
        path,
        data: body,
        queryParameters: query,
        options: Options(method: method),
      );

      final data = resp.data;
      final map = data is Map<String, dynamic> ? data : <String, dynamic>{};
      final code = map['code'];
      final businessCode = code is int ? code : (resp.statusCode == 200 ? 0 : resp.statusCode);

      if (businessCode == 0) return map['data'];

      // 令牌过期：刷新后重放一次
      if ((businessCode == 11011 || businessCode == 11012) && attempt == 0) {
        final ok = await _refreshToken();
        if (ok) {
          return _request(method, path, body: body, query: query, attempt: 1);
        }
        onAuthLost?.call();
        throw ApiException('登录已过期，请重新登录', code: businessCode, statusCode: resp.statusCode);
      }

      throw ApiException(
        (map['message'] is String && (map['message'] as String).isNotEmpty)
            ? map['message'] as String
            : '请求失败（$businessCode）',
        code: businessCode,
        statusCode: resp.statusCode,
        fields: map['fields'] is Map ? Map<String, dynamic>.from(map['fields'] as Map) : null,
      );
    } on ApiException {
      rethrow;
    } on DioException catch (e) {
      // 网络类错误重试
      final retryable = e.type == DioExceptionType.connectionTimeout ||
          e.type == DioExceptionType.receiveTimeout ||
          e.type == DioExceptionType.sendTimeout ||
          e.type == DioExceptionType.connectionError;
      if (retryable && retryOnNetwork && attempt < 2) {
        await Future<void>.delayed(Duration(milliseconds: 400 * (attempt + 1)));
        return _request(method, path, body: body, query: query, attempt: attempt + 1);
      }
      throw ApiException(_networkMessage(e), statusCode: e.response?.statusCode);
    }
  }

  String _networkMessage(DioException e) {
    switch (e.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
        return '网络超时，请检查网络后重试';
      case DioExceptionType.connectionError:
        return '无法连接服务器，请检查网络';
      default:
        return '网络异常，请稍后重试';
    }
  }

  /// 刷新访问令牌（并发安全：同一时刻只发一次）
  Future<bool> _refreshToken() {
    return _refreshing ??= _doRefresh().whenComplete(() => _refreshing = null);
  }

  /// 确保访问令牌可用（给 WebSocket 握手、上传等非 dio 流程用）
  ///
  /// 提前 60 秒刷新，避免「刚拿到的令牌在握手途中过期」。
  Future<bool> refreshIfNeeded() async {
    final token = AppStorage.instance.accessToken;
    if (token == null || token.isEmpty) return false;
    final expiresAt = AppStorage.instance.accessExpiresAt;
    final now = DateTime.now().millisecondsSinceEpoch;
    if (expiresAt > 0 && now < expiresAt - 60000) return true;
    return _refreshToken();
  }

  Future<bool> _doRefresh() async {
    final refresh = AppStorage.instance.refreshToken;
    if (refresh == null || refresh.isEmpty) return false;
    try {
      final resp = await _dio.post<dynamic>(
        '/auth/refresh',
        data: {'refreshToken': refresh, 'platform': AppConfig.platform},
      );
      final map = resp.data is Map<String, dynamic> ? resp.data as Map<String, dynamic> : null;
      if (map == null || map['code'] != 0) return false;
      final result = AuthResult.fromJson(map['data'] is Map<String, dynamic>
          ? map['data'] as Map<String, dynamic>
          : <String, dynamic>{});
      if (result.accessToken.isEmpty) return false;
      await AppStorage.instance.saveTokens(
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.accessTokenExpiresAt,
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<dynamic> get(String path, {Map<String, dynamic>? query}) =>
      _request('GET', path, query: query);

  Future<dynamic> post(String path, [Object? body]) => _request('POST', path, body: body);

  Future<dynamic> patch(String path, [Object? body]) => _request('PATCH', path, body: body);

  Future<dynamic> put(String path, [Object? body]) => _request('PUT', path, body: body);

  Future<dynamic> delete(String path, [Object? body]) => _request('DELETE', path, body: body);

  /* ------------------------------------------------------------------ */
  /* 认证                                                                */
  /* ------------------------------------------------------------------ */

  Future<Map<String, dynamic>> sendEmailCode(String email, String purpose) async {
    final r = await post('/auth/email-code', {'email': email, 'purpose': purpose});
    return Map<String, dynamic>.from(r as Map);
  }

  Future<Map<String, dynamic>> validateInviteCode(String code) async {
    final r = await post('/invites/validate', {'code': code});
    return Map<String, dynamic>.from(r as Map);
  }

  Future<AuthResult> login({
    required String email,
    required String password,
  }) async {
    final r = await post('/auth/login', {
      'email': email,
      'password': password,
      'platform': AppConfig.platform,
      'deviceName': AppConfig.deviceName,
    });
    return AuthResult.fromJson(Map<String, dynamic>.from(r as Map));
  }

  Future<AuthResult> register({
    required String email,
    required String code,
    required String password,
    required String nickname,
    required String inviteCode,
  }) async {
    final r = await post('/auth/register', {
      'email': email,
      'code': code,
      'password': password,
      'nickname': nickname,
      'inviteCode': inviteCode,
      'platform': AppConfig.platform,
      'deviceName': AppConfig.deviceName,
    });
    return AuthResult.fromJson(Map<String, dynamic>.from(r as Map));
  }

  Future<void> logout() async {
    final refresh = AppStorage.instance.refreshToken;
    try {
      await post('/auth/logout', {'refreshToken': refresh});
    } catch (_) {
      // 服务端失败也要允许本地退出
    }
  }

  Future<void> resetPassword({
    required String email,
    required String code,
    required String newPassword,
  }) =>
      post('/auth/reset-password', {'email': email, 'code': code, 'newPassword': newPassword});

  /* ------------------------------------------------------------------ */
  /* 推送                                                                */
  /* ------------------------------------------------------------------ */

  /// 上报推送令牌（同设备重复上报会覆盖，天然幂等）
  ///
  /// provider 目前用 'mob'：MobPush 会给一个统一令牌，
  /// 由 Mob 服务端按控制台配置路由到华为/小米/OPPO/vivo 等厂商通道，
  /// 客户端不需要分别接各家 SDK。
  Future<void> registerPushToken({
    required String provider,
    required String platform,
    required String deviceId,
    required String token,
  }) =>
      post('/push/register', {
        'provider': provider,
        'platform': platform,
        'deviceId': deviceId,
        'token': token,
      });

  /// 注销本设备的推送令牌（退出登录时调用）
  Future<void> unregisterPushToken({required String deviceId}) =>
      delete('/push/register', {'deviceId': deviceId});

  /* ------------------------------------------------------------------ */
  /* 用户与联系人                                                        */
  /* ------------------------------------------------------------------ */

  Future<AuthUser> me() async {
    final r = await get('/me');
    return AuthUser.fromJson(Map<String, dynamic>.from(r as Map));
  }

  Future<List<FriendItem>> listFriends() async {
    final r = await get('/friends');
    return (r as List).map((e) => FriendItem.fromJson(Map<String, dynamic>.from(e as Map))).toList();
  }

  Future<Map<String, dynamic>> addFriendDirectly(String userId) async {
    final r = await post('/friends/add', {'userId': userId});
    return Map<String, dynamic>.from(r as Map);
  }

  Future<List<UserProfile>> searchUsers(String q) async {
    final r = await get('/users/search', query: {'q': q});
    return (r as List).map((e) => UserProfile.fromJson(Map<String, dynamic>.from(e as Map))).toList();
  }

  Future<Map<String, dynamic>> userProfile(String userId) async {
    final r = await get('/users/$userId/profile');
    return Map<String, dynamic>.from(r as Map);
  }

  /* ------------------------------------------------------------------ */
  /* 会话与消息                                                          */
  /* ------------------------------------------------------------------ */

  Future<List<ConversationSummary>> listConversations() async {
    final r = await get('/conversations');
    return (r as List)
        .map((e) => ConversationSummary.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList();
  }

  Future<ConversationDetail> conversation(String id) async {
    final r = await get('/conversations/$id');
    return ConversationDetail.fromJson(Map<String, dynamic>.from(r as Map));
  }

  Future<String> createDirect(String peerId) async {
    final r = await post('/conversations/direct', {'peerId': peerId});
    final m = Map<String, dynamic>.from(r as Map);
    return m['conversationId'] as String;
  }

  Future<MessagePage> listMessages(
    String conversationId, {
    int? before,
    int limit = 30,
  }) async {
    final page = await get(
      '/conversations/$conversationId/messages',
      query: {
        'limit': limit,
        if (before != null) 'before': before,
      },
    );
    return MessagePage.fromJson(Map<String, dynamic>.from(page as Map));
  }

  Future<Message> sendMessage(
    String conversationId, {
    required String clientId,
    required String type,
    String? text,
    List<String>? attachmentIds,
  }) async {
    final r = await post('/conversations/$conversationId/messages', {
      'clientId': clientId,
      'type': type,
      if (text != null) 'text': text,
      if (attachmentIds != null && attachmentIds.isNotEmpty) 'attachmentIds': attachmentIds,
    });
    return Message.fromJson(Map<String, dynamic>.from(r as Map));
  }

  /// 撤回（双方可见「已撤回」）
  Future<void> recallMessage(String messageId) => delete('/messages/$messageId');

  /// 删除（仅自己不可见）
  Future<void> hideMessage(String messageId) => delete('/messages/$messageId/for-me');

  /* ------------------------------------------------------------------ */
  /* 邀请                                                                */
  /* ------------------------------------------------------------------ */

  Future<Map<String, dynamic>> inviteOverview() async {
    final r = await get('/invites');
    return Map<String, dynamic>.from(r as Map);
  }

  Future<Map<String, dynamic>> createInvite({int maxUses = 1, int? expiresInDays}) async {
    final r = await post('/invites', {
      'maxUses': maxUses,
      if (expiresInDays != null) 'expiresInDays': expiresInDays,
    });
    return Map<String, dynamic>.from(r as Map);
  }

  /* ------------------------------------------------------------------ */
  /* 媒体上传                                                            */
  /* ------------------------------------------------------------------ */

  /// 上传文件并回报进度
  ///
  /// 注意字段顺序：Fastify 的 req.file() 只收集「file 之前」的表单字段。
  /// dio 的 FormData 会先写 fields 再写 files，正好符合要求。
  Future<UploadResult> uploadMedia({
    required String filePath,
    required String filename,
    String? kind,
    int? width,
    int? height,
    int? durationMs,
    List<int>? waveform,
    void Function(double progress)? onProgress,
  }) async {
    final form = FormData();
    if (kind != null) form.fields.add(MapEntry('kind', kind));
    if (width != null) form.fields.add(MapEntry('width', '$width'));
    if (height != null) form.fields.add(MapEntry('height', '$height'));
    if (durationMs != null) form.fields.add(MapEntry('durationMs', '$durationMs'));
    if (waveform != null && waveform.isNotEmpty) {
      form.fields.add(MapEntry('waveform', '[${waveform.join(',')}]'));
    }
    form.files.add(
      MapEntry('file', await MultipartFile.fromFile(filePath, filename: filename)),
    );

    final resp = await _dio.post<dynamic>(
      '/media',
      data: form,
      options: Options(
        sendTimeout: AppConfig.uploadTimeout,
        receiveTimeout: AppConfig.uploadTimeout,
      ),
      onSendProgress: (sent, total) {
        if (total > 0) onProgress?.call(sent / total);
      },
    );

    final map = resp.data is Map<String, dynamic> ? resp.data as Map<String, dynamic> : null;
    if (map == null || map['code'] != 0) {
      throw ApiException(
        (map?['message'] as String?) ?? '上传失败',
        code: map?['code'] as int?,
      );
    }
    return UploadResult.fromJson(Map<String, dynamic>.from(map['data'] as Map));
  }

  /* ------------------------------------------------------------------ */
  /* 通话                                                                */
  /* ------------------------------------------------------------------ */

  Future<IceConfig> iceConfig() async {
    final r = await get('/ice-servers');
    return IceConfig.fromJson(Map<String, dynamic>.from(r as Map));
  }

  /// 供服务端 404 判定用的健康探测（不参与业务）
  Future<bool> health() async {
    try {
      final r = await get('/health');
      return r is Map && r['ok'] == true;
    } catch (_) {
      return false;
    }
  }

  /// 本机是否连着网络（用于错误提示细化）
  static bool get hasNetworkHint => Platform.isAndroid || Platform.isIOS || Platform.isWindows || Platform.isMacOS;
}
