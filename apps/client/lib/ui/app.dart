import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/storage.dart';
import '../services/calls.dart';
import '../services/session.dart';
import 'pages/call_page.dart';
import 'pages/home_page.dart';
import 'pages/login_page.dart';
import 'theme.dart';

/// 全局导航器：来电时要从任意页面弹出通话页
final GlobalKey<NavigatorState> rootNavigatorKey = GlobalKey<NavigatorState>();

/// 主题模式（跟随系统 / 浅色 / 深色），持久化到本地
final ValueNotifier<ThemeMode> themeModeNotifier = ValueNotifier<ThemeMode>(
  _readThemeMode(),
);

ThemeMode _readThemeMode() {
  switch (AppStorage.instance.themeMode) {
    case 'light':
      return ThemeMode.light;
    case 'dark':
      return ThemeMode.dark;
    default:
      return ThemeMode.system;
  }
}

class ChatApp extends StatefulWidget {
  const ChatApp({super.key});

  @override
  State<ChatApp> createState() => _ChatAppState();
}

class _ChatAppState extends State<ChatApp> {
  @override
  void initState() {
    super.initState();
    // 来电：从任意页面弹出通话页
    CallController.instance.onIncoming = () {
      final navigator = rootNavigatorKey.currentState;
      if (navigator == null) return;
      navigator.push(
        MaterialPageRoute<void>(builder: (_) => const CallPage()),
      );
    };
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<ThemeMode>(
      valueListenable: themeModeNotifier,
      builder: (context, mode, _) {
        return MaterialApp(
          title: 'Chat',
          navigatorKey: rootNavigatorKey,
          debugShowCheckedModeBanner: false,
          theme: buildAppTheme(Brightness.light),
          darkTheme: buildAppTheme(Brightness.dark),
          themeMode: mode,
          /**
           * 全局状态栏/导航栏样式
           * ------------------------------------------------------------
           * edge-to-edge 之后系统栏是完全透明的，
           * 图标颜色必须跟随主题，否则深色模式下会「黑字黑底」看不见。
           * 放在这里是因为它要对所有页面生效（含无 AppBar 的通话页）。
           */
          builder: (context, child) {
            final isDark = Theme.of(context).brightness == Brightness.dark;
            return AnnotatedRegion<SystemUiOverlayStyle>(
              value: SystemUiOverlayStyle(
                statusBarColor: Colors.transparent,
                statusBarIconBrightness: isDark ? Brightness.light : Brightness.dark,
                statusBarBrightness: isDark ? Brightness.dark : Brightness.light,
                systemNavigationBarColor: Colors.transparent,
                systemNavigationBarDividerColor: Colors.transparent,
                systemNavigationBarIconBrightness:
                    isDark ? Brightness.light : Brightness.dark,
                systemNavigationBarContrastEnforced: false,
                systemStatusBarContrastEnforced: false,
              ),
              child: child ?? const SizedBox.shrink(),
            );
          },
          home: const _RootGate(),
        );
      },
    );
  }
}

/// 根据登录态决定首屏
class _RootGate extends StatelessWidget {
  const _RootGate();

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Session.instance,
      builder: (context, _) {
        final session = Session.instance;

        if (session.isAuthenticated) {
          return const HomePage();
        }

        if (session.status == AuthStatus.checking) {
          return const _SplashPage();
        }

        return const LoginPage();
      },
    );
  }
}

class _SplashPage extends StatelessWidget {
  const _SplashPage();

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);
    return Scaffold(
      backgroundColor: c.bg,
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const AppLogo(size: 84),
            const SizedBox(height: AppSpacing.xl),
            SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(strokeWidth: 2, color: c.primary),
            ),
          ],
        ),
      ),
    );
  }
}

/// 品牌图标：蓝色圆角方块 + 白色 C
class AppLogo extends StatelessWidget {
  const AppLogo({super.key, this.size = 84});

  final double size;

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [c.primary, Color.lerp(c.primary, Colors.black, 0.25)!],
        ),
        borderRadius: BorderRadius.circular(size * 0.28),
        boxShadow: [
          BoxShadow(
            color: c.primary.withValues(alpha: 0.28),
            blurRadius: size * 0.28,
            offset: Offset(0, size * 0.08),
          ),
        ],
      ),
      alignment: Alignment.center,
      child: Text(
        'C',
        style: TextStyle(
          color: Colors.white,
          fontSize: size * 0.52,
          fontWeight: FontWeight.w700,
          height: 1.0,
        ),
      ),
    );
  }
}
