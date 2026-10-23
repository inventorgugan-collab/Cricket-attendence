import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'local_db.dart';
import 'sync_service.dart';

enum AuthStatus { loading, signedOut, signedIn }

class AppState extends ChangeNotifier {
  AppState(this.api, this.local, this.sync) {
    api.onSignedOut = () => _setSignedOut();
  }

  final ApiClient api;
  final LocalDb local;
  final SyncService sync;

  AuthStatus status = AuthStatus.loading;
  Map<String, dynamic>? user;

  String get role => user?['role'] as String? ?? '';
  String get academyName => (user?['academy'] as Map?)?['name'] as String? ?? '';
  String? get profileId => user?['profileId'] as String?;
  bool get mustChangePassword => user?['mustChangePassword'] == true;
  List<Map<String, dynamic>> get children => ((user?['children'] as List?) ?? const []).cast<Map<String, dynamic>>();

  /// Restore the last session. Works offline from the cached profile so a coach
  /// can open the register at the nets without signal.
  Future<void> restore() async {
    final tokens = await api.tokens.read();
    if (tokens == null) return _setSignedOut();
    final cached = await local.meta('me');
    try {
      user = await api.get('/v1/me') as Map<String, dynamic>;
      await local.setMeta(local.db, 'me', jsonEncode(user));
    } on OfflineException {
      if (cached == null) return _setSignedOut();
      user = jsonDecode(cached) as Map<String, dynamic>;
    } on ApiException {
      return _setSignedOut();
    }
    status = AuthStatus.signedIn;
    notifyListeners();
    await sync.refreshCounts();
    await sync.sync();
  }

  Future<void> signIn(String academy, String login, String password) async {
    final me = await api.login(academy, login, password);
    // A different person on this phone must never see the previous user's data.
    final previous = await local.meta('me');
    if (previous == null || (jsonDecode(previous) as Map)['id'] != me['id']) await local.wipe();
    user = me;
    await local.setMeta(local.db, 'me', jsonEncode(me));
    status = AuthStatus.signedIn;
    notifyListeners();
    await sync.sync();
  }

  Future<void> changePassword(String current, String next) async {
    await api.post('/v1/auth/change-password', {'currentPassword': current, 'newPassword': next});
    // Changing the password signs out other devices and issues new tokens.
    final me = await api.get('/v1/me') as Map<String, dynamic>;
    user = me;
    notifyListeners();
  }

  Future<void> signOut() async {
    await api.logout();
    await local.wipe();
    _setSignedOut();
  }

  void _setSignedOut() {
    user = null;
    status = AuthStatus.signedOut;
    notifyListeners();
  }
}
