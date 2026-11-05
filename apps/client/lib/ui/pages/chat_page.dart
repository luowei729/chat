import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/api.dart';
import '../../core/config.dart';
import '../../core/models.dart';
import '../../services/calls.dart';
import '../../services/chat_store.dart';
import '../../services/media.dart';
import '../../services/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/message_bubble.dart';
import 'call_page.dart';
import 'media_viewer_page.dart';

class ChatPage extends StatefulWidget {
  const ChatPage({super.key, required this.conversationId, this.title});

  final String conversationId;
  final String? title;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final ChatStore _store = ChatStore.instance;
  final MediaService _media = MediaService.instance;

  final ScrollController _scroll = ScrollController();
  final TextEditingController _input = TextEditingController();
  final FocusNode _inputFocus = FocusNode();

  String? _peerId;
  String _title = '聊天';
  bool _group = false;

  bool _voiceMode = false;
  bool _recording = false;
  int _recordStartAt = 0;
  Timer? _recordTimer;
  int _recordSeconds = 0;

  bool _stickToBottom = true;
  int _lastMessageCount = 0;

  String? _typingUserId;
  Timer? _typingClearTimer;
  DateTime _lastTypingSent = DateTime.fromMillisecondsSinceEpoch(0);

  String? _playingMessageId;
  StreamSubscription<TypingEvent>? _typingSub;

