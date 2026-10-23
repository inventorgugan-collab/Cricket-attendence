import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/app_state.dart';
import '../../ui/theme.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _academy = TextEditingController();
  final _login = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  bool _hidden = true;
  String? _error;

  // What the academy code turned out to be: null while unknown.
  String? _academyName;
  bool _academyMissing = false;
  Timer? _lookup;

  @override
  void initState() {
    super.initState();
    // Most phones only ever sign in to one academy, so remember its code.
    context.read<ApiClient>().tokens.lastAcademy().then((code) {
      if (code != null && mounted && _academy.text.isEmpty) {
        _academy.text = code;
        _check(code);
      }
    });
  }

  @override
  void dispose() {
    _lookup?.cancel();
    super.dispose();
  }

  String get _code => _academy.text.trim().toLowerCase();

  void _changed(String v) {
    _lookup?.cancel();
    setState(() {
      _academyName = null;
      _academyMissing = false;
    });
    if (_code.length >= 2) _lookup = Timer(const Duration(milliseconds: 400), () => _check(_code));
  }

  Future<void> _check(String code) async {
    try {
      final name = await context.read<ApiClient>().academyName(code.trim().toLowerCase());
      if (!mounted || code.trim().toLowerCase() != _code) return;
      setState(() {
        _academyName = name;
        _academyMissing = name == null;
      });
    } catch (_) {
      // Offline or the server is down: sign-in will say so.
    }
  }

  Future<void> _submit() async {
    if (_code.isEmpty) return setState(() => _error = 'Enter your academy code. The academy admin can tell you what it is.');
    if (_login.text.trim().isEmpty || _password.text.isEmpty) return setState(() => _error = 'Enter your email or phone and your password.');
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await context.read<AppState>().signIn(_code, _login.text.trim(), _password.text);
    } on OfflineException {
      setState(() => _error = 'Can\'t reach the academy server. Check your connection.');
    } on ApiException catch (e) {
      setState(() => _error = e.statusCode == 404 ? 'No academy with the code "$_code". Check it with your academy.' : e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: AppTheme.pitchDark,
      body: SafeArea(
        bottom: false,
        child: LayoutBuilder(
          builder: (context, c) => SingleChildScrollView(
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: c.maxHeight),
              child: Column(children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(28, 40, 28, 28),
                  child: Column(children: [
                    Container(
                      width: 64,
                      height: 64,
                      decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(20)),
                      child: const Icon(Icons.sports_cricket, size: 34, color: Colors.white),
                    ),
                    const SizedBox(height: 16),
                    Text('Cricket Performance Lab', textAlign: TextAlign.center, style: text.headlineSmall?.copyWith(color: Colors.white)),
                    const SizedBox(height: 6),
                    Text('Sessions, attendance and progress for your academy',
                        textAlign: TextAlign.center, style: text.bodyMedium?.copyWith(color: Colors.white.withValues(alpha: 0.75))),
                  ]),
                ),
                Container(
                  constraints: BoxConstraints(minHeight: c.maxHeight - 220),
                  width: double.infinity,
                  decoration: BoxDecoration(color: scheme.surfaceContainerLowest, borderRadius: const BorderRadius.vertical(top: Radius.circular(28))),
                  padding: const EdgeInsets.fromLTRB(24, 28, 24, 24),
                  child: Align(
                    alignment: Alignment.topCenter,
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 420),
                      child: AutofillGroup(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                          Text('Sign in', style: text.titleLarge),
                          const SizedBox(height: 16),
                          TextField(
                            controller: _academy,
                            onChanged: _changed,
                            autocorrect: false,
                            textInputAction: TextInputAction.next,
                            decoration: InputDecoration(
                              labelText: 'Academy code',
                              prefixIcon: const Icon(Icons.shield_outlined),
                              suffixIcon: _academyName != null ? Icon(Icons.check_circle, color: scheme.primary) : null,
                              helperText: _academyName ?? (_academyMissing ? null : 'Given to you by your academy'),
                              helperStyle: _academyName != null ? text.bodySmall?.copyWith(color: scheme.primary, fontWeight: FontWeight.w600) : null,
                              errorText: _academyMissing ? 'No academy with this code' : null,
                            ),
                          ),
                          const SizedBox(height: 12),
                          TextField(
                            controller: _login,
                            decoration: const InputDecoration(labelText: 'Email or phone', prefixIcon: Icon(Icons.person_outline)),
                            autofillHints: const [AutofillHints.username],
                            textInputAction: TextInputAction.next,
                          ),
                          const SizedBox(height: 12),
                          TextField(
                            controller: _password,
                            obscureText: _hidden,
                            decoration: InputDecoration(
                              labelText: 'Password',
                              prefixIcon: const Icon(Icons.lock_outline),
                              suffixIcon: IconButton(
                                tooltip: _hidden ? 'Show password' : 'Hide password',
                                icon: Icon(_hidden ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                                onPressed: () => setState(() => _hidden = !_hidden),
                              ),
                            ),
                            autofillHints: const [AutofillHints.password],
                            onSubmitted: (_) => _submit(),
                          ),
                          if (_error != null) ...[
                            const SizedBox(height: 12),
                            Container(
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(color: scheme.errorContainer, borderRadius: BorderRadius.circular(12)),
                              child: Text(_error!, style: TextStyle(color: scheme.onErrorContainer)),
                            ),
                          ],
                          const SizedBox(height: 20),
                          FilledButton(
                            style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
                            onPressed: _busy ? null : _submit,
                            child: Text(_busy ? 'Signing in…' : 'Sign in'),
                          ),
                          const SizedBox(height: 20),
                          Text('Accounts are created by the academy. Ask the admin if you need one.',
                              textAlign: TextAlign.center, style: text.bodySmall),
                        ]),
                      ),
                    ),
                  ),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
