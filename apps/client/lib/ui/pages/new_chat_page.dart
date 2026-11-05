import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// 发起新聊天：按邮箱/昵称搜人 → 直接建私聊（不需要先加好友）
class NewChatPage extends StatefulWidget {
  const NewChatPage({super.key});

  @override
  State<NewChatPage> createState() => _NewChatPageState();
}

class _NewChatPageState extends State<NewChatPage> {
  final _searchCtrl = TextEditingController();
  Timer? _debounce;

  List<UserProfile> _results = const [];
  bool _searching = false;
  bool _creating = false;
  String? _error;

  @override
  void dispose() {
    _debounce?.cancel();
    _searchCtrl.dispose();
    super.dispose();
  }

  void _onChanged(String value) {
    _debounce?.cancel();
    final q = value.trim();
    if (q.isEmpty) {
      setState(() => _results = const []);
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 350), () => _search(q));
  }

  Future<void> _search(String q) async {
    setState(() {
      _searching = true;
      _error = null;
    });
    try {
      final list = await ApiClient.instance.searchUsers(q);
      if (mounted) setState(() => _results = list);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _searching = false);
    }
  }

  Future<void> _startChat(UserProfile user) async {
    if (_creating) return;
    setState(() => _creating = true);
    try {
      final conversationId = await ApiClient.instance.createDirect(user.id);
      if (!mounted) return;
      Navigator.of(context).pop(<String, dynamic>{
        'conversationId': conversationId,
        'title': user.nickname,
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _creating = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('发起聊天')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: TextField(
              controller: _searchCtrl,
              onChanged: _onChanged,
              autofocus: true,
              decoration: InputDecoration(
                hintText: '搜索昵称或邮箱',
                prefixIcon: const Icon(Icons.search, size: 20),
                fillColor: c.surfaceAlt,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(AppRadius.md),
                  borderSide: BorderSide.none,
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(AppRadius.md),
                  borderSide: BorderSide.none,
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(AppRadius.md),
                  borderSide: BorderSide.none,
                ),
              ),
            ),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
              child: Text(_error!, style: TextStyle(color: c.danger, fontSize: 13)),
            ),
          Expanded(
            child: _searching
                ? const Center(child: CircularProgressIndicator())
                : _results.isEmpty
                    ? const EmptyView(text: '输入昵称或邮箱开始搜索', icon: Icons.person_search_outlined)
                    : ListView.separated(
                        itemCount: _results.length,
                        separatorBuilder: (_, __) => Divider(
                          height: 0.5,
                          indent: 72,
                          color: c.border,
                        ),
                        itemBuilder: (context, index) {
                          final user = _results[index];
                          return ListTile(
                            leading: Avatar(name: user.nickname, url: user.avatarUrl, size: 44),
                            title: Text(user.nickname),
                            subtitle: Text(
                              user.email,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            trailing: _creating
                                ? const SizedBox(
                                    width: 18,
                                    height: 18,
                                    child: CircularProgressIndicator(strokeWidth: 2),
                                  )
                                : Icon(Icons.chat_bubble_outline, size: 20, color: c.primary),
                            onTap: _creating ? null : () => _startChat(user),
                          );
                        },
                      ),
          ),
        ],
      ),
    );
  }
}
