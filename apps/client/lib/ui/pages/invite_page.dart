import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// 邀请码管理：查看剩余名额、已发邀请码、已邀请用户
class InvitePage extends StatefulWidget {
  const InvitePage({super.key});

  @override
  State<InvitePage> createState() => _InvitePageState();
}

class _InvitePageState extends State<InvitePage> {
  bool _loading = true;
  bool _creating = false;
  String? _error;

  int _quota = 0;
  List<Map<String, dynamic>> _codes = const [];
  List<Map<String, dynamic>> _invitees = const [];

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
      final data = await ApiClient.instance.inviteOverview();
      if (!mounted) return;
      setState(() {
        _quota = (data['quota'] as num?)?.toInt() ?? 0;
        _codes = ((data['codes'] as List?) ?? const [])
            .map((e) => Map<String, dynamic>.from(e as Map))
            .toList();
        _invitees = ((data['invitees'] as List?) ?? const [])
            .map((e) => Map<String, dynamic>.from(e as Map))
            .toList();
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _create() async {
    if (_creating) return;
    setState(() => _creating = true);
    try {
      final result = await ApiClient.instance.createInvite(maxUses: 1);
      final code = result['code'];
      if (mounted && code is String) {
        showError(context, '已生成邀请码：$code');
      }
      await _load();
    } on ApiException catch (e) {
      if (mounted) showError(context, e.message);
    } finally {
      if (mounted) setState(() => _creating = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('我的邀请码')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                children: [
                  Container(
                    margin: const EdgeInsets.all(AppSpacing.md),
                    padding: const EdgeInsets.all(AppSpacing.lg),
                    decoration: BoxDecoration(
                      color: c.primarySoft,
                      borderRadius: BorderRadius.circular(AppRadius.lg),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '剩余可创建名额：$_quota',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                            color: c.primary,
                          ),
                        ),
                        const SizedBox(height: AppSpacing.xs),
                        Text(
                          '把邀请码发给朋友，对方注册后自动成为你的受邀用户',
                          style: TextStyle(fontSize: 13, color: c.textMuted),
                        ),
                        const SizedBox(height: AppSpacing.md),
                        FilledButton(
                          onPressed: (_creating || _quota <= 0) ? null : _create,
                          child: _creating
                              ? const SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Colors.white,
                                  ),
                                )
                              : const Text('生成邀请码'),
                        ),
                      ],
                    ),
                  ),
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
                      child: Text(_error!, style: TextStyle(color: c.danger, fontSize: 13)),
                    ),
                  SettingsCard(
                    header: '已发出的邀请码',
                    children: [
                      if (_codes.isEmpty)
                        const Padding(
                          padding: EdgeInsets.all(AppSpacing.lg),
                          child: Text('还没有邀请码', style: TextStyle(fontSize: 14)),
                        ),
                      for (final code in _codes)
                        SettingsRow(
                          title: (code['code'] as String?) ?? '',
                          subtitle:
                              '已用 ${code['usedCount'] ?? 0}/${code['maxUses'] ?? 1} · 剩余 ${code['remainingUses'] ?? 0}',
                          icon: Icons.confirmation_number_outlined,
                          trailing: IconButton(
                            icon: const Icon(Icons.copy_outlined, size: 18),
                            onPressed: () {
                              // 复制到剪贴板
                              showError(context, '邀请码：${code['code']}');
                            },
                          ),
                        ),
                    ],
                  ),
                  SettingsCard(
                    header: '通过我邀请注册',
                    children: [
                      if (_invitees.isEmpty)
                        const Padding(
                          padding: EdgeInsets.all(AppSpacing.lg),
                          child: Text('还没有受邀用户', style: TextStyle(fontSize: 14)),
                        ),
                      for (final invitee in _invitees)
                        ListTile(
                          leading: Avatar(
                            name: (invitee['nickname'] as String?) ?? '用户',
                            url: invitee['avatarUrl'] as String?,
                            size: 40,
                          ),
                          title: Text((invitee['nickname'] as String?) ?? '用户'),
                          subtitle: Text(
                            formatListTime((invitee['joinedAt'] as num?)?.toInt()),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: AppSpacing.xl),
                ],
              ),
            ),
    );
  }
}
