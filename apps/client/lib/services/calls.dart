import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' as rtc;

import '../core/api.dart';
import 'session.dart';
import 'ws.dart';

enum CallPhase { idle, outgoing, incoming, connecting, active, ended }

/// ============================================================
/// 语音通话控制器（P2P，1:1）
/// ------------------------------------------------------------
/// 服务端只转发信令，媒体直连（ICE 不通时走 TURN）。
///
/// 角色规则（避免 glare）：**已在通话中的人发 offer，新加入者只应答**。
/// 对 1:1 来说：主叫发 offer，被叫等 offer。
///
/// 状态机：
///   idle → outgoing(主叫) / incoming(被叫)
///   → connecting(已接听，正在协商)
///   → active(媒体连通)
///   → ended(任意一方挂断)
/// ============================================================
class CallController extends ChangeNotifier {
  CallController._();

  static final CallController instance = CallController._();

  CallPhase phase = CallPhase.idle;
  String? callId;
  String? conversationId;
  String? peerId;
  String peerName = '';
  bool incoming = false;
  bool muted = false;
  bool speakerOn = true;
  int elapsedSeconds = 0;
  String? error;
  String? iceState;

  rtc.RTCPeerConnection? _pc;
  rtc.MediaStream? _localStream;
  List<Map<String, dynamic>> _iceServers = const [];
  Timer? _tick;
  Timer? _timeout;
  StreamSubscription<Map<String, dynamic>>? _wsSub;
  bool _mediaStarted = false;

  /// 来电时由 UI 层挂接（用于自动弹出通话页）
  VoidCallback? onIncoming;

  bool get isBusy => phase != CallPhase.idle && phase != CallPhase.ended;

  void attach() {
    _wsSub ??= WsService.instance.events.listen(_onWsEvent);
  }

  /* ------------------------------------------------------------------ */
  /* 发起                                                               */
  /* ------------------------------------------------------------------ */

