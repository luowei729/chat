import 'dart:io';

import 'package:flutter/material.dart';

import '../../core/config.dart';
import '../theme.dart';

/// 头像：有图显示图，没图显示昵称首字（跨平台一致）
class Avatar extends StatelessWidget {
  const Avatar({
    super.key,
    required this.name,
    this.url,
    this.size = 48,
    this.isGroup = false,
  });

  final String name;
  final String? url;
  final double size;
  final bool isGroup;

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);
    final radius = isGroup ? BorderRadius.circular(size * 0.28) : BorderRadius.circular(size / 2);
    final absolute = AppConfig.mediaUrl(url);

    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: c.primarySoft,
        borderRadius: radius,
      ),
      clipBehavior: Clip.antiAlias,
      alignment: Alignment.center,
      child: absolute.isEmpty
          ? Text(
              _initial(name),
              style: TextStyle(
                color: c.primary,
                fontSize: size * 0.4,
                fontWeight: FontWeight.w600,
              ),
            )
          : Image.network(
              absolute,
              width: size,
              height: size,
              fit: BoxFit.cover,
              errorBuilder: (_, __, ___) => Text(
                _initial(name),
                style: TextStyle(
                  color: c.primary,
                  fontSize: size * 0.4,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
    );
  }

  static String _initial(String name) {
    final trimmed = name.trim();
    if (trimmed.isEmpty) return '?';
    // 用 runes 取首字符：直接 substring 会把 emoji 截成半个码位
    return String.fromCharCode(trimmed.runes.first).toUpperCase();
  }
}

/// 空状态
class EmptyView extends StatelessWidget {
  const EmptyView({super.key, required this.text, this.icon});

  final String text;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon ?? Icons.chat_bubble_outline, size: 44, color: c.textFaint),
          const SizedBox(height: AppSpacing.md),
          Text(text, style: TextStyle(color: c.textMuted, fontSize: 15)),
        ],
      ),
    );
  }
}

/// 设置项行
class SettingsRow extends StatelessWidget {
  const SettingsRow({
    super.key,
    required this.title,
    this.subtitle,
    this.icon,
    this.trailing,
    this.onTap,
    this.danger = false,
  });

  final String title;
  final String? subtitle;
  final IconData? icon;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.lg,
          vertical: AppSpacing.md,
        ),
        child: Row(
          children: [
            if (icon != null) ...[
              Icon(icon, size: 20, color: danger ? c.danger : c.textMuted),
              const SizedBox(width: AppSpacing.md),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: TextStyle(
                      fontSize: 16,
                      color: danger ? c.danger : c.text,
                    ),
                  ),
                  if (subtitle != null) ...[
                    const SizedBox(height: 2),
                    Text(
                      subtitle!,
                      style: TextStyle(fontSize: 13, color: c.textMuted),
                    ),
                  ],
                ],
              ),
            ),
            trailing ??
                (onTap == null
                    ? const SizedBox.shrink()
                    : Icon(Icons.chevron_right, size: 20, color: c.textFaint)),
          ],
        ),
      ),
    );
  }
}

/// 白色卡片容器（iOS 分组样式）
class SettingsCard extends StatelessWidget {
  const SettingsCard({super.key, required this.children, this.header});

  final List<Widget> children;
  final String? header;

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (header != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.lg, AppSpacing.lg, AppSpacing.sm),
            child: Text(
              header!.toUpperCase(),
              style: TextStyle(fontSize: 12, color: c.textMuted, letterSpacing: 0.5),
            ),
          ),
        Container(
          margin: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
          decoration: BoxDecoration(
            color: c.surface,
            borderRadius: BorderRadius.circular(AppRadius.md),
            border: Border.all(color: c.border, width: 0.5),
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(
            children: [
              for (var i = 0; i < children.length; i++) ...[
                if (i > 0)
                  Divider(height: 0.5, indent: AppSpacing.lg, color: c.border),
                children[i],
              ],
            ],
          ),
        ),
      ],
    );
  }
}

/// 统一的错误提示条
void showError(BuildContext context, String message) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));
}

/// 时间格式化：今天只显示时间，昨天显示「昨天」，更早显示日期
String formatListTime(int? millis) {
  if (millis == null || millis <= 0) return '';
  final dt = DateTime.fromMillisecondsSinceEpoch(millis);
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final target = DateTime(dt.year, dt.month, dt.day);
  final diff = today.difference(target).inDays;

  final hh = dt.hour.toString().padLeft(2, '0');
  final mm = dt.minute.toString().padLeft(2, '0');
  if (diff == 0) return '$hh:$mm';
  if (diff == 1) return '昨天';
  if (diff < 7) return '$diff天前';
  if (dt.year == now.year) return '${dt.month}/${dt.day}';
  return '${dt.year}/${dt.month}/${dt.day}';
}

/// 消息时间戳（聊天页分隔用）
String formatMessageTime(int millis) {
  final dt = DateTime.fromMillisecondsSinceEpoch(millis);
  final now = DateTime.now();
  final hh = dt.hour.toString().padLeft(2, '0');
  final mm = dt.minute.toString().padLeft(2, '0');
  if (dt.year == now.year && dt.month == now.month && dt.day == now.day) {
    return '$hh:$mm';
  }
  return '${dt.month}/${dt.day} $hh:$mm';
}

/// 时长格式化：秒 → mm:ss
String formatDuration(int seconds) {
  final m = seconds ~/ 60;
  final s = seconds % 60;
  return '${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
}

/// 文件大小
String formatFileSize(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  if (bytes < 1024 * 1024 * 1024) return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
  return '${(bytes / 1024 / 1024 / 1024).toStringAsFixed(2)} GB';
}

/// 是否桌面平台（决定用文件选择器还是相册）
bool get isDesktopPlatform => Platform.isWindows || Platform.isMacOS || Platform.isLinux;
