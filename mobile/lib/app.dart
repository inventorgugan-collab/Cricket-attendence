import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'core/app_state.dart';
import 'features/admin/admin_home.dart';
import 'features/auth/change_password_screen.dart';
import 'features/auth/login_screen.dart';
import 'features/coach/coach_home.dart';
import 'features/player/family_home.dart';
import 'ui/theme.dart';

class CplApp extends StatelessWidget {
  const CplApp({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final Widget home = switch (app.status) {
      AuthStatus.loading => const Scaffold(body: Center(child: CircularProgressIndicator())),
      AuthStatus.signedOut => const LoginScreen(),
      AuthStatus.signedIn when app.mustChangePassword => const ChangePasswordScreen(),
      AuthStatus.signedIn => switch (app.role) {
          'admin' => const AdminHome(),
          'coach' => const CoachHome(),
          _ => const FamilyHome(),
        },
    };
    return MaterialApp(
      title: 'Cricket Performance Lab',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      // Keyed by user so nothing from a previous account survives in the widget tree.
      home: KeyedSubtree(key: ValueKey(app.user?['id']), child: home),
    );
  }
}
