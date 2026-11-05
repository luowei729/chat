import 'package:flutter/material.dart';

import '../../core/config.dart';
import '../../core/storage.dart';
import '../../services/chat_store.dart';
import '../../services/session.dart';
import '../../services/ws.dart';
import '../app.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'invite_page.dart';

class SettingsPage extends StatelessWidget {
  const SettingsPage({super.key});

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);

    return ListenableBuilder(
      listenable: Session.instance,
      builder: (context, _) {
        final user = Session.instance.user;

        return Scaffold(
          backgroundColor: c.bg,
          appBar: AppBar(title: const Text('设置')),
          body: ListView(
            children: [
              // 用户卡片
              Container(
                margin: const EdgeInsets.all(AppSpacing.md),
                padding: const EdgeInsets.all(AppSpacing.lg),
                decoration: BoxDecoration(
                  color: c.surface,
                  borderRadius: BorderRadius.circular(AppRadius.lg),
                  border: Border.all(color: c.border, width: 0.5),
                ),
                child: Row(
                  children: [
                    Avatar(
                      name: user?.nickname ?? '我',
                      url: user?.avatarUrl,
                      size: 56,
                    ),
                    const SizedBox(width: AppSpacing.md),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            user?.nickname ?? '未登录',
                            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
                          ),
                          const SizedBox(height: 3),
                          Text(
                            user?.emailFull ?? '',
                            style: TextStyle(fontSize: 13, color: c.textMuted),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),

              SettingsCard(
                children: [
                  SettingsRow(
                    title: '我的邀请码',
                    subtitle: '剩余名额 ${user?.inviteQuota ?? 0}',
                    icon: Icons.confirmation_number_outlined,
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(builder: (_) => const InvitePage()),
                    ),
                  ),
                ],
              ),

              SettingsCard(
                header: '外观',
                children: [
                  SettingsRow(
                    title: '跟随系统',
                    icon: Icons.brightness_auto_outlined,
                    trailing: _check(themeModeNotifier.value == ThemeMode.system, c),
                    onTap: () => _setTheme(ThemeMode.system, 'system'),
                  ),
                  SettingsRow(
                    title: '浅色',
                    icon: Icons.light_mode_outlined,
                    trailing: _check(themeModeNotifier.value == ThemeMode.light, c),
                    onTap: () => _setTheme(ThemeMode.light, 'light'),
                  ),
                  SettingsRow(
                    title: '深色',
                    icon: Icons.dark_mode_outlined,
                    trailing: _check(themeModeNotifier.value == ThemeMode.dark, c),
                    onTap: () => _setTheme(ThemeMode.dark, 'dark'),
                  ),
                ],
              ),

              SettingsCard(
                header: '连接',
                children: [
                  ValueListenableBuilder<WsStatus>(
                    valueListenable: WsService.instance.status,
                    builder: (context, status, _) => SettingsRow(
                      title: '实时消息',
                      subtitle: switch (status) {
                        WsStatus.connected => '已连接',
                        WsStatus.connecting => '连接中…',
                        WsStatus.disconnected => '未连接（点击重连）',
                      },
                      icon: Icons.wifi_outlined,
                      trailing: Icon(
                        status == WsStatus.connected ? Icons.check_circle : Icons.refresh,
                        size: 20,
                        color: status == WsStatus.connected ? c.success : c.textMuted,
                      ),
                      onTap: () => WsService.instance.connect(),
                    ),
                  ),
                ],
              ),

              SettingsCard(
                header: '关于',
                children: [
                  SettingsRow(title: '版本', icon: Icons.info_outline, trailing: Text(
                    '${AppConfig.appVersion} (${AppConfig.platform})',
                    style: TextStyle(fontSize: 13, color: c.textMuted),
                  )),
                  const SettingsRow(
                    title: '服务地址',
                    icon: Icons.dns_outlined,
                    trailing: Text('chat.lkz.pub', style: TextStyle(fontSize: 13)),
                  ),
                ],
              ),

              SettingsCard(
                children: [
                  SettingsRow(
                    title: '退出登录',
                    icon: Icons.logout,
                    danger: true,
                    onTap: () => _confirmLogout(context, c),
                  ),
                ],
              ),

              const SizedBox(height: AppSpacing.xl),
            ],
          ),
        );
      },
    );
  }

  Widget _check(bool selected, AppColors c) {
    return Icon(
      selected ? Icons.check_circle : Icons.circle_outlined,
      size: 20,
      color: selected ? c.primary : c.textFaint,
    );
  }

  void _setTheme(ThemeMode mode, String raw) {
    themeModeNotifier.value = mode;
    // 直接落盘：下次启动保持
    AppStorage.instance.setThemeMode(raw);
  }

  Future<void> _confirmLogout(BuildContext context, AppColors c) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('退出登录'),
        content: const Text('退出后需要重新输入邮箱和密码。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text('退出', style: TextStyle(color: c.danger)),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    ChatStore.instance.reset();
    await Session.instance.logout();
  }
}
