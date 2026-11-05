import 'dart:async';

import 'package:flutter/material.dart';

import '../../services/call_overlay.dart';
import '../../services/calls.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// 通话页
///
/// 所有状态都来自 CallController（单一数据源），
/// 页面本身不做信令判断，只负责展示与转发用户意图。
class CallPage extends StatefulWidget {
  const CallPage({super.key});

  @override
  State<CallPage> createState() => _CallPageState();
}

class _CallPageState extends State<CallPage> {
  final CallController _call = CallController.instance;
  bool _closing = false;

  @override
  void initState() {
    super.initState();
    _call.addListener(_onChange);
  }

  @override
  void dispose() {
    _call.removeListener(_onChange);
    super.dispose();
  }

  void _onChange() {
    if (!mounted) return;
    if (_call.phase == CallPhase.ended && !_closing) {
      _closing = true;
      // 让用户看到「通话已结束」再退出
      Future<void>.delayed(const Duration(milliseconds: 1200), () {
        if (!mounted) return;
        Navigator.of(context).maybePop();
        _call.reset();
      });
    }
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);
    final phase = _call.phase;

    return Scaffold(
      backgroundColor: c.bg,
      body: SafeArea(
        /**
         * 布局约束（Windows 上「按钮不居中」的修复）
         * ------------------------------------------------------------
         * 两个必要的约束：
         *   1. crossAxisAlignment.center + 居中文本：桌面窗口很宽，
         *      不显式居中时内容会靠左（Row/Column 的默认行为在
         *      宽屏下不够可靠）；
         *   2. 按钮组限制最大宽度（360）：桌面全屏时 spaceEvenly
         *      会把三个按钮抳到屏幕两端，看着像「没居中」。
         */
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                const SizedBox(height: 64),
                Avatar(name: _call.peerName.isEmpty ? '通话' : _call.peerName, size: 96),
                const SizedBox(height: AppSpacing.lg),
                Text(
                  _call.peerName.isEmpty ? '语音通话' : _call.peerName,
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600, color: c.text),
                ),
                const SizedBox(height: AppSpacing.sm),
                Text(
                  _statusText(phase),
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 14, color: c.textMuted),
                ),
                if (_call.error != null) ...[
                  const SizedBox(height: AppSpacing.sm),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.xl),
                    child: Text(
                      _call.error!,
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 13, color: c.danger),
                    ),
                  ),
                ],
                const Spacer(),
                SizedBox(
                  width: double.infinity,
                  child: _buttons(c, phase),
                ),
                const SizedBox(height: 48),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /**
   * 最小化到悬浮窗
   * ------------------------------------------------------------
   * Android：先确认/申请悬浮窗权限，再隐藏当前页 ——
   *          必须真的把 App 退到后台，否则悬浮窗会被本页盖住。
   * 桌面端：直接缩窗口（桌面本来就能多窗口共存，不需要悬浮窗）。
   */
  Future<void> _minimize() async {
    final bridge = CallOverlayBridge.instance;
    if (await bridge.isAvailable) {
      var granted = await bridge.hasPermission();
      if (!granted) {
        granted = await bridge.requestPermission();
      }
      if (!granted) {
        if (mounted) showError(context, '需要悬浮窗权限才能后台通话');
        return;
      }
      if (!mounted) return;
      // 先把悬浮窗挂上，再退出 App，避免中间出现「什么都没有」的空档
      await bridge.show(peerName: _call.peerName.isEmpty ? '通话中' : _call.peerName);
      await bridge.bringToFront();
      if (mounted) Navigator.of(context).maybePop();
    }
  }

  String _statusText(CallPhase phase) {
    switch (phase) {
      case CallPhase.outgoing:
        return '正在呼叫…';
      case CallPhase.incoming:
        return '邀请你语音通话';
      case CallPhase.connecting:
        return '正在连接…';
      case CallPhase.active:
        // 不要把 RTCPeerConnectionState 这类内部枚举暴露给用户，
        // 只在真的没连上时给出人能看懂的状态。
        final connected = _call.iceState == 'connected';
        final suffix = connected ? '' : '（网络重连中…）';
        return '${formatDuration(_call.elapsedSeconds)} · 已接通$suffix';
      case CallPhase.ended:
        return '通话已结束';
      case CallPhase.idle:
        return '';
    }
  }

  Widget _buttons(AppColors c, CallPhase phase) {
    if (phase == CallPhase.incoming) {
      return Row(
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: [
          _CircleButton(
            icon: Icons.call_end,
            color: c.danger,
            label: '拒接',
            onTap: () {
              _call.reject();
            },
          ),
          _CircleButton(
            icon: Icons.call,
            color: c.success,
            label: '接听',
            onTap: () => _call.accept(),
          ),
        ],
      );
    }

    if (phase == CallPhase.outgoing || phase == CallPhase.connecting) {
      return _CircleButton(
        icon: Icons.call_end,
        color: c.danger,
        label: '取消',
        onTap: () => _call.hangup(),
      );
    }

    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: [
        _CircleButton(
          icon: _call.muted ? Icons.mic_off : Icons.mic,
          color: _call.muted ? c.primary : c.surfaceAlt,
          iconColor: _call.muted ? Colors.white : c.text,
          label: _call.muted ? '取消静音' : '静音',
          onTap: _call.toggleMute,
        ),
        _CircleButton(
          icon: _call.speakerOn ? Icons.volume_up : Icons.volume_down,
          color: _call.speakerOn ? c.primary : c.surfaceAlt,
          iconColor: _call.speakerOn ? Colors.white : c.text,
          label: '扬声器',
          onTap: () => _call.toggleSpeaker(),
        ),
        // 最小化：退到后台并挂悬浮窗，通话持续进行
        _CircleButton(
          icon: Icons.picture_in_picture_alt_outlined,
          color: c.surfaceAlt,
          iconColor: c.text,
          label: '最小化',
          onTap: () => unawaited(_minimize()),
        ),
        _CircleButton(
          icon: Icons.call_end,
          color: c.danger,
          label: '挂断',
          onTap: () => _call.hangup(),
        ),
      ],
    );
  }
}

class _CircleButton extends StatelessWidget {
  const _CircleButton({
    required this.icon,
    required this.color,
    required this.label,
    required this.onTap,
    this.iconColor = Colors.white,
  });

  final IconData icon;
  final Color color;
  final String label;
  final VoidCallback onTap;
  final Color iconColor;

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          width: 68,
          height: 68,
          child: Material(
            color: color,
            shape: const CircleBorder(),
            child: InkWell(
              customBorder: const CircleBorder(),
              onTap: onTap,
              child: Icon(icon, size: 28, color: iconColor),
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.sm),
        Text(label, style: TextStyle(fontSize: 12, color: c.textMuted)),
      ],
    );
  }
}
