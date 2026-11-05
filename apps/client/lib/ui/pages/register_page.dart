import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../services/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

class RegisterPage extends StatefulWidget {
  const RegisterPage({super.key, this.inviteCode});

  /// 从邀请链接进入时预填
  final String? inviteCode;

  @override
  State<RegisterPage> createState() => _RegisterPageState();
}

class _RegisterPageState extends State<RegisterPage> {
  final _emailCtrl = TextEditingController();
  final _codeCtrl = TextEditingController();
  final _nicknameCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  final _inviteCtrl = TextEditingController();
  final _formKey = GlobalKey<FormState>();

  bool _obscure = true;
  bool _loading = false;
  bool _sendingCode = false;
  String? _error;
  int _cooldown = 0;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    if (widget.inviteCode != null) _inviteCtrl.text = widget.inviteCode!;
  }

  @override
  void dispose() {
    _timer?.cancel();
    _emailCtrl.dispose();
    _codeCtrl.dispose();
    _nicknameCtrl.dispose();
    _passwordCtrl.dispose();
    _inviteCtrl.dispose();
    super.dispose();
  }

  void _startCooldown(int seconds) {
    setState(() => _cooldown = seconds);
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return;
      setState(() => _cooldown = _cooldown > 0 ? _cooldown - 1 : 0);
      if (_cooldown == 0) t.cancel();
    });
  }

  Future<void> _sendCode() async {
    if (_sendingCode || _cooldown > 0) return;
    final email = _emailCtrl.text.trim();
    if (email.isEmpty || !email.contains('@')) {
      setState(() => _error = '请先填写正确的邮箱');
      return;
    }

    setState(() {
      _sendingCode = true;
      _error = null;
    });
    try {
      final r = await ApiClient.instance.sendEmailCode(email, 'register');
      final cooldown = r['cooldownSeconds'];
      _startCooldown(cooldown is int ? cooldown : 60);
      if (mounted) {
        final devCode = r['devCode'];
        showError(
          context,
          devCode is String && devCode.isNotEmpty
              ? '开发环境验证码：$devCode'
              : '验证码已发送，请查收邮件',
        );
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _sendingCode = false);
    }
  }

  Future<void> _submit() async {
    if (_loading) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;
    FocusScope.of(context).unfocus();

    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      await Session.instance.register(
        email: _emailCtrl.text.trim(),
        code: _codeCtrl.text.trim(),
        password: _passwordCtrl.text,
        nickname: _nicknameCtrl.text.trim(),
        inviteCode: _inviteCtrl.text.trim(),
      );
      // 注册成功即登录，_RootGate 会自动切换首页
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = '注册失败，请稍后重试');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('注册账号')),
      body: SafeArea(
        child: GestureDetector(
          onTap: () => FocusScope.of(context).unfocus(),
          behavior: HitTestBehavior.translucent,
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(AppSpacing.xl),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: Form(
                  key: _formKey,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      TextFormField(
                        controller: _emailCtrl,
                        keyboardType: TextInputType.emailAddress,
                        autocorrect: false,
                        decoration: const InputDecoration(
                          hintText: '邮箱',
                          prefixIcon: Icon(Icons.mail_outline, size: 20),
                        ),
                        validator: (v) {
                          final value = (v ?? '').trim();
                          if (value.isEmpty) return '请输入邮箱';
                          if (!value.contains('@') || !value.contains('.')) return '邮箱格式不正确';
                          return null;
                        },
                      ),
                      const SizedBox(height: AppSpacing.md),
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: TextFormField(
                              controller: _codeCtrl,
                              keyboardType: TextInputType.number,
                              maxLength: 6,
                              decoration: const InputDecoration(
                                hintText: '邮箱验证码',
                                counterText: '',
                                prefixIcon: Icon(Icons.verified_outlined, size: 20),
                              ),
                              validator: (v) =>
                                  (v ?? '').trim().length < 4 ? '请输入验证码' : null,
                            ),
                          ),
                          const SizedBox(width: AppSpacing.sm),
                          SizedBox(
                            height: 50,
                            width: 116,
                            child: OutlinedButton(
                              onPressed: (_cooldown > 0 || _sendingCode) ? null : _sendCode,
                              style: OutlinedButton.styleFrom(
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(AppRadius.md),
                                ),
                                side: BorderSide(color: c.border),
                              ),
                              child: _sendingCode
                                  ? const SizedBox(
                                      width: 16,
                                      height: 16,
                                      child: CircularProgressIndicator(strokeWidth: 2),
                                    )
                                  : Text(
                                      _cooldown > 0 ? '${_cooldown}s' : '发送验证码',
                                      style: const TextStyle(fontSize: 13),
                                    ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: AppSpacing.md),
                      TextFormField(
                        controller: _nicknameCtrl,
                        maxLength: 20,
                        decoration: const InputDecoration(
                          hintText: '昵称',
                          counterText: '',
                          prefixIcon: Icon(Icons.person_outline, size: 20),
                        ),
                        validator: (v) {
                          final value = (v ?? '').trim();
                          if (value.isEmpty) return '请输入昵称';
                          if (value.length < 2) return '昵称至少 2 个字';
                          return null;
                        },
                      ),
                      const SizedBox(height: AppSpacing.md),
                      TextFormField(
                        controller: _passwordCtrl,
                        obscureText: _obscure,
                        decoration: InputDecoration(
                          hintText: '密码（至少 8 位）',
                          prefixIcon: const Icon(Icons.lock_outline, size: 20),
                          suffixIcon: IconButton(
                            onPressed: () => setState(() => _obscure = !_obscure),
                            icon: Icon(
                              _obscure ? Icons.visibility_off_outlined : Icons.visibility_outlined,
                              size: 20,
                            ),
                          ),
                        ),
                        validator: (v) {
                          final value = v ?? '';
                          if (value.length < 8) return '密码至少 8 位';
                          return null;
                        },
                      ),
                      const SizedBox(height: AppSpacing.md),
                      TextFormField(
                        controller: _inviteCtrl,
                        autocorrect: false,
                        textCapitalization: TextCapitalization.characters,
                        decoration: const InputDecoration(
                          hintText: '邀请码',
                          prefixIcon: Icon(Icons.confirmation_number_outlined, size: 20),
                          helperText: '注册需要邀请码',
                        ),
                        validator: (v) => (v ?? '').trim().isEmpty ? '请输入邀请码' : null,
                      ),
                      if (_error != null) ...[
                        const SizedBox(height: AppSpacing.md),
                        Text(
                          _error!,
                          style: TextStyle(color: c.danger, fontSize: 13),
                        ),
                      ],
                      const SizedBox(height: AppSpacing.xl),
                      FilledButton(
                        onPressed: _loading ? null : _submit,
                        child: _loading
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: Colors.white,
                                ),
                              )
                            : const Text('注册并登录'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