  Future<void> startOutgoing({
    required String conversationId,
    required String peerId,
    required String peerName,
  }) async {
    if (isBusy) {
      error = '当前已在通话中';
      notifyListeners();
      return;
    }

    this.conversationId = conversationId;
    this.peerId = peerId;
    this.peerName = peerName;
    callId = null;
    incoming = false;
    muted = false;
    error = null;
    iceState = null;
    elapsedSeconds = 0;
    phase = CallPhase.outgoing;
    notifyListeners();

    await _ensureIceConfig();
    if (!WsService.instance.isConnected) {
      error = '未连接到服务器，请检查网络';
      phase = CallPhase.ended;
      notifyListeners();
      return;
    }

    WsService.instance.inviteCall(conversationId, inviteeIds: [peerId]);

    // 50 秒无应答兜底：服务端 45 秒会广播 missed，但弱网可能丢帧
    _timeout?.cancel();
    _timeout = Timer(const Duration(seconds: 50), () {
      if (phase == CallPhase.outgoing) {
        error = '对方未接听';
        unawaited(_finish(sendHangup: true));
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 接听 / 拒接 / 挂断                                                  */
  /* ------------------------------------------------------------------ */

  Future<void> accept() async {
    if (phase != CallPhase.incoming) return;
    phase = CallPhase.connecting;
    notifyListeners();

    final ok = await _startMedia();
    if (!ok) {
      error = '无法启动麦克风，请检查权限';
      await _finish(sendHangup: true);
      return;
    }

    if (callId != null) WsService.instance.acceptCall(callId!);
    await _ensureIceConfig();
  }

  void reject() {
    if (callId != null) WsService.instance.rejectCall(callId!);
    unawaited(_finish(sendHangup: false));
  }

  void hangup() {
    unawaited(_finish(sendHangup: true));
  }

  void toggleMute() {
    muted = !muted;
    final stream = _localStream;
    if (stream != null) {
      for (final track in stream.getAudioTracks()) {
        track.enabled = !muted;
      }
    }
    if (callId != null) {
      WsService.instance.sendMediaState(callId!, muted: muted, speaking: false);
    }
    notifyListeners();
  }

  Future<void> toggleSpeaker() async {
    speakerOn = !speakerOn;
    try {
      await rtc.Helper.setSpeakerphoneOn(speakerOn);
    } catch (_) {
      // 桌面端无此概念
    }
    notifyListeners();
  }

  /* ------------------------------------------------------------------ */
  /* WS 事件                                                             */
  /* ------------------------------------------------------------------ */

  void _onWsEvent(Map<String, dynamic> msg) {
    final type = msg['type'];
    if (type == 'call.incoming') {
      _onIncoming(msg);
      return;
    }
    if (type == 'call.state') {
      _onCallState(msg);
      return;
    }
    if (type == 'call.p2p') {
      unawaited(_onP2p(msg));
    }
  }

  void _onIncoming(Map<String, dynamic> msg) {
    final incomingCallId = msg['callId'];
    if (incomingCallId is! String) return;

    // 已在通话中：直接拒接，避免打断当前通话
    if (isBusy && callId != incomingCallId) {
      WsService.instance.rejectCall(incomingCallId);
      return;
    }

    final caller = msg['caller'];
    final callerName = caller is Map ? (caller['nickname'] as String? ?? '来电') : '来电';

    callId = incomingCallId;
    conversationId = msg['conversationId'] as String?;
    peerName = callerName;
    peerId = caller is Map ? caller['id'] as String? : null;
    incoming = true;
    muted = false;
    error = null;
    iceState = null;
    elapsedSeconds = 0;
    phase = CallPhase.incoming;
    notifyListeners();

    onIncoming?.call();
  }

  void _onCallState(Map<String, dynamic> msg) {
    final msgCallId = msg['callId'];
    if (msgCallId is! String) return;

    // 主叫等待服务端回执：第一次 call.state(ringing) 带着真实 callId
    if (callId == null && phase == CallPhase.outgoing) {
      callId = msgCallId;
      final names = msg['participantNames'];
      if (names is Map && peerId != null) {
        final name = names[peerId];
        if (name is String && name.isNotEmpty) peerName = name;
      }
      notifyListeners();
      return;
    }

    if (msgCallId != callId) return;

    final status = msg['status'];

    if (status == 'ringing') {
      final names = msg['participantNames'];
      if (names is Map && peerId != null) {
        final name = names[peerId];
        if (name is String && name.isNotEmpty) peerName = name;
      }
      notifyListeners();
      return;
    }

    if (status == 'active') {
      unawaited(_onActive(msg));
      return;
    }

    if (status == 'ended' || status == 'rejected' || status == 'missed') {
      final reason = msg['reason'];
      if (status == 'rejected') {
        error = '对方已拒接';
      } else if (status == 'missed') {
        error = '对方未接听';
      } else if (reason == 'timeout') {
        error = '对方未接听';
      }
      unawaited(_finish(sendHangup: false));
      return;
    }
  }

  Future<void> _onActive(Map<String, dynamic> msg) async {
    // 只剩自己 → 对方已挂断（弱网下 ended 帧可能丢）
    final participants = msg['participantIds'];
    if (participants is List && participants.length <= 1) {
      error = '对方已挂断';
      await _finish(sendHangup: false);
      return;
    }

    if (phase == CallPhase.active) return;

    if (phase == CallPhase.outgoing || phase == CallPhase.connecting) {
      final ok = await _startMedia();
      if (!ok) {
        error = '无法启动麦克风';
        await _finish(sendHangup: true);
        return;
      }

      await _ensurePc();

      // 角色判定：joinedUserId 是「新加入的人」
      final joinedUserId = msg['joinedUserId'];
      final me = Session.instance.userId;
      final iAmNewJoiner = joinedUserId is String && joinedUserId == me;

      if (!iAmNewJoiner && peerId != null) {
        await _sendOffer(peerId!);
      }

      phase = CallPhase.active;
      _startTick();
      notifyListeners();
    }
  }

  /* ------------------------------------------------------------------ */
  /* WebRTC                                                             */
  /* ------------------------------------------------------------------ */

  Future<void> _ensureIceConfig() async {
    if (_iceServers.isNotEmpty) return;
    try {
      final config = await ApiClient.instance.iceConfig();
      _iceServers = config.iceServers;
    } catch (_) {
      // 拿不到就走公共 STUN，至少同局域网/直连可用
      _iceServers = [
        {'urls': 'stun:stun.l.google.com:19302'},
      ];
    }
  }

  Future<bool> _startMedia() async {
    if (_mediaStarted && _localStream != null) return true;
    try {
      final stream = await rtc.navigator.mediaDevices.getUserMedia({
        'audio': {
          'echoCancellation': true,
          'noiseSuppression': true,
          'autoGainControl': true,
        },
        'video': false,
      });
      _localStream = stream;
      _mediaStarted = true;

      // 手机端默认开扬声器，避免用户以为没声音
      if (Platform.isAndroid || Platform.isIOS) {
        try {
          await rtc.Helper.setSpeakerphoneOn(speakerOn);
        } catch (_) {
          // 忽略
        }
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> _ensurePc() async {
    if (_pc != null) return;
    await _ensureIceConfig();

    final pc = await rtc.createPeerConnection({
      'iceServers': _iceServers,
      'sdpSemantics': 'unified-plan',
      'bundlePolicy': 'max-bundle',
      'rtcpMuxPolicy': 'require',
    });
    _pc = pc;

    final stream = _localStream;
    if (stream != null) {
      for (final track in stream.getTracks()) {
        await pc.addTrack(track, stream);
      }
    }

    pc.onIceCandidate = (candidate) {
      if (candidate.candidate == null || callId == null || peerId == null) return;
      WsService.instance.sendP2p(
        callId!,
        'ice',
        peerId!,
        jsonEncode({
          'candidate': candidate.candidate,
          'sdpMid': candidate.sdpMid,
          'sdpMLineIndex': candidate.sdpMLineIndex,
        }),
      );
    };

    pc.onConnectionState = (state) {
      // 归一化成小写语义值：UI 只做判断，不显示原始枚举名
      iceState = switch (state) {
        rtc.RTCPeerConnectionState.RTCPeerConnectionStateConnected => 'connected',
        rtc.RTCPeerConnectionState.RTCPeerConnectionStateConnecting => 'connecting',
        rtc.RTCPeerConnectionState.RTCPeerConnectionStateDisconnected => 'disconnected',
        rtc.RTCPeerConnectionState.RTCPeerConnectionStateFailed => 'failed',
        _ => 'new',
      };
      if (state == rtc.RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        if (phase != CallPhase.active) {
          phase = CallPhase.active;
          _startTick();
        }
      } else if (state == rtc.RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        error = '通话连接失败（网络不通）';
        unawaited(_finish(sendHangup: true));
      }
      notifyListeners();
    };

    pc.onTrack = (event) {
      // 远端音频由 WebRTC 音频设备自动播放，这里只需确保扬声器状态
      if (Platform.isAndroid || Platform.isIOS) {
        unawaited(rtc.Helper.setSpeakerphoneOn(speakerOn));
      }
    };
  }

  Future<void> _sendOffer(String to) async {
    final pc = _pc;
    if (pc == null) return;
    try {
      final offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      WsService.instance.sendP2p(
        callId!,
        'offer',
        to,
        jsonEncode({'sdp': offer.sdp, 'type': offer.type}),
      );
    } catch (_) {
      error = '建立通话连接失败';
      notifyListeners();
    }
  }

  Future<void> _onP2p(Map<String, dynamic> msg) async {
    final kind = msg['kind'];
    final from = msg['from'];
    final payload = msg['payload'];
    if (kind is! String || from is! String || payload is! String) return;

    // 被叫在收到 offer 时才建连接（此时才拿到对端 id）
    peerId ??= from;
    await _ensurePc();
    final pc = _pc;
    if (pc == null) return;

    try {
      if (kind == 'offer') {
        final data = jsonDecode(payload) as Map<String, dynamic>;
        await pc.setRemoteDescription(
          rtc.RTCSessionDescription(data['sdp'] as String?, data['type'] as String?),
        );
        final answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        WsService.instance.sendP2p(
          callId!,
          'answer',
          from,
          jsonEncode({'sdp': answer.sdp, 'type': answer.type}),
        );
        if (phase != CallPhase.active) {
          phase = CallPhase.active;
          _startTick();
          notifyListeners();
        }
      } else if (kind == 'answer') {
        final data = jsonDecode(payload) as Map<String, dynamic>;
        await pc.setRemoteDescription(
          rtc.RTCSessionDescription(data['sdp'] as String?, data['type'] as String?),
        );
      } else if (kind == 'ice') {
        final data = jsonDecode(payload) as Map<String, dynamic>;
        final candidate = data['candidate'];
        if (candidate is String && candidate.isNotEmpty) {
          await pc.addCandidate(
            rtc.RTCIceCandidate(
              candidate,
              data['sdpMid'] as String?,
              (data['sdpMLineIndex'] as num?)?.toInt(),
            ),
          );
        }
      }
    } catch (_) {
      // 候选早于 remoteDescription 到达属于正常现象，ICE 会重传
    }
  }

  /* ------------------------------------------------------------------ */
  /* 计时与清理                                                          */
  /* ------------------------------------------------------------------ */

  void _startTick() {
    _tick?.cancel();
    elapsedSeconds = 0;
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      elapsedSeconds++;
      notifyListeners();
    });
  }

  Future<void> _finish({required bool sendHangup}) async {
    if (sendHangup && callId != null) {
      WsService.instance.hangupCall(callId!);
    }
    _tick?.cancel();
    _tick = null;
    _timeout?.cancel();
    _timeout = null;

    // 必须显式停轨道，否则麦克风指示灯常亮
    try {
      final stream = _localStream;
      if (stream != null) {
        for (final track in stream.getTracks()) {
          await track.stop();
        }
        await stream.dispose();
      }
    } catch (_) {
      // 忽略
    }
    _localStream = null;
    _mediaStarted = false;

    try {
      await _pc?.close();
    } catch (_) {
      // 忽略
    }
    _pc = null;

    phase = CallPhase.ended;
    notifyListeners();
  }

  /// 关闭并复位（通话页退出时调用）
  void reset() {
    _tick?.cancel();
    _timeout?.cancel();
    _tick = null;
    _timeout = null;
    phase = CallPhase.idle;
    callId = null;
    conversationId = null;
    peerId = null;
    peerName = '';
    incoming = false;
    muted = false;
    elapsedSeconds = 0;
    error = null;
    iceState = null;
    notifyListeners();
  }
}
