import 'package:flutter/material.dart';

import '../../services/chat_store.dart';
import '../theme.dart';
import 'chat_page.dart';
import 'contacts_page.dart';
import 'conversations_page.dart';
import 'settings_page.dart';

/// 主界面：三栏等分底部导航（聊天 / 联系人 / 设置）
class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  int _index = 0;

  @override
  void initState() {
    super.initState();
    // 首页只订阅列表级事件；具体会话由 ChatPage 负责订阅
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ChatStore.instance.loadConversations();
    });
  }

  void _switchTo(int index) {
    if (_index == index) return;
    setState(() => _index = index);
  }

  /// 供子页面切换 Tab（例如从设置页点到聊天）
  void switchTab(int index) => _switchTo(index);

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);

    return Scaffold(
      backgroundColor: c.bg,
      body: IndexedStack(
        index: _index,
        children: [
          ConversationsPage(onOpenChat: _openChat),
          ContactsPage(onOpenChat: _openChat),
          const SettingsPage(),
        ],
      ),
      bottomNavigationBar: ListenableBuilder(
        listenable: ChatStore.instance,
        builder: (context, _) {
          final unread = ChatStore.instance.totalUnread;
          return Container(
            decoration: BoxDecoration(
              color: c.surface,
              border: Border(top: BorderSide(color: c.border, width: 0.5)),
            ),
            child: SafeArea(
              top: false,
              child: SizedBox(
                height: 56,
                child: Row(
                  children: [
                    _TabItem(
                      icon: Icons.chat_bubble_outline,
                      activeIcon: Icons.chat_bubble,
                      label: '聊天',
                      selected: _index == 0,
                      badge: unread,
                      onTap: () => _switchTo(0),
                    ),
                    _TabItem(
                      icon: Icons.people_outline,
                      activeIcon: Icons.people,
                      label: '联系人',
                      selected: _index == 1,
                      onTap: () => _switchTo(1),
                    ),
                    _TabItem(
                      icon: Icons.settings_outlined,
                      activeIcon: Icons.settings,
                      label: '设置',
                      selected: _index == 2,
                      onTap: () => _switchTo(2),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  void _openChat(String conversationId, {String? title}) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ChatPage(conversationId: conversationId, title: title),
      ),
    );
  }
}

class _TabItem extends StatelessWidget {
  const _TabItem({
    required this.icon,
    required this.activeIcon,
    required this.label,
    required this.selected,
    required this.onTap,
    this.badge = 0,
  });

  final IconData icon;
  final IconData activeIcon;
  final String label;
  final bool selected;
  final VoidCallback onTap;
  final int badge;

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);
    final color = selected ? c.primary : c.textMuted;

    return Expanded(
      child: InkWell(
        onTap: onTap,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Stack(
              clipBehavior: Clip.none,
              children: [
                Icon(selected ? activeIcon : icon, size: 22, color: color),
                if (badge > 0)
                  Positioned(
                    right: -8,
                    top: -4,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                      constraints: const BoxConstraints(minWidth: 16),
                      decoration: BoxDecoration(
                        color: c.danger,
                        borderRadius: BorderRadius.circular(9),
                      ),
                      alignment: Alignment.center,
                      child: Text(
                        badge > 99 ? '99+' : '$badge',
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 10,
                          fontWeight: FontWeight.w600,
                          height: 1.3,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 3),
            Text(
              label,
              style: TextStyle(
                fontSize: 11,
                color: color,
                fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
