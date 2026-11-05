import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'new_chat_page.dart';

class ContactsPage extends StatefulWidget {
  const ContactsPage({super.key, required this.onOpenChat});

  final void Function(String conversationId, {String? title}) onOpenChat;

  @override
  State<ContactsPage> createState() => _ContactsPageState();
}

class _ContactsPageState extends State<ContactsPage> {
  List<FriendItem> _friends = const [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final list = await ApiClient.instance.listFriends();
      if (mounted) setState(() => _friends = list);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openFriend(FriendItem friend) async {
    try {
      final conversationId =
          friend.conversationId ?? await ApiClient.instance.createDirect(friend.userId);
      if (!mounted) return;
      widget.onOpenChat(conversationId, title: friend.displayName);
    } on ApiException catch (e) {
      if (mounted) showError(context, e.message);
    }
  }

  Future<void> _startNewChat() async {
    final result = await Navigator.of(context).push<Map<String, dynamic>>(
      MaterialPageRoute<Map<String, dynamic>>(builder: (_) => const NewChatPage()),
    );
    if (result == null) return;
    final conversationId = result['conversationId'] as String?;
    if (conversationId == null) return;
    if (mounted) widget.onOpenChat(conversationId, title: result['title'] as String?);
  }

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('联系人'),
        actions: [
          IconButton(
            tooltip: '发起聊天',
            onPressed: _startNewChat,
            icon: const Icon(Icons.person_add_alt, size: 22),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                children: [
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.all(AppSpacing.lg),
                      child: Text(_error!, style: TextStyle(color: c.danger, fontSize: 13)),
                    ),
                  ListTile(
                    leading: _circleIcon(Icons.person_add_alt_1_outlined, c.primary, c),
                    title: const Text('发起新聊天'),
                    subtitle: const Text('不需要先加好友'),
                    onTap: _startNewChat,
                  ),
                  Divider(height: 0.5, indent: 72, color: c.border),
                  if (_friends.isEmpty)
                    const Padding(
                      padding: EdgeInsets.only(top: 80),
                      child: EmptyView(text: '还没有联系人', icon: Icons.people_outline),
                    )
                  else
                    for (final friend in _friends) ...[
                      ListTile(
                        leading: Avatar(
                          name: friend.displayName,
                          url: friend.avatarUrl,
                          size: 44,
                        ),
                        title: Text(friend.displayName),
                        subtitle: friend.remark != null && friend.remark!.isNotEmpty
                            ? Text(friend.nickname)
                            : null,
                        trailing: Icon(
                          Icons.chat_bubble_outline,
                          size: 18,
                          color: c.textFaint,
                        ),
                        onTap: () => _openFriend(friend),
                      ),
                      Divider(height: 0.5, indent: 72, color: c.border),
                    ],
                ],
              ),
      ),
    );
  }

  Widget _circleIcon(IconData icon, Color color, AppColors c) {
    return Container(
      width: 44,
      height: 44,
      decoration: BoxDecoration(color: c.primarySoft, shape: BoxShape.circle),
      child: Icon(icon, size: 22, color: color),
    );
  }
}
