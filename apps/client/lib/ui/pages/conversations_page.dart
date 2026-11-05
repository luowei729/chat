import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../services/chat_store.dart';
import '../../services/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'new_chat_page.dart';

class ConversationsPage extends StatelessWidget {
  const ConversationsPage({super.key, required this.onOpenChat});

  final void Function(String conversationId, {String? title}) onOpenChat;

  Future<void> _startNewChat(BuildContext context) async {
    final result = await Navigator.of(context).push<Map<String, dynamic>>(
      MaterialPageRoute<Map<String, dynamic>>(builder: (_) => const NewChatPage()),
    );
    if (result == null) return;
    final conversationId = result['conversationId'] as String?;
    if (conversationId == null) return;
    if (context.mounted) {
      onOpenChat(conversationId, title: result['title'] as String?);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);

    return ListenableBuilder(
      listenable: ChatStore.instance,
      builder: (context, _) {
        final store = ChatStore.instance;
        final list = store.conversations;

        return Scaffold(
          backgroundColor: c.bg,
          appBar: AppBar(
            title: const Text('聊天'),
            actions: [
              IconButton(
                tooltip: '发起新聊天',
                onPressed: () => _startNewChat(context),
                icon: const Icon(Icons.edit_square, size: 22),
              ),
              const SizedBox(width: 4),
            ],
          ),
          body: RefreshIndicator(
            onRefresh: () => store.loadConversations(),
            child: !store.conversationsLoaded && store.conversationsLoading
                ? const Center(child: CircularProgressIndicator())
                : list.isEmpty
                    ? ListView(
                        // 用可滚动容器包住，保证下拉刷新在空列表时也能用
                        physics: const AlwaysScrollableScrollPhysics(),
                        children: [
                          SizedBox(height: MediaQuery.of(context).size.height * 0.22),
                          EmptyView(
                            text: store.conversationsLoading ? '加载中…' : '还没有会话，点右上角开始聊天',
                            icon: Icons.chat_bubble_outline,
                          ),
                        ],
                      )
                    : ListView.separated(
                        physics: const AlwaysScrollableScrollPhysics(),
                        itemCount: list.length,
                        separatorBuilder: (_, __) => Divider(
                          height: 0.5,
                          indent: 76,
                          color: c.border,
                        ),
                        itemBuilder: (context, index) {
                          final item = list[index];
                          return _ConversationTile(
                            item: item,
                            onTap: () => onOpenChat(item.id, title: item.title),
                          );
                        },
                      ),
          ),
        );
      },
    );
  }
}

class _ConversationTile extends StatelessWidget {
  const _ConversationTile({required this.item, required this.onTap});

  final ConversationSummary item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);
    final preview = item.lastMessage;
    final isSelfLast = preview?.senderId == Session.instance.userId;

    String subtitle = '';
    if (preview != null) {
      final prefix = item.isGroup && !isSelfLast ? '${preview.senderName}：' : '';
      subtitle = '$prefix${preview.summary}';
    } else {
      subtitle = '暂无消息';
    }

    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.lg,
          vertical: AppSpacing.md,
        ),
        child: Row(
          children: [
            Avatar(
              name: item.title,
              url: item.avatarUrl,
              size: 48,
              isGroup: item.isGroup,
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      if (item.pinned) ...[
                        Icon(Icons.push_pin, size: 13, color: c.textFaint),
                        const SizedBox(width: 4),
                      ],
                      Expanded(
                        child: Text(
                          item.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                            color: c.text,
                          ),
                        ),
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Text(
                        formatListTime(item.lastMessageAt),
                        style: TextStyle(fontSize: 12, color: c.textMuted),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          subtitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 14, color: c.textMuted),
                        ),
                      ),
                      if (item.unreadCount > 0) ...[
                        const SizedBox(width: AppSpacing.sm),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          constraints: const BoxConstraints(minWidth: 20),
                          decoration: BoxDecoration(
                            color: item.muted ? c.textFaint : c.danger,
                            borderRadius: BorderRadius.circular(10),
                          ),
                          alignment: Alignment.center,
                          child: Text(
                            item.unreadCount > 99 ? '99+' : '${item.unreadCount}',
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                              height: 1.4,
                            ),
                          ),
                        ),
                      ] else if (item.muted) ...[
                        const SizedBox(width: AppSpacing.sm),
                        Icon(Icons.notifications_off_outlined, size: 14, color: c.textFaint),
                      ],
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
