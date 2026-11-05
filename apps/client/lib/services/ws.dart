import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../core/config.dart';
import '../core/storage.dart';

enum WsStatus { disconnected, connecting, connected }

/// ============================================================
/// WebSocket 服务
/// ------------------------------------------------------------
/// 这是整个实时能力的命脉：新消息、已读、输入中、来电信令全靠它。
///
/// 三条铁律（都是踩过坑总结的）：
/// 1. **任何断开都必须重连**：包括 onError / onDone / 心跳超时。
///    只处理 onDone 会出现「UI 以为在线，其实帧全丢了」。
/// 2. **重连前先刷新令牌**：令牌过期时握手会被服务端关闭，
///    不刷新就会无限重连失败。
/// 3. **重连后要重新订阅会话 + 重新拉一次增量**：
///    断线期间的消息服务端不会补推。
/// ============================================================
class WsService {
  WsService._();

  static final WsService instance = WsService._();

  final StreamController<Map<String, dynamic>> _events =
      StreamController<Map<String, dynamic>>.broadcast();

  /// 业务事件流（已过滤 auth 握手与心跳）
  Stream<Map<String, dynamic>> get events => _events.stream;

  /// 连接状态（UI 可监听显示「连接中」）
  final ValueNotifier<WsStatus> status = ValueNotifier<WsStatus>(WsStatus.disconnected);

  /// 连接成功（含重连成功）时触发：调用方据此重新拉增量数据
  final StreamController<void> _reconnected = StreamController<void>.broadcast();
  Stream<void> get onReconnected => _reconnected.stream;

  /// 令牌提供者（由 Session 注入，内部会自行刷新过期令牌）
  Future<String?> Function()? tokenProvider;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  Timer? _pingTimer;
  Timer? _reconnectTimer;

  int _attempt = 0;
  bool _manualClose = false;
  bool _everConnected = false;
  int _pingSeq = 0;

  bool get isConnected => status.value == WsStatus.connected;

  /* ------------------------------------------------------------------ */
  /* 连接管理                                                            */
  /* ------------------------------------------------------------------ */

  Future<void> connect() async {
    _manualClose = false;
    if (status.value == WsStatus.connecting) return;
    if (isConnected) return;
    await _open();
  }

  Future<void> _open() async {
    _cancelTimers();
    await _subscription?.cancel();
    _subscription = null;
    await _channel?.sink.close();
    _channel = null;

    status.value = WsStatus.connecting;

    final token = await tokenProvider?.call() ?? AppStorage.instance.accessToken;
    if (token == null || token.isEmpty) {
      status.value = WsStatus.disconnected;
      return;
    }

    try {
      final channel = IOWebSocketChannel.connect(
        Uri.parse(AppConfig.wsUrl),
        connectTimeout: const Duration(seconds: 15),
      );
      _channel = channel;

      _subscription = channel.stream.listen(
        _onData,
        onError: (Object error) => _handleDisconnect('连接异常'),
        onDone: () => _handleDisconnect('连接已关闭'),
        cancelOnError: false,
      );

      // 握手：auth 必须是第一条消息
      _sendRaw({
        'type': 'auth',
        'token': token,
        'platform': AppConfig.platform,
        'deviceId': AppStorage.instance.deviceId,
      });
    } catch (_) {
      _handleDisconnect('连接失败');
    }
  }

  void _onData(dynamic raw) {
    if (raw is! String) return;
    Map<String, dynamic> msg;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return;
      msg = decoded;
    } catch (_) {
      return;
    }

    final type = msg['type'];

    if (type == 'ready') {
      _attempt = 0;
      status.value = WsStatus.connected;
      _startPing();
      // 首次连接不触发「重连」回调，避免启动时重复拉数据
      if (_everConnected) _reconnected.add(null);
      _everConnected = true;
      return;
    }

    if (type == 'pong') return;

    if (type == 'error') {
      // 鉴权失败：换令牌后重连
      final code = msg['code'];
      if (code == 11011 || code == 11012) {
        _handleDisconnect('令牌过期');
        return;
      }
    }

    _events.add(msg);
  }

  void _handleDisconnect(String reason) {
    if (_manualClose) return;
    status.value = WsStatus.disconnected;
    _cancelTimers();
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_manualClose) return;
    _reconnectTimer?.cancel();

    // 指数退避 + 抖动：1s → 2s → 4s → 8s → 最多 15s
    final base = min(15, pow(2, min(_attempt, 4)).toInt());
    final jitter = Random().nextInt(500);
    _attempt++;

    _reconnectTimer = Timer(Duration(milliseconds: base * 1000 + jitter), () async {
      if (_manualClose) return;
      await _open();
    });
  }

  void _startPing() {
    _pingTimer?.cancel();
    // 服务端 60s 收不到消息即判定掉线，25s 一次留足余量
    _pingTimer = Timer.periodic(const Duration(seconds: 25), (_) {
      _sendRaw({'type': 'ping', 'ts': DateTime.now().millisecondsSinceEpoch, 'seq': _pingSeq++});
    });
  }

  void _cancelTimers() {
    _pingTimer?.cancel();
    _pingTimer = null;
  }

  Future<void> disconnect() async {
    _manualClose = true;
    _cancelTimers();
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    await _subscription?.cancel();
    _subscription = null;
    await _channel?.sink.close();
    _channel = null;
    status.value = WsStatus.disconnected;
  }

  /* ------------------------------------------------------------------ */
  /* 发送                                                                */
  /* ------------------------------------------------------------------ */

  bool _sendRaw(Map<String, dynamic> payload) {
    final channel = _channel;
    if (channel == null) return false;
    try {
      channel.sink.add(jsonEncode(payload));
      return true;
    } catch (_) {
      _handleDisconnect('发送失败');
      return false;
    }
  }

  /// 发送业务消息；未连接时返回 false，调用方应提示用户
  bool send(Map<String, dynamic> payload) {
    if (!isConnected) return false;
    return _sendRaw(payload);
  }

  /// 进入聊天页：只订阅本会话，减少无关推送
  void subscribe(List<String> conversationIds) {
    if (conversationIds.isEmpty) return;
    send({'type': 'subscribe', 'conversationIds': conversationIds});
  }

  void unsubscribe(List<String> conversationIds) {
    if (conversationIds.isEmpty) return;
    send({'type': 'unsubscribe', 'conversationIds': conversationIds});
  }

  void sendRead(String conversationId, int seq) {
    send({'type': 'read', 'conversationId': conversationId, 'seq': seq});
  }

  void sendTyping(String conversationId) {
    send({'type': 'typing', 'conversationId': conversationId});
  }

  /* ---------------- 通话信令 ---------------- */

  void inviteCall(String conversationId, {String mode = 'audio', List<String>? inviteeIds}) {
    send({
      'type': 'call.invite',
      'conversationId': conversationId,
      'mode': mode,
      if (inviteeIds != null && inviteeIds.isNotEmpty) 'inviteeIds': inviteeIds,
    });
  }

  void acceptCall(String callId) => send({'type': 'call.accept', 'callId': callId});

  void rejectCall(String callId) => send({'type': 'call.reject', 'callId': callId});

  void hangupCall(String callId) => send({'type': 'call.hangup', 'callId': callId});

  void sendP2p(String callId, String kind, String to, String payload) {
    send({'type': 'call.p2p', 'callId': callId, 'kind': kind, 'to': to, 'payload': payload});
  }

  void sendMediaState(String callId, {required bool muted, required bool speaking}) {
    send({'type': 'call.media-state', 'callId': callId, 'muted': muted, 'speaking': speaking});
  }
}
