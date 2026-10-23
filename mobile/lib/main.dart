import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:provider/provider.dart';

import 'app.dart';
import 'core/api.dart';
import 'core/app_state.dart';
import 'core/config.dart';
import 'core/local_db.dart';
import 'core/sync_service.dart';
import 'core/token_store.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // On the web, expose the accessibility tree so screen readers and browser automation work.
  if (kIsWeb) SemanticsBinding.instance.ensureSemantics();
  final tokens = SecureTokenStore();
  final api = ApiClient(baseUrl: await tokens.server() ?? AppConfig.apiBaseUrl, tokens: tokens);
  final local = await LocalDb.openEncrypted();
  final sync = SyncService(api, local);
  final app = AppState(api, local, sync);

  // Sync when the connection comes back, when the app returns to the
  // foreground, and every couple of minutes while it is open.
  Connectivity().onConnectivityChanged.listen((results) {
    if (app.status == AuthStatus.signedIn && !results.contains(ConnectivityResult.none)) sync.sync();
  });
  Timer.periodic(AppConfig.syncInterval, (_) {
    if (app.status == AuthStatus.signedIn) sync.sync();
  });
  AppLifecycleListener(onResume: () {
    if (app.status == AuthStatus.signedIn) sync.sync();
  });

  unawaited(app.restore());
  runApp(MultiProvider(
    providers: [
      Provider.value(value: api),
      Provider.value(value: local),
      ChangeNotifierProvider.value(value: sync),
      ChangeNotifierProvider.value(value: app),
    ],
    child: const CplApp(),
  ));
}
