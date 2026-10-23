import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/app_state.dart';
import '../common/widgets.dart';

/// Shown on first sign-in with a temporary password.
class ChangePasswordScreen extends StatefulWidget {
  const ChangePasswordScreen({super.key});
  @override
  State<ChangePasswordScreen> createState() => _ChangePasswordScreenState();
}

class _ChangePasswordScreenState extends State<ChangePasswordScreen> {
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _confirm = TextEditingController();
  bool _busy = false;

  Future<void> _submit() async {
    if (_next.text.length < 8) return showMessage(context, 'Use at least 8 characters');
    if (_next.text != _confirm.text) return showMessage(context, 'The new passwords don\'t match');
    setState(() => _busy = true);
    try {
      await context.read<AppState>().changePassword(_current.text, _next.text);
    } catch (e) {
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Choose a new password'), actions: [
        TextButton(onPressed: () => context.read<AppState>().signOut(), child: const Text('Sign out')),
      ]),
      body: ListView(padding: const EdgeInsets.all(24), children: [
        const Text('You signed in with a temporary password. Please choose your own.'),
        const SizedBox(height: 16),
        TextField(controller: _current, obscureText: true, decoration: const InputDecoration(labelText: 'Temporary password', border: OutlineInputBorder())),
        const SizedBox(height: 12),
        TextField(controller: _next, obscureText: true, decoration: const InputDecoration(labelText: 'New password', border: OutlineInputBorder())),
        const SizedBox(height: 12),
        TextField(controller: _confirm, obscureText: true, decoration: const InputDecoration(labelText: 'Repeat new password', border: OutlineInputBorder())),
        const SizedBox(height: 20),
        FilledButton(onPressed: _busy ? null : _submit, child: const Text('Save password')),
      ]),
    );
  }
}