  @override
  void initState() {
    super.initState();
    _title = widget.title ?? '聊天';
    _scroll.addListener(_onScroll);
    _typingSub = _store.onTyping.listen(_onTyping);
    // 输入内容变化要重建：发送/麦克风按钮的切换依赖它
    _input.addListener(_onInputUiChanged);

    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await _loadConversationMeta();
      await _store.openConversation(widget.conversationId);
      _scrollToBottom(animated: false);
    });
  }

  @override
  void dispose() {
    _typingSub?.cancel();
    _recordTimer?.cancel();
    _typingClearTimer?.cancel();
    _store.closeConversation(widget.conversationId);
    unawaited(_media.stopAudio());
    if (_recording) unawaited(_media.cancelRecording());
    _scroll.dispose();
    _input.removeListener(_onInputUiChanged);
    _input.dispose();
    _inputFocus.dispose();
    super.dispose();
  }

  Future<void> _loadConversationMeta() async {
    try {
      final detail = await ApiClient.instance.conversation(widget.conversationId);
      if (!mounted) return;
      setState(() {
        _title = detail.title;
        _group = detail.type == 'group';
        final peer = detail.members.where((m) => m.userId != Session.instance.userId);
        _peerId = peer.isEmpty ? null : peer.first.userId;
      });
    } catch (_) {
      // 标题用路由传入的兜底
    }
  }

  /* ------------------------------------------------------------------ */
  /* 滚动                                                                */
  /* ------------------------------------------------------------------ */

  void _onScroll() {
    if (!_scroll.hasClients) return;
    final position = _scroll.position;
    _stickToBottom = position.maxScrollExtent - position.pixels < 90;

    // 到顶部附近自动加载更早
    if (position.pixels < 120) {
      unawaited(_store.loadMore(widget.conversationId));
    }
  }

  void _scrollToBottom({bool animated = true}) {
    if (!_scroll.hasClients) return;
    final target = _scroll.position.maxScrollExtent;
    if (animated) {
      _scroll.animateTo(
        target,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    } else {
      _scroll.jumpTo(target);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 输入中                                                              */
  /* ------------------------------------------------------------------ */

  void _onTyping(TypingEvent event) {
    if (event.conversationId != widget.conversationId) return;
    if (event.userId == Session.instance.userId) return;
    setState(() => _typingUserId = event.userId);
    _typingClearTimer?.cancel();
    _typingClearTimer = Timer(const Duration(seconds: 3), () {
      if (mounted) setState(() => _typingUserId = null);
    });
  }

  void _onInputUiChanged() {
    if (mounted) setState(() {});
  }

  void _onInputChanged(String value) {
    if (value.trim().isEmpty) return;
    final now = DateTime.now();
    // 节流 3 秒，避免每个字符都发一帧
    if (now.difference(_lastTypingSent).inSeconds >= 3) {
      _lastTypingSent = now;
      _store.notifyTyping(widget.conversationId);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 发送                                                                */
  /* ------------------------------------------------------------------ */

  Future<void> _sendText() async {
    final text = _input.text;
    if (text.trim().isEmpty) return;
    _input.clear();
    _stickToBottom = true;
    await _store.sendText(widget.conversationId, text);
    if (mounted) _scrollToBottom();
  }

  Future<void> _openAttachmentSheet() async {
    final c = AppColors.of(context);
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 36,
              height: 4,
              margin: const EdgeInsets.only(top: 8, bottom: 8),
              decoration: BoxDecoration(
                color: c.textFaint,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            _sheetItem(Icons.photo_library_outlined, '相册', 'gallery'),
            _sheetItem(Icons.photo_camera_outlined, '拍照', 'camera'),
            _sheetItem(Icons.videocam_outlined, '拍摄视频', 'video'),
            _sheetItem(Icons.insert_drive_file_outlined, '文件', 'file'),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (action == null || !mounted) return;

    switch (action) {
      case 'gallery':
        await _sendPickedImage(fromCamera: false);
      case 'camera':
        await _sendPickedImage(fromCamera: true);
      case 'video':
        await _sendPickedVideo();
      case 'file':
        await _sendPickedFile();
    }
  }

  Widget _sheetItem(IconData icon, String label, String action) {
    final c = AppColors.of(context);
    return ListTile(
      leading: Icon(icon, size: 22, color: c.primary),
      title: Text(label),
      onTap: () => Navigator.of(context).pop(action),
    );
  }

  Future<void> _sendPickedImage({required bool fromCamera}) async {
    try {
      final picked = await _media.pickImage(fromCamera: fromCamera);
      if (picked == null) return;
      _stickToBottom = true;
      await _store.sendMedia(
        conversationId: widget.conversationId,
        type: 'image',
        filePath: picked.path,
        filename: picked.filename,
        kind: 'image',
        width: picked.width,
        height: picked.height,
      );
      if (mounted) _scrollToBottom();
    } on ApiException catch (e) {
      if (mounted) showError(context, e.message);
    } catch (e) {
      if (mounted) showError(context, '发送图片失败：$e');
    }
  }

  Future<void> _sendPickedVideo() async {
    try {
      final picked = await _media.pickVideo();
      if (picked == null) return;
      _stickToBottom = true;
      await _store.sendMedia(
        conversationId: widget.conversationId,
        type: 'video',
        filePath: picked.path,
        filename: picked.filename,
        kind: 'video',
        durationMs: picked.durationMs,
      );
      if (mounted) _scrollToBottom();
    } on ApiException catch (e) {
      if (mounted) showError(context, e.message);
    } catch (e) {
      if (mounted) showError(context, '发送视频失败：$e');
    }
  }

  Future<void> _sendPickedFile() async {
    try {
      final picked = await _media.pickFile();
      if (picked == null) return;
      _stickToBottom = true;
      await _store.sendMedia(
        conversationId: widget.conversationId,
        type: 'file',
        filePath: picked.path,
        filename: picked.filename,
        kind: 'file',
      );
      if (mounted) _scrollToBottom();
    } on ApiException catch (e) {
      if (mounted) showError(context, e.message);
    } catch (e) {
      if (mounted) showError(context, '发送文件失败：$e');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 语音录制（按住说话）                                                 */
  /* ------------------------------------------------------------------ */

  Future<void> _startRecord() async {
    if (_recording) return;
    final ok = await _media.startRecording();
    if (!ok) {
      if (mounted) showError(context, '麦克风权限被拒绝，请在系统设置中开启');
      return;
    }
    _recordStartAt = DateTime.now().millisecondsSinceEpoch;
    _recordSeconds = 0;
    setState(() => _recording = true);
    _recordTimer?.cancel();
    _recordTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return;
      setState(() => _recordSeconds++);
      // 60 秒自动结束，避免无限录音
      if (_recordSeconds >= 60) {
        t.cancel();
        unawaited(_stopAndSendRecord());
      }
    });
  }

  Future<void> _stopAndSendRecord() async {
    if (!_recording) return;
    _recordTimer?.cancel();
    final elapsed = DateTime.now().millisecondsSinceEpoch - _recordStartAt;
    setState(() => _recording = false);

    // 太短视为误触，取消
    if (elapsed < 800) {
      await _media.cancelRecording();
      return;
    }

    final recorded = await _media.stopRecording();
    if (recorded == null) return;

    _stickToBottom = true;
    await _store.sendMedia(
      conversationId: widget.conversationId,
      type: 'audio',
      filePath: recorded.path,
      filename: 'voice.m4a',
      kind: 'audio',
      durationMs: recorded.durationMs,
      waveform: recorded.waveform,
    );
    if (mounted) _scrollToBottom();
  }

  Future<void> _cancelRecord() async {
    if (!_recording) return;
    _recordTimer?.cancel();
    setState(() => _recording = false);
    await _media.cancelRecording();
  }

  /* ------------------------------------------------------------------ */
  /* 长按菜单                                                            */
  /* ------------------------------------------------------------------ */

  void _showMessageActions(Message message) {
    final isSelf = message.senderId == Session.instance.userId;
    final c = AppColors.of(context);

    showModalBottomSheet<void>(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (message.type == 'text' && (message.text?.isNotEmpty ?? false))
              ListTile(
                leading: Icon(Icons.copy_outlined, size: 20, color: c.text),
                title: const Text('复制'),
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  // 剪贴板由系统提供，桌面与移动端一致
                  _copyText(message.text ?? '');
                },
              ),
            if (isSelf && message.seq > 0)
              ListTile(
                leading: Icon(Icons.undo, size: 20, color: c.text),
                title: const Text('撤回'),
                subtitle: const Text('双方都会看到「消息已撤回」'),
                onTap: () async {
                  Navigator.of(sheetContext).pop();
                  try {
                    await _store.recall(message);
                  } on ApiException catch (e) {
                    if (mounted) showError(context, e.message);
                  }
                },
              ),
            ListTile(
              leading: Icon(Icons.delete_outline, size: 20, color: c.danger),
              title: Text('删除', style: TextStyle(color: c.danger)),
              subtitle: const Text('仅从我的设备移除'),
              onTap: () async {
                Navigator.of(sheetContext).pop();
                try {
                  await _store.deleteForMe(message);
                } on ApiException catch (e) {
                  if (mounted) showError(context, e.message);
                }
              },
            ),
          ],
        ),
      ),
    );
  }

  void _copyText(String text) {
    // 用系统剪贴板：Flutter 内置，无需额外依赖
    Clipboard.setData(ClipboardData(text: text));
    showError(context, '已复制');
  }

  /* ------------------------------------------------------------------ */
  /* 媒体打开 / 播放                                                     */
  /* ------------------------------------------------------------------ */

  void _openMedia(Message message) {
    final att = message.firstAttachment;
    final isVideo = message.type == 'video';
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => MediaViewerPage(
          title: att?.filename ?? (isVideo ? '视频' : '图片'),
          imageUrl: isVideo ? null : AppConfig.mediaUrl(att?.url),
          videoUrl: isVideo ? AppConfig.mediaUrl(att?.url) : null,
          localPath: message.localFilePath,
        ),
      ),
    );
  }

  Future<void> _toggleAudio(Message message) async {
    final att = message.firstAttachment;
    if (att == null) return;
    if (_playingMessageId == message.id) {
      await _media.stopAudio();
      if (mounted) setState(() => _playingMessageId = null);
      return;
    }
    setState(() => _playingMessageId = message.id);
    await _media.playAudio(
      AppConfig.mediaUrl(att.url),
      onComplete: () {
        if (mounted) setState(() => _playingMessageId = null);
      },
    );
  }

  Future<void> _startCall() async {
    if (_peerId == null) {
      showError(context, '群聊通话暂未开放');
      return;
    }
    await CallController.instance.startOutgoing(
      conversationId: widget.conversationId,
      peerId: _peerId!,
      peerName: _title,
    );
    if (!mounted) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => const CallPage()),
    );
  }

  /* ------------------------------------------------------------------ */
  /* 构建                                                                */
  /* ------------------------------------------------------------------ */

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);

    return ListenableBuilder(
      listenable: _store,
      builder: (context, _) {
        final messages = _store.messagesOf(widget.conversationId);
        final hasMore = _store.hasMoreOf(widget.conversationId);
        final loadingMore = _store.isLoadingMore(widget.conversationId);

        // 新消息到达时若停留在底部，自动跟随
        if (messages.length != _lastMessageCount) {
          final grew = messages.length > _lastMessageCount;
          _lastMessageCount = messages.length;
          if (grew && _stickToBottom) {
            WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
          }
        }

        return Scaffold(
          backgroundColor: c.bg,
          appBar: AppBar(
            titleSpacing: 0,
            title: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  _title,
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                ),
                Text(
                  _typingUserId != null ? '正在输入…' : (_group ? '群聊' : '私聊'),
                  style: TextStyle(
                    fontSize: 11,
                    color: _typingUserId != null ? c.primary : c.textMuted,
                  ),
                ),
              ],
            ),
            actions: [
              IconButton(
                tooltip: '语音通话',
                onPressed: _startCall,
                icon: const Icon(Icons.phone_outlined, size: 22),
              ),
              const SizedBox(width: 4),
            ],
          ),
          body: Column(
            children: [
              Expanded(
                child: messages.isEmpty
                    ? const EmptyView(text: '还没有消息，打个招呼吧', icon: Icons.waving_hand_outlined)
                    : ListView.builder(
                        controller: _scroll,
                        padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
                        itemCount: messages.length + 1,
                        itemBuilder: (context, index) {
                          if (index == 0) {
                            return _topHint(hasMore, loadingMore);
                          }
                          final i = index - 1;
                          final message = messages[i];
                          final prev = i > 0 ? messages[i - 1] : null;
                          final isSelf = message.senderId == Session.instance.userId;

                          final showSender = prev == null ||
                              prev.senderId != message.senderId ||
                              message.createdAt - prev.createdAt > 5 * 60 * 1000;
                          final showAvatar = prev == null ||
                              prev.senderId != message.senderId ||
                              message.createdAt - prev.createdAt > 5 * 60 * 1000;

                          return MessageBubble(
                            message: message,
                            isSelf: isSelf,
                            peerReadSeq: _store.peerReadSeq(widget.conversationId),
                            showSender: _group && showSender,
                            showAvatar: showAvatar,
                            playing: _playingMessageId == message.id,
                            onLongPress: () => _showMessageActions(message),
                            onRetry: message.localStatus == LocalStatus.failed
                                ? () => _store.retry(message)
                                : null,
                            onMediaTap: () => _openMedia(message),
                            onAudioTap: () => _toggleAudio(message),
                          );
                        },
                      ),
              ),
              if (_recording) _recordingBanner(c),
              _inputBar(c),
            ],
          ),
        );
      },
    );
  }

  Widget _topHint(bool hasMore, bool loadingMore) {
    final c = AppColors.of(context);
    if (loadingMore) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 12),
        child: Center(
          child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
        ),
      );
    }
    if (!hasMore) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Center(
          child: Text('没有更多了', style: TextStyle(fontSize: 11, color: c.textFaint)),
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Center(
        child: Text('上滑查看更多', style: TextStyle(fontSize: 11, color: c.textFaint)),
      ),
    );
  }

  Widget _recordingBanner(AppColors c) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
      decoration: BoxDecoration(
        color: c.primarySoft,
        borderRadius: BorderRadius.circular(AppRadius.md),
      ),
      child: Row(
        children: [
          Icon(Icons.fiber_manual_record, size: 12, color: c.danger),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Text(
              '正在录音 ${_recordSeconds}s（松开发送，最长 60s）',
              style: TextStyle(fontSize: 13, color: c.text),
            ),
          ),
          TextButton(
            onPressed: _cancelRecord,
            child: const Text('取消'),
          ),
        ],
      ),
    );
  }

  Widget _inputBar(AppColors c) {
    return Container(
      decoration: BoxDecoration(
        color: c.surface,
        border: Border(top: BorderSide(color: c.border, width: 0.5)),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.sm),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              IconButton(
                onPressed: _openAttachmentSheet,
                icon: const Icon(Icons.add_circle_outline, size: 26),
                color: c.textMuted,
                tooltip: '发送附件',
              ),
              Expanded(
                child: _voiceMode
                    ? _holdToTalkButton(c)
                    : TextField(
                        controller: _input,
                        focusNode: _inputFocus,
                        minLines: 1,
                        maxLines: 4,
                        textInputAction: TextInputAction.newline,
                        onChanged: _onInputChanged,
                        style: const TextStyle(fontSize: 16),
                        decoration: InputDecoration(
                          hintText: '发消息…',
                          fillColor: c.surfaceAlt,
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 14,
                            vertical: 10,
                          ),
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(AppRadius.xl),
                            borderSide: BorderSide.none,
                          ),
                          enabledBorder: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(AppRadius.xl),
                            borderSide: BorderSide.none,
                          ),
                          focusedBorder: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(AppRadius.xl),
                            borderSide: BorderSide.none,
                          ),
                        ),
                      ),
              ),
              const SizedBox(width: 4),
              // 右侧按钮：语音模式=键盘；无内容=麦克风；有内容=发送
              if (_voiceMode)
                IconButton(
                  onPressed: () => setState(() => _voiceMode = false),
                  icon: const Icon(Icons.keyboard_outlined, size: 24),
                  color: c.textMuted,
                  tooltip: '切换键盘',
                )
              else if (_input.text.trim().isEmpty)
                IconButton(
                  onPressed: () => setState(() => _voiceMode = true),
                  icon: const Icon(Icons.mic_none, size: 24),
                  color: c.textMuted,
                  tooltip: '语音消息',
                )
              else
                IconButton(
                  onPressed: _sendText,
                  icon: Icon(Icons.send_rounded, size: 24, color: c.primary),
                  tooltip: '发送',
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _holdToTalkButton(AppColors c) {
    return Listener(
      onPointerDown: (_) => unawaited(_startRecord()),
      onPointerUp: (_) => unawaited(_stopAndSendRecord()),
      onPointerCancel: (_) => unawaited(_cancelRecord()),
      child: Container(
        height: 42,
        decoration: BoxDecoration(
          color: _recording ? c.primarySoft : c.surfaceAlt,
          borderRadius: BorderRadius.circular(AppRadius.xl),
          border: Border.all(
            color: _recording ? c.primary : Colors.transparent,
            width: 1.5,
          ),
        ),
        alignment: Alignment.center,
        child: Text(
          _recording ? '松开发送' : '按住 说话',
          style: TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.w500,
            color: _recording ? c.primary : c.textMuted,
          ),
        ),
      ),
    );
  }
}
