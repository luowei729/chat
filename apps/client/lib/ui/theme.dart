import 'package:flutter/material.dart';

/// ============================================================
/// 设计令牌
/// ------------------------------------------------------------
/// 沿用原 iOS 风格配色（浅色/深色两套），让迁移前后视觉一致。
/// 全部用 const，切换主题不需要重建对象。
/// ============================================================
class AppColors {
  const AppColors({
    required this.bg,
    required this.surface,
    required this.surfaceAlt,
    required this.text,
    required this.textMuted,
    required this.textFaint,
    required this.border,
    required this.primary,
    required this.primarySoft,
    required this.danger,
    required this.success,
    required this.bubbleSelf,
    required this.bubbleOther,
    required this.bubbleSelfText,
    required this.bubbleOtherText,
  });

  final Color bg;
  final Color surface;
  final Color surfaceAlt;
  final Color text;
  final Color textMuted;
  final Color textFaint;
  final Color border;
  final Color primary;
  final Color primarySoft;
  final Color danger;
  final Color success;
  final Color bubbleSelf;
  final Color bubbleOther;
  final Color bubbleSelfText;
  final Color bubbleOtherText;

  static const light = AppColors(
    bg: Color(0xFFFFFFFF),
    surface: Color(0xFFFFFFFF),
    surfaceAlt: Color(0xFFF2F2F7),
    text: Color(0xFF000000),
    textMuted: Color(0xFF8E8E93),
    textFaint: Color(0xFFC7C7CC),
    border: Color(0xFFE5E5EA),
    primary: Color(0xFF007AFF),
    primarySoft: Color(0xFFE9F1FF),
    danger: Color(0xFFFF3B30),
    success: Color(0xFF34C759),
    bubbleSelf: Color(0xFF007AFF),
    bubbleOther: Color(0xFFF2F2F7),
    bubbleSelfText: Color(0xFFFFFFFF),
    bubbleOtherText: Color(0xFF000000),
  );

  static const dark = AppColors(
    bg: Color(0xFF000000),
    surface: Color(0xFF1C1C1E),
    surfaceAlt: Color(0xFF2C2C2E),
    text: Color(0xFFFFFFFF),
    textMuted: Color(0xFF8E8E93),
    textFaint: Color(0xFF48484A),
    border: Color(0xFF38383A),
    primary: Color(0xFF0A84FF),
    primarySoft: Color(0xFF0A2540),
    danger: Color(0xFFFF453A),
    success: Color(0xFF30D158),
    bubbleSelf: Color(0xFF0A84FF),
    bubbleOther: Color(0xFF262629),
    bubbleSelfText: Color(0xFFFFFFFF),
    bubbleOtherText: Color(0xFFFFFFFF),
  );

  static AppColors of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? dark : light;
}

/// 圆角与间距：与 iOS 原生观感对齐
class AppRadius {
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 22;
  static const double bubble = 18;
}

class AppSpacing {
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;
  static const double xxl = 32;
}

ThemeData buildAppTheme(Brightness brightness) {
  final c = brightness == Brightness.dark ? AppColors.dark : AppColors.light;
  final base = ThemeData(
    useMaterial3: true,
    brightness: brightness,
    scaffoldBackgroundColor: c.bg,
    colorScheme: ColorScheme.fromSeed(
      seedColor: c.primary,
      brightness: brightness,
      surface: c.surface,
      error: c.danger,
    ),
  );

  return base.copyWith(
    appBarTheme: AppBarTheme(
      backgroundColor: c.bg,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      centerTitle: true,
      foregroundColor: c.text,
      titleTextStyle: TextStyle(
        color: c.text,
        fontSize: 17,
        fontWeight: FontWeight.w600,
      ),
    ),
    dividerTheme: DividerThemeData(color: c.border, thickness: 0.5, space: 0.5),
    textTheme: base.textTheme.apply(
      bodyColor: c.text,
      displayColor: c.text,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: c.surfaceAlt,
      hintStyle: TextStyle(color: c.textMuted, fontSize: 15),
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
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
        borderSide: BorderSide(color: c.primary, width: 1.5),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size.fromHeight(50),
        backgroundColor: c.primary,
        foregroundColor: Colors.white,
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.md),
        ),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: c.primary),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: brightness == Brightness.dark ? c.surfaceAlt : const Color(0xFF323232),
      contentTextStyle: const TextStyle(color: Colors.white, fontSize: 14),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: c.surface,
      surfaceTintColor: Colors.transparent,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadius.lg)),
      ),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: c.surface,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.lg)),
    ),
  );
}
